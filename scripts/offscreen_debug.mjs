import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url"; const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function copyTree(s, d) { if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); for (const f of fs.readdirSync(s)) copyTree(path.join(s, f), path.join(d, f)); } else fs.copyFileSync(s, d); }
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-ext-"));
for (const f of ["src", "dist", "vendor", "popup.html", "popup.js", "offscreen.html", "manifest.json"]) copyTree(path.join(ROOT, f), path.join(EXT, f));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "pfr-dbg-")), {
  channel: "chromium", headless: true, args: ["--disable-extensions-except=" + EXT, "--load-extension=" + EXT] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
sw.on("console", m => console.log("[sw]", m.type(), m.text().slice(0, 300)));
const extId = sw.url().split("/")[2];
const page = await ctx.newPage();
page.on("console", m => console.log("[offscreen]", m.type(), m.text().slice(0, 400)));
page.on("pageerror", e => console.log("[pageerror]", e.message.slice(0, 400)));
page.on("requestfailed", r => console.log("[reqfail]", r.url().slice(0, 120), r.failure() && r.failure().errorText));
page.on("response", r => { if (!r.ok()) console.log("[http]", r.status(), r.url().slice(0, 120)); });
await page.goto("chrome-extension://" + extId + "/offscreen.html");
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  const st = await page.evaluate(() => new Promise(res => chrome.runtime.sendMessage({ target: "offscreen", type: "status" }, r => res(r))));
  console.log("status:", JSON.stringify(st));
  if (st && st.status !== "loading") break;
}
await ctx.close();
