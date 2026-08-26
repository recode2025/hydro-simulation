/**
 * Sorensen-Dice coefficient over k-gram hash sets, plus 4-level classification.
 *
 *      dice(A, B) = 2 |A ∩ B| / (|A| + |B|)
 *
 * Both fingerprints are sorted ascending, so the intersection is a two-pointer
 * merge (O(n+m), no per-pair Set allocation).
 */

export type Level = 0 | 1 | 2 | 3;

export interface Thresholds {
    identical: number;
    high: number;
    suspected: number;
}

export const LEVEL_LOCALE_KEY = [
    'sim_level_none', 'sim_level_suspected', 'sim_level_high', 'sim_level_identical',
] as const;

export function diceCoeff(a: Uint32Array, b: Uint32Array): { sim: number; common: number } {
    if (!a.length || !b.length) return { sim: 0, common: 0 };
    let i = 0;
    let j = 0;
    let common = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            common++;
            i++;
            j++;
        } else if (a[i] < b[j]) i++;
        else j++;
    }
    return { sim: (2 * common) / (a.length + b.length), common };
}

export function classify(sim: number, t: Thresholds): Level {
    if (sim >= t.identical) return 3;
    if (sim >= t.high) return 2;
    if (sim >= t.suspected) return 1;
    return 0;
}

/** Median of a 101-bucket similarity histogram (bucket b covers values
 *  rounding to b/100). count = pairs sampled; even counts average the two
 *  middle values. Pure module so tests can exercise it without hydrooj. */
export function histogramMedian(hist: Uint32Array, count: number): number {
    if (!count) return 0;
    const pick = (rank: number): number => {
        let acc = 0;
        for (let b = 0; b < hist.length; b++) {
            acc += hist[b];
            if (acc >= rank) return b / 100;
        }
        return 1;
    };
    const mid = count >> 1;
    return count % 2 ? pick(mid + 1) : (pick(mid) + pick(mid + 1)) / 2;
}

/**
 * Rename-evidence gates for classifyPair's top level. Normalization maps every
 * identifier to V, so a renamed copy of a solution keeps a ~1.0 structural
 * Dice — structure alone must never read as "identical" when the names are
 * gone. These thresholds demand name evidence for the top label.
 */
export const LEX_GATE_IDENTICAL = 0.85;
export const VAR_GATE_IDENTICAL = 0.6;
export const VAR_GATE_TRIVIAL_IDENTICAL = 0.8;

/**
 * Two-channel level decision (replaces classify as the pipeline gate).
 *
 * Normal problems: structure keeps the classic ladder, but the top label
 * additionally requires name evidence (lexical or identifier similarity) —
 * a pure rename lands at "High", not "Identical".
 *
 * Trivial problems (structural similarity saturated for the whole field —
 * everyone writes the same skeleton): structure carries no information, so
 * the whole ladder runs on the lexical channel (identifiers kept). A rename
 * drops lexSim hard, which is exactly the discrimination structure cannot
 * provide there. null lexSim (stream < k) falls back to structSim; null
 * varSim (no distinctive identifiers) means lexSim alone decides level 3.
 */
export function classifyPair(
    structSim: number, lexSim: number | null, varSim: number | null,
    trivial: boolean, t: Thresholds,
): Level {
    if (!trivial) {
        if (structSim >= t.identical) {
            const named = (lexSim != null && lexSim >= LEX_GATE_IDENTICAL)
                || (varSim != null && varSim >= VAR_GATE_IDENTICAL);
            return named ? 3 : 2;
        }
        if (structSim >= t.high) return 2;
        if (structSim >= t.suspected) return 1;
        return 0;
    }
    const s = lexSim ?? structSim;
    if (s >= t.identical && (varSim == null || varSim >= VAR_GATE_TRIVIAL_IDENTICAL)) return 3;
    if (s >= t.high) return 2;
    if (s >= t.suspected) return 1;
    return 0;
}
