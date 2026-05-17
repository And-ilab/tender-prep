/**
 * Снимок структурированных данных с HTML-карточки IceTrade (процесс **Import**).
 * Эвристики: верстка площадки может меняться — проверяйте `warnings` и при необходимости дорабатывайте паттерны.
 */

/**
 * Убирает HTML-комментарии (часто «протекают» в текст событий как `//-->`).
 * @param {string} html
 */
function stripHtmlComments(html) {
  return html
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/\/\*([\s\S]*?)\*\//g, " ");
}

/**
 * @param {string} plain
 */
function truncateIceTradeSiteChrome(plain) {
  const patterns = [
    /©/,
    /Республиканск(?:ое|ий)\s+унитарное\s+предприятие/i,
    /Национальн\w+\s+центр\s+поддержки\s+экспорт/i,
    /\b2013\s*[-–]\s*2026\b/i,
    /\/\/\s*-->/,
    /\bicetrade\.by\s*[-–]?\s*поддержк/i,
    /<!\[endif\]/i,
  ];
  let cut = plain.length;
  for (const re of patterns) {
    const m = re.exec(plain);
    if (m && m.index >= 80 && m.index < cut) cut = m.index;
  }
  return plain.slice(0, cut).trimEnd();
}

/**
 * @param {string} t
 */
function cleanChronologyEventText(t) {
  let s = t.replace(/\s+/g, " ").trim();
  s = s.replace(/^\s*:\d{1,3}\s+/, "");
  for (const needle of ["©", "//-->", "Республиканское унитарное", "Национальный центр поддержки"]) {
    const i = s.indexOf(needle);
    if (i > 8) s = s.slice(0, i).trim();
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} text
 */
function isFooterNoise(text) {
  return /©|Республиканское\s+унитарное|Национальн\w+\s+центр\s+поддержки\s+экспорт|2013\s*[-–]\s*2026|\/\/\s*-->|\[endif\]/.test(
    text,
  );
}

/**
 * @param {string} t
 */
function isGenericIceTradeTitle(t) {
  if (!t || t.length < 4) return true;
  const s = t.trim();
  return /^icetrade\.by/i.test(s) || /^icetrade\s*[-–]/i.test(s) || /\bicetrade\.by\s*[-–]\s*\d{4}\s*[-–]\s*\d+$/i.test(s);
}

/**
 * @param {string} html
 */
function extractH1Plain(html) {
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  /** @type {string[]} */
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = stripHtmlToPlain(m[1]);
    if (t.length >= 12 && !isGenericIceTradeTitle(t)) out.push(t);
  }
  return out[0] ?? "";
}

/**
 * @param {string} html
 */
function extractJsonLdName(html) {
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    try {
      const j = JSON.parse(raw);
      /** @type {unknown[]} */
      const stack = Array.isArray(j) ? j : [j];
      for (const item of stack) {
        if (!item || typeof item !== "object") continue;
        const o = /** @type {Record<string, unknown>} */ (item);
        const name = o.name;
        if (typeof name === "string" && name.length > 15 && !isGenericIceTradeTitle(name)) return name.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return "";
}

/**
 * @param {string} html
 */
export function stripHtmlToPlain(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number.parseInt(n, 10));
      } catch {
        return " ";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} html
 */
function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]+content\\s*=\\s*["']([^"']*)["']`, "i");
  const m = re.exec(html);
  if (m) return decodeAmp(m[1].trim());
  const re2 = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+(?:property|name)\\s*=\\s*["']${prop}["']`, "i");
  const m2 = re2.exec(html);
  return m2 ? decodeAmp(m2[1].trim()) : "";
  /** @param {string} s */
  function decodeAmp(s) {
    return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number.parseInt(n, 10)),
    );
  }
}

/**
 * @param {string} html
 */
function titleTag(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripHtmlToPlain(m[1]) : "";
}

/**
 * @param {string} text
 */
function extractPhones(text) {
  /** @type {Set<string>} */
  const set = new Set();
  const patterns = [
    /\+375\s*\d{2}\s*\d{3}\s*\d{2}\s*\d{2}\b/g,
    /\+375[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}\b/g,
    /80[\s\-]?(?:\d[\s\-]?){9}\d/g,
    /\+7[\s\-]?(?:\d[\s\-]?){10}\d/g,
    /8\s?\(\d{3,4}\)\s?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g,
  ];
  for (const re of patterns) {
    let m;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(text)) !== null) {
      const n = m[0].replace(/\s+/g, " ").trim();
      if (n.length >= 8) set.add(n);
    }
  }
  return Array.from(set);
}

/**
 * @param {string} text
 */
