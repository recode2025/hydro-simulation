import test from 'node:test';
import assert from 'node:assert/strict';
import {
    funcSimilarity, round4, seqSimilarity, sharedCommentCount, structSimilarity,
    tfidfSimilarity, varSimilarity,
} from '../src/lib/metrics.ts';
import { fnv32a } from '../src/lib/fingerprint.ts';

const h = (s: string) => fnv32a(s);
const arr = (xs: string[]) => new Uint32Array(xs.map(h));

test('seqSimilarity: identical -> 1', () => {
    const a = arr(['int', 'V', '(', ')', '{', 'return', 'N', ';', '}']);
    const r = seqSimilarity(a, a);
    assert.equal(r!.sim, 1);
    assert.equal(r!.lcs, a.length);
});

test('seqSimilarity: hand-computed LCS ratio', () => {
    // LCS(A,B) = x z -> 2*2/(3+3) = 2/3
    const a = arr(['x', 'y', 'z']);
    const b = arr(['z', 'x', 'z']);
    assert.equal(seqSimilarity(a, b)!.sim, 2 / 3);
});

test('seqSimilarity: insertion degrades monotonically', () => {
    const base = arr(['a', 'b', 'c', 'd', 'e', 'f']);
    const one = arr(['a', 'b', 'c', 'X', 'd', 'e', 'f']);
    const three = arr(['X', 'a', 'Y', 'b', 'c', 'Z', 'd', 'e', 'f']);
    const s0 = seqSimilarity(base, base)!.sim;
    const s1 = seqSimilarity(base, one)!.sim;
    const s2 = seqSimilarity(base, three)!.sim;
    assert.ok(s1 < s0);
    assert.ok(s2 < s1);
});

test('seqSimilarity: empty or over-cap -> null', () => {
    assert.equal(seqSimilarity(new Uint32Array(0), arr(['a'])), null);
    assert.equal(seqSimilarity(arr(['a']), new Uint32Array(0)), null);
    const big = new Uint32Array(3000).fill(1);
    const big2 = new Uint32Array(3000).fill(2);
    assert.equal(seqSimilarity(big, big2, 4_000_000), null); // 9M cells > cap
});

test('tfidfSimilarity: same doc -> 1, disjoint terms -> 0-ish', () => {
    const tf = new Map([['for', 3], ['int', 5]]);
    const df = new Map([['for', 1], ['int', 1]]);
    assert.equal(tfidfSimilarity(tf, tf, df, 1), 1);
    const other = new Map([['while', 2]]);
    const df2 = new Map([['for', 1], ['int', 1], ['while', 1]]);
    assert.equal(tfidfSimilarity(tf, other, df2, 2), 0);
});

test('tfidfSimilarity: rare terms outweigh ubiquitous ones', () => {
    // doc A and B share a RARE term r (df=1 of 10) and a ubiquitous term u (df=10)
    // sharing only r should beat sharing only u
    const nDocs = 10;
    const onlyRareA = new Map([['r', 1], ['x', 1]]);
    const onlyRareB = new Map([['r', 1], ['y', 1]]);
    const onlyUbA = new Map([['u', 1], ['x', 1]]);
    const onlyUbB = new Map([['u', 1], ['y', 1]]);
    const df = new Map([['r', 1], ['u', 10], ['x', 5], ['y', 5]]);
    const rareSim = tfidfSimilarity(onlyRareA, onlyRareB, df, nDocs)!;
    const ubSim = tfidfSimilarity(onlyUbA, onlyUbB, df, nDocs)!;
    assert.ok(rareSim > ubSim, `rare ${rareSim} should beat ubiquitous ${ubSim}`);
});

test('varSimilarity: identical distinctive sets -> 1 after stoplist', () => {
    const a = ['i', 'n', 'dijkstra', 'priorityQueue', 'shortestPath'];
    assert.equal(varSimilarity(a, a), 1);
    // stoplist-only -> null
    assert.equal(varSimilarity(['i', 'j', 'n'], ['x', 'y']), null);
});

test('varSimilarity: disjoint distinctive sets -> 0', () => {
    assert.equal(varSimilarity(['dijkstra', 'heap'], ['bellman', 'queue']), 0);
});

test('varSimilarity: half overlap hand-computed', () => {
    // distinctive A = {alpha, beta}, B = {alpha, gamma} -> 2*1/(2+2) = 0.5
    assert.equal(varSimilarity(['alpha', 'beta', 'i'], ['alpha', 'gamma', 'j']), 0.5);
});

test('funcSimilarity: hand-computed weighted match', () => {
    // A: two bodies len 10 & 30; B: one body len 30 matching the big one
    // matched = 30 -> 2*30/(40+30)
    const fa = [
        { name: 'small', len: 10, hash: 1 },
        { name: 'big', len: 30, hash: 2 },
    ];
    const fb = [{ name: 'big', len: 30, hash: 2 }];
    assert.equal(funcSimilarity(fa, fb), 60 / 70);
});

test('funcSimilarity: nothing shared -> 0; both empty -> null', () => {
    assert.equal(funcSimilarity(
        [{ name: 'a', len: 5, hash: 1 }],
        [{ name: 'b', len: 5, hash: 2 }],
    ), 0);
    assert.equal(funcSimilarity([], []), null);
    // one side empty -> 0 (not null): the pair exists but shares no functions
    assert.equal(funcSimilarity([{ name: 'a', len: 5, hash: 1 }], []), 0);
});

test('structSimilarity: parallel vectors -> 1, orthogonal -> 0', () => {
    assert.equal(structSimilarity([1, 2, 3], [2, 4, 6]), 1);
    assert.equal(structSimilarity([1, 0, 0], [0, 1, 0]), 0);
    assert.equal(structSimilarity([0, 0], [1, 1]), null); // zero norm
});

test('sharedCommentCount: two-pointer intersection', () => {
    const a = new Uint32Array([1, 3, 5, 7, 9]).sort();
    const b = new Uint32Array([3, 4, 7, 10]);
    assert.equal(sharedCommentCount(a, b), 2);
    assert.equal(sharedCommentCount(new Uint32Array(0), b), 0);
    assert.equal(sharedCommentCount(a, a), a.length);
});

test('round4', () => {
    assert.equal(round4(0.123456), 0.1235);
    assert.equal(round4(1), 1);
});
