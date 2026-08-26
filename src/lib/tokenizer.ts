/**
 * Language-aware tokenizer for code similarity detection.
 *
 * Anti-false-positive equivalence classes produced by the scanner:
 *  - comments removed (line/block, per language family)
 *  - boilerplate lines removed (`#include`/`#pragma`/`import`/`using`/`uses` ...)
 *  - string/char literals folded into placeholders S / C
 *  - identifiers -> V, numeric literals -> N (keywords & punctuation kept)
 *  - whitespace-insensitive, Pascal case-insensitive
 *
 * The scanner is a single linear pass (index-advancing state machine), no regex
 * backtracking, so it stays fast on large submissions.
 */

export type Family = 'c' | 'python' | 'pascal' | 'plain';

export interface Token {
    k: 'kw' | 'punct' | 'ph';
    v: string;
}

const C_KEYWORDS = new Set([
    'alignas', 'alignof', 'and', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char',
    'class', 'const', 'const_cast', 'constexpr', 'continue', 'decltype', 'default', 'delete',
    'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false',
    'final', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable',
    'namespace', 'new', 'noexcept', 'not', 'nullptr', 'operator', 'or', 'override', 'private',
    'protected', 'public', 'register', 'reinterpret_cast', 'return', 'short', 'signed',
    'sizeof', 'static', 'static_cast', 'struct', 'switch', 'template', 'this', 'throw',
    'throws', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using',
    'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor',
    // Java extras
    'abstract', 'extends', 'implements', 'import', 'instanceof', 'interface', 'native',
    'package', 'strictfp', 'super', 'synchronized', 'this', 'transient',
]);

const PY_KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
    'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
    'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
    'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);

const PAS_KEYWORDS = new Set([
    'and', 'array', 'begin', 'case', 'const', 'div', 'do', 'downto', 'else', 'end', 'file',
    'for', 'function', 'goto', 'if', 'in', 'label', 'mod', 'nil', 'not', 'of', 'or', 'packed',
    'procedure', 'program', 'record', 'repeat', 'set', 'then', 'to', 'type', 'until', 'uses',
    'var', 'while', 'with', 'out', 'string', 'integer', 'longint', 'int64', 'qword',
    'cardinal', 'ansistring', 'boolean', 'char', 'real', 'byte', 'word',
]);

function isIdentStart(c: string) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}

function isIdentChar(c: string) {
    return isIdentStart(c) || (c >= '0' && c <= '9');
}

function isDigit(c: string) {
    return c >= '0' && c <= '9';
}

/** Longest-match operator/punct consumption using a length-sorted candidate list. */
function readPunct(src: string, i: number, ops: string[]) {
    for (const op of ops) {
        if (src.startsWith(op, i)) return op;
    }
    return src[i];
}

const C_OPS = [
    '<<=', '>>=', '<=>', '...',
    '->*', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '->', '++', '--', '::', '.*',
    '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?', ':', ';', ',',
    '(', ')', '[', ']', '{', '}', '.', '@', '#',
];

const PY_OPS = [
    '**=', '//=', '<<=', '>>=',
    '**', '//', '->', '<=', '>=', '==', '!=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
    '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '@', ':', ';', ',',
    '(', ')', '[', ']', '{', '}', '.',
];

const PAS_OPS = [
    ':=', '<=', '>=', '<>', '..',
    '+', '-', '*', '/', '=', '<', '>', '^', '@', ':', ';', ',', '(', ')', '[', ']', '.',
];

const PLAIN_OPS = [
    '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '->', '++', '--', '::',
    '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?', ':', ';', ',',
    '(', ')', '[', ']', '{', '}', '.', '@', '#', '$', '_',
];

/** Map a hydro `lang` key to a scanner family. */
export function langFamily(lang: string): Family {
    const l = (lang || '').toLowerCase();
    if (['c', 'cc', 'cc.cc98', 'cc.cc11', 'cc.cc11o2', 'cc.cc14', 'cc.cc17', 'cc.cc17o2',
        'cc.cc20', 'cc.cc20o2', 'cpp', 'cxx', 'gcc', 'g++', 'java', 'kt', 'kotlin', 'rs',
        'rust', 'go', 'golang', 'cs', 'csharp', 'swift', 'd', 'zig', 'nim'].some(
        (p) => l === p || l.startsWith(`${p}.`) || l.startsWith(`${p}-`),
    )) return 'c';
    if (['py', 'py2', 'py3', 'pypy', 'pypy3', 'python', 'python2', 'python3', 'rb', 'ruby',
        'pl', 'perl', 'php', 'lua', 'js', 'javascript', 'ts', 'typescript', 'sh', 'bash',
        'zsh', 'r'].some((p) => l === p || l.startsWith(`${p}.`) || l.startsWith(`${p}-`))) return 'python';
    if (['pas', 'pascal', 'fpc', 'fp'].some((p) => l === p || l.startsWith(`${p}.`) || l.startsWith(`${p}-`))) return 'pascal';
    return 'plain';
}

/** True when only whitespace was consumed since the last `\n` (or start). */
function atLineStart(src: string, i: number) {
    let j = i;
    while (j > 0) {
        const c = src[j - 1];
        if (c === '\n') return true;
        if (c !== ' ' && c !== '\t' && c !== '\r') return false;
        j--;
    }
    return true;
}

/** Consume a c-style string literal starting at `i` (src[i] is the quote). */
function readCString(src: string, i: number, quote: string) {
    let j = i + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === '\\') {
            j += 2;
            continue;
        }
        if (c === quote) return j + 1;
        if (c === '\n') return j; // unterminated: stop at newline
        j++;
    }
    return src.length;
}

