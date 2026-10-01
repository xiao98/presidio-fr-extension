// The JS NER path (transformers.js + token→char alignment) must score on FR-PII-Bench like the Python
// onnxruntime run did (recall_any 0.968 / precision 0.895 for raw nym). Exact span identity is not the
// yardstick: Python offsets include SentencePiece leading spaces and int8 kernels differ slightly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { configure, load, nerSpans } from "../src/ner.mjs";

const require = createRequire(import.meta.url);
const { findPII } = require("../src/recognizers.js");
const { combine } = require("../src/nermap.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = fs.readFileSync(path.join(here, "fixtures", "fr_pii_bench_v0.jsonl"), "utf8").trim().split("\n").map(JSON.parse);

function covered(g, spans, thr = 0.8) {
  const chars = new Set();
  for (const s of spans) for (let i = Math.max(g.start, s.start); i < Math.min(g.end, s.end); i++) chars.add(i);
  return chars.size >= thr * (g.end - g.start);
}
function score(pred) {
  let n = 0, hit = 0, np = 0, tp = 0, fm = 0;
  const byLabel = {};
  for (const d of docs) {
    const spans = pred[d.id];
    for (const g of d.entities) {
      n++;
      byLabel[g.label] = byLabel[g.label] || { n: 0, hit: 0 };
      byLabel[g.label].n++;
      if (covered(g, spans)) { hit++; byLabel[g.label].hit++; }
    }
    for (const s of spans) {
      np++;
      let ov = 0;
      for (const g of d.entities) ov += Math.max(0, Math.min(g.end, s.end) - Math.max(g.start, s.start));
      if (ov >= 0.5 * (s.end - s.start)) tp++; else if (ov === 0) fm++;
    }
  }
  return { recall: hit / n, precision: tp / np, falseMasks: fm, byLabel };
}

test("JS NER on FR-PII-Bench: raw nym and product config (nym + regex, DATE gated)", { timeout: 900000 }, async () => {
  configure({ cacheDir: process.env.TJS_CACHE || "C:/hfcache/tjs" });
  await load();
  const raw = {}, product = {};
  const t0 = Date.now();
  for (const d of docs) {
    const spans = await nerSpans(d.text);
    raw[d.id] = spans;
    product[d.id] = combine(d.text, findPII(d.text), spans);
  }
  const ms = (Date.now() - t0) / docs.length;
  const r = score(raw), p = score(product);
  console.log(`raw nym (JS):      recall_any ${r.recall.toFixed(3)}  precision ${r.precision.toFixed(3)}  false masks ${r.falseMasks}   (${ms.toFixed(0)} ms/doc)`);
  console.log(`nym+regex, gated:  recall_any ${p.recall.toFixed(3)}  precision ${p.precision.toFixed(3)}  false masks ${p.falseMasks}`);
  console.log("product recall by label:", JSON.stringify(Object.fromEntries(Object.entries(p.byLabel).map(([k, v]) => [k, +(v.hit / v.n).toFixed(2)]))));
  // PERSON recall by writing style (the administrative caps form is the known weak spot)
  const style = { caps: [0, 0], other: [0, 0] };
  for (const d of docs) for (const g of d.entities) if (g.label === "PERSON") {
    const k = /^[A-ZÀ-Ö' -]+ [A-ZÀ-Ö][a-zà-ÿ]/.test(g.text) ? "caps" : "other";
    style[k][1]++; if (covered(g, product[d.id])) style[k][0]++;
  }
  console.log(`PERSON recall  caps ${(style.caps[0] / style.caps[1]).toFixed(2)} (n=${style.caps[1]})  other ${(style.other[0] / style.other[1]).toFixed(2)} (n=${style.other[1]})`);
  assert.ok(r.recall >= 0.95, "raw JS recall below Python run");
  assert.ok(p.recall >= 0.93 && p.precision >= 0.95, "product config regressed vs Python union_nodate (0.948 / 0.978)");
});
