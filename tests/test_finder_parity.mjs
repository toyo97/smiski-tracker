/**
 * Finder parity test — the static preview computes likelihoods in JavaScript
 * (static/finder.js) while the real app uses server.py's /api/finder. Both must
 * agree, or the preview would lie about the maths.
 *
 * Usage:
 *   python3 sync.py && python3 tools/export_static.py   # need dist/demo/catalog.json
 *   python3 -m uvicorn server:app --port 8123           # server to compare against
 *   node tests/test_finder_parity.mjs
 */

import fs from "fs";
import { finder } from "../static/finder.js";

const BASE = process.env.BASE || "http://localhost:8123";
const catalog = JSON.parse(fs.readFileSync(new URL("../dist/demo/catalog.json", import.meta.url)));

const series = [...new Set(catalog.figures.map((f) => f.series))];
let comparisons = 0;
let worst = 0;
let worstAt = "";
const failures = [];

for (const s of series) {
  const rows = catalog.figures.filter((f) => f.series === s);
  const avgs = rows.flatMap((r) => [r.avg_boxed, r.avg_unboxed]).filter((x) => x != null);
  if (!avgs.length) continue;
  const lo = Math.min(...avgs);
  const hi = Math.max(...avgs);
  for (const weight of [lo - 1, lo + (hi - lo) / 2, hi + 1, lo, hi]) {
    for (const mode of ["boxed", "unboxed"]) {
      const js = finder(rows, weight, mode);
      const py = await (
        await fetch(`${BASE}/api/finder?series=${encodeURIComponent(s)}&weight=${weight}&mode=${mode}`)
      ).json();

      const pyByKey = new Map(py.results.map((r) => [r.key, r.likelihood]));
      if (py.results.length !== js.results.length) {
        failures.push(`${s} @${weight}g ${mode}: result count ${js.results.length} vs ${py.results.length}`);
      }
      for (const r of js.results) {
        const diff = Math.abs(r.likelihood - pyByKey.get(r.key));
        comparisons++;
        if (diff > worst) {
          worst = diff;
          worstAt = `${s} @${weight}g ${mode} ${r.name}`;
        }
      }
      // same top pick
      const jsTop = js.results[0]?.key;
      const pyTop = py.results[0]?.key;
      if (jsTop !== pyTop) {
        failures.push(`${s} @${weight}g ${mode}: top pick ${jsTop} vs ${pyTop}`);
      }
      if (js.no_data.length !== py.no_data.length) {
        failures.push(`${s} @${weight}g ${mode}: no-data count differs`);
      }
    }
  }
}

console.log(`compared ${comparisons} likelihoods across ${series.length} series`);
console.log(`largest difference: ${worst.toFixed(4)} percentage points (${worstAt})`);
if (failures.length) {
  console.log("MISMATCHES:");
  failures.slice(0, 20).forEach((f) => console.log("  -", f));
  console.log(`\nFINDER PARITY FAILED (${failures.length})`);
  process.exit(1);
}
// tolerance covers Python's banker's rounding vs JS Math.round at .5 boundaries
if (worst > 0.15) {
  console.log(`\nFINDER PARITY FAILED: difference too large (${worst})`);
  process.exit(1);
}
console.log("\nFINDER PARITY PASSED");
