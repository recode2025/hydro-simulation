/**
 * k-gram fingerprints over the normalized token stream.
 *
 * - per-token base value: FNV-1a 32
 * - k-gram: rolling polynomial hash (B = 16777619) over consecutive token
 *   base values, mod 2^32 via Math.imul
 * - fingerprint of a document = SORTED DEDUPLICATED set of k-gram hashes
 *   (set semantics is what Sorensen-Dice operates on)
 */

import { createHash } from 'node:crypto';

export const FNV_OFFSET = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;
const POLY_BASE = 16777619;

export function fnv32a(s: string): number {
    let h = FNV_OFFSET;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, FNV_PRIME);
    }
    return h >>> 0;
}

/** Rolling polynomial k-gram hashes over per-token base values. */
export function kgramHashes(baseValues: number[] | Uint32Array, k: number): Uint32Array {
    const n = baseValues.length;
    if (k <= 0 || n < k) return new Uint32Array(0);
    let bk = 1; // B^(k-1)
    for (let i = 1; i < k; i++) bk = Math.imul(bk, POLY_BASE);
    let h = 0;
    for (let i = 0; i < k; i++) h = (Math.imul(h, POLY_BASE) + baseValues[i]) | 0;
    const out = new Uint32Array(n - k + 1);
    out[0] = h >>> 0;
    for (let j = 1; j + k <= n; j++) {
        h = (Math.imul(h - Math.imul(baseValues[j - 1], bk), POLY_BASE) + baseValues[j + k - 1]) | 0;
        out[j] = h >>> 0;
    }
    return out;
}

/** Sort ascending and drop duplicates -> set semantics. */
export function dedupSorted(h: Uint32Array): Uint32Array {
    const sorted = Uint32Array.from(h).sort();
    if (sorted.length < 2) return sorted;
    let w = 1;
    for (let r = 1; r < sorted.length; r++) {
        if (sorted[r] !== sorted[w - 1]) sorted[w++] = sorted[r];
    }
    return sorted.subarray(0, w);
}

/** sha1 hex of the canonical token text — identity of the normalized source. */
export function codeHash(tokenTextStr: string): string {
    return createHash('sha1').update(tokenTextStr).digest('hex');
}

export function pack(h: Uint32Array): Buffer {
    const buf = Buffer.alloc(h.length * 4);
    for (let i = 0; i < h.length; i++) buf.writeUInt32LE(h[i], i * 4);
    return buf;
}

export function unpack(b: Buffer): Uint32Array {
    const out = new Uint32Array(Math.floor(b.length / 4));
    for (let i = 0; i < out.length; i++) out[i] = b.readUInt32LE(i * 4);
    return out;
}
