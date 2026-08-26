/**
 * hydrooj-similarity — post-contest code plagiarism detection plugin.
 *
 * - Sorensen-Dice over language-normalized k-gram fingerprints
 * - levels: identical (>=0.95) / high (>=0.75) / suspected (>=0.55) / none
 * - runs AFTER a contest/homework ends (schedule + hourly sweep + manual),
 *   never on submission, to save compute
 * - admin only: every route requires PERM_EDIT_DOMAIN
 */

import { ContestModel, PERM, ScheduleModel, SettingModel, definePlugin } from 'hydrooj';
import type { Context } from 'hydrooj';
import { ObjectId } from 'mongodb';
import { runInBackground, setBackgroundContext } from './background';
import { readConfig, runDetection } from './detect';
import {
    SimDiffHandler, SimDetailHandler, SimGraphApiHandler, SimGraphHandler, SimListHandler,
    SimStatusHandler,
} from './handler';
import {
    casStatus, collReport, createReport, deleteDomainData, ensureIndexes,
} from './model';

const Setting = SettingModel.Setting;
const FAMILY = 'setting_sim';

/** A running report whose lockedAt is older than this is a zombie (the
 *  detection loop heartbeats every ~25s, so 3min is a 7x margin). */
const STALE_RUNNING_MS = 3 * 60_000;
/** A waiting report older than this lost its schedule task somewhere
 *  (consumed-but-failed handler, mongo blip on insert) — sweep re-enqueues. */
const STALE_WAITING_MS = 2 * 60_000;
/** How long a failed report waits before the sweep may auto-retry it. */
const FAILED_RETRY_MS = 60 * 60_000;

const SETTINGS = [
    Setting(FAMILY, 'sim.threshold.identical', 0.95, 'float', 'sim.threshold.identical', ''),
    Setting(FAMILY, 'sim.threshold.high', 0.75, 'float', 'sim.threshold.high', ''),
    Setting(FAMILY, 'sim.threshold.suspected', 0.55, 'float', 'sim.threshold.suspected', ''),
    Setting(FAMILY, 'sim.kgram', 8, 'number', 'sim.kgram', ''),
    Setting(FAMILY, 'sim.minTokens', 0, 'number', 'sim.minTokens', ''),
    Setting(FAMILY, 'sim.maxCodeSize', 1_048_576, 'number', 'sim.maxCodeSize', ''),
    Setting(FAMILY, 'sim.submissionMode', 'latest',
        [['latest', 'sim_mode_latest'], ['all', 'sim_mode_all']] as [string, string][],
        'sim.submissionMode', ''),
    Setting(FAMILY, 'sim.scope', 'both',
        [['contest', 'sim_scope_contest'], ['homework', 'sim_scope_homework'], ['both', 'sim_scope_both']] as [string, string][],
        'sim.scope', ''),
    Setting(FAMILY, 'sim.autoScan', true, 'boolean', 'sim.autoScan', ''),
    Setting(FAMILY, 'sim.graceMinutes', 10, 'number', 'sim.graceMinutes', ''),
    Setting(FAMILY, 'sim.sweepBatch', 5, 'number', 'sim.sweepBatch', ''),
    Setting(FAMILY, 'sim.scanWindowDays', 90, 'number', 'sim.scanWindowDays', ''),
    Setting(FAMILY, 'sim.diffCellLimit', 4000000, 'number', 'sim.diffCellLimit', ''),
];

/** (Re)schedule the post-contest scan for a contest that has not ended yet. */
async function scheduleForContest(ctx: Context, domainId: string, tid: ObjectId, endAt: Date) {
    // drop any not-yet-fired tasks for this contest so edits never stack duplicates
    await ScheduleModel.deleteMany({
        type: 'schedule', subType: { $in: ['sim.scan', 'sim.scan.precheck'] }, domainId, tid,
        executeAfter: { $gt: new Date() },
    });
    const cfg = readConfig(ctx);
    const executeAfter = new Date(endAt.getTime() + cfg.graceMinutes * 60_000);
    if (executeAfter <= new Date()) return; // already ended: sweep will pick it up
    await ScheduleModel.add({
        type: 'schedule', subType: 'sim.scan.precheck', domainId, tid, executeAfter,
    });
}

