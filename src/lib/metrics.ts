/**
 * Evidence metrics beyond the primary Dice gate.
 *
 * These never decide a pair's LEVEL — dice over k-gram fingerprints does
 * (see detect.ts). They are computed only for pairs that already passed the
 * suspected threshold and are stored as per-pair evidence for human review.
 * Every function is pure (no hydrooj imports) and returns null when the
 * metric is not applicable (too large / empty / cross-language).
 */

export interface FuncSig {
    /** function name (informational — matching is body-hash based) */
    name: string;
    /** body length in tokens (weight for the length-weighted match) */
    len: number;
    /** fnv32a of the body's canonical token text (rename-invariant) */
    hash: number;
}

export function round4(x: number) {
    return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// sequence similarity — token-level LCS
// ---------------------------------------------------------------------------

/**
 * Longest-common-subsequence length over the token base-hash sequences,
 * reported as sim = 2*LCS/(n+m) so it shares Dice's scale and symmetry.
 * null when either side is empty or n*m exceeds cellLimit (O(n·m) DP).
 */
export function seqSimilarity(
    a: Uint32Array, b: Uint32Array, cellLimit = 4_000_000,
): { sim: number; lcs: number } | null {
    const n = a.length;
    const m = b.length;
    if (!n || !m) return null;
    if (n * m > cellLimit) return null;
    // rolling two-row DP, length only (no backtrack)
    let prev = new Uint32Array(m + 1);
    let cur = new Uint32Array(m + 1);
    for (let i = 1; i <= n; i++) {
        const ai = a[i - 1];
        for (let j = 1; j <= m; j++) {
            cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        const t = prev;
        prev = cur;
        cur = t;
        cur.fill(0);
    }
    const lcs = prev[m];
    return { sim: (2 * lcs) / (n + m), lcs };
}

// ---------------------------------------------------------------------------
// TF-IDF similarity — cosine over tf·idf token-frequency vectors
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two documents' tf·idf vectors. `df` holds the
 * per-problem document frequency of each term (computed over distinct
 * normalized sources, not raw submissions) and nDocs is the corpus size.
 * idf = ln(1 + nDocs/df) — ubiquitous terms (V/N/S/C) get idf ≈ 0, so the
 * weight lands on keyword/punctuation usage profiles.
 * null when either vector is empty or has zero norm.
 */
export function tfidfSimilarity(
    tfA: Map<string, number>, tfB: Map<string, number>,
    df: Map<string, number>, nDocs: number,
): number | null {
    if (!tfA.size || !tfB.size || nDocs <= 0) return null;
    const weight = (term: string, tf: number) => {
        const d = df.get(term) ?? 1;
        return tf * Math.log(1 + nDocs / Math.max(1, d));
    };
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [t, f] of tfA) {
        const w = weight(t, f);
        na += w * w;
        const fb = tfB.get(t);
        if (fb !== undefined) dot += w * weight(t, fb);
    }
    for (const [t, f] of tfB) nb += weight(t, f) ** 2;
    if (na === 0 || nb === 0) return null;
    return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// variable-name similarity — dice over distinctive identifier sets
// ---------------------------------------------------------------------------

/** Single/double letter names and ubiquitous competitive-programming
 *  identifiers — not distinctive enough to signal anything. */
export const IDENT_STOPLIST = new Set([
    'i', 'j', 'k', 'l', 'm', 'n', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'p',
    'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ok', 'ans', 'tmp',
    'temp', 'sum', 'res', 'cnt', 'tot', 'num', 'pos', 'len', 'size', 'st',
    'ed', 'end', 'begin', 'vis', 'dis', 'dist', 'dep', 'fa', 'son', 'nxt',
    'pre', 'flag', 'flg', 'head', 'tail', 'que', 'stack', 'str', 's1', 's2',
    'ch', 'str1', 'str2', 'maxn', 'maxx', 'minn', 'arr', 'vec', 'set', 'map',
    'mp', 'lst', 'li', 'row', 'col', 'dx', 'dy', 'now', 'ret', 'val', 'key',
    'it', 'id', 'ii', 'jj', 'kk', 'nn', 'mm', 'tt', 'pp', 'xx', 'yy', 'zz',
]);

/** Dice over the distinctive identifier sets (stoplist + len<=2 removed).
 *  null when either side has no distinctive identifier left — a fair "n/a"
 *  for tiny snippets whose names carry no signal. */
export function varSimilarity(identsA: string[], identsB: string[]): number | null {
    const fa = distinctive(identsA);
    const fb = distinctive(identsB);
    if (!fa.size || !fb.size) return null;
    let common = 0;
    for (const x of fa) if (fb.has(x)) common++;
    return (2 * common) / (fa.size + fb.size);
}

function distinctive(idents: string[]) {
    const s = new Set<string>();
    for (const id of idents) {
        if (id.length <= 2) continue;
        if (IDENT_STOPLIST.has(id)) continue;
        s.add(id);
    }
    return s;
}

// ---------------------------------------------------------------------------
// function-level similarity — length-weighted body match
// ---------------------------------------------------------------------------

/**
 * 2*Σ min(lenA(h), lenB(h)) over hashes present on both sides, divided by
 * the total body length of both sides. Long matching functions dominate the
 * score; tiny helpers barely move it. null when both sides have no functions.
 */
export function funcSimilarity(fa: FuncSig[], fb: FuncSig[]): number | null {
    if (!fa.length && !fb.length) return null;
    const byHash = new Map<number, number>(); // hash -> len (min across dupes)
    for (const f of fa) byHash.set(f.hash, Math.min(byHash.get(f.hash) ?? Infinity, f.len));
    let totalA = 0;
    for (const f of fa) totalA += f.len;
    let totalB = 0;
    let matched = 0;
    const seen = new Set<number>();
    for (const f of fb) {
        totalB += f.len;
        const la = byHash.get(f.hash);
        if (la !== undefined && !seen.has(f.hash)) {
            seen.add(f.hash);
            matched += Math.min(la, f.len);
        }
    }
    const denom = totalA + totalB;
    if (!denom) return null;
    return (2 * matched) / denom;
}

// ---------------------------------------------------------------------------
// structure similarity — cosine over fixed-dim structure vectors
// ---------------------------------------------------------------------------

/** Cosine similarity between structure vectors; null on zero norm. */
export function structSimilarity(va: number[], vb: number[]): number | null {
    const n = Math.min(va.length, vb.length);
    if (!n) return null;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
        dot += va[i] * vb[i];
        na += va[i] * va[i];
        nb += vb[i] * vb[i];
    }
    if (na === 0 || nb === 0) return null;
    return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// shared comments — two-pointer intersection over sorted comment-line hashes
// ---------------------------------------------------------------------------

/** Count of identical (normalized) comment lines present on both sides. */
export function sharedCommentCount(ca: Uint32Array, cb: Uint32Array): number {
    let i = 0;
    let j = 0;
    let common = 0;
    while (i < ca.length && j < cb.length) {
        if (ca[i] === cb[j]) {
            common++;
            i++;
            j++;
        } else if (ca[i] < cb[j]) i++;
        else j++;
    }
    return common;
}
