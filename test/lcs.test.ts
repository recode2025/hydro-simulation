import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff, splitLines } from '../src/lib/lcs.ts';

test('splitLines normalizes CRLF', () => {
    assert.deepEqual(splitLines('a\r\nb\nc'), ['a', 'b', 'c']);
});

test('lineDiff marks insert/delete/equal', () => {
    const rows = lineDiff(
        ['int a = 1;', 'int b = 2;', 'sum();'],
        ['int a = 1;', 'int c = 3;', 'sum();', 'print();'],
    )!;
    assert.ok(rows.some((r) => r.type === 'eq' && r.l === 1 && r.r === 1));
    assert.ok(rows.some((r) => r.type === 'del' && r.l === 2));
    assert.ok(rows.some((r) => r.type === 'ins' && r.r === 2));
    assert.ok(rows.some((r) => r.type === 'ins' && r.r === 4));
    assert.ok(rows.every((r) => (r.type === 'ins') === (r.l === undefined)));
});

test('lineDiff is whitespace-insensitive', () => {
    const rows = lineDiff(['  int a;', '\tint b;'], ['int a;', 'int b;'])!;
    assert.ok(rows.every((r) => r.type === 'eq'));
});

test('lineDiff degrades to null over cell limit', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    assert.equal(lineDiff(a, a, 1_000_000), null);
});
