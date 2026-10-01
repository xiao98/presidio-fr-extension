// End-to-end: load the unpacked extension in Chromium against a mock ChatGPT page.
// Verifies (1) the text that leaves the input box is redacted, (2) the assistant reply that
// echoes placeholders is restored on screen, (3) the vault survives a reload.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");

// fs.cpSync crashes Node 22 natively on non-ASCII Windows paths; copy by hand.
function copyTree(src, dst) {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copyTree(path.join(src, f), path.join(dst, f));
  } else {
    fs.copyFileSync(src, dst);
  }
}

function buildTestExtension(origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-ext-"));
  for (const f of ["src", "popup.html", "popup.js", "icons"]) copyTree(path.join(ROOT, f), path.join(dir, f));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  manifest.content_scripts[0].matches = [origin + "/*"];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("redact on send, restore in reply, vault survives reload", async () => {
  const html = fs.readFileSync(path.join(__dirname, "mock", "chatgpt.html"));
  const server = http.createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const extDir = buildTestExtension(origin);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-prof-"));
  const ctx = await chromium.launchPersistentContext(userData, {
    channel: "chromium",
    headless: true,
    args: ["--disable-extensions-except=" + extDir, "--load-extension=" + extDir],
  });
  try {
    // regex-only path: switch the NER model off through the popup before the first send
    const extId = (ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker")).url().split("/")[2];
    const setup = await ctx.newPage();
    await setup.goto("chrome-extension://" + extId + "/popup.html");
    await setup.locator("#ner").uncheck();
    await setup.close();

    const page = await ctx.newPage();
    const ready = () => page.waitForSelector("html[data-pfr-ready]", { state: "attached", timeout: 10000 });
    await page.goto(origin + "/");
    await ready();
    const input = page.locator("#prompt-textarea");
    await input.click();
    const msg = "Le salarié NIR 1 85 05 78 006 084 91, mail jean@cabinet.fr, SIRET 552 100 554 00013 est en arrêt.";
    await page.keyboard.type(msg);
    await page.keyboard.press("Enter");

    await page.waitForFunction(() => window.__sent.length === 1);
    const sent = await page.evaluate(() => window.__sent[0]);
    assert.equal(sent, "Le salarié NIR {{NIR_1}}, mail {{EMAIL_1}}, SIRET {{SIRET_1}} est en arrêt.");

    // assistant echo streams "Reçu : ...{{NIR_1}}..." and must end up restored on screen
    // wait for the stream to finish AND the last replacement to be restored (each streamed chunk is a
    // new text node, restored on the next animation frame)
    await page.waitForFunction((expected) => {
      const a = document.querySelector('[data-message-author-role="assistant"]');
      return a && a.textContent === expected;
    }, "Reçu : " + msg, { timeout: 5000 });
    assert.equal(await page.locator('[data-message-author-role="user"]').textContent(), msg);
    assert.ok((await page.locator("#pfr-toast").textContent()).includes("3 données masquées"));
    // visible proof: both bubbles carry the shield badge
    assert.equal(await page.locator('[data-message-author-role][data-pfr-protected="restored"]').count(), 2);

    // reveal mode via the popup: messages switch to what the model received
    const popup = await ctx.newPage();
    await popup.goto("chrome-extension://" + extId + "/popup.html");
    assert.equal(await popup.locator("#masked").textContent(), "3");
    // audit log: one entry per masking event, counts per type, never a value
    const audit = await popup.evaluate(() => chrome.storage.local.get("audit").then(v => v.audit));
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].byType, { NIR: 1, EMAIL: 1, SIRET: 1 });
    assert.ok(!JSON.stringify(audit).includes("185057800608491"));
    assert.ok(/essai|licenc/i.test(await popup.locator("#tier").textContent()));
    await popup.locator("#reveal").check();
    await page.waitForFunction(() => document.querySelector('[data-message-author-role="assistant"]').textContent.includes("{{NIR_1}}"), null, { timeout: 3000 });
    assert.equal(await page.locator('[data-message-author-role="user"]').textContent(), "Le salarié NIR {{NIR_1}}, mail {{EMAIL_1}}, SIRET {{SIRET_1}} est en arrêt.");
    assert.equal(await page.locator('[data-message-author-role][data-pfr-protected="reveal"]').count(), 2);
    await popup.locator("#reveal").uncheck();
    await page.waitForFunction(() => !document.querySelector('[data-message-author-role="assistant"]').textContent.includes("{{"), null, { timeout: 3000 });
    await popup.close();

    // reload: vault is in chrome.storage.session, so a reply mentioning {{NIR_1}} is still restorable
    await page.reload();
    await ready();
    await page.evaluate(() => {
      const a = document.createElement("div");
      a.dataset.messageAuthorRole = "assistant";
      a.textContent = "Après reload : {{NIR_1}}";
      document.getElementById("thread").appendChild(a);
    });
    await page.waitForFunction(() => document.querySelector('[data-message-author-role="assistant"]').textContent.includes("1 85 05 78 006 084 91"), null, { timeout: 3000 });

    // a message without PII must pass through untouched
    await input.click();
    await page.keyboard.type("Bonjour, résume ce dossier.");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sent.length === 1);
    assert.equal(await page.evaluate(() => window.__sent[0]), "Bonjour, résume ce dossier.");

    // fail closed: an editor that rejects rewrites must block the send, never leak the original
    await page.goto(origin + "/?stubborn=1");
    await ready();
    await input.click();
    await page.keyboard.type("SIRET 552 100 554 00013 à mémoriser");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#pfr-toast", { timeout: 3000 });
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => window.__sent), []);
    assert.ok((await page.locator("#pfr-toast").textContent()).includes("envoi bloqué"));
  } finally {
    await ctx.close();
    server.close();
  }
});

