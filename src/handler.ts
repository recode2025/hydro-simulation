/**
 * Admin-facing handlers. EVERY route is registered with PERM.PERM_EDIT_DOMAIN
 * (checked by the framework before the handler runs) and re-checked in
 * prepare() — the plugin is admin-only by design. Diff additionally requires
 * PERM_READ_RECORD_CODE (viewing source code).
 */

import {
    ContestNotEndedError, ContestModel, DomainModel, Handler, NotFoundError, PERM,
    ProblemModel, RecordModel, ScheduleModel, Types, UserModel, param, requireSudo,
} from 'hydrooj';
import type { Context } from 'hydrooj';
import { ObjectId } from 'mongodb';
import { runInBackground } from './background';
import { buildGraph } from './graph';
import { buildUserSummary } from './lib/userSummary';
import { diffCellLimit, fetchCode, readConfig, runDetection } from './detect';
import { lineDiff, splitLines } from './lib/lcs';
import type { PairDoc } from './model';
import {
    FP_SCHEMA, cancelContestData, cancelReport, casStatus, claimReport, collFp, collPair,
    collReport, createReport, deleteContestData, deleteContestTasks, getActiveReport,
    getLatestReport, getLatestReportMap, requeueReport,
} from './model';

const PAGE_SIZE = 50;

function scopeRuleFilter(scope: 'contest' | 'homework' | 'both') {
    if (scope === 'contest') return { rule: { $ne: 'homework' } };
    if (scope === 'homework') return { rule: 'homework' };
    return {};
}

/**
 * Clamp a per-scan threshold override. 0 / out-of-range / NaN falls back to
 * the corresponding default; ordering suspected <= high <= identical is
 * enforced by swapping (admins get a sane ladder, never an inverted one).
 */
function resolveThresholds(
    override: { identical?: number; high?: number; suspected?: number } | undefined,
    defaults: { identical: number; high: number; suspected: number },
) {
    const pick = (v: number | undefined, d: number) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0.05 || n > 1) return d;
        return Math.round(n * 10000) / 10000;
    };
    const t = {
        identical: pick(override?.identical, defaults.identical),
        high: pick(override?.high, defaults.high),
        suspected: pick(override?.suspected, defaults.suspected),
    };
    if (t.high < t.suspected) t.high = t.suspected;
    if (t.identical < t.high) t.identical = t.high;
    return t;
}

/** Parse an admin-typed problem exclusion list ("1001,1002 1003") into a
 *  clean ascending unique array; undefined when nothing valid was given. */
function parseExcludePids(raw: string): number[] | undefined {
    const pids = Array.from(new Set(
        String(raw || '').split(/[,，;;\s]+/)
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0),
    )).sort((a, b) => a - b);
    return pids.length ? pids : undefined;
}

/** Create a waiting report and enqueue the scan immediately. */
async function triggerScan(
    ctx: Context, domainId: string, tid: ObjectId, mode: 'latest' | 'all', uid: number,
    override?: { identical?: number; high?: number; suspected?: number },
    noCache = false,
    excludePids?: number[],
) {
    const tdoc = await ContestModel.get(domainId, tid);
    if (!tdoc) throw new NotFoundError(tid);
    if (!ContestModel.isDone(tdoc)) throw new ContestNotEndedError(domainId, tid);
    const cfg = readConfig(ctx);
    const reportId = await createReport({
        domainId,
        tid,
        title: tdoc.title,
        rule: tdoc.rule,
        beginAt: tdoc.beginAt,
        endAt: tdoc.endAt,
        mode,
        config: {
            k: cfg.k, minTokens: cfg.minTokens,
            thresholds: resolveThresholds(override, cfg.thresholds),
            ignoreCache: !!noCache,
            excludePids,
        },
        triggeredBy: uid,
    });
    if (reportId) {
        startScanNow(reportId);
        return true;
    }
    // createReport refused: a report is already in flight. If it is WAITING,
    // do NOT adopt it — it snapshots the config (mode / thresholds /
    // minTokens) it was CREATED with, so adopting made "Scan again" after a
    // settings change silently rerun the OLD config ("rescan reuses old
    // data"). Drop the stale report and its pending task, then fall through
    // to a fresh create below with the CURRENT settings. A RUNNING one is
    // genuinely working: leave it alone.
    const active = await getActiveReport(domainId, tid);
    if (active?.status !== 'waiting') return false;
    await deleteContestTasks(domainId, tid);
    await collReport.deleteOne({ _id: active._id, status: 'waiting' });
    const freshId = await createReport({
        domainId,
        tid,
        title: tdoc.title,
        rule: tdoc.rule,
        beginAt: tdoc.beginAt,
        endAt: tdoc.endAt,
        mode,
        config: {
            k: cfg.k, minTokens: cfg.minTokens,
            thresholds: resolveThresholds(override, cfg.thresholds),
            ignoreCache: !!noCache,
            excludePids,
        },
        triggeredBy: uid,
    });
    if (freshId) startScanNow(freshId);
    return !!freshId;
}

