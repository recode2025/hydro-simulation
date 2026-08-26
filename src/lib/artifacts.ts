/**
 * Per-document artifacts for the evidence metrics.
 *
 * One buildArtifacts() call tokenizes once (with collectors) and produces
 * everything the pairwise phase needs, split by invariance:
 *
 *  - GROUP-invariant (derivable from the normalized stream, identical for
 *    every submission the codeHash group collapsed): baseHashes, tf,
 *    structVec, funcs.
 *  - PER-RID (destroyed by normalization on purpose — the differences ARE
 *    the evidence): idents, commentHashes, commentCount, flags,
 *    lexBaseHashes (fnv32a per token with identifier NAMES kept — the
 *    rename-sensitive lexical channel; same-group members differ here).
 *
 * Persistence: artifactsToFpFields()/groupArtFromFpDoc()/ridArtFromFpDoc()
 * round-trip through the sim.fingerprint doc. FP_SCHEMA gates cache reuse —
 * docs written before this schema exist miss the cache once and are rewritten.
 * Every persisted field must be DEFINED (the mongo driver rejects undefined).
 */

import type { Family, Token } from './tokenizer.ts';
import { langFamily, tokenText, tokenize } from './tokenizer.ts';
import type { FuncSig } from './metrics.ts';
import { fnv32a, pack, unpack } from './fingerprint.ts';

/** Bump when the artifact field set changes — old cache entries miss once.
 *  v3 adds lexBaseHashes (keep-names lexical channel). */
export const FP_SCHEMA = 3;

export const MAX_IDENTS = 512;
export const MAX_COMMENT_LINES = 256;
export const MAX_FUNCS = 128;
export const MAX_FUNC_BODY_TOKENS = 20_000;

export interface DocArtifacts {
    /** normalized token stream (caller reuses for fingerprinting) */
    tokens: Token[];
    /** fnv32a(tokens[i].v) per token — group-invariant */
    baseHashes: Uint32Array;
    /** token.v -> count — group-invariant */
    tf: Map<string, number>;
    /** fixed-dim structure profile — group-invariant */
    structVec: number[];
    /** function body signatures — group-invariant */
    funcs: FuncSig[];
    /** sorted distinct identifier names — PER-RID */
    idents: string[];
    /** fnv32a per token, identifiers KEPT as written (literals normalized) —
     *  PER-RID; k-grams over this are the rename-sensitive lexical channel */
    lexBaseHashes: Uint32Array;
    /** sorted distinct fnv32a of normalized comment lines — PER-RID */
    commentHashes: Uint32Array;
    /** raw comment line count — PER-RID */
    commentCount: number;
    /** matched keyword flag names — PER-RID */
    flags: string[];
}

// ---------------------------------------------------------------------------
// keyword flags
// ---------------------------------------------------------------------------

/** Suspicious-in-contest API names worth an admin's glance. A flag is a
 *  MARK, not an accusation — `system("pause")` is harmless Windows habit. */
export const KEYWORD_FLAGS = [
    'freopen', 'fopen', 'fclose', 'fread', 'fwrite',
    'ifstream', 'ofstream', 'fstream',
    'system', 'popen',
    'execl', 'execlp', 'execv', 'execvp',
    'fork', 'remove', 'unlink',
] as const;

const FLAG_RE = new RegExp(`\\b(${KEYWORD_FLAGS.join('|')})\\b`, 'g');

/** Flag names present in the RAW source (comments/strings included — a
 *  freopen mentioned anywhere is worth looking at). Sorted, unique. */
export function scanKeywordFlags(code: string): string[] {
    const found = new Set<string>();
    for (const m of code.matchAll(FLAG_RE)) found.add(m[1]);
    return Array.from(found).sort();
}

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

/**
 * Normalize a raw comment block into comparable lines: strip comment markers,
 * trim, collapse internal whitespace, drop fragments shorter than 4 chars
 * (marker leftovers like "{" or "*)"). Capped at 64 lines per block.
 */
