/**
 * Plagiarism network graph payload for the canvas force layout.
 * Users become nodes, similar pairs become edges; node color = highest level
 * the user is involved in, edge width/color = level & similarity.
 */

import type { Level } from './lib/dice';
import type { PairDoc } from './model';

export interface GraphNode {
    id: number;
    label: string;
    degree: number;
    maxLevel: 0 | 1 | 2 | 3;
    pairCount: number;
}

export interface GraphEdge {
    u: number;
    v: number;
    sim: number;
    level: 1 | 2 | 3;
    pid: number;
    ptitle: string;
    pairId: string;
    url: string;
}

export interface GraphPayload {
    nodes: GraphNode[];
    edges: GraphEdge[];
    problems: { pid: number; title: string }[];
    stats: { l1: number; l2: number; l3: number; users: number; total: number };
}

export function buildGraph(
    pairs: PairDoc[],
    udict: Record<number, any>,
    pdict: Record<number, any>,
    minLevel: Level,
    urlFor: (pairId: string) => string,
): GraphPayload {
    const nodes = new Map<number, GraphNode>();
    const edges: GraphEdge[] = [];
    const problems = new Map<number, string>();
    const stats = { l1: 0, l2: 0, l3: 0, users: 0, total: pairs.length };
    for (const p of pairs) {
        stats[`l${p.level}` as 'l1' | 'l2' | 'l3']++;
    }
    for (const p of pairs) {
        if (p.level < minLevel) continue;
        for (const uid of [p.uid1, p.uid2]) {
            if (!nodes.has(uid)) {
                nodes.set(uid, {
                    id: uid,
                    label: udict[uid]?.uname || `U${uid}`,
                    degree: 0,
                    maxLevel: 0,
                    pairCount: 0,
                });
            }
            const node = nodes.get(uid)!;
            node.degree++;
            node.pairCount++;
            if (p.level > node.maxLevel) node.maxLevel = p.level;
        }
        const title = pdict[p.pid]?.title || `P${p.pid}`;
        if (!problems.has(p.pid)) problems.set(p.pid, title);
        const pairId = p._id.toHexString();
        edges.push({
            u: p.uid1,
            v: p.uid2,
            sim: p.similarity,
            level: p.level,
            pid: p.pid,
            ptitle: title,
            pairId,
            url: urlFor(pairId),
        });
    }
    stats.users = nodes.size;
    return {
        nodes: Array.from(nodes.values()),
        edges,
        problems: Array.from(problems, ([pid, title]) => ({ pid, title })),
        stats,
    };
}