/**
 * Start scanning a waiting report RIGHT NOW, bypassing the schedule queue.
 *
 * Manual triggers ("Scan now" / queue buttons) must not wait behind the
 * worker loop: it is a serial await that can be busy for minutes with judge
 * dispatch or unrelated schedule tasks, which users read as "stuck in queue".
 * Safety is identical to the queued path — CAS claim + heartbeat + idempotent
 * rerun all live inside runDetection. Only automatic triggers (post-contest
 * precheck / sweep catch-up) still go through the schedule queue, where
 * persistence and retry matter.
 *
 * NOT ctx.setImmediate: the framework disposes the request's cordis scope
 * when the response completes, which CANCELS pending setImmediates — the
 * callback must never fire on the request context (see background.ts).
 */
function startScanNow(reportId: ObjectId) {
    runInBackground(async (ctx) => {
        try {
            const runId = await claimReport(reportId);
            ctx.logger.info('sim manual start %s: claim=%s', reportId.toHexString(), !!runId);
            if (!runId) return; // already running / done / deleted — nothing to do
            await runDetection(ctx, reportId);
        } catch (e) {
            ctx.logger.error('sim manual scan failed for %s', reportId.toHexString());
            ctx.logger.error(e);
        }
    });
}

export class SimBaseHandler extends Handler {
    async prepare({ domainId }: { domainId: string }) {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        this.domain = await DomainModel.get(domainId);
    }
}