export function normalizeCommentLines(raw: string): string[] {
    const out: string[] = [];
    for (let line of raw.split('\n')) {
        line = line
            .replace(/^[\t ]*/, '')
            .replace(/\/\/|\/\*|\*\/|^\{|\}$|^\(\*|\*\)$|^#/, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (line.length >= 4) out.push(line);
        if (out.length >= 64) break;
    }
    return out;
}

// ---------------------------------------------------------------------------
// structure vector
// ---------------------------------------------------------------------------

const STRUCT_CTRL = ['for', 'while', 'if', 'else', 'do', 'switch', 'case',
    'break', 'continue', 'return', 'try', 'catch'] as const;
const STRUCT_DEF = ['def', 'class', 'struct', 'enum', 'union', 'template'] as const;
const STRUCT_PUNCT = [';', '{', '}', '(', ')', '[', ']'] as const;
export const STRUCT_DIMS = STRUCT_CTRL.length + STRUCT_DEF.length + STRUCT_PUNCT.length
    + 3 /* kinds */ + 1 /* maxNest */ + 8 /* depth histogram */;

/**
 * Fixed-dimension structural profile: control-keyword / definition-keyword /
 * punctuation counts, token-kind counts, max bracket-nesting depth and an
 * 8-bucket nesting histogram. Order-agnostic by design — this is the "same
 * bag of structure" signal, complementary to order-sensitive LCS.
 */
export function structVector(tokens: Token[]): number[] {
    const v = new Array<number>(STRUCT_DIMS).fill(0);
    const ctrl: Map<string, number> = new Map(STRUCT_CTRL.map((k, i) => [k, i]));
    const def: Map<string, number> = new Map(STRUCT_DEF.map((k, i) => [k, STRUCT_CTRL.length + i]));
    const punct: Map<string, number> = new Map(STRUCT_PUNCT.map((k, i) => [k, STRUCT_CTRL.length + STRUCT_DEF.length + i]));
    const kindBase = STRUCT_CTRL.length + STRUCT_DEF.length + STRUCT_PUNCT.length;
    const maxNestIdx = kindBase + 3;
    const histBase = maxNestIdx + 1;
    let depth = 0;
    for (const t of tokens) {
        if (t.k === 'kw') {
            let idx = ctrl.get(t.v);
            if (idx === undefined) idx = def.get(t.v);
            if (idx !== undefined) v[idx]++;
            if (t.v === 'begin') { // pascal nesting
                depth++;
                v[maxNestIdx] = Math.max(v[maxNestIdx], depth);
                v[histBase + Math.min(depth, 8) - 1]++;
            } else if (t.v === 'end') depth = Math.max(0, depth - 1);
        } else if (t.k === 'punct') {
            const idx = punct.get(t.v);
            if (idx !== undefined) v[idx]++;
            if (t.v === '{' || t.v === '(' || t.v === '[') {
                depth++;
                v[maxNestIdx] = Math.max(v[maxNestIdx], depth);
                v[histBase + Math.min(depth, 8) - 1]++;
            } else if (t.v === '}' || t.v === ')' || t.v === ']') {
                depth = Math.max(0, depth - 1);
            }
        }
    }
    // log1p transform: raw counts are dominated by dimensions EVERY solution
    // shares (semicolons, parens, if/for), which flattens cosines toward 1.
    // Damping the large common dims lets the differing dims move the angle.
    for (let i = 0; i < v.length; i++) v[i] = Math.log1p(v[i]);
    return v;
}

// ---------------------------------------------------------------------------
// function extraction (heuristic — no AST)
// ---------------------------------------------------------------------------

interface RawFunc {
    name: string;
    bodyStart: number; // token index of the token AFTER the opening brace
    bodyEnd: number; // token index of the closing brace (exclusive end)
}

/** Map tokenIndex -> raw identifier text, built from the ident collector. */
function identMap(idents: [string, number][]) {
    return new Map(idents.map(([w, i]) => [i, w]));
}

/** c/plain: `name ( <balanced parens> ) [trailing qualifiers] { body }`
 *  scanned over the NORMALIZED stream (comments/strings already gone, so no
 *  false matches inside them). Control statements are kw, never ph, so
 *  `if (` cannot match; declarations without a `{` are skipped. */
function extractFunctionsC(tokens: Token[], names: Map<number, string>): RawFunc[] {
    const out: RawFunc[] = [];
    const n = tokens.length;
    let i = 0;
    while (i < n && out.length < MAX_FUNCS) {
        if (!(tokens[i].k === 'ph' && tokens[i + 1]?.k === 'punct' && tokens[i + 1].v === '(')) {
            i++;
            continue;
        }
        // match parens starting at i+1
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
            if (tokens[j].k !== 'punct') continue;
            if (tokens[j].v === '(') depth++;
            else if (tokens[j].v === ')') {
                depth--;
                if (!depth) break;
            }
        }
        if (j >= n) {
            i++;
            continue;
        }
        // up to 3 trailing qualifier tokens (const / noexcept / -> Type ...)
        let k = j + 1;
        let skips = 0;
        while (k < n && skips < 3 && tokens[k].k !== 'punct') {
            k++;
            skips++;
        }
        if (k < n && tokens[k].k === 'punct' && tokens[k].v === '{') {
            // find matching brace
            let bd = 0;
            let e = k;
            for (; e < n; e++) {
                if (tokens[e].k !== 'punct') continue;
                if (tokens[e].v === '{') bd++;
                else if (tokens[e].v === '}') {
                    bd--;
                    if (!bd) break;
                }
            }
            if (e < n) {
                out.push({ name: names.get(i) ?? '', bodyStart: k + 1, bodyEnd: e });
                i = e + 1; // skip past the whole body (no double-count)
                continue;
            }
        }
        i++;
    }
    return out;
}