// Real model in the browser: downloads ~120 MB into a fresh profile, so it only runs when asked for.
const runNer = process.env.PFR_E2E_NER === "1";
test("NER path: names and addresses masked by the in-browser model", { skip: !runNer, timeout: 900000 }, async () => {
  const html = fs.readFileSync(path.join(__dirname, "mock", "chatgpt.html"));
  const server = http.createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const extDir = buildTestExtension(origin);
  for (const f of ["dist", "vendor", "offscreen.html"]) copyTree(path.join(ROOT, f), path.join(extDir, f));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-prof-"));
  const ctx = await chromium.launchPersistentContext(userData, {
    channel: "chromium", headless: true,
    args: ["--disable-extensions-except=" + extDir, "--load-extension=" + extDir],
  });
  try {
    const extId = (ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker")).url().split("/")[2];
    const popup = await ctx.newPage();
    await popup.goto("chrome-extension://" + extId + "/popup.html");
    const t0 = Date.now();
    await popup.waitForFunction(() => /prêt/.test(document.getElementById("nerStatus").textContent), null, { timeout: 600000 });
    console.log(`model ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await popup.close();

    const page = await ctx.newPage();
    await page.goto(origin + "/");
    await page.waitForSelector("html[data-pfr-ready]", { state: "attached", timeout: 10000 });
    await page.locator("#prompt-textarea").click();
    await page.keyboard.type("Le salarié Jean Dupont, demeurant 12 rue de la Paix, 75002 Paris, né le 12/03/1985, travaille chez Lemaire SARL. Facture du 27/04/2026.");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sent.length === 1, null, { timeout: 60000 });
    const sent = await page.evaluate(() => window.__sent[0]);
    console.log("sent:", sent);
    assert.ok(sent.includes("{{PERSON_1}}") && !sent.includes("Dupont"), "name not masked");
    assert.ok(sent.includes("{{ADDRESS_1}}") && !sent.includes("rue de la Paix"), "address not masked");
    assert.ok(sent.includes("{{DOB_1}}"), "birth date not masked");
    assert.ok(sent.includes("27/04/2026"), "invoice date must stay");
    await page.waitForFunction(() => {
      const a = document.querySelector('[data-message-author-role="assistant"]');
      return a && a.textContent.includes("Jean Dupont") && !a.textContent.includes("{{");
    }, null, { timeout: 5000 });
  } finally {
    await ctx.close();
    server.close();
  }
});

// Attachments: PDF / DOCX / XLSX chosen in the file input are replaced by masked copies before "upload";
// a scanned PDF is blocked. Regex-only (model off) so it runs in CI; the NER e2e above covers the model.
test("attachments are masked before upload; scanned PDF is blocked", { timeout: 300000 }, async () => {
  const JSZip = require("jszip");
  const html = fs.readFileSync(path.join(__dirname, "mock", "chatgpt.html"));
  const server = http.createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const extDir = buildTestExtension(origin);
  for (const f of ["dist", "vendor", "offscreen.html"]) copyTree(path.join(ROOT, f), path.join(extDir, f));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-prof-"));
  const ctx = await chromium.launchPersistentContext(userData, {
    channel: "chromium", headless: true,
    args: ["--disable-extensions-except=" + extDir, "--load-extension=" + extDir],
  });
  try {
    const extId = (ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker")).url().split("/")[2];
    const setup = await ctx.newPage();
    await setup.goto("chrome-extension://" + extId + "/popup.html");
    await setup.locator("#ner").uncheck();
    await setup.close();
    const page = await ctx.newPage();
    page.on("console", m => { if (m.type() === "error") console.log("[page]", m.text().slice(0, 200)); });
    await page.goto(origin + "/");
    await page.waitForSelector("html[data-pfr-ready]", { state: "attached", timeout: 10000 });
    const fx = (f) => path.join(__dirname, "fixtures", "files", f);

    await page.setInputFiles("#file", [fx("facture.pdf"), fx("contrat.docx"), fx("clients.xlsx")]);
    await page.waitForFunction(() => window.__uploads.length === 3, null, { timeout: 120000 });
    const ups = await page.evaluate(() => window.__uploads);
    const byName = Object.fromEntries(ups.map(u => [u.name, u]));
    assert.deepEqual(Object.keys(byName).sort(), ["clients-masqué.xlsx", "contrat-masqué.docx", "facture-masqué.txt"]);

    const txt = Buffer.from(byName["facture-masqué.txt"].b64, "base64").toString("utf8");
    assert.ok(txt.includes("{{SIRET_1}}") || txt.includes("{{SIREN_1}}"), txt);
    for (const leak of ["552 100 554", "06 12 34 56 78", "jean.dupont@example.com", "1 85 05 78 006 084 91", "FR76 3000"]) assert.ok(!txt.includes(leak), "pdf leaked " + leak);
    assert.ok(txt.includes("FAC-2026-0042"));

    const docx = await JSZip.loadAsync(Buffer.from(byName["contrat-masqué.docx"].b64, "base64"));
    const body = await docx.file("word/document.xml").async("string");
    for (const leak of ["552 100 554 00013", "jean.dupont@example.com", "1 85 05 78 006 084 91"]) assert.ok(!body.includes(leak), "docx leaked " + leak);
    assert.ok(body.includes("<w:tbl>"));

    const xlsx = await JSZip.loadAsync(Buffer.from(byName["clients-masqué.xlsx"].b64, "base64"));
    const sheet = await xlsx.file("xl/worksheets/sheet1.xml").async("string");
    for (const leak of ["55210055400013", "FR7630006000011234567890189", "jean.dupont@example.com"]) assert.ok(!sheet.includes(leak), "xlsx leaked " + leak);
    assert.ok(sheet.includes("<f>SUM(E2:E3)</f>"));
    assert.ok((await page.locator("#pfr-toast").textContent()).includes("masquée"));

    // scanned PDF: blocked, nothing uploaded, red toast
    await page.setInputFiles("#file", [fx("scan.pdf")]);
    await page.waitForFunction(() => /scanné/.test(document.getElementById("pfr-toast").textContent), null, { timeout: 60000 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__uploads.length), 3);

    // drag & drop goes through the same path
    await page.evaluate(async (b64) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], "note.txt", { type: "text/plain" }));
      document.getElementById("drop").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, Buffer.from("Client SIRET 552 100 554 00013, IBAN FR76 3000 6000 0112 3456 7890 189.").toString("base64"));
    await page.waitForFunction(() => window.__uploads.length === 4, null, { timeout: 60000 });
    const note = await page.evaluate(() => window.__uploads[3]);
    assert.equal(note.name, "note-masqué.txt");
    // same SIRET / IBAN as in facture.pdf -> same placeholders (stable across messages and files)
    assert.equal(Buffer.from(note.b64, "base64").toString("utf8"), "Client SIRET {{SIRET_1}}, IBAN {{IBAN_1}}.");
  } finally {
    await ctx.close();
    server.close();
  }
});

// Site-agnostic path: a page with Claude / Le Chat-like markup (ProseMirror editor without id,
// aria-label send button, no data-message-author-role) must be handled by the generic fallbacks.
test("generic site: ProseMirror editor + aria-label send button + unmarked messages", { timeout: 120000 }, async () => {
  const html = fs.readFileSync(path.join(__dirname, "mock", "claude.html"));
  const server = http.createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const extDir = buildTestExtension(origin);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-prof-"));
  const ctx = await chromium.launchPersistentContext(userData, {
    channel: "chromium", headless: true,
    args: ["--disable-extensions-except=" + extDir, "--load-extension=" + extDir],
  });
  try {
    const extId = (ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker")).url().split("/")[2];
    const setup = await ctx.newPage();
    await setup.goto("chrome-extension://" + extId + "/popup.html");
    await setup.locator("#ner").uncheck();
    await setup.close();
    const page = await ctx.newPage();
    await page.goto(origin + "/");
    await page.waitForSelector("html[data-pfr-ready]", { state: "attached", timeout: 10000 });
    await page.locator(".ProseMirror").click();
    const msg = "Dossier SIRET 552 100 554 00013, contact jean@cabinet.fr.";
    await page.keyboard.type(msg);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sent.length === 1, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__sent[0]), "Dossier SIRET {{SIRET_1}}, contact {{EMAIL_1}}.");
    await page.waitForFunction(() => {
      const a = document.querySelector(".assistant-turn");
      return a && a.textContent.includes("552 100 554 00013") && !a.textContent.includes("{{");
    }, null, { timeout: 5000 });
    assert.equal(await page.locator(".user-turn").textContent(), msg);
    assert.ok(await page.locator('[data-pfr-protected="restored"]').count() >= 2, "badges missing");
    // the editor itself must never be touched by restore/conceal: type an original value, toggle reveal, check it stays
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("note 552 100 554 00013");
    const popup = await ctx.newPage();
    await popup.goto("chrome-extension://" + extId + "/popup.html");
    await popup.locator("#reveal").check();
    await page.waitForFunction(() => document.querySelector(".user-turn").textContent.includes("{{SIRET_1}}"), null, { timeout: 3000 });
    assert.equal(await page.locator(".ProseMirror").innerText(), "note 552 100 554 00013");
    await popup.close();
    // send button click path (not Enter)
    await page.locator('button[aria-label="Envoyer le message"]').click();
    await page.waitForFunction(() => window.__sent.length === 2, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__sent[1]), "note {{SIRET_1}}");
  } finally {
    await ctx.close();
    server.close();
  }
});
