import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function copyTree(s, d) { if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); for (const f of fs.readdirSync(s)) copyTree(path.join(s, f), path.join(d, f)); } else fs.copyFileSync(s, d); }
const html = fs.readFileSync(path.join(ROOT, "test/mock/chatgpt.html"));
const server = http.createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-ext-"));
for (const f of ["src", "dist", "vendor", "popup.html", "popup.js", "offscreen.html", "manifest.json"]) copyTree(path.join(ROOT, f), path.join(EXT, f));
const m = JSON.parse(fs.readFileSync(EXT + "/manifest.json", "utf8")); m.content_scripts[0].matches = [origin + "/*"]; fs.writeFileSync(EXT + "/manifest.json", JSON.stringify(m));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "pfr-dbg-")), { channel: "chromium", headless: true, args: ["--disable-extensions-except=" + EXT, "--load-extension=" + EXT] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
sw.on("console", m => console.log("[sw]", m.type(), m.text().slice(0, 300)));
const extId = sw.url().split("/")[2];
// 2) mock page: content script path, model switched off (regex only)
const setup = await ctx.newPage(); await setup.goto("chrome-extension://" + extId + "/popup.html"); await setup.locator("#ner").uncheck(); await setup.close();
const page = await ctx.newPage();
page.on("console", m => console.log("[page]", m.type(), m.text().slice(0, 300)));
page.on("pageerror", e => console.log("[pageerror]", e.message.slice(0, 300)));
await page.goto(origin + "/");
await page.waitForSelector("html[data-pfr-ready]", { state: "attached" });
await page.setInputFiles("#file", ["facture.pdf", "contrat.docx", "clients.xlsx"].map(f => path.join(ROOT, "test/fixtures/files", f)));
await page.waitForFunction(() => window.__uploads.length === 3, null, { timeout: 60000 });
await page.setInputFiles("#file", [path.join(ROOT, "test/fixtures/files/scan.pdf")]);
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(2000);
  console.log("uploads:", await page.evaluate(() => window.__uploads.map(u => u.name)), "toast:", await page.evaluate(() => { const t = document.getElementById("pfr-toast"); return t && t.textContent; }));
}
await ctx.close(); server.close();
