// Bundle the offscreen document (transformers.js + ner.mjs) and copy the ONNX Runtime WASM files.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const vendor = path.join(root, "vendor");
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(vendor, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "offscreen.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: true,
  outfile: path.join(dist, "offscreen.js"),
  external: ["onnxruntime-node", "sharp", "node:*", "fs", "path", "url", "stream", "crypto"],
  logLevel: "warning",
});

// ORT web runtime: single-threaded WASM (no cross-origin isolation in extension pages) + its loader module.
const ortDist = path.join(root, "node_modules", "onnxruntime-web", "dist");
// ORT picks a variant at runtime (this transformers.js build asks for the asyncify one), so ship them all.
const wanted = fs.readdirSync(ortDist).filter(f => /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f));
for (const f of wanted) fs.copyFileSync(path.join(ortDist, f), path.join(vendor, f));
const size = f => (fs.statSync(f).size / 1048576).toFixed(1) + " MB";
console.log("dist/offscreen.js", size(path.join(dist, "offscreen.js")));
for (const f of wanted) console.log("vendor/" + f, size(path.join(vendor, f)));