export default definePlugin({
    name: 'hydrooj-similarity',
    async apply(ctx: Context) {
        // capture the long-lived plugin context FIRST: every background
        // execution path (manual "scan now", worker handlers) runs on it,
        // never on a request ctx (which is disposed with the response)
        setBackgroundContext(ctx);
        ctx.setting.SystemSetting(...SETTINGS);

        // NOTE: apply() performs NO database operations. Depending on cordis
        // service timing the mongo client may not be connected yet when addons
        // load, and a query here aborts the whole plugin. All db work
        // (indexes, sweep bootstrap) is deferred to 'app/started'.

        ctx.Route('domain_sim_list', '/domain/sim', SimListHandler, PERM.PERM_EDIT_DOMAIN);
        ctx.Route('domain_sim_detail', '/domain/sim/:tid', SimDetailHandler, PERM.PERM_EDIT_DOMAIN);
        ctx.Route('domain_sim_status', '/domain/sim/:tid/status.json', SimStatusHandler, PERM.PERM_EDIT_DOMAIN);
        // contest-scoped alias: the report also lives under the contest's own
        // URL space so admins can reach it per contest (/contest/<tid>/sim)
        ctx.Route('contest_sim', '/contest/:tid/sim', SimDetailHandler, PERM.PERM_EDIT_DOMAIN);
        ctx.Route('domain_sim_diff', '/domain/sim/:tid/diff/:pairId', SimDiffHandler, PERM.PERM_EDIT_DOMAIN);
        ctx.Route('domain_sim_graph', '/domain/sim/:tid/graph', SimGraphHandler, PERM.PERM_EDIT_DOMAIN);
        ctx.Route('domain_sim_graph_api', '/domain/sim/:tid/graph.json', SimGraphApiHandler, PERM.PERM_EDIT_DOMAIN);

        ctx.injectUI('DomainManage', 'domain_sim_list',
            { family: 'Sim Detection', icon: 'copy' }, PERM.PERM_EDIT_DOMAIN);

        await ctx.inject(['worker'], (c: Context) => {
            // scan executes: CAS the report, then run OFF the worker loop
            // (worker is a serial await loop — a long detection here would
            // stall judge dispatch and every other schedule task)
            c.worker.addHandler('sim.scan', async (doc: any) => {
                try {
                    const reportId: ObjectId = new ObjectId(doc.reportId);
                    const ok = await casStatus(reportId, 'waiting', 'running', { startedAt: new Date() });
                    if (!ok) {
                        // claim failed: find out why instead of dying silently
                        const cur = await collReport.findOne(
                            { _id: reportId },
                            { projection: { status: 1, lockedAt: 1 } },
                        );
                        if (cur?.status === 'running'
                            && (!cur.lockedAt || Date.now() - cur.lockedAt.getTime() > STALE_RUNNING_MS)) {
                            // zombie run (process died mid-detection): reclaim
                            // the lock and restart right here instead of
                            // waiting for the next sweep
                            await collReport.updateOne(
                                { _id: reportId, status: 'running' },
                                { $set: { lockedAt: new Date(), startedAt: new Date() } },
                            );
                            c.logger.warn('sim.scan %s: reclaimed stale running report, restarting', reportId.toHexString());
                            runInBackground((bg) => runDetection(bg, reportId));
                        } else {
                            // waiting = another task claimed it first (dup); done/
                            // failed/gone = expected after admin actions
                            c.logger.info('sim.scan %s: claim skipped (status=%s)', reportId.toHexString(), cur?.status ?? 'gone');
                        }
                        return;
                    }
                    runInBackground((bg) => runDetection(bg, reportId));
                } catch (e) {
                    // the schedule task is consumed the moment this handler
                    // runs; if we fail before claiming the report it would
                    // sit in "waiting" forever — put the task back
                    c.logger.error(e);
                    try {
                        await ScheduleModel.add({
                            type: 'schedule', subType: 'sim.scan',
                            domainId: doc.domainId, tid: doc.tid, reportId: doc.reportId,
                            executeAfter: new Date(Date.now() + 120_000),
                        });
                    } catch { /* hourly sweep requeue covers it */ }
                }
            });

            // precheck fires at endAt+grace: creates the report and enqueues the scan
            c.worker.addHandler('sim.scan.precheck', async (doc: any) => {
                const { domainId } = doc;
                const tid: ObjectId = new ObjectId(doc.tid);
                const cfg = readConfig(c);
                try {
                    const tdoc = await ContestModel.get(domainId, tid);
                    if (!tdoc || !ContestModel.isDone(tdoc)) return; // extended: edit event rescheduled
                    const existing = await collReport.findOne({ domainId, tid, status: { $in: ['waiting', 'running'] } });
                    if (existing) return;
                    const rdoc = await createReport({
                        domainId, tid,
                        title: tdoc.title,
                        rule: tdoc.rule,
                        beginAt: tdoc.beginAt,
                        endAt: tdoc.endAt,
                        mode: cfg.mode,
                        config: { k: cfg.k, minTokens: cfg.minTokens, thresholds: cfg.thresholds },
                        triggeredBy: 0,
                    });
                    if (rdoc) {
                        await ScheduleModel.add({
                            type: 'schedule', subType: 'sim.scan', domainId, tid, reportId: rdoc,
                            executeAfter: new Date(),
                        });
                    }
                } catch (e) {
                    c.logger.error('sim.scan.precheck failed for %s/%s', domainId, tid.toHexString());
                    c.logger.error(e);
                }
            });

            // hourly sweep: crashed-run recovery + catch-up for missed triggers
            c.worker.addHandler('sim.sweep', async () => {
              try {
                const cfg = readConfig(c);
                if (!cfg.autoScan) return;
                const now = Date.now();
                // 0) requeue waiting reports whose schedule task was lost
                //    (consumed-but-failed handler, add raced with a blip...)
                const staleWaiting = await collReport.find({
                    status: 'waiting', createdAt: { $lt: new Date(now - STALE_WAITING_MS) },
                }).limit(20).toArray();
                for (const report of staleWaiting) {
                    await ScheduleModel.add({
                        type: 'schedule', subType: 'sim.scan',
                        domainId: report.domainId, tid: report.tid, reportId: report._id,
                        executeAfter: new Date(),
                    });
                }
                // 1) recover reports stuck in running (process died mid-run)
                const stuck = await collReport.find({
                    status: 'running', lockedAt: { $lt: new Date(now - STALE_RUNNING_MS) },
                }).limit(20).toArray();
                for (const report of stuck) {
                    const ok = await casStatus(report._id, 'running', 'waiting');
                    if (ok) {
                        await ScheduleModel.add({
                            type: 'schedule', subType: 'sim.scan',
                            domainId: report.domainId, tid: report.tid, reportId: report._id,
                            executeAfter: new Date(),
                        });
                    }
                }
                // 2) catch-up: ended contests without a (fresh) report
                const graceMs = cfg.graceMinutes * 60_000;
                const windowStart = new Date(now - cfg.scanWindowDays * 24 * 3600_000);
                const domains = await ctx.db.collection('domain').find({}, { projection: { _id: 1 } }).toArray();
                let budget = cfg.sweepBatch;
                outer:
                for (const d of domains) {
                    // 'both' deliberately has no rule filter: docType 30 covers
                    // every contest rule (incl. ones added after this plugin)
                    const ruleQuery = cfg.scope === 'contest' ? { rule: { $ne: 'homework' } }
                        : cfg.scope === 'homework' ? { rule: 'homework' } : {};
                    const tdocs = await ctx.db.collection('document').find({
                        domainId: d._id, docType: 30, ...ruleQuery,
                        endAt: { $lt: new Date(now - graceMs), $gt: windowStart },
                    }, { projection: { docId: 1, title: 1, rule: 1, beginAt: 1, endAt: 1 } }).limit(50).toArray();
                    if (!tdocs.length) continue;
                    // one batched query per domain instead of a findOne per contest
                    // (newest report per tid: sorted, first hit wins)
                    const existing = await collReport.find(
                        { domainId: d._id, tid: { $in: tdocs.map((t) => t.docId) } },
                        { projection: { tid: 1, status: 1, finishedAt: 1, createdAt: 1 } },
                    ).sort({ createdAt: -1 }).toArray();
                    const seen = new Map<string, { status: string; finishedAt?: Date }>();
                    for (const r of existing) {
                        const key = String(r.tid);
                        if (!seen.has(key)) seen.set(key, { status: r.status, finishedAt: r.finishedAt });
                    }
                    for (const tdoc of tdocs) {
                        if (budget <= 0) break outer;
                        const st = seen.get(String(tdoc.docId));
                        if (st) {
                            if (st.status !== 'failed') continue;
                            // rate-limit auto-retry of failed scans (at most
                            // hourly) so one persistently failing scan cannot
                            // churn the queue on every sweep pass
                            const failedAt = st.finishedAt?.getTime() || 0;
                            if (now - failedAt < FAILED_RETRY_MS) continue;
                        }
                        const reportId = await createReport({
                            domainId: d._id, tid: tdoc.docId,
                            title: tdoc.title, rule: tdoc.rule || 'acm',
                            beginAt: tdoc.beginAt, endAt: tdoc.endAt,
                            mode: cfg.mode,
                            config: { k: cfg.k, minTokens: cfg.minTokens, thresholds: cfg.thresholds },
                            triggeredBy: 0,
                        });
                        if (reportId) {
                            await ScheduleModel.add({
                                type: 'schedule', subType: 'sim.scan',
                                domainId: d._id, tid: tdoc.docId, reportId,
                                executeAfter: new Date(),
                            });
                            budget--;
                        }
                    }
                }
              } catch (e) {
                // transient (e.g. mongo blip): log and let the next hourly
                // sweep retry — never crash the worker loop
                c.logger.error('sim.sweep failed');
                c.logger.error(e);
              }
            });
        });

        // schedule post-contest scans when contests are created / edited
        // (registered on every instance: in PM2 mode events may fire anywhere)
        ctx.on('contest/add', (payload, id) => {
            if (payload?.endAt && payload.domainId && payload.endAt > new Date()) {
                scheduleForContest(ctx, payload.domainId, id, new Date(payload.endAt)).catch(() => { });
            }
        });
        ctx.on('contest/edit', (payload) => {
            if (payload?.endAt && payload.domainId && payload.docId && payload.endAt > new Date()) {
                scheduleForContest(ctx, payload.domainId, payload.docId, new Date(payload.endAt)).catch(() => { });
            }
        });
        ctx.on('domain/delete', (domainId) => {
            deleteDomainData(domainId).catch(() => { });
        });

        // Deferred init: indexes + the hourly sweep bootstrap. 'app/started'
        // fires at the very end of boot (after every service is up), so mongo
        // is guaranteed connected here. Try/catch keeps a failure from
        // taking the whole app down — the plugin degrades to manual scans.
        ctx.on('app/started', async () => {
            try {
                // index creation must NEVER disable the sweep bootstrap below:
                // a failure here (old mongo, option conflict) would silently
                // kill queue recovery, which is what rescues stuck reports
                try {
                    await ensureIndexes(ctx);
                } catch (e) {
                    ctx.logger.error('sim ensureIndexes failed (continuing)');
                    ctx.logger.error(e);
                }
                // NOTE: NODE_APP_INSTANCE is only set under PM2 cluster mode.
                // A plain `hydrooj serve` leaves it undefined — the stock
                // `!== '0'` guard would skip sweep bootstrap entirely in dev,
                // so undefined is treated as single-instance and bootstraps.
                const instance = process.env.NODE_APP_INSTANCE;
                if (instance !== undefined && instance !== '0') return;
                // sweep every 5 minutes (not hourly): queue recovery paths —
                // a lost schedule task or a zombie running report — then heal
                // within minutes. deleteMany+add also migrates an existing
                // hourly task from an older plugin version and self-heals
                // duplicates from racing instances.
                await ScheduleModel.deleteMany({ type: 'schedule', subType: 'sim.sweep' });
                await ScheduleModel.add({
                    type: 'schedule', subType: 'sim.sweep',
                    interval: [5, 'minute'],
                });
                // One-time default bump: SettingModel.apply only writes a
                // default when the stored value is absent, and existing
                // installs already have the OLD defaults (30 / 131072)
                // persisted. Overwrite those (and only those) so upgraded
                // installs pick up "never skip short code" behavior; an
                // admin-chosen other value is left untouched.
                const sys = ctx.db.collection('system');
                if (!await sys.findOne({ _id: 'sim.defaults.v2' })) {
                    const bump = async (key: string, from: number, to: number) => {
                        const cur = await sys.findOne({ _id: key });
                        const v = Number((cur as any)?.value);
                        if (!cur || (cur as any).value == null || (cur as any).value === ''
                            || v === from) {
                            await global.Hydro.model.system.set(key, to);
                        }
                    };
                    await bump('sim.minTokens', 30, 0);
                    await bump('sim.maxCodeSize', 131072, 1_048_576);
                    await global.Hydro.model.system.set('sim.defaults.v2', 1);
                }
            } catch (e) {
                ctx.logger.error('sim deferred init failed');
                ctx.logger.error(e);
            }
        });
    },
});
