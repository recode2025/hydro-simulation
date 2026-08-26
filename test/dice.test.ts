import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classify, classifyPair, diceCoeff, histogramMedian, LEX_GATE_IDENTICAL,
    VAR_GATE_IDENTICAL, VAR_GATE_TRIVIAL_IDENTICAL,
} from '../src/lib/dice.ts';

const T = { identical: 0.95, high: 0.75, suspected: 0.55 };

test('dice: identical sets -> 1', () => {
    const a = Uint32Array.from([1, 2, 3, 4, 5]);
    assert.equal(diceCoeff(a, a).sim, 1);
});

test('dice: disjoint sets -> 0', () => {
    const a = Uint32Array.from([1, 2, 3]);
    const b = Uint32Array.from([4, 5, 6]);
    assert.equal(diceCoeff(a, b).sim, 0);
});

test('dice: hand computed value', () => {
    // {1,2,3,4} vs {2,3,4,5}: common=3 -> 2*3/8 = 0.75
    const a = Uint32Array.from([1, 2, 3, 4]);
    const b = Uint32Array.from([2, 3, 4, 5]);
    const { sim, common } = diceCoeff(a, b);
    assert.equal(common, 3);
    assert.ok(Math.abs(sim - 0.75) < 1e-12);
});

test('dice: empty set guard', () => {
    assert.equal(diceCoeff(new Uint32Array(0), Uint32Array.from([1])).sim, 0);
});

test('classify thresholds (defaults not too high)', () => {
    assert.equal(classify(1.0, T), 3);
    assert.equal(classify(0.95, T), 3);
    assert.equal(classify(0.949, T), 2);
    assert.equal(classify(0.75, T), 2);
    assert.equal(classify(0.749, T), 1);
    assert.equal(classify(0.55, T), 1);
    assert.equal(classify(0.549, T), 0);
});

test('dice is symmetric and size-handles unbalanced docs', () => {
    const big = Uint32Array.from(Array.from({ length: 1000 }, (_, i) => i * 2));
    const small = Uint32Array.from([2, 4, 6, 8]);
    const d1 = diceCoeff(big, small).sim;
    const d2 = diceCoeff(small, big).sim;
    assert.equal(d1, d2);
    // small fully contained: 2*4/(1000+4)
    assert.ok(Math.abs(d1 - 8 / 1004) < 1e-12);
});

// ---- classifyPair (two-channel gating) ----

test('classifyPair: pure rename downgrades identical -> high', () => {
    // structure fully matches (dice 1.0) but both name channels disagree —
    // the exact case the old single-channel classify mislabeled "identical"
    assert.equal(classifyPair(1.0, 0.2, 0.1, false, T), 2);
    assert.equal(classifyPair(0.99, 0.1, 0, false, T), 2);
});

test('classifyPair: identical requires name evidence from either channel', () => {
    assert.equal(classifyPair(1.0, 0.9, null, false, T), 3); // lexical channel
    assert.equal(classifyPair(1.0, null, 0.7, false, T), 3); // identifier channel
    assert.equal(classifyPair(1.0, LEX_GATE_IDENTICAL, null, false, T), 3);
    assert.equal(classifyPair(1.0, null, VAR_GATE_IDENTICAL, false, T), 3);
    // both channels unavailable (sub-k streams): structure alone cannot say identical
    assert.equal(classifyPair(1.0, null, null, false, T), 2);
});

test('classifyPair: normal ladder unchanged below the identical gate', () => {
    assert.equal(classifyPair(0.9, 0, 0, false, T), 2);
    assert.equal(classifyPair(0.75, 0, 0, false, T), 2);
    assert.equal(classifyPair(0.55, 0, 0, false, T), 1);
    // name evidence never upgrades a structurally-low pair
    assert.equal(classifyPair(0.5, 1, 1, false, T), 0);
});

test('classifyPair: trivial problems rank entirely by the lexical channel', () => {
    // structure saturated (1.0) for the whole field — only names discriminate
    assert.equal(classifyPair(1.0, 0.97, 0.9, true, T), 3);
    assert.equal(classifyPair(1.0, 0.97, null, true, T), 3); // no distinctive idents: lex alone
    assert.equal(classifyPair(1.0, 0.97, VAR_GATE_TRIVIAL_IDENTICAL, true, T), 3);
    assert.equal(classifyPair(1.0, 0.97, 0.5, true, T), 2); // names kept, identifiers differ
    assert.equal(classifyPair(1.0, 0.8, 0.9, true, T), 2); // renamed
    assert.equal(classifyPair(1.0, 0.55, null, true, T), 1);
    assert.equal(classifyPair(1.0, 0.3, 0.3, true, T), 0); // not even suspected
    // lexical channel unavailable (stream < k): structure is the fallback
    assert.equal(classifyPair(0.8, null, null, true, T), 2);
});

// ---- histogramMedian (trivial-problem detection) ----

test('histogramMedian: odd count picks the middle bucket', () => {
    // 5 pairs: 0.60 0.80 0.80 0.80 0.90 -> median 0.80
    const h = new Uint32Array(101);
    h[60] = 1; h[80] = 3; h[90] = 1;
    assert.equal(histogramMedian(h, 5), 0.8);
});

test('histogramMedian: even count averages the two middle values', () => {
    // 4 pairs: 0.70 0.80 0.90 1.00 -> median (0.80+0.90)/2
    const h = new Uint32Array(101);
    h[70] = 1; h[80] = 1; h[90] = 1; h[100] = 1;
    assert.ok(Math.abs(histogramMedian(h, 4) - 0.85) < 1e-12);
});

test('histogramMedian: empty and saturated distributions', () => {
    assert.equal(histogramMedian(new Uint32Array(101), 0), 0);
    const h = new Uint32Array(101);
    h[100] = 25;
    assert.equal(histogramMedian(h, 25), 1);
});
