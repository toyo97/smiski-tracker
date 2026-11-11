/**
 * Finder maths — shared by the static preview.
 *
 * Mirrors server.py's /api/finder exactly: Student-t predictive distributions
 * built from the community measurements (mean/sd/n per figure, per packaging
 * mode), normalised across the series into likelihood percentages.
 *
 * The server keeps its own Python implementation for the real API; the two are
 * kept in sync by tests/test_finder_parity.mjs, which compares this module's
 * output against the live endpoint.
 */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(z), Lanczos approximation (accurate to ~1e-10). */
function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** log density of Student-t at t with df degrees of freedom. */
function tLogpdf(t, df) {
  if (df < 1) return -Infinity;
  return (
    lgamma((df + 1) / 2) -
    lgamma(df / 2) -
    0.5 * Math.log(df * Math.PI) -
    ((df + 1) / 2) * Math.log(1 + (t * t) / df)
  );
}

const round = (x, d) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

/**
 * Score a measured weight against every figure in a series.
 * @param {Array} rows  figures of one series, with stats_boxed/stats_unboxed
 * @param {number} weight  measured weight in grams
 * @param {"boxed"|"unboxed"} mode
 * @returns {{results: Array, no_data: Array}}
 */
export function finder(rows, weight, mode) {
  const sCol = mode === "boxed" ? "stats_boxed" : "stats_unboxed";
  const aCol = mode === "boxed" ? "avg_boxed" : "avg_unboxed";

  // pooled sd within the series, for figures without enough samples
  let pooledSum = 0;
  let pooledN = 0;
  for (const r of rows) {
    const st = r[sCol];
    if (st && st.sd != null && st.n >= 2) {
      pooledSum += (st.n - 1) * st.sd * st.sd;
      pooledN += st.n - 1;
    }
  }
  const pooledSd = pooledN ? Math.sqrt(pooledSum / pooledN) : 3.0;
  const pooledDf = Math.max(pooledN, 5);

  const scored = [];
  const noData = [];
  for (const r of rows) {
    const st = r[sCol];
    let n, mean, sd, df;
    if (st && st.n) {
      n = st.n;
      mean = st.mean;
      sd = st.sd != null ? st.sd : pooledSd;
      df = n >= 2 ? n - 1 : pooledDf;
    } else if (r[aCol] != null) {
      n = 1;
      mean = r[aCol];
      sd = pooledSd;
      df = pooledDf;
    } else {
      noData.push({
        key: r.key, name: r.name, image: r.image,
        is_secret: r.is_secret, has_data: false,
      });
      continue;
    }
    const t = (weight - mean) / (sd * Math.sqrt(1 + 1 / n));
    scored.push({
      key: r.key,
      name: r.name,
      image: r.image,
      is_secret: r.is_secret,
      has_data: true,
      mean: round(mean, 2),
      sd: round(sd, 2),
      n,
      delta: round(weight - mean, 2),
      t: round(t, 2),
      logLik: tLogpdf(t, df) - Math.log(sd * Math.sqrt(1 + 1 / n)),
    });
  }

  if (scored.length) {
    const max = Math.max(...scored.map((c) => c.logLik));
    const exps = scored.map((c) => Math.exp(c.logLik - max));
    const total = exps.reduce((a, x) => a + x, 0);
    scored.forEach((c, i) => {
      c.likelihood = round((100 * exps[i]) / total, 1);
      delete c.logLik;
    });
    scored.sort((a, b) => b.likelihood - a.likelihood);
  }
  return { results: scored, no_data: noData };
}
