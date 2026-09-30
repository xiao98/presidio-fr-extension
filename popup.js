(async () => {
  const cb = document.getElementById("enabled");
  const rv = document.getElementById("reveal");
  const nr = document.getElementById("ner");
  const st = document.getElementById("nerStatus");
  const { enabled, reveal, ner, stats } = await chrome.storage.local.get({
    enabled: true, reveal: false, ner: true, stats: { masked: 0, byType: {} },
  });
  cb.checked = enabled;
  rv.checked = reveal;
  nr.checked = ner;
  cb.addEventListener("change", () => chrome.storage.local.set({ enabled: cb.checked }));
  rv.addEventListener("change", () => chrome.storage.local.set({ reveal: rv.checked }));
  nr.addEventListener("change", () => { chrome.storage.local.set({ ner: nr.checked }); refresh(); });
  document.getElementById("masked").textContent = stats.masked;
  const ul = document.getElementById("byType");
  for (const [t, n] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    const li = document.createElement("li");
    li.textContent = t + " : " + n;
    ul.appendChild(li);
  }

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
})();