function extractEmails(text) {
  /** @type {Set<string>} */
  const set = new Set();
  const re = /[a-z0-9._%+-]+@[a-z0-9][a-z0-9.-]+\.[a-z]{2,}/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const e = m[0].toLowerCase().replace(/[.,;]+$/, "");
    if (e.length > 5) set.add(e);
  }
  return Array.from(set);
}

/**
 * @param {string} plain
 */
function extractProcedureFromPlain(plain) {
  const ref = /\bПроцедура\s+закупки\s*№\s*([0-9\-–]+)/i.exec(plain);
  const form = /\b(Запрос\s+ценовых\s+предложений|Электронн(?:ый|ого)\s+аукцион|Открыт(?:ый|ого)\s+конкурс|Закрыт(?:ый|ого)\s+конкурс|Запрос\s+котировок)[^\n.]*/i.exec(plain);
  return {
    reference: ref ? ref[1].replace(/[–-]+/g, "-").trim() : null,
    form: form ? form[1].trim().slice(0, 120) : null,
  };
}

/**
 * Таблицы карточки IceTrade: в строке несколько ячеек — первая подпись, остальные склеиваются в значение.
 * @param {string} html
 */
function extractTableRowsAsFields(html) {
  /** @type {Record<string, string>} */
  const fields = {};
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tm;
  while ((tm = trRe.exec(html)) !== null) {
    const row = tm[1];
    /** @type {string[]} */
    const cells = [];
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = cellRe.exec(row)) !== null) {
      const c = stripHtmlToPlain(cm[1]).trim();
      cells.push(c);
    }
    if (cells.length < 2) continue;

    const key = cells[0].replace(/:\s*$/u, "").trim().slice(0, 220);
    const val = cells
      .slice(1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12_000);
    if (key.length < 2 || val.length < 1) continue;
    if (/^лоты|раскрыть\s+все\s+лоты|свернуть\s+все\s+лоты$/i.test(key)) continue;
    if (/^№\s*лота$/i.test(key) && /^предмет\s+закупки$/i.test(cells[1] ?? "")) continue;

    if (!fields[key] || fields[key].length < val.length) fields[key] = val;
  }
  return fields;
}

/**
 * @param {string} html
 * @param {string} baseUrl
 */
