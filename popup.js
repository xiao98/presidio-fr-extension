(async () => {
  const $ = (id) => document.getElementById(id);
  const cb = $("enabled"), rv = $("reveal"), nr = $("ner"), st = $("nerStatus"), tierEl = $("tier");
  const keyEl = $("licenseKey"), keySt = $("licenseStatus");
  const { enabled, reveal, ner, stats, licenseKey } = await chrome.storage.local.get({
    enabled: true, reveal: false, ner: true, stats: { masked: 0, byType: {} }, licenseKey: "",
  });
  cb.checked = enabled;
  rv.checked = reveal;
  nr.checked = ner;
  keyEl.value = licenseKey;
  cb.addEventListener("change", () => chrome.storage.local.set({ enabled: cb.checked }));
  rv.addEventListener("change", () => chrome.storage.local.set({ reveal: rv.checked }));
  nr.addEventListener("change", () => { chrome.storage.local.set({ ner: nr.checked }); refresh(); });
  keyEl.addEventListener("change", async () => { await chrome.storage.local.set({ licenseKey: keyEl.value.trim() }); showTier(); });
  $("masked").textContent = stats.masked;
  const ul = $("byType");
  for (const [t, n] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    const li = document.createElement("li");
    li.textContent = t + " : " + n;
    ul.appendChild(li);
  }

  async function showTier() {
    const e = await globalThis.PFR.entitlement();
    if (e.tier === "licensed") { tierEl.textContent = "Licence : " + e.email + " (" + e.seats + " poste" + (e.seats > 1 ? "s" : "") + ", jusqu'au " + e.until + ")"; keySt.textContent = "Clé valide."; }
    else if (e.tier === "trial") { tierEl.textContent = "Période d'essai jusqu'au " + e.until + " : toutes les fonctions."; keySt.textContent = e.reason ? "Clé refusée (" + e.reason + ")." : ""; }
    else { tierEl.textContent = "Version gratuite : règles seules (modèle et pièces jointes désactivés). Entrez une clé de licence."; keySt.textContent = e.reason ? "Clé refusée (" + e.reason + ")." : ""; }
  }
  showTier();

  async function refresh() {
    if (!nr.checked) { st.textContent = "Modèle désactivé : règles seules (numéros, e-mails, téléphones)."; return; }
    let r;
    try { r = await chrome.runtime.sendMessage({ target: "background", type: "status" }); } catch (e) { r = { status: "error", error: String(e) }; }
    if (!r) st.textContent = "Modèle : démarrage…";
    else if (r.status === "ready") st.textContent = "Modèle : prêt.";
    else if (r.status === "loading") st.textContent = "Modèle : chargement " + (r.pct || 0) + " %…";
    else st.textContent = "Modèle : erreur (" + (r.error || r.detail || "?") + ")";
  }
  refresh();
  setInterval(refresh, 1500);

  // Registre export: one CSV line per masking event. Columns are counts per type; no value is ever stored.
  $("export").addEventListener("click", async () => {
    const { audit } = await chrome.storage.local.get({ audit: [] });
    const types = [...new Set(audit.flatMap(a => Object.keys(a.byType)))].sort();
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [["horodatage", "site", "evenement", "fichier", "total", ...types].map(esc).join(";")];
    for (const a of audit) {
      const total = Object.values(a.byType).reduce((x, y) => x + y, 0);
      lines.push([a.ts, a.site, a.kind, a.file || "", total, ...types.map(t => a.byType[t] || 0)].map(esc).join(";"));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "presidio-fr-registre-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
})();
