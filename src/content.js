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
    if (ch.licenseKey) refreshTier();
  });

  // persist: vault (session), counters, and one audit entry per masking event. The audit log is the DPO's
  // registre: timestamps, site, kind of event, counts per type. Never any value (same rule as AstrLink's
  // findings: offsets and kinds, no plaintext).
  const AUDIT_KEY = "audit", AUDIT_MAX = 5000;
  async function persist(newCount, types, event) {
    try { await chrome.storage.session.set({ [VAULT_KEY]: vault.serialize() }); } catch (_) { /* memory only */ }
    const got = await chrome.storage.local.get({ [STATS_KEY]: { masked: 0, byType: {} }, [AUDIT_KEY]: [] });
    const s = got[STATS_KEY];
    s.masked += newCount;
    const byType = {};
    for (const t of types) { s.byType[t] = (s.byType[t] || 0) + 1; byType[t] = (byType[t] || 0) + 1; }
    const audit = got[AUDIT_KEY];
    audit.push({ ts: new Date().toISOString(), site: location.host, kind: (event && event.kind) || "message", file: (event && event.file) || "", byType });
    if (audit.length > AUDIT_MAX) audit.splice(0, audit.length - AUDIT_MAX);
    await chrome.storage.local.set({ [STATS_KEY]: s, [AUDIT_KEY]: audit });
  }

  // Entitlement: trial / licensed -> everything; free -> rules only (model off, attachments blocked).
  let tier = "trial";
  async function refreshTier() { try { tier = (await globalThis.PFR.entitlement()).tier; } catch (_) { tier = "trial"; } }
  await refreshTier();

  // ---------- input box ----------
  // Site-agnostic: ChatGPT, Claude.ai and Le Chat all use one visible rich editor plus one send button.
  const visible = (el) => el && el.offsetParent !== null && !el.closest("[aria-hidden='true']");
  const firstVisible = (sels) => { for (const s of sels) for (const el of document.querySelectorAll(s)) if (visible(el)) return el; return null; };
  function findInput() {
    return firstVisible([
      "#prompt-textarea",                                   // ChatGPT
      'div.ProseMirror[contenteditable="true"]',            // Claude.ai, Le Chat
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label]',
      "form textarea", "textarea",
    ]);
  }
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',                                  // ChatGPT
    'button[aria-label*="send" i]', 'button[aria-label*="envoyer" i]',    // Claude.ai / Le Chat (EN / FR UI)
    'button[type="submit"]',
  ];
  function findSendButton() {
    // prefer a button in the composer around the input, then anywhere on the page
    const input = findInput();
    let scope = input;
    for (let i = 0; i < 6 && scope && scope !== document.body; i++) {
      scope = scope.parentElement;
      for (const s of SEND_SELECTORS) for (const el of scope.querySelectorAll(s)) if (visible(el)) return el;
    }
    return firstVisible(SEND_SELECTORS);
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
    if (!ner || tier === "free") return { spans: [] };
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
    persist(vault.size() - before, matches.map(m => m.type), { kind: "message" });
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

  // ---------- attachments: a file chosen, dropped or pasted is replaced by a masked copy before upload ----------
  const MAX_FILE = 25 * 1024 * 1024;
  const ours = new WeakSet();   // events we re-dispatch with the masked files (never a timed window: it raced)

  const toB64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  const fromB64 = (b64, name, mime) => new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type: mime });

  // Returns the masked File, or null when the upload must be blocked (toast already shown).
  async function maskFile(file) {
    if (tier === "free") { toast(file.name + " : pièces jointes réservées à la version licenciée (période d'essai terminée). Envoi bloqué.", true); return null; }
    if (file.size > MAX_FILE) { toast(file.name + " : fichier trop volumineux (> 25 Mo), envoi bloqué.", true); return null; }
    if (!/\.(pdf|docx|xlsx|txt|csv|md)$/i.test(file.name)) {
      toast(file.name + " : type non pris en charge (PDF, Word, Excel, texte), envoi bloqué.", true); return null;
    }
    let r;
    try { r = await chrome.runtime.sendMessage({ target: "background", type: "file.extract", name: file.name, ner: ner && tier !== "free", b64: await toB64(file) }); }
    catch (e) { r = { error: "model_error", detail: String(e && e.message || e) }; }
    if (!r || r.error) {
      const why = { not_ready: "modèle en cours de chargement, réessayez dans un instant", scanned: "PDF scanné sans texte, non masquable pour l'instant",
        unsupported: "type non pris en charge", disabled: "modèle désactivé : les noms ne seraient pas masqués", job_expired: "délai dépassé" }[r && r.error]
        || (r && (r.error + (r.detail ? " — " + r.detail : ""))) || "pas de réponse";
      toast(file.name + " : " + why + ". Envoi bloqué.", true);
      return null;
    }
    const before = vault.size();
    const redactedById = {};
    let count = 0;
    const types = new Set();
    for (const s of r.segments) {
      const matches = combine(s.text, findPII(s.text), s.ner || []);
      if (!matches.length) continue;
      redactedById[s.id] = vault.redact(s.text, matches);
      count += matches.length;
      matches.forEach(m => types.add(m.type));
    }
    let w;
    try { w = await chrome.runtime.sendMessage({ target: "background", type: "file.rewrite", job: r.job, redactedById }); }
    catch (e) { w = { error: "model_error" }; }
    if (!w || w.error) { toast(file.name + " : réécriture impossible (" + (w && w.error) + "). Envoi bloqué.", true); return null; }
    persist(vault.size() - before, [...types], { kind: "file", file: (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase() });
    toast(file.name + " → " + w.name + " : " + count + " donnée" + (count > 1 ? "s" : "") + " masquée" + (count > 1 ? "s" : "") + (count ? " : " + [...types].join(", ") : ""));
    return fromB64(w.b64, w.name, w.mime);
  }

  async function maskFiles(files) {
    const out = [];
    for (const f of files) {
      const m = await maskFile(f);
      if (!m) return null;          // one blocked file blocks the whole upload
      out.push(m);
    }
    return out;
  }

  function dispatchOurs(target, ev) { ours.add(ev); target.dispatchEvent(ev); }

  document.addEventListener("change", (e) => {
    const input = e.target;
    if (!enabled || ours.has(e) || !(input instanceof HTMLInputElement) || input.type !== "file" || !input.files || !input.files.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const files = [...input.files];
    maskFiles(files).then(masked => {
      if (!masked) { input.value = ""; return; }
      const dt = new DataTransfer();
      masked.forEach(f => dt.items.add(f));
      input.files = dt.files;
      dispatchOurs(input, new Event("input", { bubbles: true }));
      dispatchOurs(input, new Event("change", { bubbles: true }));
    });
  }, true);

  document.addEventListener("drop", (e) => {
    if (!enabled || ours.has(e) || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const target = e.target, files = [...e.dataTransfer.files];
    maskFiles(files).then(masked => {
      if (!masked) return;
      const dt = new DataTransfer();
      masked.forEach(f => dt.items.add(f));
      dispatchOurs(target, new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
  }, true);

  document.addEventListener("paste", (e) => {
    if (!enabled || ours.has(e) || !e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const target = e.target, files = [...e.clipboardData.files];
    maskFiles(files).then(masked => {
      if (!masked) return;
      const dt = new DataTransfer();
      masked.forEach(f => dt.items.add(f));
      dispatchOurs(target, new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    });
  }, true);

  // ---------- render placeholders in messages: restore originals, or reveal what the model saw ----------
  // Placeholders only exist where we put them, so they can be rendered anywhere on the page except inside
  // the editor (the user may be typing an original value) and our own toast. This keeps the extension
  // independent of each site's message markup; known message containers only decide where the badge goes.
  const MSG_SELECTOR = '[data-message-author-role], [data-testid*="message" i], [class*="message" i], article, li';
  const SKIP = "[contenteditable], textarea, script, style, #pfr-toast";
  function badgeHost(textNode) {
    const el = textNode.parentElement;
    if (!el) return null;
    const host = el.closest(MSG_SELECTOR);
    return host && host !== document.body ? host : el;
  }
  function renderUnder(rootEl) {
    if (rootEl.nodeType !== 1 || rootEl.closest(SKIP)) return;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement && n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue;
      const out = reveal ? vault.conceal(v) : vault.restore(v);
      const carries = out !== v || (reveal && vault.hasPlaceholder(v));
      if (out !== v) n.nodeValue = out;
      // Once a message has carried a placeholder, keep the badge: it is the visible proof of what left the page.
      if (carries) { const h = badgeHost(n); if (h) h.dataset.pfrProtected = reveal ? "reveal" : "restored"; }
    }
  }
  function renderAll() {
    if (!vault.size()) return;
    renderUnder(document.body);
  }
  const pending = new Set();
  let scheduled = false;
  function scheduleRender(nodes) {
    if (!vault.size()) return;
    for (const n of nodes) pending.add(n);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const roots = [...pending]; pending.clear();
      // streamed replies replace their text node every few ms: a queued node may be detached by now
      for (const r of roots) if (r.isConnected) renderUnder(r);
    });
  }
  new MutationObserver((muts) => {
    const els = [];
    for (const m of muts) {
      // queue elements, never text nodes (resolve the parent now, while the node is still attached)
      if (m.type === "characterData") { if (m.target.parentElement) els.push(m.target.parentElement); }
      else { els.push(m.target); for (const a of m.addedNodes) if (a.nodeType === 1) els.push(a); }
    }
    if (els.length) scheduleRender(els);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  const style = document.createElement("style");
  style.textContent = `
    [data-pfr-protected]::after {
      content: "\\1F6E1 valeurs masquées avant l'envoi";
      display: inline-block; margin-top: 4px; padding: 1px 6px; border-radius: 4px;
      font: 11px system-ui, sans-serif; color: #065f46; background: #d1fae5;
    }
    [data-pfr-protected="reveal"]::after { content: "\\1F6E1 vue du modèle : placeholders"; color: #92400e; background: #fef3c7; }
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
