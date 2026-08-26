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
import { codeHash, dedupSorted, kgramHashes, pack, unpack } from './lib/fingerprint';
import { langFamily, tokenText } from './lib/tokenizer';
import {
    artifactsToFpFields, buildArtifacts, groupArtFromFpDoc, ridArtFromFpDoc,
} from './lib/artifacts';
import type { GroupArt, RidArt } from './lib/artifacts';
import {
    funcSimilarity, round4, seqSimilarity, sharedCommentCount, structSimilarity,
    tfidfSimilarity, varSimilarity,
} from './lib/metrics';
import type { PairDoc, ReportDoc } from './model';
import {
    FP_SCHEMA, collPair, collReport, failReport, finishReport, getFingerprintMap, heartbeat,
    insertPairs, isTransientDbError, requeueReport, setProgress, upsertFingerprint,
} from './model';

/** Thrown when a run-scoped write discovers this run no longer owns the
 *  report (swept as a zombie, requeued, force-reset). The run stops
 *  SILENTLY: no requeue, no fail — the replacement run owns the state. */
class SupersededError extends Error {
    constructor() {
        super('sim run superseded');
    }
}

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
    // 0 = never skip short code: k=8 k-grams already give tiny snippets an
    // effective floor (a stream shorter than k produces no fingerprints at
    // all -> dice 0), so an explicit length gate only hides real evidence.
    'sim.minTokens': 0,
    // pure safety valve against pathological pastes (not a realism limit)
    'sim.maxCodeSize': 1_048_576,
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

/** A "transient" db error that survives this many retries is not transient:
 *  fail the report (sweep/admin retry still applies) instead of queue-
 *  looping forever, which reads on the UI as stuck in 排队中 with no reason. */
const MAX_TRANSIENT_RETRIES = 5;

interface FpGroup {
    codeHash: string;
    fps: Uint32Array;
    tokenCount: number;
    /** group-invariant evidence artifacts (from the creating rid) */
    art: GroupArt;
    /** uid -> representative rid (first seen) */
    members: Map<number, { rid: ObjectId; lang: string }>;
}

