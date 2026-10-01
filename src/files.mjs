// Attachment pipeline: turn a file into text "segments", let the caller redact them, write the file back.
//  - PDF with a text layer  -> segments = lines; output is a .txt (layout cannot be preserved in PDF)
//  - PDF without text layer -> { scanned: true } (caller blocks the upload; OCR is a later step)
//  - DOCX / XLSX            -> segments = paragraphs / cells; rewritten in place, layout preserved
//  - TXT / CSV / MD         -> one segment
// Pure functions where possible so Node tests and the offscreen document share the code.
import JSZip from "jszip";

export const SUPPORTED = /\.(pdf|docx|xlsx|txt|csv|md)$/i;

// ---------------------------------------------------------------- XML text helpers
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A segment is text made of pieces (XML text nodes). `rewriteSegment` maps a redacted string back onto the
// pieces: a placeholder replacing a span that crosses several pieces lands in the first piece, the rest shrink.
export function rewritePieces(pieces, original, redacted, replacements) {
  // replacements: [{start, end, repl}] over `original`, sorted, non-overlapping
  const out = pieces.map(p => "");
  const bounds = [];
  let acc = 0;
  for (const p of pieces) { bounds.push([acc, acc + p.length]); acc += p.length; }
  let cursor = 0, ri = 0;
  const emit = (pos, s) => {            // append s to the piece that owns original position pos
    let i = bounds.findIndex(([a, b]) => pos >= a && pos < b);
    if (i === -1) i = pieces.length - 1;
    out[i] += s;
  };
  for (let pos = 0; pos < original.length;) {
    const r = replacements[ri];
    if (r && r.start === pos) { emit(pos, r.repl); pos = r.end; ri++; continue; }
    const stop = r ? r.start : original.length;
    for (; pos < stop; pos++) emit(pos, original[pos]);
  }
  void cursor; void redacted;
  return out;
}

// Build replacements from (original, redacted) when the caller only returns the redacted string:
// placeholders are {{TYPE_n}}; everything else is unchanged text, so a diff is unambiguous.
export function diffReplacements(original, redacted) {
  const reps = [];
  const PH = /\{\{[A-Z]+_\d+\}\}/g;
  let oi = 0, ri = 0, m;
  while ((m = PH.exec(redacted)) !== null) {
    const keep = redacted.slice(ri, m.index);          // unchanged text before the placeholder
    if (original.slice(oi, oi + keep.length) !== keep) throw new Error("redacted text diverged from original");
    oi += keep.length;
    // the placeholder replaced original[oi .. k) where original resumes with the text after the placeholder
    const after = redacted.slice(m.index + m[0].length);
    const nextPh = after.search(PH);
    const tail = nextPh === -1 ? after : after.slice(0, nextPh);
    let k;
    if (tail.length === 0) k = original.length;
    else { k = original.indexOf(tail, oi + 1); if (k === -1) throw new Error("cannot align placeholder"); }
    reps.push({ start: oi, end: k, repl: m[0] });
    oi = k;
    ri = m.index + m[0].length;
  }
  return reps;
}

// ---------------------------------------------------------------- DOCX
const W_T = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;

export async function docxSegments(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter(n => /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(n));
  const segments = [];   // {id, text, part, para, pieces:[{start,end,text}]}
  const xml = {};
  for (const part of parts) {
    xml[part] = await zip.file(part).async("string");
    const paras = xml[part].split(/(?=<w:p[ >])/);
    paras.forEach((para, pi) => {
      const pieces = [];
      let m;
      W_T.lastIndex = 0;
      while ((m = W_T.exec(para)) !== null) pieces.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] || "", text: unesc(m[2]) });
      if (pieces.length) segments.push({ id: `${part}#${pi}`, part, para: pi, text: pieces.map(p => p.text).join(""), pieces });
    });
  }
  return { zip, xml, segments };
}

