// Placeholder vault: original <-> {{TYPE_n}}. The same original always gets the same placeholder,
// so the model can refer to "{{NIR_1}}" consistently across turns.
(function (root) {
  const PH = /\{\{([A-Z]+)_(\d+)\}\}/g;

  function createVault(initial) {
    const toPh = new Map(Object.entries((initial && initial.toPh) || {}));
    const toOrig = new Map(Object.entries((initial && initial.toOrig) || {}));
    const counters = Object.assign({}, (initial && initial.counters) || {});

    function placeholderFor(type, original) {
      const key = type + ":" + original.replace(/[\s.-]/g, "");
      const existing = toPh.get(key);
      if (existing) return existing;
      counters[type] = (counters[type] || 0) + 1;
      const ph = "{{" + type + "_" + counters[type] + "}}";
      toPh.set(key, ph);
      toOrig.set(ph, original);
      return ph;
    }

    // redact(text, matches from findPII) -> redacted text
    function redact(text, matches) {
      let out = "", cursor = 0;
      for (const m of matches) {
        out += text.slice(cursor, m.start) + placeholderFor(m.type, m.text);
        cursor = m.end;
      }
      return out + text.slice(cursor);
    }

    function restore(text) {
      return text.replace(PH, ph => toOrig.get(ph) || ph);
    }

    // Inverse of restore: show the placeholders the model actually received.
    function conceal(text) {
      let out = text;
      for (const [ph, orig] of toOrig) if (out.includes(orig)) out = out.split(orig).join(ph);
      return out;
    }

    function hasPlaceholder(text) { PH.lastIndex = 0; return PH.test(text); }

    function serialize() {
      return { toPh: Object.fromEntries(toPh), toOrig: Object.fromEntries(toOrig), counters };
    }

    return { redact, restore, conceal, hasPlaceholder, serialize, size: () => toOrig.size };
  }

  const api = { createVault, PH };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PFR = Object.assign(root.PFR || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
