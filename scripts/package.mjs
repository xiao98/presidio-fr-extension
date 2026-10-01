// Build the two zips: store/<name>-<version>.zip (manifest at the root, what the Chrome Web Store wants)
// and store/<name>-<version>-unpacked.zip (one folder inside, for "load unpacked" testers).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const name = "presidio-fr-shield", version = manifest.version;
const include = ["manifest.json", "src", "dist", "vendor", "icons", "popup.html", "popup.js", "offscreen.html", "README.md", "PRIVACY.md", "LICENSE"];
for (const f of ["dist/offscreen.js", "vendor/pdf.worker.min.mjs"]) if (!fs.existsSync(path.join(root, f))) throw new Error("run `npm run build` first: missing " + f);

const out = path.join(root, "store");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const stage = path.join(out, "stage");
function copyTree(s, d) {
  if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); for (const f of fs.readdirSync(s)) copyTree(path.join(s, f), path.join(d, f)); }
  else { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
}
for (const f of include) copyTree(path.join(root, f), path.join(stage, name, f));

const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-Command", cmd], { stdio: "inherit" });
const storeZip = path.join(out, `${name}-${version}.zip`);
const unpackedZip = path.join(out, `${name}-${version}-unpacked.zip`);
ps(`Compress-Archive -Path '${path.join(stage, name, "*")}' -DestinationPath '${storeZip}' -Force`);
ps(`Compress-Archive -Path '${path.join(stage, name)}' -DestinationPath '${unpackedZip}' -Force`);
fs.rmSync(stage, { recursive: true, force: true });
for (const z of [storeZip, unpackedZip]) console.log(path.relative(root, z), (fs.statSync(z).size / 1048576).toFixed(1) + " MB");
