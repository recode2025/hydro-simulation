import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FP_SCHEMA, artifactsToFpFields, buildArtifacts, groupArtFromFpDoc,
    normalizeCommentLines, ridArtFromFpDoc, scanKeywordFlags, structVector,
} from '../src/lib/artifacts.ts';
import { unpack } from '../src/lib/fingerprint.ts';
import { tokenText, tokenize } from '../src/lib/tokenizer.ts';

test('scanKeywordFlags: flags freopen and friends', () => {
    const flags = scanKeywordFlags('int main(){freopen("in.txt","r",stdin);system("pause");}');
    assert.ok(flags.includes('freopen'));
    assert.ok(flags.includes('system'));
});

test('scanKeywordFlags: word boundary — freopenx does not flag', () => {
    assert.deepEqual(scanKeywordFlags('int freopenx = 1;'), []);
});

test('scanKeywordFlags: inside comments/strings still flags (by design)', () => {
    assert.ok(scanKeywordFlags('// maybe use fopen here').includes('fopen'));
});

test('scanKeywordFlags: sorted and unique', () => {
    const flags = scanKeywordFlags('fopen(); fopen(); system();');
    assert.deepEqual(flags, ['fopen', 'system']);
});

test('normalizeCommentLines: strips markers, drops short fragments', () => {
    const lines = normalizeCommentLines('// compute the answer\n/* cache lookup */\n// ok\n');
    assert.deepEqual(lines.filter((l) => l.length >= 4), lines);
    assert.ok(lines.some((l) => l.includes('compute the answer')));
    assert.ok(lines.some((l) => l.includes('cache lookup')));
    assert.ok(!lines.some((l) => l === 'ok')); // too short after strip
});

test('normalizeCommentLines: collapses internal whitespace', () => {
    const [line] = normalizeCommentLines('// foo    bar\t\tbaz');
    assert.equal(line, 'foo bar baz');
});

const C_CODE = `
#include <bits/stdc++.h>
using namespace std;
// dijkstra main loop
void relax(int u) {
    dist[u] = min(dist[u], dist[u] + 1);
}
void dijkstra(int start) {
    priority_queue<int> pq;
    pq.push(start);
    while (!pq.empty()) {
        int u = pq.top(); pq.pop();
        relax(u);
    }
}
void declaredOnly(int x);
int main() {
    dijkstra(1);
    if (dist[1] < 100) { return 0; }
    return 1;
}
`;

test('buildArtifacts: extracts c functions, skips declarations', () => {
    const a = buildArtifacts(C_CODE, 'c');
    const names = a.funcs.map((f) => f.name);
    assert.ok(names.includes('relax'));
    assert.ok(names.includes('dijkstra'));
    assert.ok(names.includes('main'));
    assert.ok(!names.includes('declaredOnly')); // no body -> skipped
    assert.ok(!a.funcs.some((f) => f.name === 'if')); // control kw never a func
});

