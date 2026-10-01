// Offscreen document: hosts the NER model (WASM) and the attachment pipeline (pdf.js worker, JSZip),
// so both stay loaded across page navigations. Bundled by scripts/build.mjs into dist/offscreen.js.
import * as pdfjs from "pdfjs-dist";
import { configure, load, nerSpans, isReady } from "./ner.mjs";
import { docxSegments, docxRewrite, xlsxSegments, xlsxRewrite, pdfSegments, pdfToText, outputName } from "./files.mjs";

configure({ wasmPaths: chrome.runtime.getURL("vendor/"), numThreads: 1 });
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

let progress = { status: "loading", pct: 0 };
load((p) => {
  if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) progress = { status: "loading", pct: Math.round(p.progress) };
}).then(() => { progress = { status: "ready", pct: 100 }; })
  .catch((e) => { progress = { status: "error", error: String(e && e.message || e) }; });

// ---------- attachments ----------
const jobs = new Map();   // job id -> { kind, name, doc }
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function extract(name, b64, useNer) {
  const bytes = b64ToBytes(b64);
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  let kind, doc, segments, scanned = false;
  if (ext === "pdf") {
    kind = "pdf";
    const r = await pdfSegments(bytes, pdfjs);
    segments = r.segments; scanned = r.scanned;
  } else if (ext === "docx") { kind = "docx"; doc = await docxSegments(bytes); segments = doc.segments; }
  else if (ext === "xlsx") { kind = "xlsx"; doc = await xlsxSegments(bytes); segments = doc.segments; }
  else if (["txt", "csv", "md"].includes(ext)) {
    kind = "text";
    const text = new TextDecoder("utf-8").decode(bytes);
    segments = text.split(/\r?\n/).map((t, i) => ({ id: "l" + i, text: t }));
  } else return { error: "unsupported" };
  if (scanned) return { error: "scanned" };
  // NER on every non-trivial segment (the content script owns the vault, so it does the redaction)
  const out = [];
  for (const s of segments) {
    const ner = useNer && s.text.trim().length >= 3 && isReady() ? await nerSpans(s.text) : [];
    out.push({ id: s.id, text: s.text, ner });
  }
  const job = Math.random().toString(36).slice(2);
  jobs.set(job, { kind, name, doc, segments });
  setTimeout(() => jobs.delete(job), 10 * 60 * 1000);
  return { job, kind, segments: out, nerReady: isReady() };
}

async function rewrite(job, redactedById) {
  const j = jobs.get(job);
  if (!j) return { error: "job_expired" };
  let bytes, name, mime;
  if (j.kind === "docx") { bytes = await docxRewrite(j.doc, redactedById); name = outputName(j.name, false); mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; }
  else if (j.kind === "xlsx") { bytes = await xlsxRewrite(j.doc, redactedById); name = outputName(j.name, false); mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
  else if (j.kind === "pdf") { bytes = new TextEncoder().encode(pdfToText(j.segments, redactedById)); name = outputName(j.name, true); mime = "text/plain"; }
  else { bytes = new TextEncoder().encode(j.segments.map(s => redactedById[s.id] ?? s.text).join("\n")); name = outputName(j.name, false); mime = "text/plain"; }
  jobs.delete(job);
  return { name, mime, b64: bytesToB64(bytes) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "status") { sendResponse(progress); return; }
  (async () => {
    try {
      if (msg.type === "ner") {
        if (!isReady()) { sendResponse({ error: progress.status === "error" ? "model_error" : "not_ready", progress }); return; }
        sendResponse({ spans: await nerSpans(msg.text) });
      } else if (msg.type === "file.extract") {
        if (msg.ner && !isReady() && progress.status !== "error") { sendResponse({ error: "not_ready", progress }); return; }
        sendResponse(await extract(msg.name, msg.b64, !!msg.ner && isReady()));
      } else if (msg.type === "file.rewrite") {
        sendResponse(await rewrite(msg.job, msg.redactedById));
      } else sendResponse({ error: "unknown_type" });
    } catch (e) {
      sendResponse({ error: "model_error", detail: String(e && e.message || e) });
    }
  })();
  return true;
});
