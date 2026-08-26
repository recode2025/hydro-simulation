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
