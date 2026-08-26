/**
 * Detection pipeline (runs off the worker loop via setImmediate).
 *
 * For one contest/homework:
 *  1. collect target records ('latest': scoring submission per (uid, pid) from
 *     tsdoc.detail; 'all': every record with contest == tid)
 *  2. per problem group: build fingerprints with the sim.fingerprint cache
 *     (rid hit + same k => no code read at all), collapsing identical
 *     normalized sources (same codeHash) into one fingerprint group
 *  3. pairwise Sorensen-Dice via inverted-index accumulation
 *  4. persist pairs (level >= suspected), stats, finish report
 *
 * The loop yields to the event loop between problems and between fingerprint
 * batches so HTTP/judge traffic on the same process stays healthy.
 */

import { ContestModel, RecordModel, ScheduleModel, StorageModel } from 'hydrooj';
import type { Context } from 'hydrooj';
import { ObjectId } from 'mongodb';
import { classify, diceCoeff } from './lib/dice';
import type { Thresholds } from './lib/dice';
import { codeHash, dedupSorted, fnv32a, kgramHashes, pack, unpack } from './lib/fingerprint';
import { langFamily, tokenText, tokenize } from './lib/tokenizer';
import type { PairDoc, ReportDoc } from './model';
import {
    collPair, collReport, failReport, finishReport, getFingerprintMap, heartbeat,
    insertPairs, isTransientDbError, setProgress, upsertFingerprint,
} from './model';
import { casStatus } from './model';

export interface DetectConfig {
    k: number;
    minTokens: number;
    maxCodeSize: number;
    mode: 'latest' | 'all';
    thresholds: Thresholds;
}

export interface SweepConfig extends DetectConfig {
    scope: 'contest' | 'homework' | 'both';
    autoScan: boolean;
    graceMinutes: number;
    sweepBatch: number;
    scanWindowDays: number;
}

const DEFAULTS = {
    'sim.threshold.identical': 0.95,
    'sim.threshold.high': 0.75,
    'sim.threshold.suspected': 0.55,
    'sim.kgram': 8,
    'sim.minTokens': 30,
    'sim.maxCodeSize': 131072,
    'sim.submissionMode': 'latest',
    'sim.scope': 'both',
    'sim.autoScan': true,
    'sim.graceMinutes': 10,
    'sim.sweepBatch': 5,
    'sim.scanWindowDays': 90,
    'sim.diffCellLimit': 4_000_000,
} as const;

export function readConfig(ctx: Context): SweepConfig {
    const get = (key: keyof typeof DEFAULTS) => {
        const v = ctx.setting.get(key);
        return v === undefined || v === null || v === '' ? DEFAULTS[key] : v;
    };
    const num = (key: keyof typeof DEFAULTS): number => {
        const n = Number(get(key));
        return Number.isFinite(n) && n !== 0 ? n : DEFAULTS[key] as number;
    };
    const mode = String(get('sim.submissionMode')) === 'all' ? 'all' : 'latest';
    const scopeRaw = String(get('sim.scope'));
    const scope = scopeRaw === 'contest' || scopeRaw === 'homework' ? scopeRaw : 'both';
    return {
        k: Math.max(2, Math.floor(num('sim.kgram'))),
        minTokens: Math.max(0, Math.floor(num('sim.minTokens'))),
        maxCodeSize: Math.max(1024, Math.floor(num('sim.maxCodeSize'))),
        mode,
        thresholds: {
            identical: num('sim.threshold.identical'),
            high: num('sim.threshold.high'),
            suspected: num('sim.threshold.suspected'),
        },
        scope,
        autoScan: get('sim.autoScan') !== false && get('sim.autoScan') !== 'false',
        graceMinutes: Math.max(1, Math.floor(num('sim.graceMinutes'))),
        sweepBatch: Math.max(1, Math.floor(num('sim.sweepBatch'))),
        scanWindowDays: Math.max(1, Math.floor(num('sim.scanWindowDays'))),
    };
}

export function diffCellLimit(ctx: Context) {
    return Number(ctx.setting.get('sim.diffCellLimit') ?? DEFAULTS['sim.diffCellLimit']) || DEFAULTS['sim.diffCellLimit'];
}

/** Fetch source text of a record: inline `code` or storage-backed files.code. */
export async function fetchCode(rdoc: any): Promise<string> {
    if (rdoc.files?.code) {
        const [id] = String(rdoc.files.code).split('#');
        if (!id) return '';
        try {
            const stream = await StorageModel.get(`submission/${id}`);
            if (!stream) return '';
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
                size += (chunk as Buffer).length;
                if (size > 64 * 1024 * 1024) break;
                chunks.push(chunk as Buffer);
            }
            return Buffer.concat(chunks).toString('utf-8');
        } catch {
            return '';
        }
    }
    return rdoc.code || '';
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/** Safety valve: pathological cases (hundreds of users sharing one template)
 *  would otherwise emit O(n^2) pairs for a single problem. */
