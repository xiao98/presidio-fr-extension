(async function () {
  const { findPII, createVault } = globalThis.PFR;
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

  // Returns true if the send was intercepted (caller must stop the original event).
  let bypass = false;
  function interceptSend() {
    if (!enabled || bypass) return false;
    const el = findInput();
    if (!el) return false;
    const text = readInput(el);
    const matches = findPII(text);
    if (!matches.length) return false;

    const before = vault.size();
    const redacted = vault.redact(text, matches);
    const ok = writeInput(el, redacted);
    if (!ok) {
      // Fail closed: never let the original text leave the page silently.
      toast("Masquage impossible dans cet éditeur, envoi bloqué. Retirez les données sensibles ou désactivez l'extension.", true);
      return true;
    }
    const types = [...new Set(matches.map(m => m.type))];
    persist(vault.size() - before, matches.map(m => m.type));
    const n = matches.length;
    toast(n + " donnée" + (n > 1 ? "s" : "") + " masquée" + (n > 1 ? "s" : "") + " : " + types.join(", "));
    // Re-trigger the send once the editor has applied the new text.
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
