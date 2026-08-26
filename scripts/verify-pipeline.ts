/**
 * Standalone end-to-end verification of the detection pipeline.
 * No hydrooj/mongo needed — runs the exact production code path:
 *   fetchCode -> tokenize -> codeHash -> kgramHashes -> diceCoeff -> classify
 *
 * Usage: node --experimental-strip-types scripts/verify-pipeline.ts
 */
import { classify, diceCoeff } from '../src/lib/dice.ts';
import { codeHash, dedupSorted, fnv32a, kgramHashes } from '../src/lib/fingerprint.ts';
import { langFamily, tokenText, tokenize } from '../src/lib/tokenizer.ts';
import { buildArtifacts } from '../src/lib/artifacts.ts';
import {
    funcSimilarity, seqSimilarity, sharedCommentCount, structSimilarity,
    tfidfSimilarity, varSimilarity,
} from '../src/lib/metrics.ts';

const K = 8;
const THRESHOLDS = { identical: 0.95, high: 0.75, suspected: 0.55 };

/** User A: original solution */
const CODE_A = `#include <bits/stdc++.h>
using namespace std;

int n, m;
vector<pair<int,int>> adj[100005];
bool visited[100005];
long long dist[100005];

// dijkstra main loop
void dijkstra(int start) {
    priority_queue<pair<long long,int>, vector<pair<long long,int>>, greater<>> pq;
    for (int i = 1; i <= n; i++) dist[i] = LLONG_MAX;
    dist[start] = 0;
    pq.push({0, start});
    while (!pq.empty()) {
        auto [d, u] = pq.top(); pq.pop();
        if (visited[u]) continue;
        visited[u] = true;
        for (auto [w, v] : adj[u]) {
            if (dist[u] + w < dist[v]) {
                dist[v] = dist[u] + w;
                pq.push({dist[v], v});
            }
        }
    }
}

int main() {
    scanf("%d %d", &n, &m);
    for (int i = 0; i < m; i++) {
        int u, v, w;
        scanf("%d %d %d", &u, &v, &w);
        adj[u].push_back({w, v});
    }
    dijkstra(1);
    printf("%lld\\n", dist[n]);
    return 0;
}
`;

/** User B: plagiarized — renamed vars, comments added, reformatted.
 *  Also: copies ONE comment line from A verbatim (shared-comment evidence)
 *  and calls freopen (keyword flag evidence). */
const CODE_B = `#include <cstdio>
#include <queue>
#include <vector>
using namespace std;
// my own solution, definitely not copied
// dijkstra main loop
constexpr int MAXN = 100005;

int node_count, edge_count;
vector<pair<int,int>> graph[MAXN]; // adjacency
bool seen[MAXN];
long long shortest[MAXN];

void run_dijkstra(int source) {
    // use a min-heap
    priority_queue<pair<long long,int>, vector<pair<long long,int>>, greater<>> heap;
    for (int i = 1; i <= node_count; i++) shortest[i] = LLONG_MAX;
    shortest[source] = 0;
    heap.push({0, source});
    while (!heap.empty()) {
        auto [d, u] = heap.top(); heap.pop();
        if (seen[u]) continue;
        seen[u] = true;
        for (auto [w, v] : graph[u]) {
            if (shortest[u] + w < shortest[v]) {
                shortest[v] = shortest[u] + w;
                heap.push({shortest[v], v});
            }
        }
    }
}

int main() {
    freopen("in.txt", "r", stdin);
    scanf("%d %d", &node_count, &edge_count);
    for (int i = 0; i < edge_count; i++) {
        int a, b, weight;
        scanf("%d %d %d", &a, &b, &weight);
        graph[a].push_back({weight, b});
    }
    run_dijkstra(1);
    printf("%lld\\n", shortest[node_count]);
    return 0;
}
`;

/** User C: independent solution (BFS on 0/1 weights, different structure) */
const CODE_C = `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n, m;
    cin >> n >> m;
    vector<vector<array<int,3>>> g(n + 1);
    for (int i = 0, u, v, w; i < m && cin >> u >> v >> w; i++) g[u].push_back({v, w, i});
    vector<long long> d(n + 1, -1);
    deque<int> q;
    d[1] = 0; q.push_back(1);
    while (q.size()) {
        int u = q.front(); q.pop_front();
        for (auto& [v, w, id] : g[u]) {
            long long nd = d[u] + w;
            if (d[v] < 0 || nd < d[v]) {
                d[v] = nd;
                if (w) q.push_back(v); else q.push_front(v);
            }
        }
    }
    cout << d[n] << endl;
}
`;