const MAX_PAIRS_PER_REPORT = 50_000;

interface FpGroup {
    codeHash: string;
    fps: Uint32Array;
    tokenCount: number;
    /** uid -> representative rid (first seen) */
    members: Map<number, { rid: ObjectId; lang: string }>;
}

export async function runDetection(ctx: Context, reportId: ObjectId) {
    const report = await collReport.findOne({ _id: reportId });
    if (!report || report.status !== 'running') return;
    const startedAt = Date.now();
    let lastBeat = Date.now();
    // thresholds/mode are snapshotted in the report; size limit stays live
    const live = readConfig(ctx);
    const cfg: DetectConfig = {
        k: report.config.k,
        minTokens: report.config.minTokens,
        maxCodeSize: live.maxCodeSize,
        mode: report.mode,
        thresholds: report.config.thresholds,
    };
    const stats = {
        users: 0, submissions: 0, skipped: 0, pairs: 0, l1: 0, l2: 0, l3: 0,
        skippedShort: 0, skippedBig: 0, skippedEmpty: 0,
    };
    let pairCapLogged = false;
    const uids = new Set<number>();
    try {
        const { domainId, tid } = report;
        const tdoc = await ContestModel.get(domainId, tid);
        if (!ContestModel.isDone(tdoc)) throw new Error('contest not ended');

        // idempotent reruns: a requeued/recovered rerun of THIS report must not
        // duplicate pairs inserted by the previous attempt
        await collPair.deleteMany({ reportId });

        // ---- collect target rdocs, grouped by pid ----
        const byPid = new Map<number, any[]>();
        if (cfg.mode === 'latest') {
            const [, tsdocs] = await ContestModel.getAndListStatus(domainId, tid);
            const wanted = new Map<string, number>(); // ridHex -> uid
            for (const tsdoc of tsdocs || []) {
                for (const pid of Object.keys(tsdoc.detail || {})) {
                    const rid = tsdoc.detail[pid]?.rid;
                    if (rid) wanted.set(String(rid), tsdoc.uid);
                }
            }
            const rdocs = await RecordModel.getMulti(domainId, {
                _id: { $in: Array.from(wanted.keys()).map((r) => new ObjectId(r)) },
            }).project({ code: 1, files: 1, lang: 1, uid: 1, pid: 1 }).toArray();
            for (const rdoc of rdocs) {
                const uid = wanted.get(rdoc._id.toHexString());
                if (uid === undefined || rdoc.uid !== uid) continue;
                if (!byPid.has(rdoc.pid)) byPid.set(rdoc.pid, []);
                byPid.get(rdoc.pid)!.push(rdoc);
            }
        } else {
            const rdocs = await RecordModel.getMulti(domainId, { contest: tid })
                .project({ code: 1, files: 1, lang: 1, uid: 1, pid: 1 }).toArray();
            for (const rdoc of rdocs) {
                if (!byPid.has(rdoc.pid)) byPid.set(rdoc.pid, []);
                byPid.get(rdoc.pid)!.push(rdoc);
            }
        }

        const pids = Array.from(byPid.keys());
        if (!pids.length) {
            // nothing collected: nearly always means the rid extraction found
            // no scoring submissions — log loudly so "no results" is debuggable
            ctx.logger.warn(
                'sim.scan %s: 0 submissions collected (mode=%s) — no tsdoc.detail rids matched any record',
                tid.toHexString(), cfg.mode,
            );
        }
        await setProgress(reportId, 0, pids.length);
        const pairDocs: Omit<PairDoc, '_id'>[] = [];

        for (let pi = 0; pi < pids.length; pi++) {
            const pid = pids[pi];
            const rdocs = byPid.get(pid)!;
            const fpCache = await getFingerprintMap(rdocs.map((r) => r._id));
            const groups = new Map<string, FpGroup>();
            let processed = 0;
            for (const rdoc of rdocs) {
                const ridHex = rdoc._id.toHexString();
                let ch: string;
                let fps: Uint32Array;
                let tokenCount: number;
                const cached = fpCache.get(ridHex);
                if (cached && cached.k === cfg.k) {
                    ch = cached.codeHash;
                    fps = unpack(cached.hashes);
                    tokenCount = cached.tokenCount;
                } else {
                    const code = await fetchCode(rdoc);
                    if (!code) {
                        stats.skippedEmpty++;
                        stats.skipped++;
                        continue;
                    }
                    if (code.length > cfg.maxCodeSize) {
                        stats.skippedBig++;
                        stats.skipped++;
                        continue;
                    }
                    const tokens = tokenize(code, langFamily(rdoc.lang));
                    if (tokens.length < cfg.minTokens) {
                        stats.skippedShort++;
                        stats.skipped++;
                        continue;
                    }
                    ch = codeHash(tokenText(tokens));
                    const base = new Array<number>(tokens.length);
                    for (let t = 0; t < tokens.length; t++) base[t] = fnv32a(tokens[t].v);
                    fps = dedupSorted(kgramHashes(base, cfg.k));
                    tokenCount = tokens.length;
                    // always cache: even when an identical normalized source was
                    // already grouped in this run, persisting lets the NEXT run
                    // skip fetch+tokenize for this rid entirely
                    await upsertFingerprint({
                        rid: rdoc._id, domainId, codeHash: ch, lang: rdoc.lang,
                        k: cfg.k, tokenCount, hashes: pack(fps),
                    });
                }
                let group = groups.get(ch);
                if (!group) {
                    group = { codeHash: ch, fps, tokenCount, members: new Map() };
                    groups.set(ch, group);
                }
                if (!group.members.has(rdoc.uid)) group.members.set(rdoc.uid, { rid: rdoc._id, lang: rdoc.lang });
                stats.submissions++;
                uids.add(rdoc.uid);
                if (++processed % 25 === 0) await yieldLoop();
                if (Date.now() - lastBeat > 25_000) {
                    lastBeat = Date.now();
                    await heartbeat(reportId);
                }
            }

            // ---- pairwise dice via group pairs ----
            const list = Array.from(groups.values());
            for (let i = 0; i < list.length; i++) {
                for (let j = i; j < list.length; j++) {
                    const g1 = list[i];
                    const g2 = list[j];
                    let sim: number;
                    let common: number;
                    if (i === j) {
                        sim = 1;
                        common = g1.tokenCount;
                    } else if (g1.codeHash === g2.codeHash) {
                        sim = 1;
                        common = Math.min(g1.tokenCount, g2.tokenCount);
                    } else {
                        ({ sim, common } = diceCoeff(g1.fps, g2.fps));
                    }
                    const level = classify(sim, cfg.thresholds) as 1 | 2 | 3;
                    if (level < 1) continue;
                    for (const [uid1, m1] of g1.members) {
                        for (const [uid2, m2] of g2.members) {
                            if (uid1 === uid2) continue;
                            if (i === j && uid1 > uid2) continue; // same group: emit once
                            if (stats.pairs >= MAX_PAIRS_PER_REPORT) {
                                if (!pairCapLogged) {
                                    pairCapLogged = true;
                                    ctx.logger.warn(
                                        'sim.scan %s: pair cap %d reached, remaining pairs for this report are dropped',
                                        tid.toHexString(), MAX_PAIRS_PER_REPORT,
                                    );
                                }
                                continue;
                            }
                            const a = uid1 < uid2 ? uid1 : uid2;
                            const b = uid1 < uid2 ? uid2 : uid1;
                            const ra = uid1 < uid2 ? m1 : m2;
                            const rb = uid1 < uid2 ? m2 : m1;
                            pairDocs.push({
                                domainId, tid, reportId, pid,
                                uid1: a, uid2: b, rid1: ra.rid, rid2: rb.rid,
                                lang1: ra.lang, lang2: rb.lang,
                                similarity: Math.round(sim * 10000) / 10000,
                                level, common, createdAt: new Date(),
                            });
                            stats.pairs++;
                            stats[`l${level}` as 'l1' | 'l2' | 'l3']++;
                        }
                    }
                }
                await yieldLoop();
                // heartbeat here too: a long pairwise phase with no lockedAt
                // refresh made the sweep mistake the scan for a dead one and
                // flip it back to "waiting" mid-run
                if (Date.now() - lastBeat > 25_000) {
                    lastBeat = Date.now();
                    await heartbeat(reportId);
                }
            }
            await setProgress(reportId, pi + 1, pids.length);
            if (pairDocs.length >= 2000) {
                await insertPairs(pairDocs.splice(0, pairDocs.length));
            }
        }
        if (pairDocs.length) await insertPairs(pairDocs);
        stats.users = uids.size;
        await finishReport(reportId, stats);
        ctx.logger.info(
            'sim.scan done %s/%s in %dms, %d pairs (subs=%d skipped: short=%d big=%d empty=%d)',
            report.domainId, report.tid.toHexString(), Date.now() - startedAt, stats.pairs,
            stats.submissions, stats.skippedShort, stats.skippedBig, stats.skippedEmpty,
        );
    } catch (e) {
        ctx.logger.error('sim.scan failed for report %s', reportId.toHexString());
        ctx.logger.error(e);
        if (isTransientDbError(e)) {
            // mongo blip (restart / network): do NOT permanently fail the
            // report — put it back to waiting and requeue a retry
            try {
                await casStatus(reportId, 'running', 'waiting');
                await ScheduleModel.add({
                    type: 'schedule', subType: 'sim.scan',
                    domainId: report.domainId, tid: report.tid, reportId,
                    executeAfter: new Date(Date.now() + 60_000),
                });
                ctx.logger.info('sim.scan %s requeued after transient db error', reportId.toHexString());
                return;
            } catch (e2) {
                ctx.logger.error(e2);
            }
        }
        try {
            await failReport(reportId, String(e));
        } catch { /* db unavailable — hourly sweep recovery will pick it up */ }
    }
}

export type { ReportDoc };
