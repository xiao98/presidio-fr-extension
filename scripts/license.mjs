// Licence tooling (vendor side).
//   node scripts/license.mjs keygen                      -> prints a JWK key pair; keep the private part secret,
//                                                           paste the public "x" into src/license.js
//   node scripts/license.mjs sign <privkey.json> <email> <plan> <seats> <YYYY-MM-DD>
//                                                        -> prints the key to send to the customer
import fs from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "keygen") {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  console.log("PRIVATE (keep secret, e.g. license-private.json):");
  console.log(JSON.stringify({ kty: "OKP", crv: "Ed25519", d: priv.d, x: priv.x }));
  console.log("\nPUBLIC x (paste into src/license.js PUBLIC_KEY_JWK.x):");
  console.log(pub.x);
} else if (cmd === "sign") {
  const [privPath, email, plan, seats, expiry] = args;
  if (!privPath || !email || !plan || !seats || !/^\d{4}-\d{2}-\d{2}$/.test(expiry || "")) {
    console.error("usage: sign <privkey.json> <email> <plan> <seats> <YYYY-MM-DD>"); process.exit(2);
  }
  const jwk = JSON.parse(fs.readFileSync(privPath, "utf8"));
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ e: email, p: plan, s: Number(seats), x: expiry })));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode(payload));
  console.log(`PFR1.${payload}.${b64u(sig)}`);
} else {
  console.error("commands: keygen | sign"); process.exit(2);
}
