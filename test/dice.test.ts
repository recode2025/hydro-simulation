import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, diceCoeff } from '../src/lib/dice.ts';

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