test('buildArtifacts: function body hash is rename-invariant', () => {
    const renamed = C_CODE
        .replace(/void relax/g, 'void applyRelaxation')
        .replace(/relax\(/g, 'applyRelaxation(');
    const a1 = buildArtifacts(C_CODE, 'c');
    const a2 = buildArtifacts(renamed, 'c');
    const byName = (a: typeof a1, n: string) => a.funcs.find((f) => f.name === n);
    const relax1 = byName(a1, 'relax')!;
    const relax2 = byName(a2, 'applyRelaxation')!;
    assert.equal(relax1.hash, relax2.hash);
    assert.equal(relax1.len, relax2.len);
});

test('buildArtifacts: python def bodies extracted by indentation', () => {
    const py = `def solve(n):
    total = 0
    for i in range(n):
        total += i
    return total

def main():
    print(solve(10))
`;
    const a = buildArtifacts(py, 'python');
    assert.deepEqual(a.funcs.map((f) => f.name).sort(), ['main', 'solve']);
    assert.ok(a.funcs.find((f) => f.name === 'solve')!.len > 5);
});

test('buildArtifacts: pascal procedure bodies', () => {
    const pas = `program Demo;
procedure Hello;
begin
  WriteLn('hi');
end;
begin
  Hello;
end.`;
    const a = buildArtifacts(pas, 'pascal');
    assert.deepEqual(a.funcs.map((f) => f.name), ['hello']);
});

test('buildArtifacts: idents distinct+sorted, flags captured', () => {
    const a = buildArtifacts(C_CODE, 'c');
    assert.deepEqual([...a.idents], [...a.idents].slice().sort());
    assert.ok(a.idents.includes('dijkstra'));
    assert.ok(a.idents.includes('relax'));
    assert.ok(!a.idents.includes('int')); // keyword, not ident
    assert.ok(a.flags.length === 0);
});

test('buildArtifacts: comments hashed; identical comment lines match', () => {
    const a = buildArtifacts('// the answer is computed here\nint main(){}', 'c');
    const b = buildArtifacts('/* unrelated */\n// the answer is computed here\nint main(){}', 'c');
    assert.equal(a.commentCount, 1);
    // shared line present in both
    let shared = 0;
    const bh = new Set(Array.from(b.commentHashes));
    for (const x of a.commentHashes) if (bh.has(x)) shared++;
    assert.equal(shared, 1);
});

test('structVector: loop-heavy vs recursion differ', () => {
    const loops = buildArtifacts('int f(int n){int s=0;for(int i=0;i<n;i++)s+=i;return s;}', 'c');
    const rec = buildArtifacts('int f(int n){if(n<=1)return n;return f(n-1)+f(n-2);}', 'c');
    const v1 = loops.structVec;
    const v2 = rec.structVec;
    assert.notDeepEqual(v1, v2);
    // same skeleton -> identical vector
    assert.deepEqual(structVector(loops.tokens), v1);
});

test('artifacts round-trip through persistence fields', () => {
    const a = buildArtifacts(C_CODE, 'c');
    const fields = artifactsToFpFields(a);
    // mongo rejects undefined values — every field must be defined
    for (const [k, v] of Object.entries(fields)) assert.notEqual(v, undefined, k);
    assert.equal(fields.schema, FP_SCHEMA);
    const doc = { lang: 'cc', ...fields };
    const g = groupArtFromFpDoc(doc);
    const r = ridArtFromFpDoc(doc);
    assert.equal(g.baseHashes.length, a.baseHashes.length);
    assert.deepEqual(Array.from(g.baseHashes), Array.from(a.baseHashes));
    assert.deepEqual(g.tf, a.tf);
    assert.deepEqual(g.structVec, a.structVec);
    assert.deepEqual(g.funcs, a.funcs);
    assert.equal(g.family, 'c');
    assert.deepEqual(r.idents, a.idents);
    assert.deepEqual(Array.from(unpack(fields.commentHashes)), Array.from(a.commentHashes));
    assert.equal(r.commentCount, a.commentCount);
    assert.deepEqual(r.flags, a.flags);
});

test('artifacts: tokens equal plain tokenize (cache identity intact)', () => {
    const a = buildArtifacts(C_CODE, 'c');
    assert.equal(tokenText(a.tokens), tokenText(tokenize(C_CODE, 'c')));
});

test('lexBaseHashes: same structure + renamed vars -> same base, different lex', () => {
    const a = buildArtifacts('int aaa(int x){int r=x*2;return r;}', 'c');
    const b = buildArtifacts('int bbb(int y){int s=y*2;return s;}', 'c');
    // normalized streams identical — one fingerprint group
    assert.deepEqual(Array.from(a.baseHashes), Array.from(b.baseHashes));
    // lexical streams differ: PER-RID rename evidence
    assert.notDeepEqual(Array.from(a.lexBaseHashes), Array.from(b.lexBaseHashes));
});

test('lexBaseHashes: identical code -> identical lex; round-trips via fp fields', () => {
    const a = buildArtifacts('int main(){int v=1;return v;}', 'c');
    const b = buildArtifacts('int main(){int v=1;return v;}', 'c');
    assert.deepEqual(Array.from(a.lexBaseHashes), Array.from(b.lexBaseHashes));
    const fields = artifactsToFpFields(a);
    assert.equal(fields.schema, FP_SCHEMA);
    assert.ok(fields.lexBaseHashes!.length > 0);
    const rart = ridArtFromFpDoc({
        idents: fields.idents, lexBaseHashes: fields.lexBaseHashes,
        commentHashes: fields.commentHashes, commentCount: fields.commentCount,
        flags: fields.flags,
    });
    assert.deepEqual(Array.from(rart.lexBaseHashes), Array.from(a.lexBaseHashes));
});
