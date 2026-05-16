/**
 * ВСТАВИТЬ В КОНСОЛЬ БРАУЗЕРА (F12 → Console) на открытой карточке IceTrade.
 * Не запускать в Node.js.
 *
 * См. DEBUG_BROWSER.md
 */
(() => {
  const ext = /\.(pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?)(\?|#|$)/i;
  const absInText =
    /https?:\/\/(?:www\.)?icetrade\.by[-a-z0-9+&@#/%?=~_|!:,.;]*\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt)(?:\?[-a-z0-9+&@#/%?=~_|!:,.;]*)?/gi;

  const found = new Set();

  document.querySelectorAll("a[href]").forEach((a) => {
    const h = a.getAttribute("href");
    if (!h || h.startsWith("#") || h.toLowerCase().startsWith("javascript:")) return;
    try {
      const u = new URL(h, location.href).href;
      if (ext.test(u)) found.add(u);
    } catch {
      /* ignore */
    }
  });

  const html = document.documentElement.outerHTML;
  let m;
  const re = new RegExp(absInText.source, "gi");
  while ((m = re.exec(html)) !== null) found.add(m[0]);

  const arr = [...found].sort();
  console.log("[IceTrade debug] URL с расширением файла:", arr.length);
  console.table(arr.map((url, i) => ({ "#": i + 1, url })));

  try {
    if (typeof copy === "function" && arr.length) {
      copy(arr.join("\n"));
      console.log("[IceTrade debug] Список URL скопирован в буфер обмена (по одному на строку).");
    }
  } catch {
    /* не Chrome */
  }

  const res = performance.getEntriesByType("resource").filter((e) => ext.test(e.name));
  if (res.length) {
    console.log("[IceTrade debug] Resource timing (уже загруженные ресурсы с «файловым» URL):", res.length);
    console.table(res.slice(0, 40).map((e) => ({ name: e.name, initiatorType: e.initiatorType })));
  }

  return arr;
})();
