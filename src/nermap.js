// Map raw nym labels to product labels, drop what the benchmark showed to be noise, merge name parts.
// Plain script: shared by the content script (browser) and Node tests.
(function (root) {
  const LABEL = {
    GIVEN_NAME: "PERSON", SURNAME: "PERSON",
    STREET_ADDRESS: "ADDRESS", STREET_NAME: "ADDRESS", BUILDING_NUMBER: "ADDRESS", ZIP_CODE: "ADDRESS",
    CITY: "ADDRESS", SECONDARY_ADDRESS: "ADDRESS",
    COMPANY_NAME: "COMPANY", DATE_OF_BIRTH: "DOB",
    // DATE is only kept when the text says it is a birth date (FR-PII-Bench: generic DATE = invoice dates = false masks)
    DATE: "DOB?",
    PASSPORT: "PASSEPORT", LICENSE_PLATE: "PLAQUE", IBAN: "IBAN", EMAIL: "EMAIL", PHONE: "PHONE",
    SSN: "NIR", GOVERNMENT_ID: "ID", TAX_ID: "ID", CREDIT_DEBIT_CARD: "CARD", API_KEY: "SECRET", PASSWORD: "SECRET",
  };
  const BIRTH_CTX = /\bn[ée]e?s?\s*(?:\(e\))?\s*(?:le|à|a)?\s*$|naissance\s*(?::|le)?\s*$/i;
  const MIN_SCORE = 0.5;

  // spans: raw nym spans [{label,start,end,score}] -> [{type,start,end,text}] sorted, non-overlapping
  function mapSpans(text, spans) {
    const out = [];
    for (const s of spans) {
      if (s.score < MIN_SCORE) continue;
      let type = LABEL[s.label];
      if (!type) continue;
      if (type === "DOB?") {
        if (!BIRTH_CTX.test(text.slice(Math.max(0, s.start - 24), s.start))) continue;
        type = "DOB";
      }
      out.push({ type, start: s.start, end: s.end });
    }
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    // merge adjacent pieces of the same type (GIVEN_NAME + SURNAME, street + zip + city)
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      const gap = last ? text.slice(last.end, s.start) : null;
      if (last && last.type === s.type && s.start >= last.end && /^[\s,'-]{0,3}$/.test(gap)) {
        last.end = Math.max(last.end, s.end);
      } else if (!last || s.start >= last.end) {
        merged.push({ type: s.type, start: s.start, end: s.end });
      }
    }
    for (const m of merged) m.text = text.slice(m.start, m.end);
    return merged;
  }

  // Combine regex matches (authoritative for structured ids) with NER spans: regex wins on overlap.
  function combine(text, regexMatches, nerRaw) {
    const all = regexMatches.map(m => ({ type: m.type, start: m.start, end: m.end, text: m.text, src: "regex" }));
    for (const s of mapSpans(text, nerRaw)) {
      if (all.some(a => Math.min(a.end, s.end) > Math.max(a.start, s.start))) continue;
      all.push({ ...s, src: "ner" });
    }
    return all.sort((a, b) => a.start - b.start);
  }

  const api = { mapSpans, combine, LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PFR = Object.assign(root.PFR || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
