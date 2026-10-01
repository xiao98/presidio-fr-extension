import { createRequire } from "node:module";
import { configure, load, nerSpans } from "../src/ner.mjs";
const require = createRequire(import.meta.url);
const { findPII } = require("../src/recognizers.js");
const { combine, createVault } = { ...require("../src/nermap.js"), ...require("../src/vault.js") };
configure({ cacheDir: "C:/hfcache/tjs" });
await load();
for (const t of process.argv.slice(2)) {
  const v = createVault();
  console.log(JSON.stringify(t), "->", JSON.stringify(v.redact(t, combine(t, findPII(t), await nerSpans(t)))));
}