export class SimListHandler extends SimBaseHandler {
    @param('scope', Types.Range(['contest', 'homework', 'both']), true)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, scope = 'both', page = 1) {
        const s = (['contest', 'homework', 'both'].includes(scope) ? scope : 'both') as 'contest' | 'homework' | 'both';
        const cursor = ContestModel.getMulti(domainId, scopeRuleFilter(s) as any)
            .sort({ endAt: -1, beginAt: -1, _id: -1 });
        const [tdocs, tpcount] = await this.paginate(cursor, page, 'contest');
        const reports = await getLatestReportMap(domainId, tdocs.map((t: any) => t.docId));
        // queue management: everything not finished, oldest first
        const queueDocs = await collReport.find(
            { domainId, status: { $in: ['waiting', 'running', 'failed'] } },
        ).sort({ createdAt: 1 }).limit(50).toArray();
        const now = Date.now();
        const queue = queueDocs.map((r) => ({
            _id: r._id,
            tid: r.tid,
            title: r.title,
            status: r.status,
            progress: r.progress,
            // failed reports show their error; requeued waiting ones show the
            // transient error that keeps requeueing them (lastError)
            error: r.error || r.lastError || null,
            minutes: Math.max(0, Math.floor((now - r.createdAt.getTime()) / 60000)),
        }));
        this.response.template = 'sim_list.html';
        this.response.body = {
            page, tpcount, scope: s, tdocs, reports, queue,
            // any report in flight on this page -> template enables auto refresh
            scanning: Object.values(reports).some((r) => r.status === 'waiting' || r.status === 'running')
                || queue.some((r) => r.status === 'waiting' || r.status === 'running'),
            thresholds: readConfig(this.ctx).thresholds,
            qs: s === 'both' ? '' : `scope=${s}`,
            urlContest: (tid: ObjectId) => this.url('contest_detail', { tid }),
            urlHomework: (tid: ObjectId) => this.url('homework_detail', { tid }),
            isHomework: (t: any) => t.rule === 'homework',
        };
    }

    @requireSudo
    @param('tid', Types.ObjectId)
    @param('mode', Types.Range(['latest', 'all']), true)
    @param('tIdentical', Types.Float, true)
    @param('tHigh', Types.Float, true)
    @param('tSuspected', Types.Float, true)
    @param('noCache', Types.UnsignedInt, true)
    @param('exclude', Types.Content, true)
    async postRun(
        domainId: string, tid: ObjectId, mode = '',
        tIdentical = 0, tHigh = 0, tSuspected = 0, noCache = 0, exclude = '',
    ) {
        // quick-scan posts no mode: fall back to the configured default
        const cfgMode = readConfig(this.ctx).mode;
        const m = mode === 'all' || mode === 'latest' ? mode : cfgMode;
        await triggerScan(this.ctx, domainId, tid, m, this.user._id, {
            identical: tIdentical, high: tHigh, suspected: tSuspected,
        }, !!noCache, parseExcludePids(exclude));
        this.response.redirect = this.url('domain_sim_detail', { tid });
    }

    // ---- queue management ----

    /** Force a queued (waiting) report to execute now (bypasses the queue). */
    @requireSudo
    @param('reportId', Types.ObjectId)
    async postQueueRun(domainId: string, reportId: ObjectId) {
        const report = await collReport.findOne({ _id: reportId, domainId });
        if (report?.status === 'waiting') startScanNow(reportId);
        this.response.redirect = this.url('domain_sim_list');
    }

    /** Cancel a queued (or just-started) report. The report is MARKED
     *  cancelled, not deleted: the doc stays as a tombstone the sweep and
     *  precheck respect, so the scan cannot come back as a fresh task on the
     *  next catch-up pass (it used to resurrect right after every plugin
     *  update, when the sweep task is re-registered and fires). */
    @requireSudo
    @param('reportId', Types.ObjectId)
    async postQueueCancel(domainId: string, reportId: ObjectId) {
        const report = await collReport.findOne(
            { _id: reportId, domainId },
            { projection: { tid: 1, status: 1 } },
        );
        if (report && (report.status === 'waiting' || report.status === 'running')) {
            await ScheduleModel.deleteMany({
                type: 'schedule', subType: { $in: ['sim.scan', 'sim.scan.precheck'] }, domainId,
                $or: [{ tid: report.tid }, { reportId }],
            });
            await cancelReport(reportId);
        }
        this.response.redirect = this.url('domain_sim_list');
    }

    /** Unlock a running report (stuck scan) and restart it immediately.
     *  requeueReport resets progress and rotates the run token so the old
     *  (possibly still alive) run aborts instead of racing the restart. */
    @requireSudo
    @param('reportId', Types.ObjectId)
    async postQueueReset(domainId: string, reportId: ObjectId) {
        const report = await collReport.findOne({ _id: reportId, domainId });
        if (report?.status === 'running') {
            await requeueReport(reportId);
            startScanNow(reportId);
        }
        this.response.redirect = this.url('domain_sim_list');
    }

    /** Retry a failed report with its snapshotted config. */
    @requireSudo
    @param('reportId', Types.ObjectId)
    async postQueueRetry(domainId: string, reportId: ObjectId) {
        const report = await collReport.findOne({ _id: reportId, domainId });
        if (report?.status === 'failed') {
            await casStatus(reportId, 'failed', 'waiting');
            startScanNow(reportId);
        }
        this.response.redirect = this.url('domain_sim_list');
    }

    /** Delete a contest's sim data from the LIST page (the table's Delete
     *  button posts here). Same tombstone semantics as the detail page's
     *  postDelete — this method used to be missing entirely, so the button
     *  died with MethodNotAllowedError. */
    @requireSudo
    @param('tid', Types.ObjectId)
    async postDelete(domainId: string, tid: ObjectId) {
        await deleteContestTasks(domainId, tid);
        await cancelContestData(domainId, tid);
        this.response.redirect = this.url('domain_sim_list');
    }
}

