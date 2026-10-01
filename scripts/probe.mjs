import { configure, load, nerSpans } from "../src/ner.mjs";
configure({ cacheDir: "C:/hfcache/tjs" });
await load();
for (const t of process.argv.slice(2)) {
  const s = await nerSpans(t);
  console.log(JSON.stringify(t), "->", s.map(x => `${x.label}:"${x.text}"(${x.score.toFixed(2)})`).join("  ") || "(nothing)");
}