export async function docxRewrite(doc, redactedById) {
  const { zip, xml, segments } = doc;
  const byPart = {};
  for (const s of segments) (byPart[s.part] = byPart[s.part] || []).push(s);
  for (const part of Object.keys(byPart)) {
    const paras = xml[part].split(/(?=<w:p[ >])/);
    for (const s of byPart[part]) {
      const red = redactedById[s.id];
      if (red === undefined || red === s.text) continue;
      const newTexts = rewritePieces(s.pieces.map(p => p.text), s.text, red, diffReplacements(s.text, red));
      let para = paras[s.para], shift = 0;
      s.pieces.forEach((p, i) => {
        const attrs = /xml:space/.test(p.attrs) ? p.attrs : p.attrs + ' xml:space="preserve"';
        const repl = `<w:t${attrs}>${esc(newTexts[i])}</w:t>`;
        para = para.slice(0, p.start + shift) + repl + para.slice(p.end + shift);
        shift += repl.length - (p.end - p.start);
      });
      paras[s.para] = para;
    }
    zip.file(part, paras.join(""));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// ---------------------------------------------------------------- XLSX
const T_RUN = /<t(\s[^>]*)?>([^<]*)<\/t>/g;

export async function xlsxSegments(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const segments = [];
  const xml = {};
  // shared strings: one segment per <si>
  if (zip.file("xl/sharedStrings.xml")) {
    const part = "xl/sharedStrings.xml";
    xml[part] = await zip.file(part).async("string");
    const sis = xml[part].split(/(?=<si>)/);
    sis.forEach((si, i) => {
      const pieces = [];
      let m;
      T_RUN.lastIndex = 0;
      while ((m = T_RUN.exec(si)) !== null) pieces.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] || "", text: unesc(m[2]) });
      if (pieces.length) segments.push({ id: `${part}#${i}`, part, para: i, text: pieces.map(p => p.text).join(""), pieces, kind: "si" });
    });
  }
  // sheets: inline strings and numeric values (a SIRET typed as a number lives in <v>)
  for (const part of Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    xml[part] = await zip.file(part).async("string");
    const cellRe = /<c\b([^>]*)>(.*?)<\/c>/gs;
    let m, i = 0;
    while ((m = cellRe.exec(xml[part])) !== null) {
      const attrs = m[1], inner = m[2];
      if (/t="s"/.test(attrs)) { i++; continue; }                       // shared string: handled above
      if (/<f>/.test(inner)) { i++; continue; }                          // formula: leave alone
      const is = /<is>.*?<t(\s[^>]*)?>([^<]*)<\/t>.*?<\/is>/s.exec(inner);
      const v = /<v>([^<]*)<\/v>/.exec(inner);
      if (is) segments.push({ id: `${part}#${i}`, part, text: unesc(is[2]), cell: { start: m.index, end: m.index + m[0].length, attrs }, kind: "is" });
      else if (v && !/t="b"|t="e"|t="d"/.test(attrs)) segments.push({ id: `${part}#${i}`, part, text: v[1], cell: { start: m.index, end: m.index + m[0].length, attrs }, kind: "v" });
      i++;
    }
  }
  return { zip, xml, segments };
}

export async function xlsxRewrite(doc, redactedById) {
  const { zip, xml, segments } = doc;
  const byPart = {};
  for (const s of segments) (byPart[s.part] = byPart[s.part] || []).push(s);
  for (const part of Object.keys(byPart)) {
    if (part === "xl/sharedStrings.xml") {
      const sis = xml[part].split(/(?=<si>)/);
      for (const s of byPart[part]) {
        const red = redactedById[s.id];
        if (red === undefined || red === s.text) continue;
        const newTexts = rewritePieces(s.pieces.map(p => p.text), s.text, red, diffReplacements(s.text, red));
        let si = sis[s.para], shift = 0;
        s.pieces.forEach((p, i) => {
          const attrs = /xml:space/.test(p.attrs) ? p.attrs : p.attrs + ' xml:space="preserve"';
          const repl = `<t${attrs}>${esc(newTexts[i])}</t>`;
          si = si.slice(0, p.start + shift) + repl + si.slice(p.end + shift);
          shift += repl.length - (p.end - p.start);
        });
        sis[s.para] = si;
      }
      zip.file(part, sis.join(""));
    } else {
      let sheet = xml[part], shift = 0;
      for (const s of byPart[part].sort((a, b) => a.cell.start - b.cell.start)) {
        const red = redactedById[s.id];
        if (red === undefined || red === s.text) continue;
        // a masked value becomes an inline string cell (numbers cannot hold a placeholder)
        const attrs = s.cell.attrs.replace(/\s*t="[^"]*"/, "") + ' t="inlineStr"';
        const repl = `<c${attrs}><is><t xml:space="preserve">${esc(red)}</t></is></c>`;
        sheet = sheet.slice(0, s.cell.start + shift) + repl + sheet.slice(s.cell.end + shift);
        shift += repl.length - (s.cell.end - s.cell.start);
      }
      zip.file(part, sheet);
    }
  }
  // Excel caches formula results in <v>; leave them, Excel recalculates on open.
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// ---------------------------------------------------------------- PDF (text layer only)
export async function pdfSegments(bytes, pdfjs) {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const segments = [];
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // group items into lines by their y coordinate (transform[5]), keep reading order
    const lines = [];
    for (const it of content.items) {
      if (!("str" in it)) continue;
      const y = Math.round(it.transform[5]);
      let line = lines.find(l => Math.abs(l.y - y) <= 2);
      if (!line) { line = { y, items: [] }; lines.push(line); }
      line.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    lines.forEach((l, li) => {
      l.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const text = l.items.map(i => i.str).join(" ").replace(/\s+/g, " ").trim();
      if (!text) return;
      chars += text.length;
      segments.push({ id: `p${p}#${li}`, page: p, text });
    });
  }
  const scanned = doc.numPages > 0 && chars < 20 * doc.numPages;
  return { segments, numPages: doc.numPages, scanned };
}

export function pdfToText(segments, redactedById) {
  let out = "", page = 0;
  for (const s of segments) {
    if (s.page !== page) { out += (page ? "\n\n" : "") + `--- page ${s.page} ---\n`; page = s.page; }
    out += (redactedById[s.id] ?? s.text) + "\n";
  }
  return out;
}

export function outputName(name, toTxt) {
  const i = name.lastIndexOf(".");
  const base = i === -1 ? name : name.slice(0, i), ext = i === -1 ? "" : name.slice(i);
  return base + "-masqué" + (toTxt ? ".txt" : ext);
}
