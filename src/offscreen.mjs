// Offscreen document: hosts the NER model (WASM) so it stays loaded across page navigations.
// Bundled by scripts/build.mjs into dist/offscreen.js.
import { configure, load, nerSpans, isReady } from "./ner.mjs";

configure({ wasmPaths: chrome.runtime.getURL("vendor/"), numThreads: 1 });

let progress = { status: "loading", pct: 0 };
load((p) => {
  if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) progress = { status: "loading", pct: Math.round(p.progress) };
}).then(() => { progress = { status: "ready", pct: 100 }; })
  .catch((e) => { progress = { status: "error", error: String(e && e.message || e) }; });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "status") { sendResponse(progress); return; }
  if (msg.type === "ner") {
    (async () => {
      if (!isReady()) { sendResponse({ error: progress.status === "error" ? "model_error" : "not_ready", progress }); return; }
      try { sendResponse({ spans: await nerSpans(msg.text) }); }
      catch (e) { sendResponse({ error: "model_error", detail: String(e && e.message || e) }); }
    })();
    return true;
  }
});
