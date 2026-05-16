/** IceTrade: номера закупок из URL вида …/tenders/all/view/<id> (со схемой и без). */
export function extractIceTradeViewIds(text) {
  /** @type {Set<string>} */
  const ids = new Set();
  const r1 = /https?:\/\/(?:www\.)?icetrade\.by\/tenders\/all\/view\/(\d+)/gi;
  let m;
  while ((m = r1.exec(text)) !== null) ids.add(m[1]);
  const r2 = /(?:^|[^\w/])(?:www\.)?icetrade\.by\/tenders\/all\/view\/(\d+)/gi;
  while ((m = r2.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

/** Первый id из текста или голых цифр. */
export function normalizeIceTradeViewId(urlOrText) {
  const s = urlOrText.trim();
  if (/^\d+$/.test(s)) return s;
  const ids = extractIceTradeViewIds(s);
  return ids[0] ?? null;
}
