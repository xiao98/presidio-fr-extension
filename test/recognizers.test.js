const test = require("node:test");
const assert = require("node:assert/strict");
const { findPII, nirOk, luhnOk, ibanOk } = require("../src/recognizers.js");
const { createVault } = require("../src/vault.js");

const types = (t) => findPII(t).map(m => m.type);
const texts = (t) => findPII(t).map(m => m.text);

test("validators", () => {
  assert.ok(nirOk("185057800608491"));
  assert.ok(!nirOk("185057800608436"));
  assert.ok(luhnOk("552100554") && luhnOk("55210055400013") && !luhnOk("552100555"));
  assert.ok(ibanOk("FR7630006000011234567890189"));
  assert.ok(!ibanOk("FR7630006000011234567890180"));
});

test("NIR spaced and compact, bad key rejected", () => {
  assert.deepEqual(texts("n° sécu 1 85 05 78 006 084 91 du salarié"), ["1 85 05 78 006 084 91"]);
  assert.deepEqual(texts("NIR 185057800608491"), ["185057800608491"]);
  assert.deepEqual(texts("NIR 185057800608436"), []);
});

test("SIRET wins over SIREN on overlap", () => {
  assert.deepEqual(types("SIRET 552 100 554 00013"), ["SIRET"]);
  assert.deepEqual(types("SIREN 552 100 554"), ["SIREN"]);
});

test("IBAN, email, phone, plate, passport", () => {
  assert.deepEqual(types("IBAN FR76 3000 6000 0112 3456 7890 189"), ["IBAN"]);
  assert.deepEqual(texts("contact jean.dupont@cabinet-martin.fr"), ["jean.dupont@cabinet-martin.fr"]);
  assert.deepEqual(texts("tél 06 12 34 56 78 ou +33 6 12 34 56 78"), ["06 12 34 56 78", "+33 6 12 34 56 78"]);
  assert.deepEqual(texts("véhicule AB-123-CD"), ["AB-123-CD"]);
  assert.deepEqual(texts("AI-123-CD SS-123-CD"), []);
  assert.deepEqual(texts("passeport 12AB34567"), ["12AB34567"]);
});

test("numéro fiscal only with tax context", () => {
  assert.deepEqual(types("Commande 1234567890123 expédiée."), []);
  assert.deepEqual(types("numéro fiscal 1234567890123"), ["FISCAL"]);
});

test("plain numbers are left alone", () => {
  assert.deepEqual(types("Le montant total est de 123 456 789 euros. Rendez-vous le 12 05 2024 à 14h."), []);
});

test("vault: redact, stable placeholders, restore", () => {
  const v = createVault();
  const t1 = "Salarié NIR 185057800608491, mail a@b.fr";
  const r1 = v.redact(t1, findPII(t1));
  assert.equal(r1, "Salarié NIR {{NIR_1}}, mail {{EMAIL_1}}");
  const t2 = "Encore 1 85 05 78 006 084 91 et c@d.fr";
  const r2 = v.redact(t2, findPII(t2));
  assert.equal(r2, "Encore {{NIR_1}} et {{EMAIL_2}}");   // same NIR (spacing differs) -> same placeholder
  assert.equal(v.restore("Le {{NIR_1}} de {{EMAIL_2}} et {{NIR_9}}"), "Le 185057800608491 de c@d.fr et {{NIR_9}}");
  const v2 = createVault(v.serialize());
  assert.equal(v2.restore("{{EMAIL_1}}"), "a@b.fr");
  assert.equal(v2.conceal("Le 185057800608491 de c@d.fr"), "Le {{NIR_1}} de {{EMAIL_2}}");
});
