/**
 * Line-level LCS diff for the side-by-side evidence view.
 *
 * Classic DP with a Uint16Array length matrix and backtrack by value
 * comparison. `n*m > cellLimit` returns null so the template can degrade to a
 * plain unhighlighted side-by-side view (protects the request from huge
 * submissions).
 */

export interface DiffRow {
    l?: number;
    r?: number;
    type: 'eq' | 'ins' | 'del';
}

export function splitLines(code: string): string[] {
    return code.replace(/\r\n/g, '\n').split('\n');
}

export function lineDiff(a: string[], b: string[], cellLimit = 4_000_000): DiffRow[] | null {
    const n = a.length;
    const m = b.length;
    if (n * m > cellLimit) return null;
    // whitespace-insensitive comparison: lines equal after trim()
    const na = a.map((l) => l.trim());
    const nb = b.map((l) => l.trim());
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = na[i] === nb[j]
                ? dp[(i + 1) * w + j + 1] + 1
                : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
    }
    const rows: DiffRow[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (na[i] === nb[j] && dp[i * w + j] === dp[(i + 1) * w + j + 1] + 1) {
            rows.push({ l: i + 1, r: j + 1, type: 'eq' });
            i++;
            j++;
        } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
            rows.push({ l: i + 1, type: 'del' });
            i++;
        } else {
            rows.push({ r: j + 1, type: 'ins' });
            j++;
        }
    }
    while (i < n) rows.push({ l: ++i, type: 'del' });
    while (j < m) rows.push({ r: ++j, type: 'ins' });
    return rows;
}
