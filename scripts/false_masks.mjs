import fs from "node:fs";
import { createRequire } from "node:module";
import { configure, load, nerSpans } from "../src/ner.mjs";
const require = createRequire(import.meta.url);
const { findPII } = require("../src/recognizers.js");
const { combine } = require("../src/nermap.js");
configure({ cacheDir: "C:/hfcache/tjs" });
await load();
const docs = fs.readFileSync("test/fixtures/fr_pii_bench_v0.jsonl", "utf8").trim().split("\n").map(JSON.parse);
const byType = {}, ex = {};
for (const d of docs) {
  const spans = combine(d.text, findPII(d.text), await nerSpans(d.text));
  for (const s of spans) {
    const ov = d.entities.some(g => Math.min(g.end, s.end) > Math.max(g.start, s.start));
    if (ov) continue;
    const k = s.type + "/" + s.src;
    byType[k] = (byType[k] || 0) + 1;
    (ex[k] = ex[k] || []).length < 4 && ex[k].push(s.text);
  }
}
for (const [k, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), k.padEnd(16), JSON.stringify(ex[k]));