/** python: `def name(...)` at line start; body ends at the next non-blank
 *  line with indent <= the def's indent. Works on raw lines (the token stream
 *  loses indentation). */
function extractFunctionsPython(code: string): { name: string; body: string }[] {
    const out: { name: string; body: string }[] = [];
    const lines = code.split('\n');
    const re = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
    for (let i = 0; i < lines.length && out.length < MAX_FUNCS; i++) {
        const m = lines[i].match(re);
        if (!m) continue;
        const indent = m[1].length;
        const body: string[] = [lines[i]];
        let j = i + 1;
        for (; j < lines.length; j++) {
            const l = lines[j];
            if (!l.trim()) {
                body.push(l);
                continue;
            }
            let ind = 0;
            while (ind < l.length && (l[ind] === ' ' || l[ind] === '\t')) ind++;
            if (ind <= indent) break;
            body.push(l);
        }
        out.push({ name: m[2], body: body.join('\n') });
        i = j - 1;
    }
    return out;
}

/** pascal: `procedure|function name ... begin ... end` — body spans the
 *  begin/end pair matched over kw tokens. */
function extractFunctionsPascal(tokens: Token[], names: Map<number, string>): RawFunc[] {
    const out: RawFunc[] = [];
    const n = tokens.length;
    let i = 0;
    while (i < n && out.length < MAX_FUNCS) {
        const isDef = tokens[i].k === 'kw'
            && (tokens[i].v === 'procedure' || tokens[i].v === 'function');
        if (!isDef) {
            i++;
            continue;
        }
        const nameIdx = tokens.findIndex((t, idx) => idx > i && t.k === 'ph');
        // find the FIRST begin after the header (skip nested parens naturally:
        // begin/end kw counting handles nesting)
        let j = i + 1;
        while (j < n && !(tokens[j].k === 'kw' && tokens[j].v === 'begin')) j++;
        if (j >= n) break;
        let depth = 0;
        let e = j;
        for (; e < n; e++) {
            if (tokens[e].k !== 'kw') continue;
            if (tokens[e].v === 'begin') depth++;
            else if (tokens[e].v === 'end') {
                depth--;
                if (!depth) break;
            }
        }
        if (e >= n) break;
        out.push({
            name: (nameIdx > i && nameIdx < j) ? names.get(nameIdx) ?? '' : '',
            bodyStart: j + 1,
            bodyEnd: e,
        });
        i = e + 1;
    }
    return out;
}

// ---------------------------------------------------------------------------
// buildArtifacts
// ---------------------------------------------------------------------------

