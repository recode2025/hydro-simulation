import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserSummary } from '../src/lib/userSummary.ts';
import type { PairDoc } from '../src/model.ts';

const pair = (over: Partial<PairDoc>): PairDoc => ({
    _id: {} as any,
    domainId: 'd',
    tid: {} as any,
    reportId: {} as any,
    pid: 1,
    uid1: 10,
    uid2: 20,
    rid1: {} as any,
    rid2: {} as any,
    lang1: 'cc',
    lang2: 'cc',
    similarity: 0.8,
    level: 2,
    common: 100,
    createdAt: new Date(),
    ...over,
}) as PairDoc;

test('buildUserSummary: counts by level and max sim', () => {
    const pairs = [
        pair({ uid1: 10, uid2: 20, level: 3, similarity: 0.99, pid: 1 }),
        pair({ uid1: 30, uid2: 10, level: 2, similarity: 0.8, pid: 1 }), // we are uid2
        pair({ uid1: 30, uid2: 40, level: 1, similarity: 0.6, pid: 2 }), // not ours
    ];
    const s = buildUserSummary(pairs, 10);
    assert.equal(s.total, 2);
    assert.equal(s.l3, 1);
    assert.equal(s.l2, 1);
    assert.equal(s.l1, 0);
    assert.equal(s.maxSim, 0.99);
});

test('buildUserSummary: per-problem rollup with partners', () => {
    const pairs = [
        pair({ uid1: 10, uid2: 20, pid: 1 }),
        pair({ uid1: 10, uid2: 30, pid: 1 }),
        pair({ uid1: 40, uid2: 10, pid: 2 }),
    ];
    const s = buildUserSummary(pairs, 10);
    assert.equal(s.perProblem.length, 2);
    const p1 = s.perProblem.find((p) => p.pid === 1)!;
    assert.equal(p1.count, 2);
    assert.equal(p1.partners, 2);
    const p2 = s.perProblem.find((p) => p.pid === 2)!;
    assert.equal(p2.partners, 1);
    // busiest first
    assert.equal(s.perProblem[0].pid, 1);
});

test('buildUserSummary: flags come from THIS user\'s side only', () => {
    const pairs = [
        pair({
            uid1: 10, uid2: 20,
            flags1: ['freopen'],   // ours (uid1)
            flags2: ['system'],    // theirs
        }),
        pair({
            uid1: 30, uid2: 10,
            flags1: ['fopen'],     // theirs (we are uid2)
            flags2: ['freopen'],   // ours
        }),
    ];
    const s = buildUserSummary(pairs, 10);
    assert.deepEqual(s.flags, ['freopen']);
});

test('buildUserSummary: shared comment pairs counted', () => {
    const pairs = [
        pair({ uid1: 10, uid2: 20, sharedComments: 3 }),
        pair({ uid1: 10, uid2: 30, sharedComments: 0 }),
    ];
    const s = buildUserSummary(pairs, 10);
    assert.equal(s.sharedCommentPairs, 1);
});

test('buildUserSummary: empty input', () => {
    const s = buildUserSummary([], 10);
    assert.equal(s.total, 0);
    assert.deepEqual(s.flags, []);
    assert.deepEqual(s.perProblem, []);
});