function fingerprint(code: string, lang: string) {
    const tokens = tokenize(code, langFamily(lang));
    const base = new Array<number>(tokens.length);
    for (let i = 0; i < tokens.length; i++) base[i] = fnv32a(tokens[i].v);
    return { tokens, hashes: dedupSorted(kgramHashes(base, K)), ch: codeHash(tokenText(tokens)) };
}

const names = ['A (original)', 'B (plagiarized)', 'C (independent)'];
const fps = [fingerprint(CODE_A, 'cc'), fingerprint(CODE_B, 'cc'), fingerprint(CODE_C, 'cc')];

console.log(`k=${K}  thresholds: identical>=${THRESHOLDS.identical} high>=${THRESHOLDS.high} suspected>=${THRESHOLDS.suspected}\n`);
for (let i = 0; i < 3; i++) {
    console.log(`${names[i]}: tokens=${fps[i].tokens.length} kgrams(set)=${fps[i].hashes.length} codeHash=${fps[i].ch.slice(0, 8)}`);
}
console.log('');
for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
        const { sim } = diceCoeff(fps[i].hashes, fps[j].hashes);
        const level = classify(sim, THRESHOLDS);
        const label = ['无 none', '疑似 suspected', '高度 high', '完全相同 identical'][level];
        console.log(`${names[i]} vs ${names[j]}: dice=${sim.toFixed(4)}  ->  ${label}`);
    }
}
console.log('\n(expected: A-B highly similar or above; A-C / B-C none)');

// ---- evidence metrics: the full artifact set on the same fixtures ----
console.log('\n=== evidence metrics ===');
const arts = [
    buildArtifacts(CODE_A, langFamily('cc')),
    buildArtifacts(CODE_B, langFamily('cc')),
    buildArtifacts(CODE_C, langFamily('cc')),
];
const df = new Map<string, number>();
for (const a of arts) for (const t of a.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
for (let i = 0; i < 3; i++) {
    console.log(`${names[i]}: funcs=[${arts[i].funcs.map((f) => `${f.name}:${f.len}`).join(', ')}]`
        + ` idents=${arts[i].idents.length} comments=${arts[i].commentCount}`
        + ` flags=[${arts[i].flags.join(',') || '-'}]`);
}
const pct = (x: number | null) => (x === null ? '  —  ' : `${(x * 100).toFixed(1)}%`);
for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
        const a = arts[i];
        const b = arts[j];
        console.log(`${names[i]} vs ${names[j]}:`
            + ` seq=${pct(seqSimilarity(a.baseHashes, b.baseHashes)?.sim ?? null)}`
            + ` tfidf=${pct(tfidfSimilarity(a.tf, b.tf, df, 3))}`
            + ` var=${pct(varSimilarity(a.idents, b.idents))}`
            + ` func=${pct(funcSimilarity(a.funcs, b.funcs))}`
            + ` struct=${pct(structSimilarity(a.structVec, b.structVec))}`
            + ` sharedComments=${sharedCommentCount(a.commentHashes, b.commentHashes)}`);
    }
}
console.log('\n(expected: A-B high on every metric with sharedComments=1; A-C / B-C low)');

// codeHash fast-path: comments + whitespace only -> identical
const CODE_A2 = CODE_A
    .replace(/int n, m;/, 'int n, m;   // vertices and edges')
    .replace(/\n/g, '\n\n')
    .replace(/dist\[start\] = 0;/, 'dist[start]=0;');
const f2 = fingerprint(CODE_A2, 'cc');
const fa = fps[0];
console.log(`\nA vs A(comment/whitespace only): dice=${diceCoeff(fa.hashes, f2.hashes).sim.toFixed(4)} codeHash equal=${fa.ch === f2.ch}`);

// minTokens skip demo (default 30)
const tiny = 'int main(){int a,b;cin>>a>>b;cout<<a+b;}\n';
const ft = tokenize(tiny, langFamily('cc'));
console.log(`tiny snippet: tokens=${ft.length} -> skipped when minTokens=30: ${ft.length < 30}`);
