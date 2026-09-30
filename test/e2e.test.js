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
  for (const f of ["src", "popup.html", "popup.js"]) copyTree(path.join(ROOT, f), path.join(dir, f));
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
    await page.waitForFunction(() => {
      const a = document.querySelector('[data-message-author-role="assistant"]');
      return a && a.textContent.includes("185057800608491".slice(0, 1) + " 85 05 78 006 084 91") && !a.textContent.includes("{{");
    }, null, { timeout: 5000 });
    const shown = await page.locator('[data-message-author-role="assistant"]').textContent();
    assert.equal(shown, "Reçu : " + msg);
    assert.equal(await page.locator('[data-message-author-role="user"]').textContent(), msg);
    assert.ok((await page.locator("#pfr-toast").textContent()).includes("3 données masquées"));
    // visible proof: both bubbles carry the shield badge
    assert.equal(await page.locator('[data-message-author-role][data-pfr-protected="restored"]').count(), 2);

    // reveal mode via the popup: messages switch to what the model received
    const extId = ctx.serviceWorkers()[0].url().split("/")[2];
    const popup = await ctx.newPage();
    await popup.goto("chrome-extension://" + extId + "/popup.html");
    assert.equal(await popup.locator("#masked").textContent(), "3");
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
