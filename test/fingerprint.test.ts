import test from 'node:test';
import assert from 'node:assert/strict';
import {
    codeHash, dedupSorted, fnv32a, kgramHashes, pack, unpack,
} from '../src/lib/fingerprint.ts';

test('fnv32a known values', () => {
    assert.equal(fnv32a(''), 0x811c9dc5);
    assert.equal(typeof fnv32a('a'), 'number');
    assert.ok(fnv32a('a') !== fnv32a('b'));
});

test('rolling k-gram matches naive polynomial recomputation', () => {
    const n = 200;
    const base = Array.from({ length: n }, (_, i) => fnv32a(`tok_${i % 37}`));
    const k = 8;
    const B = 16777619;
    const rolling = kgramHashes(base, k);
    assert.equal(rolling.length, n - k + 1);
    for (let j = 0; j + k <= n; j++) {
        let naive = 0;
        for (let i = 0; i < k; i++) naive = (Math.imul(naive, B) + base[j + i]) | 0;
        assert.equal(rolling[j], naive >>> 0, `window ${j}`);
    }
});

test('k larger than input yields empty fingerprint', () => {
    assert.equal(kgramHashes([1, 2, 3], 5).length, 0);
});

test('dedupSorted sorts and removes duplicates', () => {
    const out = dedupSorted(Uint32Array.from([5, 3, 5, 1, 3, 9, 1]));
    assert.deepEqual(Array.from(out), [1, 3, 5, 9]);
});

test('pack/unpack roundtrip', () => {
    const h = dedupSorted(kgramHashes([fnv32a('int'), fnv32a('main'), fnv32a('('), fnv32a(')'), fnv32a('{'), fnv32a('}')], 3));
    assert.deepEqual(Array.from(unpack(pack(h))), Array.from(h));
});

test('codeHash is stable and content-addressed', () => {
    assert.equal(codeHash('int\nmain'), codeHash('int\nmain'));
    assert.notEqual(codeHash('int\nmain'), codeHash('int\nmain2'));
});
