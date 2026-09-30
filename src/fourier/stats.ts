/** Small least-squares helpers (no dependencies). */
export function solve(A: number[][], b: number[]): number[] | null {
  const m = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let i = c + 1; i < m; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) return null;
    for (let i = 0; i < m; i++) {
      if (i === c) continue;
      const f = M[i][c] / M[c][c];
      for (let j = c; j <= m; j++) M[i][j] -= f * M[c][j];
    }
  }
  return M.map((r, i) => r[m] / r[i]);
}

/** OLS of y on the given columns → coefficients, residual sum of squares, and (X'X) for inference. */
export function ols(cols: number[][], y: number[]): { beta: number[]; ssr: number; xtx: number[][] } | null {
  const m = cols.length, N = y.length;
  const xtx = Array.from({ length: m }, () => new Array<number>(m).fill(0)), xty = new Array<number>(m).fill(0);
  for (let n = 0; n < N; n++) for (let i = 0; i < m; i++) {
    const ci = cols[i][n]; xty[i] += ci * y[n];
    for (let j = i; j < m; j++) xtx[i][j] += ci * cols[j][n];
  }
  for (let i = 0; i < m; i++) for (let j = 0; j < i; j++) xtx[i][j] = xtx[j][i];
  const beta = solve(xtx, xty);
  if (!beta) return null;
  let ssr = 0;
  for (let n = 0; n < N; n++) { let f = 0; for (let i = 0; i < m; i++) f += beta[i] * cols[i][n]; ssr += (y[n] - f) ** 2; }
  return { beta, ssr, xtx };
}

/** Seeded PRNG so simulations are reproducible run to run. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}
export const upperP = (sorted: number[], v: number) => (sorted.filter((x) => x >= v).length + 1) / (sorted.length + 1);
export const lowerP = (sorted: number[], v: number) => (sorted.filter((x) => x <= v).length + 1) / (sorted.length + 1);
