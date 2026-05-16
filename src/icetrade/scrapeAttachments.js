/** Начало блока с файлами на карточке IceTrade (см. скрин «Аукционные документы»). */
const RX_AUCTION_DOCS_HEADER = /Аукционные\s+документы/i;
/** Конец блока — следующая крупная секция на типичной карточке. */
const RX_SLICE_END =
  /События\s+в\s+хронологическом|конкурсн(?:ые|ыя)\s+документы|закупк(?:и|а)\s*:\s*документы/i;

/**
 * В path/query URL встречается номер карточки как отдельный токен (не подстрока в другом числе).
 * @param {string} urlStr
 * @param {string} viewId
 */
function urlMentionsTenderViewId(urlStr, viewId) {
  const id = viewId.trim();
  if (!/^\d+$/.test(id)) return false;
  try {
    const u = new URL(urlStr);
    const s = `${u.pathname}${u.search}`;
    const re = new RegExp(`(^|[^0-9])${id}([^0-9]|$)`);
    return re.test(s);
  } catch {
    return false;
  }
}

/**
 * Часть карточки — инструкции ЭТП (браузер, ЛК), не документы закупки.
 * Имена как в PDF с площадки: edge_browser_settings, ice_account_settings, …
 *
 * Если передан **tenderViewId** и URL явно относится к этой карточке (содержит id), не считаем служебным
 * (на случай спорных имён файлов в комплекте закупки).
 *
 * @param {string} url
 * @param {string | undefined} linkText
 * @param {string | undefined} tenderViewId
 */
