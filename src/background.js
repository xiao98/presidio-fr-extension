// Service worker: grants content scripts access to storage.session, owns the offscreen document that
// hosts the NER model, and relays NER requests between content scripts and that document.
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

let creating;
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Runs the local PII detection model (WASM) so it stays loaded between pages.",
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function nerEnabled() {
  return (await chrome.storage.local.get({ ner: true })).ner;
}

// Warm the model as soon as the browser starts, if NER is on.
chrome.runtime.onStartup.addListener(() => nerEnabled().then(on => on && ensureOffscreen()));
chrome.runtime.onInstalled.addListener(() => nerEnabled().then(on => on && ensureOffscreen()));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "background") return;
  (async () => {
    try {
      // "ner" needs the model; file.* runs regex-only when the model is switched off (same policy as text)
      if (msg.type === "ner" && !(await nerEnabled())) { sendResponse({ error: "disabled" }); return; }
      await ensureOffscreen();
      // createDocument resolves before the offscreen module script has registered its listener:
      // an undefined reply means "nobody listening yet", so retry for up to 10 s.
      let reply;
      for (let i = 0; i < 100 && reply === undefined; i++) {
        try { reply = await chrome.runtime.sendMessage({ ...msg, target: "offscreen" }); }
        catch (e) { if (!/Receiving end does not exist/.test(String(e && e.message))) throw e; }
        if (reply === undefined) await new Promise(r => setTimeout(r, 100));
      }
      sendResponse(reply || { error: "no_reply" });
    } catch (e) {
      sendResponse({ error: "model_error", detail: String(e && e.message || e) });
    }
  })();
  return true;
});