export async function runDetection(ctx: Context, reportId: ObjectId) {
    const report = await collReport.findOne({ _id: reportId });
    if (!report || report.status !== 'running') {
        ctx.logger.warn(
            'sim runDetection %s: skipped (report %s)', reportId.toHexString(),
            report ? `status=${report.status}` : 'gone',
        );
        return;
    }
    ctx.logger.info(
        'sim runDetection %s: start (domain=%s tid=%s mode=%s)',
        reportId.toHexString(), report.domainId, report.tid.toHexString(), report.mode,
    );
    const startedAt = Date.now();
    // ownership token stamped by the claim: every write below carries it, so
    // once this run is superseded its writes stop matching and it aborts
    const runId = report.runId;
    let lastBeat = Date.now();
    /** Refresh lockedAt at most every 25s; abort when ownership is lost. */
    const maybeBeat = async () => {
        if (Date.now() - lastBeat <= 25_000) return;
        lastBeat = Date.now();
        if (!(await heartbeat(reportId, runId))) throw new SupersededError();
    };
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
            // newest submission per (uid, pid), taken straight from the record
            // collection. (The previous tsdoc.detail-based path depended on
            // the contest rule engine having recalculated status rids into
            // detail — when that had not happened the scan silently
            // collected ZERO submissions and the report read as "nothing
            // was scanned".)
            const rdocs = await RecordModel.getMulti(domainId, { contest: tid })
                .project({ code: 1, files: 1, lang: 1, uid: 1, pid: 1 })
                .sort({ _id: -1 }).toArray();
            const latest = new Map<string, any>(); // `${uid}:${pid}` -> rdoc
            for (const rdoc of rdocs) {
                const key = `${rdoc.uid}:${rdoc.pid}`;
                if (!latest.has(key)) latest.set(key, rdoc);
            }
            for (const rdoc of latest.values()) {
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
            // nothing collected: no record carries contest=tid for this
            // contest — log loudly so "no results" is debuggable
            ctx.logger.warn(
                'sim.scan %s: 0 submissions collected (mode=%s) — no record matches { contest: tid };'
                + ' verify submissions exist for this contest',
                tid.toHexString(), cfg.mode,
            );
        }
        if (!(await setProgress(reportId, 0, pids.length, runId))) throw new SupersededError();
        const pairDocs: Omit<PairDoc, '_id'>[] = [];

        for (let pi = 0; pi < pids.length; pi++) {
            const pid = pids[pi];
            const rdocs = byPid.get(pid)!;
            const fpCache = await getFingerprintMap(rdocs.map((r) => r._id));
            const groups = new Map<string, FpGroup>();
            // per-rid evidence artifacts (idents/comments/flags survive only
            // per submission — same-group members may differ, and that
            // difference IS the rename-evasion evidence)
            const ridArt = new Map<string, RidArt>();
            let processed = 0;
            for (const rdoc of rdocs) {
                const ridHex = rdoc._id.toHexString();
                let ch: string;
                let fps: Uint32Array;
                let tokenCount: number;
                let art: GroupArt | null = null;
                let rart: RidArt | null = null;
                const cached = fpCache.get(ridHex);
                if (cached && cached.k === cfg.k && cached.schema === FP_SCHEMA) {
                    ch = cached.codeHash;
                    fps = unpack(cached.hashes);
                    tokenCount = cached.tokenCount;
                    art = groupArtFromFpDoc(cached);
                    rart = ridArtFromFpDoc(cached);
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
                    const family = langFamily(rdoc.lang);
                    // one pass produces the token stream AND the evidence
                    // artifacts (collectors side-channel)
                    const da = buildArtifacts(code, family);
                    const tokens = da.tokens;
                    if (tokens.length < cfg.minTokens) {
                        stats.skippedShort++;
                        stats.skipped++;
                        continue;
                    }
                    ch = codeHash(tokenText(tokens));
                    fps = dedupSorted(kgramHashes(da.baseHashes, cfg.k));
                    tokenCount = tokens.length;
                    art = {
                        baseHashes: da.baseHashes, tf: da.tf, structVec: da.structVec,
                        funcs: da.funcs, family,
                    };
                    rart = {
                        idents: da.idents, commentHashes: da.commentHashes,
                        commentCount: da.commentCount, flags: da.flags,
                    };
                    // always cache: even when an identical normalized source was
                    // already grouped in this run, persisting lets the NEXT run
                    // skip fetch+tokenize for this rid entirely
                    await upsertFingerprint({
                        rid: rdoc._id, domainId, codeHash: ch, lang: rdoc.lang,
                        k: cfg.k, tokenCount, hashes: pack(fps),
                        ...artifactsToFpFields(da),
                    });
                }
                ridArt.set(ridHex, rart!);
                let group = groups.get(ch);
                if (!group) {
                    group = { codeHash: ch, fps, tokenCount, art: art!, members: new Map() };
                    groups.set(ch, group);
                }
                if (!group.members.has(rdoc.uid)) group.members.set(rdoc.uid, { rid: rdoc._id, lang: rdoc.lang });
                stats.submissions++;
                uids.add(rdoc.uid);
                if (++processed % 25 === 0) await yieldLoop();
                await maybeBeat();
            }

            // ---- pairwise dice via group pairs ----
            // tf-idf document frequency over DISTINCT normalized sources
            // (groups), so duplicated submissions cannot inflate df
            const df = new Map<string, number>();
            for (const g of groups.values()) {
                for (const term of g.art.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
            }
            const nDocs = groups.size;
            const list = Array.from(groups.values());
            for (let i = 0; i < list.length; i++) {
                for (let j = i; j < list.length; j++) {
                    // yield + heartbeat INSIDE the j sweep: with O(n·m) LCS
                    // evidence metrics one outer-i pass can block the event
                    // loop for minutes, heartbeats stop, and the sweep
                    // misjudges this live run as a zombie — flipping it back
                    // to "waiting" at (or right after) 100% progress
                    if ((j - i) % 32 === 31) {
                        await yieldLoop();
                        await maybeBeat();
                    }
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
                    // ---- evidence metrics (group pair, computed once) ----
                    let mSeq: number | null = null;
                    let mTf: number | null = null;
                    let mSt: number | null = null;
                    let mFu: number | null = null;
                    if (stats.pairs < MAX_PAIRS_PER_REPORT) {
                        if (i === j || g1.codeHash === g2.codeHash) {
                            // identical normalized streams: every derived
                            // metric is 1 by construction (skip the work)
                            mSeq = 1;
                            mTf = 1;
                            mSt = 1;
                            mFu = 1;
                        } else {
                            mSeq = seqSimilarity(g1.art.baseHashes, g2.art.baseHashes)?.sim ?? null;
                            mTf = tfidfSimilarity(g1.art.tf, g2.art.tf, df, nDocs);
                            mSt = structSimilarity(g1.art.structVec, g2.art.structVec);
                            // function bodies only compare within a language
                            // family — cross-family 0 would be misleading
                            mFu = g1.art.family === g2.art.family
                                ? funcSimilarity(g1.art.funcs, g2.art.funcs) : null;
                        }
                    }
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
                            // per-rid evidence: same-group members may have
                            // renamed variables / different comments
                            const ea = ridArt.get(ra.rid.toHexString())!;
                            const eb = ridArt.get(rb.rid.toHexString())!;
                            pairDocs.push({
                                domainId, tid, reportId, pid,
                                uid1: a, uid2: b, rid1: ra.rid, rid2: rb.rid,
                                lang1: ra.lang, lang2: rb.lang,
                                similarity: Math.round(sim * 10000) / 10000,
                                level, common, createdAt: new Date(),
                                simSeq: mSeq === null ? null : round4(mSeq),
                                simTfidf: mTf === null ? null : round4(mTf),
                                simVar: (() => {
                                    const v = varSimilarity(ea.idents, eb.idents);
                                    return v === null ? null : round4(v);
                                })(),
                                simFunc: mFu === null ? null : round4(mFu),
                                simStruct: mSt === null ? null : round4(mSt),
                                sharedComments: sharedCommentCount(ea.commentHashes, eb.commentHashes),
                                flags1: ea.flags.length ? ea.flags : undefined,
                                flags2: eb.flags.length ? eb.flags : undefined,
                            });
                            stats.pairs++;
                            stats[`l${level}` as 'l1' | 'l2' | 'l3']++;
                        }
                    }
                }
                await yieldLoop();
                await maybeBeat();
            }
            if (!(await setProgress(reportId, pi + 1, pids.length, runId))) throw new SupersededError();
            if (pairDocs.length >= 2000) {
                await insertPairs(pairDocs.splice(0, pairDocs.length));
            }
        }
        // final flush: refresh the lock first — insertMany of the tail (up to
        // 2000 docs in 500-doc chunks) happens AFTER the last progress write
        // and must never read as a stale lock to the sweep
        if (!(await heartbeat(reportId, runId))) throw new SupersededError();
        lastBeat = Date.now();
        if (pairDocs.length) await insertPairs(pairDocs);
        stats.users = uids.size;
        if (!(await finishReport(reportId, stats, runId))) throw new SupersededError();
        ctx.logger.info(
            'sim.scan done %s/%s in %dms, %d pairs (subs=%d skipped: short=%d big=%d empty=%d)',
            report.domainId, report.tid.toHexString(), Date.now() - startedAt, stats.pairs,
            stats.submissions, stats.skippedShort, stats.skippedBig, stats.skippedEmpty,
        );
    } catch (e) {
        if (e instanceof SupersededError) {
            // requeued / reset / replaced mid-flight: stop quietly, the
            // replacement (or the queue) owns the report now
            ctx.logger.info(
                'sim.scan %s superseded mid-run, aborting this attempt', reportId.toHexString(),
            );
            return;
        }
        ctx.logger.error('sim.scan failed for report %s', reportId.toHexString());
        ctx.logger.error(e);
        if (isTransientDbError(e)) {
            // mongo blip (restart / network): do NOT permanently fail the
            // report — put it back to waiting and requeue a retry
            try {
                const attempts = (report.attempts ?? 0) + 1;
                const msg = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 1000);
                if (attempts >= MAX_TRANSIENT_RETRIES) {
                    // persistent "transient" errors looped the queue long
                    // enough — surface the reason and stop retrying
                    if (await failReport(reportId, `${msg} (gave up after ${attempts} retries)`, runId)) {
                        ctx.logger.error(
                            'sim.scan %s: transient retry cap reached, failing', reportId.toHexString(),
                        );
                    }
                    return;
                }
                // progress resets inside requeueReport, so the retried run
                // reads as a fresh scan instead of a finished bar + Waiting;
                // lastError records WHY it keeps requeueing (error used to be
                // swallowed into the log, leaving a queue that never drained)
                if (!(await requeueReport(reportId, runId, { lastError: msg, attempts }))) {
                    return; // superseded elsewhere
                }
                // drop tasks from earlier requeues first: each requeue adding
                // another delayed task stacks duplicates (CAS makes the extra
                // claims no-ops, but the queue fills with junk)
                await ScheduleModel.deleteMany({ type: 'schedule', subType: 'sim.scan', reportId });
                await ScheduleModel.add({
                    type: 'schedule', subType: 'sim.scan',
                    domainId: report.domainId, tid: report.tid, reportId,
                    executeAfter: new Date(Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 15 * 60_000)),
                });
                ctx.logger.info(
                    'sim.scan %s requeued after transient db error (attempt %d): %s',
                    reportId.toHexString(), attempts, msg,
                );
                return;
            } catch (e2) {
                ctx.logger.error(e2);
            }
        }
        try {
            await failReport(reportId, String(e), runId);
        } catch { /* db unavailable — hourly sweep recovery will pick it up */ }
    }
}

export type { ReportDoc };
