(async function () {
  const { findPII, createVault, combine } = globalThis.PFR;
  const VAULT_KEY = "vault:" + location.host;
  const STATS_KEY = "stats";

  let enabled = true;
  let reveal = false;   // true: show messages as ChatGPT sees them (placeholders), false: restore originals
  // storage.session can throw if the service worker has not yet granted content-script access; fall back to memory.
  let saved;
  try { saved = (await chrome.storage.session.get(VAULT_KEY))[VAULT_KEY]; } catch (_) { saved = undefined; }
  let vault = createVault(saved);
  chrome.storage.local.get({ enabled: true, reveal: false }).then(v => { enabled = v.enabled; reveal = v.reveal; renderAll(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.enabled) enabled = ch.enabled.newValue;
    if (ch.reveal) { reveal = ch.reveal.newValue; renderAll(); }
  });

  async function persist(newCount, types) {
    try { await chrome.storage.session.set({ [VAULT_KEY]: vault.serialize() }); } catch (_) { /* memory only */ }
    const s = (await chrome.storage.local.get({ [STATS_KEY]: { masked: 0, byType: {} } }))[STATS_KEY];
    s.masked += newCount;
    for (const t of types) s.byType[t] = (s.byType[t] || 0) + 1;
    await chrome.storage.local.set({ [STATS_KEY]: s });
  }

  // ---------- input box ----------
  function findInput() {
    return document.querySelector("#prompt-textarea")
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector("form textarea");
  }
  function findSendButton() {
    return document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('form button[type="submit"]');
  }
  function readInput(el) {
    return el.tagName === "TEXTAREA" ? el.value : el.innerText;
  }
  const norm = s => s.replace(/\s+/g, " ").trim();

  // Two strategies for rich editors (ProseMirror on ChatGPT): execCommand first, raw DOM as fallback.
  function writeInput(el, text) {
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return norm(readInput(el)) === norm(text);
    }
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    if (norm(readInput(el)) === norm(text)) return true;
    // Fallback: rewrite the paragraphs directly; ProseMirror's DOM observer re-parses them.
    el.innerHTML = "";
    for (const line of text.split("\n")) {
      const p = document.createElement("p");
      p.textContent = line;
      el.appendChild(p);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return norm(readInput(el)) === norm(text);
  }

  // ---------- NER (names, addresses, companies) via the offscreen model ----------
  let ner = true;
  chrome.storage.local.get({ ner: true }).then(v => { ner = v.ner; });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.ner) ner = ch.ner.newValue; });

  async function nerSpans(text) {
    if (!ner) return { spans: [] };
    try { return (await chrome.runtime.sendMessage({ target: "background", type: "ner", text })) || { error: "no_reply" }; }
    catch (e) { return { error: "model_error", detail: String(e && e.message || e) }; }
  }

  // Every send is held, inspected (regex + model), rewritten if needed, then re-triggered with `bypass`.
  let bypass = false;
  function resend(el) {
    setTimeout(() => {
      const btn = findSendButton();
      bypass = true;
      try {
        if (btn) btn.click();
        else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      } finally {
        setTimeout(() => { bypass = false; }, 50);
      }
    }, 30);
  }

  async function handleSend(el, text) {
    const regex = findPII(text);
    const r = await nerSpans(text);
    let nerRaw = r.spans || [];
    if (r.error === "not_ready") {
      // Fail closed while the model is still loading: names would otherwise leave unmasked.
      const pct = r.progress && r.progress.pct ? r.progress.pct + " %" : "";
      toast("Modèle de détection des noms en cours de chargement " + pct + ". Réessayez dans un instant.", true);
      return;
    }
    if (r.error && r.error !== "disabled") {
      toast("Détection des noms indisponible (" + r.error + ") : seules les règles ont été appliquées.", true);
    }
    const matches = combine(text, regex, nerRaw);
    if (!matches.length) { resend(el); return; }

    const before = vault.size();
    const ok = writeInput(el, vault.redact(text, matches));
    if (!ok) {
      toast("Masquage impossible dans cet éditeur, envoi bloqué. Retirez les données sensibles ou désactivez l'extension.", true);
      return;
    }
    const types = [...new Set(matches.map(m => m.type))];
    persist(vault.size() - before, matches.map(m => m.type));
    const n = matches.length;
    toast(n + " donnée" + (n > 1 ? "s" : "") + " masquée" + (n > 1 ? "s" : "") + " : " + types.join(", "));
    resend(el);
  }

  // Returns true if the send was taken over (caller must stop the original event).
  function interceptSend() {
    if (!enabled || bypass) return false;
    const el = findInput();
    if (!el) return false;
    const text = readInput(el);
    if (!text.trim()) return false;
    handleSend(el, text);
    return true;
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const el = findInput();
    if (!el || !el.contains(e.target)) return;
    if (interceptSend()) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  document.addEventListener("click", (e) => {
    const btn = findSendButton();
    if (!btn || !btn.contains(e.target)) return;
    if (interceptSend()) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // ---------- render placeholders in messages: restore originals, or reveal what the model saw ----------
  const MSG_SELECTOR = "[data-message-author-role]";
  function renderUnder(rootEl) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    let n, touched = 0;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue;
      const out = reveal ? vault.conceal(v) : vault.restore(v);
      if (out !== v) { n.nodeValue = out; touched++; }
    }
    // Once a message has carried a placeholder, keep the badge: it is the visible proof of what left the page.
    if (touched || (reveal && vault.hasPlaceholder(rootEl.textContent))) {
      rootEl.dataset.pfrProtected = reveal ? "reveal" : "restored";
    }
  }
  function renderAll() {
    if (!vault.size()) return;
    document.querySelectorAll(MSG_SELECTOR).forEach(renderUnder);
  }
  let scheduled = false;
  function scheduleRender() {
    if (scheduled || !vault.size()) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; renderAll(); });
  }
  function touchesMessage(m) {
    const t = m.target;
    const el = t.nodeType === 1 ? t : t.parentElement;
    if (el && el.closest(MSG_SELECTOR)) return true;
    for (const a of m.addedNodes) {
      if (a.nodeType === 1 && (a.matches(MSG_SELECTOR) || a.querySelector(MSG_SELECTOR))) return true;
    }
    return false;
  }
  new MutationObserver((muts) => {
    for (const m of muts) if (touchesMessage(m)) { scheduleRender(); return; }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  const style = document.createElement("style");
  style.textContent = `
    [data-pfr-protected]::after {
      content: "\\1F6E1 valeurs masquées pour ChatGPT";
      display: inline-block; margin-top: 4px; padding: 1px 6px; border-radius: 4px;
      font: 11px system-ui, sans-serif; color: #065f46; background: #d1fae5;
    }
    [data-pfr-protected="reveal"]::after { content: "\\1F6E1 vue ChatGPT : placeholders"; color: #92400e; background: #fef3c7; }
  `;
  document.documentElement.appendChild(style);
  renderAll();
  document.documentElement.dataset.pfrReady = "1";

  // ---------- toast ----------
  let toastEl;
  function toast(msg, warn) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "pfr-toast";
      Object.assign(toastEl.style, {
        position: "fixed", right: "16px", bottom: "16px", zIndex: 2147483647, maxWidth: "360px",
        color: "#f9fafb", padding: "10px 14px", borderRadius: "8px",
        font: "13px system-ui, sans-serif", boxShadow: "0 4px 16px rgba(0,0,0,.3)", transition: "opacity .3s",
      });
      document.body.appendChild(toastEl);
    }
    toastEl.style.background = warn ? "#991b1b" : "#111827";
    toastEl.textContent = "\u{1F6E1} " + msg;
    toastEl.style.opacity = "1";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.style.opacity = "0"; }, warn ? 8000 : 3500);
  }
})();
