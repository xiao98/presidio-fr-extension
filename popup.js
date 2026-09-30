(async () => {
  const cb = document.getElementById("enabled");
  const rv = document.getElementById("reveal");
  const { enabled, reveal, stats } = await chrome.storage.local.get({ enabled: true, reveal: false, stats: { masked: 0, byType: {} } });
  cb.checked = enabled;
  rv.checked = reveal;
  cb.addEventListener("change", () => chrome.storage.local.set({ enabled: cb.checked }));
  rv.addEventListener("change", () => chrome.storage.local.set({ reveal: rv.checked }));
  document.getElementById("masked").textContent = stats.masked;
  const ul = document.getElementById("byType");
  for (const [t, n] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    const li = document.createElement("li");
    li.textContent = t + " : " + n;
    ul.appendChild(li);
  }
})();