export class SimDetailHandler extends SimBaseHandler {
    @param('tid', Types.ObjectId)
    @param('level', Types.Range(['1', '2', '3']), true)
    @param('pid', Types.PositiveInt, true)
    @param('page', Types.PositiveInt, true)
    @param('user', Types.UidOrName, true)
    // metric filter: only pairs where this evidence metric is at least the
    // given value (trivial problems saturate Seq/TF-IDF/Func/Struct for
    // everyone — Var is often the only signal left)
    @param('metric', Types.Range(['seq', 'tfidf', 'var', 'func', 'struct', 'comments']), true)
    @param('metricGte', Types.Float, true)
    async get(
        domainId: string, tid: ObjectId, level = '1', pid?: number, page = 1, user = '',
        metric = '', metricGte = -1,
    ) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (!tdoc) throw new NotFoundError(tid);
        const report = await getLatestReport(domainId, tid);
        const minLevel = Math.max(1, Math.min(3, Math.floor(Number(level) || 1)));
        const query: any = { domainId, tid, level: { $gte: minLevel } };
        if (pid) query.pid = pid;
        const METRIC_FIELDS: Record<string, string> = {
            seq: 'simSeq', tfidf: 'simTfidf', var: 'simVar',
            func: 'simFunc', struct: 'simStruct', comments: 'sharedComments',
        };
        let metricField = '';
        if (metric && METRIC_FIELDS[metric]) {
            metricField = METRIC_FIELDS[metric];
            // the form sends percent for ratio metrics, a line count for
            // shared comments; defaults: 70% / 1 line
            const gte = metricGte >= 0 ? metricGte : (metric === 'comments' ? 1 : 70);
            query[metricField] = { $gte: metric === 'comments' ? Math.round(gte) : gte / 100 };
        }
        const metricGteDisplay = metricGte >= 0 ? metricGte : (metric === 'comments' ? 1 : 70);
        // user filter: resolve name/mail/uid the same way the record list does
        let filterUid = 0;
        let filterUdoc: any = null;
        if (user) {
            filterUdoc = await UserModel.getById(domainId, +user)
                || await UserModel.getByUname(domainId, user)
                || await UserModel.getByEmail(domainId, user);
            filterUid = filterUdoc?._id || 0;
            if (filterUid) query.$or = [{ uid1: filterUid }, { uid2: filterUid }];
        }
        // with a metric filter active, that metric is the ranking that matters
        // (overall similarity is saturated noise on exactly these problems)
        const sort: Record<string, -1 | 1> = { similarity: -1, pid: 1 };
        if (metricField && metricField !== 'sharedComments') {
            delete sort.similarity;
            sort[metricField] = -1;
        }
        const cursor = collPair.find(query).sort(sort);
        const [pairs, tpcount] = await this.paginate(cursor, page, PAGE_SIZE);
        const pids = Array.from(new Set(pairs.map((p) => p.pid).concat(tdoc.pids)));

        // per-user rollup over ALL of the user's pairs (not just this page)
        let userSummary = null as ReturnType<typeof buildUserSummary> | null;
        if (filterUid) {
            const allPairs = await collPair.find(
                { domainId, tid, $or: [{ uid1: filterUid }, { uid2: filterUid }] },
                {
                    projection: {
                        pid: 1, level: 1, similarity: 1, sharedComments: 1,
                        flags1: 1, flags2: 1, uid1: 1, uid2: 1,
                    },
                },
            ).limit(20000).toArray();
            userSummary = buildUserSummary(allPairs, filterUid);
        }

        const [udict, pdict] = await Promise.all([
            // getList (NOT getListForRender): render_inline's badge branch
            // calls udoc.hasPriv/hasPerm, which only exist on User instances —
            // plain getListForRender docs crashed the whole page the first
            // time a completed report actually rendered its pair table
            UserModel.getList(
                domainId,
                Array.from(new Set(
                    pairs.flatMap((p) => [p.uid1, p.uid2]).concat(filterUid ? [filterUid] : []),
                )),
            ),
            ProblemModel.getList(domainId, pids, true, false),
        ]);

