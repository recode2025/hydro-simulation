/**
 * Per-user rollup of detected pairs — powers the "query by user" view.
 * Pure module: takes the user's pair docs and aggregates them for display.
 */

import type { PairDoc } from '../model';

export interface UserProblemSummary {
    pid: number;
    count: number;
    maxSim: number;
    /** distinct users this user was paired with on this problem */
    partners: number;
}

export interface UserSummary {
    uid: number;
    total: number;
    l1: number;
    l2: number;
    l3: number;
    maxSim: number;
    /** per-problem breakdown, busiest first */
    perProblem: UserProblemSummary[];
    /** deduped union of the keyword flags found on THIS user's side */
    flags: string[];
    /** pairs where this user's side shares >= 1 identical comment line */
    sharedCommentPairs: number;
}

export function buildUserSummary(pairs: PairDoc[], uid: number): UserSummary {
    const s: UserSummary = {
        uid, total: 0, l1: 0, l2: 0, l3: 0, maxSim: 0,
        perProblem: [], flags: [], sharedCommentPairs: 0,
    };
    const flags = new Set<string>();
    const byProblem = new Map<number, { count: number; maxSim: number; partners: Set<number> }>();
    for (const p of pairs) {
        if (p.uid1 !== uid && p.uid2 !== uid) continue;
        s.total++;
        s[`l${p.level}` as 'l1' | 'l2' | 'l3']++;
        s.maxSim = Math.max(s.maxSim, p.similarity);
        // flags of THIS user's side (uid1's flags when we are uid1)
        const mine = p.uid1 === uid ? p.flags1 : p.flags2;
        if (mine) for (const f of mine) flags.add(f);
        if (p.sharedComments && p.sharedComments > 0) s.sharedCommentPairs++;
        let e = byProblem.get(p.pid);
        if (!e) {
            e = { count: 0, maxSim: 0, partners: new Set() };
            byProblem.set(p.pid, e);
        }
        e.count++;
        e.maxSim = Math.max(e.maxSim, p.similarity);
        e.partners.add(p.uid1 === uid ? p.uid2 : p.uid1);
    }
    s.flags = Array.from(flags).sort();
    s.perProblem = Array.from(byProblem.entries())
        .map(([pid, e]) => ({ pid, count: e.count, maxSim: e.maxSim, partners: e.partners.size }))
        .sort((a, b) => b.count - a.count || b.maxSim - a.maxSim);
    return s;
}
