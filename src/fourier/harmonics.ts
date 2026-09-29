/**
 * Least-squares fit of y[n] ≈ a + b·(n/N) + Σ_j (c_j cos 2πf_j n + s_j sin 2πf_j n)
 * at fixed frequencies f_j (cycles per sample). Once the FFT has located the rhythms, this
 * recovers their amplitude and phase exactly (no bin-centering error) and gives a model that
 * can be evaluated beyond the end of the data.
 */
export interface HarmonicModel {
  predict(n: number): number;
  r2: number;
  components: { f: number; c: number; s: number }[];
}

export function harmonicFit(y: number[], freqs: number[]): HarmonicModel | null {
  const N = y.length, m = 2 + 2 * freqs.length;
  const basis = (n: number): number[] => {
    const r = [1, n / N];
    for (const f of freqs) { const g = 2 * Math.PI * f * n; r.push(Math.cos(g), Math.sin(g)); }
    return r;
  };
  const A = Array.from({ length: m }, () => new Array<number>(m + 1).fill(0));
  for (let n = 0; n < N; n++) {
    const r = basis(n);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += r[i] * r[j];
      A[i][m] += r[i] * y[n];
    }
  }
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  const beta = A.map((row, i) => row[m] / row[i]);
  const predict = (n: number) => basis(n).reduce((s, v, i) => s + v * beta[i], 0);

  const mean = y.reduce((s, v) => s + v, 0) / N;
  let ssRes = 0, ssTot = 0;
  for (let n = 0; n < N; n++) { ssRes += (y[n] - predict(n)) ** 2; ssTot += (y[n] - mean) ** 2; }
  return {
    predict,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    components: freqs.map((f, j) => ({ f, c: beta[2 + 2 * j], s: beta[3 + 2 * j] })),
  };
}
