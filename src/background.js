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
      if (!(await nerEnabled())) { sendResponse({ error: "disabled" }); return; }
      await ensureOffscreen();
      const reply = await chrome.runtime.sendMessage({ target: "offscreen", type: msg.type, text: msg.text });
      sendResponse(reply || { error: "no_reply" });
    } catch (e) {
      sendResponse({ error: "model_error", detail: String(e && e.message || e) });
    }
  })();
  return true;
});
