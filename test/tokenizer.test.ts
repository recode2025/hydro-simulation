import test from 'node:test';
import assert from 'node:assert/strict';
import { langFamily, tokenize, tokenText } from '../src/lib/tokenizer.ts';

const canon = (code: string, family: Parameters<typeof tokenize>[1]) => tokenText(tokenize(code, family));

test('langFamily maps known langs', () => {
    assert.equal(langFamily('cc.cc17o2'), 'c');
    assert.equal(langFamily('c'), 'c');
    assert.equal(langFamily('java'), 'c');
    assert.equal(langFamily('py'), 'python');
    assert.equal(langFamily('python3.11'), 'python');
    assert.equal(langFamily('pas'), 'pascal');
    assert.equal(langFamily('brainfk'), 'plain');
});

test('c: comments, includes and strings are stripped', () => {
    const a = `
#include <bits/stdc++.h>
using namespace std;
// fast io helper
int main() {
    /* block
       comment */
    string s = "hello \\"world\\"";
    printf("%d\\n", 42);
    return 0;
}`;
    const b = `
int main() {
    string q = 'x';
    int v = 7;
    printf("%d\\n", 7);
    return 0;
}`;
    // a and b differ structurally only by extra declarations; check canonical pieces
    const ca = canon(a, 'c');
    assert.ok(!ca.includes('bits'));
    assert.ok(!ca.includes('stdio'));
    assert.ok(!ca.includes('fast'));
    assert.ok(!ca.includes('block'));
    assert.ok(!ca.includes('hello'));
    assert.ok(!ca.includes('42'));
    assert.ok(ca.split('\n').includes('V')); // `main` is an identifier -> V
    assert.equal(ca.split('\n').filter((t) => t === 'S').length, 2); // two string literals
    assert.ok(ca.split('\n').includes('N'));
});

test('c: rename/reformat/comment changes keep token stream identical', () => {
    const orig = `
#include <cstdio>
int main() {
    int n, sum = 0;
    scanf("%d", &n);
    for (int i = 1; i <= n; i++) sum += i * 2;
    printf("%d\\n", sum);
    return 0;
}`;
    const copied = `
// copied solution
int main ( ) {
   int   m ,  acc = 5 ;
   scanf ( "%d" , & m ) ;
   /* loop */
   for ( int j = 1 ; j <= m ; j ++ ) acc += j * 2 ;
   printf ( "%d\\n" , acc ) ;
   return 0 ;
}`;
    assert.equal(canon(orig, 'c'), canon(copied, 'c'));
});

test('python: comments, imports and docstrings stripped; rename-safe', () => {
    const orig = `
import sys
from collections import deque

def solve(n):
    """main solver"""
    # read input
    q = deque()
    for i in range(n):
        q.append(i * 3)
    return sum(q)

print(solve(int(input())))
`;
    const copied = `
def solver(m):
    'changed docstring'
    queue = deque()
    for j in range(m):
        queue.append(j * 3)
    return sum(queue)

print(solver(int(input())))
`;
    assert.ok(!canon(orig, 'python').includes('deque'));
    assert.ok(!canon(orig, 'python').includes('import'));
    assert.equal(canon(orig, 'python'), canon(copied, 'python'));
});

test('pascal: case-insensitive and comments stripped', () => {
    const orig = `
program Test;
uses crt;
var i, n: integer;
begin
  readln(n); { read n }
  for i := 1 to n do writeln(i * 2);
end.`;
    const copied = `
VAR j , m : INTEGER ;
BEGIN
  readln ( m ) ;
  for j := 1 to m do writeln ( j * 2 ) ;
END.`;
    assert.equal(canon(orig, 'pascal'), canon(copied, 'pascal'));
});

test('different algorithms produce different streams', () => {
    const a = `
int main() {
    int n; scanf("%d", &n);
    int f0 = 0, f1 = 1;
    for (int i = 0; i < n; i++) { int t = f0 + f1; f0 = f1; f1 = t; }
    printf("%d\\n", f0);
}`;
    const b = `
int main() {
    int n; scanf("%d", &n);
    int lo = 1, hi = n;
    while (lo < hi) { int mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid + 1; }
    printf("%d\\n", lo);
}`;
    assert.notEqual(canon(a, 'c'), canon(b, 'c'));
});

test('plain family still tokenizes structurally', () => {
    const s = 'let x = 10 # comment\nprint x';
    const out = tokenText(tokenize(s, 'plain'));
    assert.ok(out.includes('V'));
    assert.ok(out.includes('N'));
});

// ---- collectors (evidence side-channel) ----

test('collectors: ident fires for non-keywords with correct token index', () => {
    const idents: [string, number][] = [];
    const tokens = tokenize('int foo = bar + 1;', 'c', {
        ident: (w, i) => idents.push([w, i]),
    });
    const names = idents.map(([w]) => w);
    assert.deepEqual(names, ['foo', 'bar']);
    // the reported index must be where the V token actually landed
    for (const [w, i] of idents) {
        assert.equal(tokens[i].k, 'ph');
        assert.equal(tokens[i].v, 'V');
        void w;
    }
});

test('collectors: keywords are NOT reported as idents', () => {
    const idents: string[] = [];
    tokenize('int main() { return 0; }', 'c', { ident: (w) => idents.push(w) });
    assert.deepEqual(idents, ['main']); // int/return are keywords
});

test('collectors: comments captured for c, python and pascal', () => {
    const c: string[] = [];
    tokenize('int a; // line note\n/* block note */', 'c', { comment: (r) => c.push(r) });
    assert.equal(c.length, 2);
    assert.ok(c[0].includes('line note'));
    assert.ok(c[1].includes('block note'));

    const p: string[] = [];
    tokenize('x = 1  # py note\ndef f():\n    pass', 'python', { comment: (r) => p.push(r) });
    assert.equal(p.length, 1);
    assert.ok(p[0].includes('py note'));

    const s: string[] = [];
    tokenize('begin { pascal note } end.', 'pascal', { comment: (r) => s.push(r) });
    assert.equal(s.length, 1);
    assert.ok(s[0].includes('pascal note'));
});

test('collectors: token stream is IDENTICAL with and without collectors', () => {
    const code = `
#include <cstdio>
// a comment
int main() {
    /* block */
    int count = 0;
    for (int i = 0; i < 10; i++) count += i;
    printf("%d", count);
}`;
    const idents: string[] = [];
    const comments: string[] = [];
    const plain = tokenize(code, 'c');
    const hooked = tokenize(code, 'c', {
        ident: (w) => idents.push(w),
        comment: (raw) => comments.push(raw),
    });
    assert.equal(tokenText(plain), tokenText(hooked));
    assert.deepEqual(plain, hooked);
    // collectors actually fired
    assert.ok(idents.includes('count'));
    assert.ok(comments.length >= 2);
});

test('collectors: pascal idents are lowercased (set-friendly)', () => {
    const idents: string[] = [];
    tokenize('Var Count: Integer;', 'pascal', { ident: (w) => idents.push(w) });
    assert.deepEqual(idents, ['count']);
});