        // preformat metric cells server-side: nunjucks has no ternary and
        // undefined/null/0 all falsy-test the same, which would hide real 0%
        const pct = (x: number | null | undefined) => (
            x === null || x === undefined ? null : `${Math.round(x * 1000) / 10}%`
        );
        const heat = (x: number | null | undefined) => (
            x === null || x === undefined ? 'na' : x >= 0.7 ? 'high' : x >= 0.4 ? 'mid' : 'low'
        );
        const rows = pairs.map((p) => ({
            pair: p,
            seqD: pct(p.simSeq), tfidfD: pct(p.simTfidf), varD: pct(p.simVar),
            funcD: pct(p.simFunc), structD: pct(p.simStruct),
            seqH: heat(p.simSeq), tfidfH: heat(p.simTfidf), varH: heat(p.simVar),
            funcH: heat(p.simFunc), structH: heat(p.simStruct),
        }));

        this.response.template = 'sim_detail.html';
        this.response.body = {
            tdoc, report, pairs: rows, page, tpcount, udict, pdict,
            level: String(minLevel), pid: pid || 0,
            // NOT "user": that name collides with the template-global user
            // view helper (an object), which shadowed it and rendered
            // "[object Object]" into the filter box
            userFilter: user, filterUdoc, userSummary,
            metric, metricGteDisplay,
            minLevels: [1, 2, 3],
            thresholds: report?.config?.thresholds || readConfig(this.ctx).thresholds,
            urlDiff: (pair: PairDoc) => this.url('domain_sim_diff', { tid, pairId: pair._id }),
            urlRecord: (rid: ObjectId) => this.url('record_detail', { rid }),
            urlGraph: this.url('domain_sim_graph', { tid }),
            urlStatus: this.url('domain_sim_status', { tid }),
            urlDebug: this.url('domain_sim_debug', { tid }),
            urlContest: this.url(tdoc.rule === 'homework' ? 'homework_detail' : 'contest_detail', { tid }),
            urlContestManage: this.url(tdoc.rule === 'homework' ? 'homework_detail' : 'contest_manage', { tid }),
            qs: `level=${minLevel}${pid ? `&pid=${pid}` : ''}${user ? `&user=${encodeURIComponent(user)}` : ''}${metric ? `&metric=${metric}&metricGte=${metricGteDisplay}` : ''}`,
        };
    }

    @requireSudo
    @param('tid', Types.ObjectId)
    @param('mode', Types.Range(['latest', 'all']), true)
    @param('tIdentical', Types.Float, true)
    @param('tHigh', Types.Float, true)
    @param('tSuspected', Types.Float, true)
    @param('noCache', Types.UnsignedInt, true)
    @param('exclude', Types.Content, true)
    async postRerun(
        domainId: string, tid: ObjectId, mode = 'latest',
        tIdentical = 0, tHigh = 0, tSuspected = 0, noCache = 0, exclude = '',
    ) {
        await deleteContestData(domainId, tid);
        // also drop any pending task of the report(s) just deleted, so a
        // leftover sim.scan cannot fire at a gone report later
        await deleteContestTasks(domainId, tid);
        await triggerScan(this.ctx, domainId, tid, mode === 'all' ? 'all' : 'latest', this.user._id, {
            identical: tIdentical, high: tHigh, suspected: tSuspected,
        }, !!noCache, parseExcludePids(exclude));
        this.response.redirect = this.url('domain_sim_detail', { tid });
    }

    /** Claim a waiting report for this contest and execute it immediately
     *  (the escape hatch for a scan stuck in the queue). */
    @requireSudo
    @param('tid', Types.ObjectId)
    async postRunNow(domainId: string, tid: ObjectId) {
        const report = await getActiveReport(domainId, tid);
        this.ctx.logger.info(
            'sim runNow %s: active=%s(%s)',
            tid.toHexString(), report?._id.toHexString() ?? 'none', report?.status ?? '-',
        );
        if (report?.status === 'waiting') startScanNow(report._id);
        this.response.redirect = this.url('domain_sim_detail', { tid });
    }

    /** Delete this contest's sim data. Reports are MARKED cancelled (tombstone)
     *  instead of deleted and pending tasks are dropped: deleting the docs left
     *  the contest with zero reports, and the sweep catch-up — which re-scans
     *  every ended contest in the lookback window without a report — recreated
     *  the whole thing minutes later ("delete didn't work"). */
    @requireSudo
    @param('tid', Types.ObjectId)
    async postDelete(domainId: string, tid: ObjectId) {
        await deleteContestTasks(domainId, tid);
        await cancelContestData(domainId, tid);
        this.response.redirect = this.url('domain_sim_list');
    }
}