export function isIceTradePlatformHelpAttachment(url, linkText, tenderViewId) {
  try {
    const hn = new URL(url).hostname.replace(/^www\./i, "");
    if (hn === "goszakupki.by" || hn.endsWith(".goszakupki.by")) return false;
  } catch {
    /* ignore */
  }

  if (tenderViewId && urlMentionsTenderViewId(url, tenderViewId)) return false;

  let baseFromUrl = "";
  try {
    const u = new URL(url);
    const raw = u.pathname.split("/").pop() || "";
    baseFromUrl = decodeURIComponent(raw.replace(/[?#].*$/, "")).replace(/\.[a-z0-9]{1,8}$/i, "");
  } catch {
    /* ignore */
  }
  const lt = (linkText ?? "")
    .trim()
    .replace(/\.[a-z0-9]{1,8}$/i, "");
  const blobs = [baseFromUrl, lt].map((s) => s.trim().toLowerCase()).filter(Boolean);
  const blob = blobs.join(" ");
  // Не использовать \b вокруг "browser": в JS "_" — \w, для "edge_browser_settings" границы слова «ломаются».
  if (/edge_browser|mozilla_browser|chrome_browser|safari_browser|ice_browser/i.test(blob)) return true;
  if (/browser_settings/i.test(blob)) return true;
  if (/ice_account.*settings|ice_account_settings/i.test(blob)) return true;
  if (/account_settings/i.test(blob)) return true;
  if (blob === "personal_data" || /^personal_data[\s_-]*(policy|notice)?$/i.test(blob)) return true;

  /** Типовые файлы самой ЭТП IceTrade (не комплект заказчика по процедуре). */
  for (const part of blobs) {
    const nx = part.replace(/\s+/g, "_");
    if (nx === "preiskurant" || nx === "reglament_os") return true;
  }

  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (/\/(help|support|instruction)\b/i.test(p)) return true;
  } catch {
    /* ignore */
  }

  return false;
}

/**
 * @typedef {{ url: string, linkText?: string }} IceTradeAttachmentLink
 */

/**
 * IceTrade при недоступной без сессии карточке отдаёт 200 и HTML формы входа (не редирект 401).
 * @param {string} html
 */
export function isIceTradeLoginWallHtml(html) {
  if (!html || html.length < 800) return false;
  if (RX_AUCTION_DOCS_HEADER.test(html)) return false;
  if (
    /Подача\s+предложений|приглашени[ея]\s+к\s+участию/i.test(html) &&
    /\.(pdf|docx?)(\?|"|'|>|$|\s)/i.test(html)
  ) {
    return false;
  }
  const h = html;
  const hasLoginForm =
    /name\s*=\s*["']llogin["']/i.test(h) &&
    (/name\s*=\s*["']lPassword["']/i.test(h) ||
      /id\s*=\s*["']pass["'][^>]*type\s*=\s*["']password["']/i.test(h));
  const hasSubmit =
    /<input[^>]+type\s*=\s*["']submit["'][^>]*value\s*=\s*["']Войти["']/i.test(h) ||
    /value\s*=\s*["']Войти["'][^>]*type\s*=\s*["']submit["']/i.test(h);
  if (hasLoginForm && hasSubmit) return true;
  if (
    /id\s*=\s*["']login["'][^>]*name\s*=\s*["']llogin["']/i.test(h) &&
    /l-pass/i.test(h) &&
    /Войти/i.test(h)
  ) {
    return true;
  }
  return false;
}

/**
 * Вырезает HTML от заголовка «Аукционные документы» до следующей секции (или разумный лимит).
 * @param {string} html
 * @returns {string | null}
 */
export function sliceAuctionDocumentsSection(html) {
  if (!html) return null;
  const m = RX_AUCTION_DOCS_HEADER.exec(html);
  if (!m || m.index === undefined) return null;
  const start = m.index;
  const tail = html.slice(start);
  const skip = Math.min(200, tail.length);
  const rest = tail.slice(skip);
  const endM = RX_SLICE_END.exec(rest);
  const endInTail =
    endM && endM.index !== undefined && endM.index > 80 ? skip + endM.index : Math.min(tail.length, 220_000);
  return html.slice(start, start + endInTail);
}

/**
 * @param {string} s
 */
function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} s
 */
function decodeHtmlEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)));
}

/**
 * @param {string} hrefLower
 * @param {string} path
 * @param {string} search
 * @param {boolean} onIcetrade
 * @param {boolean} relaxed
 * @param {string} [linkTextNorm]
 */
function linkLooksLikeAttachment(hrefLower, path, search, onIcetrade, relaxed, linkTextNorm, onGoszakupki) {
  const okExt = /\.(pdf|docx?|zip|rar|7z|xlsx?|csv|txt|pptx?)(\?|#|$)/i.test(hrefLower);
  const okKw = /(download|attach|file|upload|storage|docs)/i.test(path);
  /** Прямая выдача файла с goszakupki.by (в URL часто нет .pdf — имя в тексте ссылки). */
  const okGoszakupkiGetFile = onGoszakupki && /\/(auction\/)?get-file\/\d+/i.test(path);
  const okLinkTextGoszakupki =
    relaxed &&
    onGoszakupki &&
    linkTextNorm != null &&
    /\.(pdf|docx?|zip|rar|7z|xlsx?)\b/i.test(linkTextNorm) &&
    /\/(auction\/)?get-file\/\d+/i.test(path);
  const okIceTradeId =
    relaxed &&
    onIcetrade &&
    /_[0-9]{8,14}\.(pdf|docx?|zip|rar|7z|xlsx?)(\?|#|$)/i.test(hrefLower);
  const okIcetradePath =
    relaxed &&
    onIcetrade &&
    /\/(file|files|download|attachment|attachments|storage|get-file|getdoc|document|doc_download)/i.test(
      path,
    );
  const okQueryDoc =
    relaxed && onIcetrade && /\b(id|fid|file|doc|tid|did|aid)=[^&\s"']+/i.test(search);
  const okLinkTextIce =
    relaxed &&
    onIcetrade &&
    linkTextNorm != null &&
    /\.(pdf|docx?|zip|rar|7z|xlsx?)\b/i.test(linkTextNorm);
  return Boolean(
    okExt ||
      okKw ||
      okGoszakupkiGetFile ||
      okLinkTextGoszakupki ||
      okIceTradeId ||
      okIcetradePath ||
      okQueryDoc ||
      okLinkTextIce,
  );
}

/**
 * @param {string} rawHref
 * @param {string | undefined} linkTextNorm
 * @param {URL} base
 * @param {Set<string>} seen
 * @param {IceTradeAttachmentLink[]} out
 * @param {boolean} relaxed
 */
function tryPushDescriptor(rawHref, linkTextNorm, base, seen, out, relaxed) {
  const trimmed = rawHref.trim().replace(/^["']|["']$/g, "");
  if (!trimmed || trimmed.startsWith("#") || trimmed.toLowerCase().startsWith("javascript:")) return;
  let abs;
  try {
    abs = new URL(trimmed, base).href;
  } catch {
    return;
  }
  const u = new URL(abs);
  const host = u.hostname.replace(/^www\./i, "");
  const baseHost = base.hostname.replace(/^www\./i, "");
  const onIcetrade = host === "icetrade.by" || host.endsWith(".icetrade.by");
  const onGoszakupki = host === "goszakupki.by" || host.endsWith(".goszakupki.by");
  const onSame = host === baseHost;
  if (!onIcetrade && !onSame && !onGoszakupki) return;

  const path = `${u.pathname}`.toLowerCase();
  const search = `${u.search}`.toLowerCase();
  const hrefLow = abs.toLowerCase();

  if (!linkLooksLikeAttachment(hrefLow, path, search, onIcetrade, relaxed, linkTextNorm, onGoszakupki)) return;
  if (seen.has(abs)) return;
  seen.add(abs);
  /** @type {IceTradeAttachmentLink} */
  const rec = { url: abs };
  if (
    linkTextNorm &&
    linkTextNorm.length > 2 &&
    linkTextNorm.length < 220 &&
    /\.(pdf|docx?|zip|rar|7z|xlsx?|csv|txt)\b/i.test(linkTextNorm)
  ) {
    rec.linkText = linkTextNorm;
  }
  out.push(rec);
}

/**
 * Прямые ссылки из тегов &lt;a href&gt;…&lt;/a&gt; (текст ссылки часто = имя файла на IceTrade).
 * @param {string} html
 * @param {URL} base
 * @param {Set<string>} seen
 * @param {IceTradeAttachmentLink[]} out
 * @param {boolean} relaxed
 */
function collectFromAnchorTags(html, base, seen, out, relaxed) {
  const re =
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    const inner = decodeHtmlEntities(stripTags(String(m[4] ?? ""))).trim();
    tryPushDescriptor(raw, inner || undefined, base, seen, out, relaxed);
  }
}

/**
 * Оставшиеся href (без обхода &lt;a&gt;, на случай разметки без закрывающего тега).
 * @param {string} html
 * @param {URL} base
 * @param {Set<string>} seen
 * @param {IceTradeAttachmentLink[]} out
 * @param {boolean} relaxed
 */
function collectBareHrefs(html, base, seen, out, relaxed) {
  const reQuoted = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = reQuoted.exec(html)) !== null) {
    tryPushDescriptor(m[1], undefined, base, seen, out, relaxed);
  }
  const reBare = /\bhref\s*=\s*([^\s<>"']+)/gi;
  while ((m = reBare.exec(html)) !== null) {
    tryPushDescriptor(m[1], undefined, base, seen, out, relaxed);
  }
}

/**
 * Абсолютные URL на icetrade.by с расширением файла (в т.ч. внутри JSON/Vue в HTML).
 */
function collectIcetradeAbsoluteFileUrls(html, base, seen, out, relaxed) {
  const re =
    /https?:\/\/(?:www\.)?icetrade\.by[-a-z0-9+&@#/%?=~_|!:,.;]*\.(?:pdf|docx?|zip|rar|7z|xlsx?|csv|txt)(?:\?[-a-z0-9+&@#/%?=~_|!:,.;]*)?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    tryPushDescriptor(m[0], undefined, base, seen, out, relaxed);
  }
}

/** Ссылки вида https://goszakupki.by/auction/get-file/&lt;id&gt;?… (расширения в URL нет). */
function collectGoszakupkiGetFileUrls(html, base, seen, out, relaxed) {
  const re =
    /https?:\/\/(?:www\.)?goszakupki\.by\/auction\/get-file\/\d+[-a-z0-9+&@#/%?=~_|!:,.;]*/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    tryPushDescriptor(m[0], undefined, base, seen, out, relaxed);
  }
}

/**
 * Ссылки на файлы заказчика: блок «Аукционные документы», затем вся страница.
 * Источники на одной карточке **могут сочетаться**: прямые вложения **icetrade.by** и ссылки выдачи файлов **goszakupki.by** (`/auction/get-file/…`).
 * @param {string} html
 * @param {string} pageUrl
 * @returns {IceTradeAttachmentLink[]}
 */
export function extractAttachmentCandidates(html, pageUrl) {
  const base = new URL(pageUrl);
  const seen = new Set();
  /** @type {IceTradeAttachmentLink[]} */
  const out = [];

  const section = sliceAuctionDocumentsSection(html);
  if (section) {
    collectFromAnchorTags(section, base, seen, out, true);
    collectBareHrefs(section, base, seen, out, true);
    collectIcetradeAbsoluteFileUrls(section, base, seen, out, true);
    collectGoszakupkiGetFileUrls(section, base, seen, out, true);
  }

  const sectionOnly =
    process.env.LENA_ICETRADE_ATTACHMENTS_SECTION_ONLY?.trim() === "1" ||
    process.env.LENA_ICETRADE_ATTACHMENTS_SECTION_ONLY?.toLowerCase() === "true";
  if (!(sectionOnly && section)) {
    collectFromAnchorTags(html, base, seen, out, false);
    collectBareHrefs(html, base, seen, out, false);
    collectIcetradeAbsoluteFileUrls(html, base, seen, out, false);
    collectGoszakupkiGetFileUrls(html, base, seen, out, false);
  }

  return out.filter((c) => !isIceTradePlatformHelpAttachment(c.url, c.linkText, undefined));
}