function readNumber(src: string, i: number) {
    let j = i;
    while (j < src.length) {
        const c = src[j];
        if (isIdentChar(c) || c === '.') {
            // exponent sign (1e+5, 2E-3)
            if ((c === '+' || c === '-') && j > i && 'eE'.includes(src[j - 1])
                && /[0-9]/.test(src[j + 1] || '')) {
                j++;
                continue;
            }
            j++;
        } else break;
    }
    return j;
}

/** Skip a whole logical source line starting at `i` (handles `\` continuation). */
function skipLogicalLine(src: string, i: number) {
    let j = i;
    while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') j++; // line continuation
        j++;
    }
    return j;
}

/** Skip a pascal statement line up to and including the terminating `;`. */
function skipToSemicolon(src: string, i: number) {
    let j = i;
    while (j < src.length && src[j] !== ';' && src[j] !== '\n') j++;
    return j < src.length && src[j] === ';' ? j + 1 : j;
}

/**
 * Tokenize source code of the given family into structure-preserving tokens.
 * Comments, boilerplate lines and whitespace are dropped; literals and
 * identifiers become placeholders so that renames/reformats do not change
 * the token stream.
 */
export function tokenize(src: string, family: Family): Token[] {
    const tokens: Token[] = [];
    const push = (k: Token['k'], v: string) => tokens.push({ k, v });
    const n = src.length;
    let i = 0;
    const lower = family === 'pascal';
    const keywords = family === 'c' ? C_KEYWORDS
        : family === 'python' ? PY_KEYWORDS
            : family === 'pascal' ? PAS_KEYWORDS : null;
    const ops = family === 'c' ? C_OPS
        : family === 'python' ? PY_OPS
            : family === 'pascal' ? PAS_OPS : PLAIN_OPS;

    while (i < n) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
            i++;
            continue;
        }
        if (family === 'c' || family === 'plain') {
            if (c === '/' && src[i + 1] === '/') {
                i = skipLogicalLine(src, i);
                continue;
            }
            if (c === '/' && src[i + 1] === '*') {
                const end = src.indexOf('*/', i + 2);
                i = end === -1 ? n : end + 2;
                continue;
            }
        }
        if (family === 'c' && c === '#') {
            // preprocessor directive: drop the whole line (#include/#pragma/...)
            i = skipLogicalLine(src, i);
            continue;
        }
        if (family === 'c' && c === '"' ) {
            const end = readCString(src, i, '"');
            push('ph', 'S');
            i = end;
            continue;
        }
        if (family === 'c' && c === "'") {
            const end = readCString(src, i, "'");
            push('ph', 'C');
            i = end;
            continue;
        }
        if (family === 'python') {
            if (c === '#') {
                i = skipLogicalLine(src, i);
                continue;
            }
            if ((c === '"' || c === "'")
                && src[i + 1] === c && src[i + 2] === c) {
                const end = src.indexOf(c.repeat(3), i + 3);
                push('ph', 'S');
                i = end === -1 ? n : end + 3;
                continue;
            }
            if (c === '"' || c === "'") {
                const end = readCString(src, i, c);
                push('ph', 'S');
                i = end;
                continue;
            }
        }
        if (family === 'pascal') {
            if (c === '{' && src[i - 1] !== "'") {
                const end = src.indexOf('}', i + 1);
                i = end === -1 ? n : end + 1;
                continue;
            }
            if (c === '(' && src[i + 1] === '*') {
                const end = src.indexOf('*)', i + 2);
                i = end === -1 ? n : end + 2;
                continue;
            }
            if (c === "'") {
                let j = i + 1;
                while (j < n) {
                    if (src[j] === "'") {
                        if (src[j + 1] === "'") {
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    if (src[j] === '\n') break;
                    j++;
                }
                push('ph', 'S');
                i = Math.min(j + 1, n);
                continue;
            }
        }
        if (isDigit(c)) {
            i = readNumber(src, i);
            push('ph', 'N');
            continue;
        }
        if (isIdentStart(c)) {
            let j = i + 1;
            while (j < n && isIdentChar(src[j])) j++;
            const word = lower ? src.slice(i, j).toLowerCase() : src.slice(i, j);
            // boilerplate import/uses lines are dropped BEFORE keyword handling
            // (these words are also keywords of their family)
            if (family === 'python' && atLineStart(src, i)
                && (word === 'import' || word === 'from')) {
                i = skipLogicalLine(src, i);
                continue;
            }
            if (family === 'c' && atLineStart(src, i)
                && (word === 'import' || word === 'package')) {
                i = skipLogicalLine(src, i);
                continue;
            }
            if (family === 'c' && atLineStart(src, i) && word === 'using') {
                i = skipToSemicolon(src, i);
                continue;
            }
            if (family === 'pascal' && atLineStart(src, i)
                && (word === 'uses' || word === 'program')) {
                i = skipToSemicolon(src, i);
                continue;
            }
            if (keywords?.has(word)) push('kw', word);
            else push('ph', 'V');
            i = j;
            continue;
        }
        const op = readPunct(src, i, ops);
        push('punct', op);
        i += op.length;
    }
    return tokens;
}

/** Canonical text of a token stream — the fingerprint source. */
export function tokenText(tokens: Token[]): string {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
        if (i) out += '\n';
        out += tokens[i].v;
    }
    return out;
}