/** Extract all artifacts with a single tokenization pass. */
export function buildArtifacts(code: string, family: Family): DocArtifacts {
    const identsWithIdx: [string, number][] = [];
    const comments: string[] = [];
    const lexVals: string[] = [];
    const tokens = tokenize(code, family, {
        tok: (_k, v) => lexVals.push(v),
        ident: (w, idx) => identsWithIdx.push([w, idx]),
        comment: (raw) => comments.push(raw),
    });

    const baseHashes = new Uint32Array(tokens.length);
    const lexBaseHashes = new Uint32Array(lexVals.length);
    const tf = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
        baseHashes[i] = fnv32a(tokens[i].v);
        lexBaseHashes[i] = fnv32a(lexVals[i]);
        // tf-idf vocabulary: KEYWORDS only (control/declaration/typing words
        // — the algorithm's shape words). Placeholder tokens (V/N/S/C) occur
        // in every document and punctuation counts are near-identical across
        // same-language solutions; both drown the discriminative signal.
        if (tokens[i].k === 'kw') tf.set(tokens[i].v, (tf.get(tokens[i].v) ?? 0) + 1);
    }

    // distinct sorted identifier names (raw, case as written except pascal
    // which the tokenizer lowercases — good for set comparison)
    const identSet = Array.from(new Set(identsWithIdx.map(([w]) => w))).sort()
        .slice(0, MAX_IDENTS);

    // comment lines -> sorted distinct hashes
    const commentSet = new Set<number>();
    let commentCount = 0;
    for (const raw of comments) {
        for (const line of normalizeCommentLines(raw)) {
            commentCount++;
            commentSet.add(fnv32a(line));
        }
    }
    const commentHashes = new Uint32Array(Array.from(commentSet).sort((a, b) => a - b)
        .slice(0, MAX_COMMENT_LINES));

    // function signatures (body hash over normalized text — rename-invariant)
    const funcs: FuncSig[] = [];
    let raws: RawFunc[] = [];
    if (family === 'python') {
        for (const f of extractFunctionsPython(code)) {
            const body = tokenize(f.body, 'python');
            if (!body.length || body.length > MAX_FUNC_BODY_TOKENS) continue;
            funcs.push({ name: f.name, len: body.length, hash: fnv32a(tokenText(body)) });
        }
    } else {
        const names = identMap(identsWithIdx);
        raws = family === 'pascal'
            ? extractFunctionsPascal(tokens, names)
            : extractFunctionsC(tokens, names);
        for (const r of raws) {
            const body = tokens.slice(r.bodyStart, r.bodyEnd);
            if (!body.length || body.length > MAX_FUNC_BODY_TOKENS) continue;
            funcs.push({ name: r.name, len: body.length, hash: fnv32a(tokenText(body)) });
        }
    }

    return {
        tokens,
        baseHashes,
        tf,
        structVec: structVector(tokens),
        funcs,
        idents: identSet,
        lexBaseHashes,
        commentHashes,
        commentCount,
        flags: scanKeywordFlags(code),
    };
}

// ---------------------------------------------------------------------------
// persistence round-trip
// ---------------------------------------------------------------------------

/** Fields to spread into upsertFingerprint. All defined — mongo rejects
 *  undefined values. */
export function artifactsToFpFields(a: DocArtifacts) {
    return {
        schema: FP_SCHEMA,
        baseHashes: pack(a.baseHashes),
        tf: Object.fromEntries(a.tf),
        structVec: a.structVec,
        funcs: a.funcs.map((f) => ({ n: f.name, l: f.len, h: f.hash })),
        idents: a.idents,
        lexBaseHashes: pack(a.lexBaseHashes),
        commentHashes: pack(a.commentHashes),
        commentCount: a.commentCount,
        flags: a.flags,
    };
}

export interface GroupArt {
    baseHashes: Uint32Array;
    tf: Map<string, number>;
    structVec: number[];
    funcs: FuncSig[];
    family: Family;
}

export interface RidArt {
    idents: string[];
    /** keep-names token hashes (lexical channel) — PER-RID */
    lexBaseHashes: Uint32Array;
    commentHashes: Uint32Array;
    commentCount: number;
    flags: string[];
}

/** Group-invariant artifacts from a persisted fingerprint doc. */
export function groupArtFromFpDoc(doc: any): GroupArt {
    return {
        baseHashes: doc.baseHashes ? unpack(doc.baseHashes) : new Uint32Array(0),
        tf: new Map(Object.entries(doc.tf ?? {})),
        structVec: doc.structVec ?? [],
        funcs: (doc.funcs ?? []).map((f: any) => ({ name: f.n, len: f.l, hash: f.h })),
        family: langFamily(doc.lang ?? ''),
    };
}

/** Per-rid artifacts from a persisted fingerprint doc. */
export function ridArtFromFpDoc(doc: any): RidArt {
    return {
        idents: doc.idents ?? [],
        lexBaseHashes: doc.lexBaseHashes ? unpack(doc.lexBaseHashes) : new Uint32Array(0),
        commentHashes: doc.commentHashes ? unpack(doc.commentHashes) : new Uint32Array(0),
        commentCount: doc.commentCount ?? 0,
        flags: doc.flags ?? [],
    };
}