function extractDocumentLinks(html, baseUrl) {
  /** @type {Map<string, { name: string; href: string }>} */
  const byHref = new Map();
  const re = /<a\b[^>]*href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const hrefRaw = m[2].trim();
    const inner = stripHtmlToPlain(m[3]).trim();
    if (!/\.(pdf|docx?|zip|rar|7z)(\?|[#&]|$)/i.test(hrefRaw) && !/\.(pdf|docx?)(\?|[#&]|$)/i.test(inner)) {
      continue;
    }
    let href = hrefRaw;
    try {
      href = new URL(hrefRaw, baseUrl).href;
    } catch {
      /* относительный без базы — оставляем как есть */
    }
    const name = (inner || hrefRaw.split("/").pop() || hrefRaw).slice(0, 240);
    if (!byHref.has(href)) byHref.set(href, { name, href });
  }
  return [...byHref.values()];
}

/**
 * @param {string} html
 * @param {number} [max]
 */
function extractHeadingLines(html, max = 16) {
  /** @type {string[]} */
  const out = [];
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hm;
  while ((hm = re.exec(html)) !== null && out.length < max) {
    const t = stripHtmlToPlain(hm[2]).trim();
    if (t.length >= 2) out.push(t);
  }
  return out;
}

/**
 * @param {string} plain — сжатый однострочный текст (для цен)
 */
function extractPriceHints(plain) {
  const out = [];
  const lower = plain.toLowerCase();
  const kw =
    /(начальн[аыеоя]+\s+цен|стартов\w*\s+цен|цен\w*\s+лот|нмц|начальн\w*\s+максимальн|максимальн\w*\s+цен|бюджет|ориентировочн\w*\s+стоимость|стоимость\s+закупки|цен[аы]\s+конкурсн|\d[\d\s,.]*\s*(?:BYN|руб\.?|Br|бел\.\s*р))/gi;
  let m;
  while ((m = kw.exec(lower)) !== null) {
    const start = Math.max(0, m.index - 40);
    const end = Math.min(plain.length, m.index + 220);
    const slice = plain.slice(start, end).replace(/\s+/g, " ").trim();
    if (slice && !out.includes(slice)) out.push(slice);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * @param {string} html
 * @param {string} plainOneLine
 */
function extractLabeledHints(html, plainOneLine) {
  /** @type {Record<string, string>} */
  const fields = {};
  const patterns = [
    /(?:^|[\n\r]|\.\s)(Названи[ея]|Наименовани[ея]|Предмет\s+(?:закупки|лота)|Заказчик|Организатор|Контакт(?:ное)?\s*(?:лицо|телефон)?|Срок\s+(?:подачи|окончания)|Дата\s+(?:окончания|подачи))[\s:]+([^\n\r.]{4,240})/gi,
  ];
  for (const re of patterns) {
    let m;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(plainOneLine)) !== null) {
      const label = m[1].replace(/\s+/g, " ").trim().slice(0, 80);
      const val = (m[2] ?? m[1]).replace(/\s+/g, " ").trim().slice(0, 400);
      if (label.length >= 3 && val) {
        const key = label.slice(0, 60);
        if (!fields[key]) fields[key] = val;
      }
    }
  }
  /** Also try dl/dt from raw html — loose */
  const dtdd = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let dm;
  while ((dm = dtdd.exec(html)) !== null) {
    const k = stripHtmlToPlain(dm[1]).slice(0, 120);
    const v = stripHtmlToPlain(dm[2]).slice(0, 500);
    if (k.length >= 2 && v.length >= 1 && !fields[k]) fields[k] = v;
  }
  return fields;
}

/**
 * Подбор значения из `labeledFields`: в ключе должны встречаться все подстроки (без учёта регистра).
 * @param {Record<string, string>} fields
 * @param {string[]} mustInclude
 * @returns {string | null}
 */
function pickLabeledField(fields, mustInclude) {
  if (!mustInclude.length) return null;
  const subs = mustInclude.map((s) => s.toLowerCase());
  for (const [k, v] of Object.entries(fields)) {
    const kl = k.toLowerCase();
    if (subs.every((s) => kl.includes(s))) {
      const t = String(v).trim();
      return t.length ? t : null;
    }
  }
  return null;
}

/**
 * Каноническая структура под типовую карточку `…/tenders/all/view/<id>` (IceTrade).
 * Заполняется из табличных подписей RU; при смене формулировок на площадке смотрите сырой `labeledFields`.
 *
 * @param {Record<string, string>} labeledFields
 */
function buildStructuredIceTradeCard(labeledFields) {
  /** @param {string[]} p */
  const g = (p) => pickLabeledField(labeledFields, p);
  return {
    general: {
      industry: g(["отрасль"]),
      subjectShortDescription: g(["краткое описание предмета закупки"]),
    },
    customer: {
      procurementConductedBy: g(["закупка проводится"]),
      customerNameAddressUnp: g(["полное наименование заказчика"]),
      customerContacts: g(["фамилии", "телефон"]),
    },
    procedure: {
      invitationPublishedAt: g(["дата размещения приглашения"]),
      bidsDeadlineAt: g(["окончания приема предложений"]) || g(["приема предложений", "время"]),
      estimatedTotalValue: g(["общая ориентировочная стоимость"]) || g(["ориентировочная стоимость закупки"]),
      participantRequirements: g(["требования к составу участников"]),
      qualificationRequirements: g(["квалификационные требования"]),
      otherInfo: g(["иные сведения"]),
    },
    competitiveDocuments: {
      provisionTerms: g(["сроки", "место", "порядок предоставления конкурсных документов"]),
      documentPrice: g(["цена конкурсных документов"]),
    },
    bids: {
      submissionPlaceAndProcedure: g(["место и порядок представления конкурсных предложений"]),
    },
    lotDetails: {
      deliveryPeriod: g(["срок поставки"]),
      deliveryPlace: g(["место поставки товара", "выполнения работ"]),
      fundingSource: g(["источник финансирования"]),
      bidSecurity: g(["размер конкурсного обеспечения"]),
      okrbCode: g(["код окрб"]),
    },
  };
}

/**
 * События в хронологическом порядке (отмена и т.д.)
 * @param {string} html
 * @param {string} plain — многострочный
 */
function extractChronologyEvents(html, plain) {
  /** @type {{ date: string | null; text: string; severity?: string }[]} */
  const events = [];
  const plainCut = truncateIceTradeSiteChrome(plain);
  const markers = [
    /События\s+в\s+хронологическом\s+порядке/gi,
    /События\s+в\s+хронологическом/gi,
    /Хронологи\w+\s+событий/gi,
  ];
  let start = -1;
  for (const re of markers) {
    const m = re.exec(plainCut);
    if (m && m.index >= 0) {
      start = m.index;
      break;
    }
  }
  if (start < 0) {
    const m = /<table[^>]+class="[^"]*chronolog[^"]*"/i.exec(html);
    if (m && m.index >= 0) {
      start = Math.min(
        stripHtmlToPlain(html.slice(0, m.index)).length,
        Math.max(0, plainCut.length - 1),
      );
    }
  }
  if (start < 0) return events;

  let tail = plainCut.slice(start, start + 12_000);
  tail = truncateIceTradeSiteChrome(tail);
  const chunks = tail.split(/(?=\d{2}\.\d{2}\.\d{4}\b)/);
  for (const ch of chunks) {
    const t = ch.replace(/\s+/g, " ").trim();
    if (t.length < 15) continue;
    const dm = /^(\d{2}\.\d{2}\.\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?\s*[—\-–]?\s*(.+)$/i.exec(t);
    if (dm) {
      let text = cleanChronologyEventText(dm[3]).slice(0, 500);
      if (text.length < 12 || isFooterNoise(text)) continue;
      /** @type {"cancel"|"change"|"info"|undefined} */
      let severity;
      const low = text.toLowerCase();
      if (/отмен|аннулир|прекращ|недейств|отклон\s*ени/i.test(low)) severity = "cancel";
      else if (/изменен|изменён|корректиров|дополнен/i.test(low)) severity = "change";
      else severity = "info";
      events.push({
        date: dm[2] ? `${dm[1]} ${dm[2]}` : dm[1],
        text,
        severity,
      });
    } else if (t.length > 40 && events.length === 0) {
      const blob = cleanChronologyEventText(t).slice(0, 600);
      if (!isFooterNoise(blob) && blob.length >= 20) {
        events.push({ date: null, text: blob, severity: "info" });
      }
    }
  }
  return events.slice(0, 80);
}

/**
 * @param {string} html
 * @param {{ pageUrl: string, viewId: string, cardFetchVia?: string }} ctx
 */
export function buildIceTradeImportSnapshot(html, ctx) {
  const htmlClean = stripHtmlComments(html || "");
  const plainOne = stripHtmlToPlain(htmlClean);
  const plainMulti = htmlClean
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const ogTitle = metaContent(htmlClean, "og:title");
  const titleFromTag = titleTag(htmlClean);
  const titleFromH1 = extractH1Plain(htmlClean);
  const titleFromLd = extractJsonLdName(htmlClean);
  const headings = extractHeadingLines(htmlClean);
  let title = ogTitle || titleFromTag || "";
  if (isGenericIceTradeTitle(title)) {
    title = titleFromLd || titleFromH1 || title;
  }
  if (isGenericIceTradeTitle(title) && headings.length > 0) {
    const procH = headings.find((h) => /процедур\w*\s+закупк/i.test(h));
    if (procH) title = procH;
    else title = headings[0] || title;
  }

  const procedure = extractProcedureFromPlain(plainOne);
  const phones = extractPhones(plainOne);
  const emails = extractEmails(plainOne);
  const priceHints = extractPriceHints(plainOne);
  const plainForLabels = truncateIceTradeSiteChrome(plainOne.replace(/\s+/g, " "));
  const fromHints = extractLabeledHints(htmlClean, plainForLabels);
  const fromTable = extractTableRowsAsFields(htmlClean);
  const labeledFields = { ...fromHints, ...fromTable };
  const structured = buildStructuredIceTradeCard(labeledFields);
  const documentLinks = extractDocumentLinks(htmlClean, ctx.pageUrl);
  const events = extractChronologyEvents(htmlClean, plainMulti);

  /** @type {string[]} */
  const warnings = [];
  if (!html || html.length < 500) warnings.push("HTML карточки слишком короткий — возможно обрезка или ответ не полной страницы.");
  if (events.length === 0) warnings.push("Блок хронологии событий не найден — проверьте вручную на площадке.");
  if (isGenericIceTradeTitle(ogTitle || titleFromTag || "") && !titleFromH1 && !titleFromLd && headings.length === 0) {
    warnings.push(
      "Заголовок закупки в снимке может быть неточным (на странице только шаблонный <title>) — смотрите карточку на icetrade.by.",
    );
  }
  if (Object.keys(fromTable).length === 0 && Object.keys(fromHints).length === 0 && plainOne.length > 3000) {
    warnings.push(
      "Таблица «подпись — значение» не распознана в HTML (возможны div-сетка / подгрузка полей только в браузере). Основной текст карточки всё равно может быть в комплекте PDF/DOC.",
    );
  }

  return {
    schemaVersion: 2,
    kind: "icetrade.import.snapshot",
    fetchedAt: new Date().toISOString(),
    pageUrl: ctx.pageUrl,
    viewId: ctx.viewId,
    cardFetchVia: ctx.cardFetchVia ?? null,
    title: title || null,
    procedure,
    titleSources: {
      ogTitle: ogTitle || null,
      titleTag: titleFromTag || null,
      h1: titleFromH1 || null,
      jsonLdName: titleFromLd || null,
    },
    headings,
    phones,
    emails,
    priceHints,
    labeledFields,
    structured,
    documentLinks,
    events,
    warnings,
  };
}

/**
 * @param {unknown} snap
 * @returns {string}
 */
export function importSnapshotToJson(snap) {
  return `${JSON.stringify(snap, null, 2)}\n`;
}
