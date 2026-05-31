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

/**
 * Первый view id из сообщения: URL, только цифры, «№1341284», «тендер … 1341284».
 * @param {string} text
 * @returns {string | null}
 */
export function resolveIceTradeViewIdFromMessage(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const urlIds = extractIceTradeViewIds(s);
  if (urlIds.length > 0) return urlIds[0];
  const numMark = s.match(/(?:№|#|no\.?\s)\s*(\d{6,10})\b/i);
  if (numMark) return numMark[1];
  if (/(?:тендер|закупк|icetrade|лот|view)/i.test(s)) {
    const m = s.match(/\b(\d{6,10})\b/);
    if (m) return m[1];
  }
  return null;
}

/** Первый id из текста или голых цифр (CLI, bootstrap). */
export function normalizeIceTradeViewId(urlOrText) {
  return resolveIceTradeViewIdFromMessage(urlOrText);
}

function iceTradeBootstrapLooksLikeQuestion(text) {
  return /^(?:как\s+(?!начина)|почему|зачем|что\s+(?:такое|значит|положить|написать|нужно)|объясни|расскажи|можно\s+ли|нужно\s+ли|какой|какая|какие|где|когда|сколько)/i.test(
    text,
  );
}

/**
 * Запускать Import по тексту (ссылка, голый id, «начинаю подготовку №…»), а не отдавать в свободный LLM.
 * @param {string} text
 */
export function iceTradeBootstrapShouldRun(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  if (extractIceTradeViewIds(s).length > 0) return true;
  if (!resolveIceTradeViewIdFromMessage(s)) return false;
  if (/^\d+$/.test(s)) return true;
  if (
    /(?:начина(?:ю|ем|ть)|подготовк|импорт|скач(?:ай|ать)|загруз(?:и|ить)|bootstrap|нов(?:ый|ая)\s+(?:тендер|закупк))/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/(?:№|#)\s*\d{6,10}/.test(s) && /(?:тендер|закупк|icetrade|лот)/i.test(s)) return true;
  if (/(?:тендер|закупк|icetrade|лот)/i.test(s) && /\b\d{6,10}\b/.test(s)) {
    if (iceTradeBootstrapLooksLikeQuestion(s) && !/(?:начина(?:ю|ем|ть)|импорт|bootstrap)/i.test(s)) {
      return false;
    }
    return true;
  }
  return false;
}