export class SimDiffHandler extends SimBaseHandler {
    async prepare(args: { domainId: string }) {
        await super.prepare(args);
        this.checkPerm(PERM.PERM_READ_RECORD_CODE);
    }

    @param('tid', Types.ObjectId)
    @param('pairId', Types.ObjectId)
    async get(domainId: string, tid: ObjectId, pairId: ObjectId) {
        const pair: PairDoc | null = await collPair.findOne({ _id: pairId, domainId, tid });
        if (!pair) throw new NotFoundError(pairId);
        const [rdoc1, rdoc2] = await Promise.all([
            RecordModel.get(domainId, pair.rid1),
            RecordModel.get(domainId, pair.rid2),
        ]);
        if (!rdoc1 || !rdoc2) throw new NotFoundError(tid);
        const [code1, code2, udict, pdict] = await Promise.all([
            fetchCode(rdoc1 as any),
            fetchCode(rdoc2 as any),
            // User instances, same reason as the detail handler above
            UserModel.getList(domainId, [pair.uid1, pair.uid2]),
            ProblemModel.getList(domainId, [pair.pid], true, false),
        ]);
        const a = splitLines(code1);
        const b = splitLines(code2);
        const rows = lineDiff(a, b, diffCellLimit(this.ctx));
        this.response.template = 'sim_diff.html';
        this.response.body = {
            pair, udict, pdict, rows, degraded: rows === null,
            a: a.map((l, i) => ({ text: l.length > 500 ? `${l.slice(0, 500)}…` : l })),
            b: b.map((l, i) => ({ text: l.length > 500 ? `${l.slice(0, 500)}…` : l })),
            lang1: rdoc1.lang, lang2: rdoc2.lang,
            urlRecord1: this.url('record_detail', { rid: pair.rid1 }),
            urlRecord2: this.url('record_detail', { rid: pair.rid2 }),
            urlBack: this.url('domain_sim_detail', { tid }),
        };
    }
}

/** Lightweight JSON status endpoint for live progress polling (admin only). */
export class SimStatusHandler extends SimBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const report = await getLatestReport(domainId, tid);
        this.response.body = {
            status: report?.status || 'none',
            processed: report?.progress?.processed || 0,
            total: report?.progress?.total || 0,
        };
    }
}

export class SimGraphHandler extends SimBaseHandler {
    @param('tid', Types.ObjectId)
    @param('level', Types.Range(['1', '2', '3']), true)
    async get(domainId: string, tid: ObjectId, level = '1') {
        const tdoc = await ContestModel.get(domainId, tid);
        if (!tdoc) throw new NotFoundError(tid);
        const report = await getLatestReport(domainId, tid);
        this.response.template = 'sim_graph.html';
        this.response.body = {
            tdoc, report, level: String(Math.max(1, Math.min(3, Number(level) || 1))),
            apiUrl: this.url('domain_sim_graph_api', { tid }),
            urlBack: this.url('domain_sim_detail', { tid }),
        };
    }
}

export class SimGraphApiHandler extends SimBaseHandler {    @param('tid', Types.ObjectId)
    @param('level', Types.Range(['1', '2', '3']), true)
    async get(domainId: string, tid: ObjectId, level = '1') {
        const minLevel = Math.max(1, Math.min(3, Math.floor(Number(level) || 1)));
        // projection keeps the payload lean: buildGraph only needs the fields
        // below (not rids / langs / codeHashes)
        const pairs = await collPair.find(
            { domainId, tid },
            { projection: { pid: 1, uid1: 1, uid2: 1, similarity: 1, level: 1 } },
        ).sort({ similarity: -1 }).limit(20000).toArray();
        const uids = Array.from(new Set(pairs.flatMap((p) => [p.uid1, p.uid2])));
        const pids = Array.from(new Set(pairs.map((p) => p.pid)));
        const [udict, pdict] = await Promise.all([
            UserModel.getListForRender(domainId, uids, false),
            ProblemModel.getList(domainId, pids, true, false),
        ]);
        this.response.body = buildGraph(
            pairs, udict, pdict, minLevel as 1 | 2 | 3,
            (pairId) => this.url('domain_sim_diff', { tid, pairId: new ObjectId(pairId) }),
        );
    }
}

