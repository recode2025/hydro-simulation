/**
 * Persistence layer for the similarity plugin.
 *
 * Collections:
 *  - sim.report       one detection run per contest (status machine below)
 *  - sim.pair         one detected similar pair (uid1 < uid2), level >= 1
 *  - sim.fingerprint  per-rid k-gram fingerprint cache (document cache)
 *
 * Report status machine: waiting -> running -> done | failed
 * All transitions are CAS (updateOne with status precondition) so double
 * triggers / crashed workers cannot run the same contest twice.
 */

import { db } from 'hydrooj';
import type { Context } from 'hydrooj';
import { ObjectId } from 'mongodb';
import type { Collection } from 'mongodb';

export interface ReportDoc {
    _id: ObjectId;
    domainId: string;
    tid: ObjectId;
    title: string;
    rule: string;
    beginAt: Date;
    endAt: Date;
    status: 'waiting' | 'running' | 'done' | 'failed';
    progress: { total: number; processed: number };
    stats?: {
        users: number; submissions: number; skipped: number;
        pairs: number; l1: number; l2: number; l3: number;
    };
    mode: 'latest' | 'all';
    config: { k: number; minTokens: number; thresholds: { identical: number; high: number; suspected: number } };
    triggeredBy: number;
    error?: string;
    createdAt: Date;
    startedAt?: Date;
    finishedAt?: Date;
    lockedAt?: Date;
}

export interface PairDoc {
    _id: ObjectId;
    domainId: string;
    tid: ObjectId;
    reportId: ObjectId;
    pid: number;
    uid1: number;
    uid2: number;
    rid1: ObjectId;
    rid2: ObjectId;
    lang1: string;
    lang2: string;
    similarity: number;
    level: 1 | 2 | 3;
    common: number;
    createdAt: Date;
}

export interface FingerprintDoc {
    _id: ObjectId;
    rid: ObjectId;
    domainId: string;
    codeHash: string;
    lang: string;
    k: number;
    tokenCount: number;
    hashes: Buffer;
}

// The `db` export proxies to app.get('db'), which is undefined until the mongo
// service starts — and addons get imported before that. Resolving the
// collections lazily (on first method call, always long after startup) keeps
// the plugin loadable regardless of service order.
const lazyColl = <T>(name: string): Collection<T> => new Proxy({} as Collection<T>, {
    get: (_, prop) => (db as any).collection(name)[prop],
});
const collReport = lazyColl<ReportDoc>('sim.report');
const collPair = lazyColl<PairDoc>('sim.pair');
const collFp = lazyColl<FingerprintDoc>('sim.fingerprint');

export { collPair, collFp, collReport };

/**
 * True for driver errors meaning "db briefly unavailable" (mongod restarting,
 * network blip, client closing). These are transient: callers should retry /
 * requeue instead of permanently failing a report.
 */
export function isTransientDbError(e: unknown): boolean {
    const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return /MongoNotConnected|must be connected|MongoNetwork|MongoTimeout|TopologyClosed|ServerSelection|pool destroyed/i.test(s);
}

export async function ensureIndexes(ctx: Context) {
    await ctx.db.ensureIndexes(
        collFp as any,
        { name: 'rid', key: { rid: 1 }, unique: true },
        { name: 'codeHash', key: { codeHash: 1 } },
    );
    await ctx.db.ensureIndexes(
        collReport as any,
        { name: 'domainId_tid_createdAt', key: { domainId: 1, tid: 1, createdAt: -1 } },
        { name: 'domainId_status_lockedAt', key: { domainId: 1, status: 1, lockedAt: 1 } },
    );
    await ctx.db.ensureIndexes(
        collPair as any,
        { name: 'domainId_tid_level_similarity', key: { domainId: 1, tid: 1, level: -1, similarity: -1 } },
        { name: 'domainId_tid_pid_similarity', key: { domainId: 1, tid: 1, pid: 1, similarity: -1 } },
        { name: 'reportId', key: { reportId: 1 } },
    );
}

/** Create a waiting report; null when one is already waiting/running (idempotent). */
export async function createReport(base: Omit<ReportDoc, '_id' | 'status' | 'progress' | 'createdAt'>) {
    const active = await collReport.findOne({
        domainId: base.domainId, tid: base.tid, status: { $in: ['waiting', 'running'] },
    });
    if (active) return null;
    const doc: ReportDoc = {
        ...base,
        _id: new ObjectId(),
        status: 'waiting',
        progress: { total: 0, processed: 0 },
        createdAt: new Date(),
    } as ReportDoc;
    await collReport.insertOne(doc);
    return doc._id;
}

export function getLatestReport(domainId: string, tid: ObjectId) {
    return collReport.findOne({ domainId, tid }, { sort: { createdAt: -1 } });
}

/** Latest report per tid for a batch (single query + JS reduce). */
export async function getLatestReportMap(domainId: string, tids: ObjectId[]) {
    const docs = await collReport.find({ domainId, tid: { $in: tids } }, { sort: { createdAt: -1 } }).toArray();
    const map: Record<string, ReportDoc> = {};
    for (const d of docs) {
        const key = d.tid.toHexString();
        if (!map[key]) map[key] = d;
    }
    return map;
}

export function casStatus(
    reportId: ObjectId, from: ReportDoc['status'], to: ReportDoc['status'], extra: Record<string, any> = {},
) {
    return collReport.updateOne(
        { _id: reportId, status: from },
        { $set: { status: to, lockedAt: new Date(), ...extra } },
    ).then((r) => r.modifiedCount === 1);
}

export function heartbeat(reportId: ObjectId) {
    return collReport.updateOne({ _id: reportId, status: 'running' }, { $set: { lockedAt: new Date() } }).then(() => { });
}

export function setProgress(reportId: ObjectId, processed: number, total: number) {
    return collReport.updateOne(
        { _id: reportId, status: 'running' },
        { $set: { 'progress.processed': processed, 'progress.total': total } },
    ).then(() => { });
}

export function failReport(reportId: ObjectId, error: string) {
    return collReport.updateOne(
        { _id: reportId },
        { $set: { status: 'failed', error, finishedAt: new Date() } },
    ).then(() => { });
}

export function finishReport(reportId: ObjectId, stats: ReportDoc['stats']) {
    return collReport.updateOne(
        { _id: reportId },
        { $set: { status: 'done', stats, finishedAt: new Date() } },
    ).then(() => { });
}

export function upsertFingerprint(fp: Omit<FingerprintDoc, '_id'>) {
    return collFp.updateOne(
        { rid: fp.rid },
        { $set: { ...fp } },
        { upsert: true },
    ).then(() => { });
}

export async function getFingerprintMap(rids: ObjectId[]) {
    const docs = await collFp.find({ rid: { $in: rids } }).toArray();
    const map = new Map<string, FingerprintDoc>();
    for (const d of docs) map.set(d.rid.toHexString(), d);
    return map;
}

export async function insertPairs(docs: Omit<PairDoc, '_id'>[]) {
    for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500).map((d) => ({ ...d, _id: new ObjectId() }));
        if (chunk.length) await collPair.insertMany(chunk, { ordered: false });
    }
}

export function deleteContestData(domainId: string, tid: ObjectId) {
    return Promise.all([
        collPair.deleteMany({ domainId, tid }),
        collReport.deleteMany({ domainId, tid }),
    ]);
}

export function deleteDomainData(domainId: string) {
    return Promise.all([
        collPair.deleteMany({ domainId }),
        collReport.deleteMany({ domainId }),
        collFp.deleteMany({ domainId }),
    ]);
}