/**
 * One-shot, read-only diagnostics for a contest's similarity state: the
 * report state machine, the schedule queue, what a scan would collect and
 * the fingerprint cache. Paste target for "scan finds nothing / stuck"
 * reports — every layer in one JSON payload.
 */
export class SimDebugHandler extends SimBaseHandler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const cfg = readConfig(this.ctx);
        const [tdoc, reports, tasks, rdocs] = await Promise.all([
            ContestModel.get(domainId, tid),
            collReport.find({ domainId, tid }).sort({ createdAt: -1 }).limit(10).toArray(),
            this.ctx.db.collection('schedule').find({
                subType: { $in: ['sim.scan', 'sim.scan.precheck', 'sim.sweep'] },
                $or: [{ domainId }, { domainId: { $exists: false } }],
            }).sort({ _id: -1 }).limit(20).toArray(),
            RecordModel.getMulti(domainId, { contest: tid })
                .project({ pid: 1, uid: 1, lang: 1, code: 1, files: 1 }).toArray(),
        ]);
        // what each mode would collect from these records
        const latest = new Map<string, any>();
        const users = new Set<number>();
        const perPid = new Map<number, number>();
        const langs = new Map<string, number>();
        let noSource = 0;
        for (const rdoc of rdocs) {
            const key = `${rdoc.uid}:${rdoc.pid}`;
            if (!latest.has(key)) latest.set(key, rdoc); // _id desc not sorted here; set-unique per pair is close enough for diagnostics
            users.add(rdoc.uid);
            perPid.set(rdoc.pid, (perPid.get(rdoc.pid) ?? 0) + 1);
            const l = String(rdoc.lang || '?');
            langs.set(l, (langs.get(l) ?? 0) + 1);
            if (!rdoc.code && !rdoc.files?.code) noSource++;
        }
        const ridHexes = Array.from(latest.values(), (r) => r._id as ObjectId);
        const fpDocs = await collFp.find({ rid: { $in: ridHexes } })
            .project({ k: 1, schema: 1 }).toArray();
        this.response.body = {
            now: new Date().toISOString(),
            contest: tdoc ? {
                tid: String(tid), title: tdoc.title, rule: tdoc.rule,
                beginAt: tdoc.beginAt, endAt: tdoc.endAt,
                done: ContestModel.isDone(tdoc), pids: tdoc.pids?.length,
            } : null,
            effectiveConfig: cfg,
            records: {
                total: rdocs.length,
                distinctUsers: users.size,
                latestModeSubmissions: latest.size,
                perPid: Object.fromEntries(perPid),
                langs: Object.fromEntries(langs),
                noReadableSource: noSource,
            },
            fingerprintCache: {
                docs: fpDocs.length,
                reusable: fpDocs.filter((d) => d.k === cfg.k && d.schema === FP_SCHEMA).length,
            },
            reports: reports.map((r) => ({
                _id: String(r._id), status: r.status, mode: r.mode,
                createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt,
                lockedAt: r.lockedAt, progress: r.progress, stats: r.stats ?? null,
                error: r.error ?? null, lastError: r.lastError ?? null,
                attempts: r.attempts ?? null, runId: r.runId ? String(r.runId) : null,
                triggeredBy: r.triggeredBy, config: r.config,
            })),
            scheduleTasks: tasks.map((t) => ({
                _id: String(t._id), subType: t.subType, executeAfter: t.executeAfter,
                interval: t.interval ?? null, reportId: t.reportId ? String(t.reportId) : null,
            })),
        };
    }
}
