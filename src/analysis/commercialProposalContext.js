/**
 * Модуль «Анализ» для коммерческого предложения: правила ценообразования и заготовка промпта для ИИ.
 * Вход — результат парсинга (тексты документации заказчика, опционально структура карточки IceTrade).
 *
 * Согласовано с docs/LENA_RULES.md §6d; «защита от дурака» по номинальным суммам — ниже.
 */

/** @typedef {"starting_offer_allowed" | "manager_price_required"} PricingMode */

/** @typedef {{
 *   pricingMode: PricingMode,
 *   reasons: string[],
 *   flags: {
 *     hasReductionProcedure: boolean,
 *     suspiciousCustomerPrice: boolean,
 *     referencePriceMajor: number | null,
 *     referencePriceRaw: string | null,
 *   },
 * }} CommercialProposalAnalysis */

const REDUCTION_RE =
  /снижен(?:ие|ия|ию|и)\b|этап\w*\s+снижен|переговор\w*\s+(?:в\s+)?(?:рамках\s+)?(?:процедур\w*\s+)?снижен|улучшен\w*\s+(?:предложен|оферт)|торг\w*\s+на\s+понижен|конкурентн\w*\s+переговор|приглашени\w*\s+на\s+снижен|запрос\w*\s+об\s+улучшен/i;

const MONEY_RE_GLOBAL = new RegExp(
  String(
    "(" +
      "\\d{1,3}(?:[\\s\\u00A0]\\d{3})*(?:[.,]\\d{1,2})?" +
      "|" +
      "\\d+(?:[.,]\\d{1,2})?" +
      ")\\s*" +
      "(?:тыс\\.?|млн\\.?)?\\s*" +
      "(?:" +
      "BYN|бел\\.?\\s*руб|белорусск\\w*\\s*руб|руб\\.?|₽|RUB" +
      ")",
  ),
  "gi",
);

function minSanityMajor() {
  const n = Number.parseFloat(process.env.LENA_ANALYSIS_MIN_SANITY_PRICE_MAJOR?.trim() ?? "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/**
 * @param {string} raw
 * @returns {number | null}
 */
export function parseMoneyMajorUnit(raw) {
  if (!raw || typeof raw !== "string") return null;
  let t = raw.replace(/\u00A0/g, " ").trim();
  t = t
    .replace(/\s*(?:BYN|бел\.?\s*руб\w*|белорусск\w*\s*руб\w*|руб\.?|₽|RUB)\s*$/i, "")
    .trim();
  const m = /^([\d\s]+)(?:[.,](\d{1,2}))?\s*(тыс\.?|млн\.?)?$/i.exec(t.replace(/\s+/g, " "));
  if (!m) return null;
  const whole = m[1].replace(/\s/g, "");
  const frac = m[2] ? `.${m[2]}` : "";
  const mult =
    m[3] && /млн/i.test(m[3]) ? 1_000_000 : m[3] && /тыс/i.test(m[3]) ? 1000 : 1;
  const v = Number.parseFloat(`${whole}${frac}`);
  if (!Number.isFinite(v)) return null;
  return v * mult;
}

/**
 * Вытащить первую похожую на ориентировочную стоимость сумму из строк или структуры.
 * @param {string[]} texts
 * @param {unknown} structuredSnapshot
 */
export function extractCustomerReferencePrice(texts, structuredSnapshot) {
  const fromStruct = pickStructuredEstimate(structuredSnapshot);
  if (fromStruct) {
    const v = parseMoneyMajorUnit(fromStruct);
    if (v != null && v > 0) return { major: v, raw: fromStruct };
  }
  const blob = (texts || []).filter(Boolean).join("\n").slice(0, 500_000);
  MONEY_RE_GLOBAL.lastIndex = 0;
  const hit = MONEY_RE_GLOBAL.exec(blob);
  if (hit) {
    const slice = hit[0];
    const v = parseMoneyMajorUnit(slice.replace(/[BYNRUB₽белорусскиемлнтысруб.]/gi, " ").trim());
    if (v != null && v > 0) return { major: v, raw: slice.trim() };
  }
  const nmck = /(?:НМЦК|начальн\w*\s+(?:максимальн\w*\s+)?цен\w*|ориентировочн\w*\s+стоимост\w*)[^0-9]{0,40}(\d[\d\s]*(?:[.,]\d+)?)/i.exec(
    blob,
  );
  if (nmck) {
    const v = parseMoneyMajorUnit(nmck[1].replace(/\s/g, " ") + " BYN");
    if (v != null && v > 0) return { major: v, raw: nmck[1].trim() };
  }
  return { major: null, raw: null };
}

/** @param {unknown} structured */
function pickStructuredEstimate(structured) {
  if (!structured || typeof structured !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (structured);
  const proc = o.procedure;
  if (proc && typeof proc === "object") {
    const p = /** @type {Record<string, unknown>} */ (proc);
    const v = p.estimatedTotalValue ?? p.estimated_value;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Номинальная / явно ошибочная опорная цена (1 ₽, 0,1 ₽ и т.п., или всё что ниже порога sanity).
 * @param {number | null} major
 */
export function isSuspiciousCustomerReferencePrice(major) {
  if (major == null || !Number.isFinite(major)) return false;
  if (major <= 0) return false;
  if (major < 1) return true;
  return major < minSanityMajor();
}

/**
 * @param {string[]} sources
 */
export function detectPriceReductionProcedure(...sources) {
  const t = sources.flat().filter(Boolean).join("\n");
  return REDUCTION_RE.test(t);
}

/**
 * @param {{
 *   texts?: string[],
 *   structuredSnapshot?: unknown,
 * }} p
 * @returns {CommercialProposalAnalysis}
 */
export function buildCommercialProposalAnalysis(p) {
  const texts = Array.isArray(p.texts) ? p.texts.filter((x) => typeof x === "string") : [];
  const struct = p.structuredSnapshot;
  const blob = texts.join("\n");
  const structProc =
    struct && typeof struct === "object" && "procedure" in struct
      ? /** @type {{ procedure?: { otherInfo?: string } }} */ (struct).procedure
      : undefined;
  const hasReduction = detectPriceReductionProcedure(blob, structProc?.otherInfo ?? "");

  const { major: refMajor, raw: refRaw } = extractCustomerReferencePrice(texts, struct);
  const suspicious = isSuspiciousCustomerReferencePrice(refMajor);

  /** @type {PricingMode} */
  let pricingMode = "manager_price_required";
  const reasons = [];

  if (hasReduction) {
    pricingMode = "starting_offer_allowed";
    reasons.push(
      "В переданных текстах найдены признаки процедуры снижения цены / переговоров / улучшения предложения — допустима стартовая цена в КП как ориентир под этап (не финальная политика; см. §6d LENA_RULES).",
    );
    if (refMajor != null) {
      reasons.push(`Опорная сумма из документов (для контекста): ${refRaw ?? String(refMajor)} — использовать только если это действительно стартовая/лимит заказчика по лоту.`);
    } else {
      reasons.push(
        "Явной числовой стартовой цены в переданном фрагменте не найдено — не выводить процент «от воздуха»; запросить цифру у менеджера или вынести в бланк Требуется сумма.",
      );
    }
  } else {
    reasons.push(
      "Явной процедуры снижения/переговоров в переданном тексте не обнаружено — цену в КП не задавать самостоятельно; согласовать с менеджером (НДС — как в документации заказчика).",
    );
  }

  if (suspicious) {
    pricingMode = "manager_price_required";
    reasons.push(
      `Опорная цена заказчика выглядит номинальной или нереалистичной (значение < ${minSanityMajor()} в условных единицах или < 1) — не использовать для автоматического −1–2 %; обязательно согласование с менеджером.`,
    );
  }

  return {
    pricingMode,
    reasons,
    flags: {
      hasReductionProcedure: hasReduction,
      suspiciousCustomerPrice: suspicious,
      referencePriceMajor: refMajor,
      referencePriceRaw: refRaw,
    },
  };
}

/**
 * Блоки для передачи в LLM (доп. системный контекст + пользовательская задача на черновик КП).
 * @param {CommercialProposalAnalysis} analysis
 * @param {{ tenderLabel?: string }} [opts]
 */
export function buildCommercialProposalPromptPack(analysis, opts = {}) {
  const label = opts.tenderLabel?.trim() ? `Закупка: ${opts.tenderLabel.trim()}\n\n` : "";
  const modeLine =
    analysis.pricingMode === "starting_offer_allowed"
      ? "Режим цены для КП: **стартовое предложение допустимо** (есть процедура снижения/переговоров), при наличии явной стартовой у заказчика — ориентир на 1–2 % ниже с пометкой, что это вход в этап снижения."
      : "Режим цены для КП: **цену согласовать с менеджером** — не указывать итоговую/стартовую сумму без ответа коммерции; в тексте КП можно оставить плейсхолдер «к заполнению менеджером» и перечислить нужные данные (с НДС / без НДС по документам заказчика).";

  const systemAddendum = [
    "Коммерческое предложение строить **только** на предоставленной документации заказчика (и извлечённых текстах); не дополнять факты из общих знаний.",
    modeLine,
    `Флаги анализа: процедура снижения=${analysis.flags.hasReductionProcedure ? "да" : "нет"}; подозрительная опорная цена=${analysis.flags.suspiciousCustomerPrice ? "да" : "нет"}.`,
  ].join(" ");

  const userPrompt = `${label}Подготовь структурированное **коммерческое предложение** (черновик) для участия в закупке.

**Обязательно:**
- опирайся только на факты из приложенных фрагментов (позиции, лоты, сроки, НДС, требования к составу предложения);
- если чего-то нет в тексте — явно пометь «Требуется уточнение», не выдумывай;
- ${analysis.pricingMode === "starting_offer_allowed" ? "укажи цену как стартовый ориентир под процедуру снижения (если в документах есть допустимая база); иначе плейсхолдер цены." : "не указывай конкретную итоговую цену без согласования — только плейсхолдер и список данных для менеджера."}

**Контекст решения по цене (для модели):**
${analysis.reasons.map((r) => `- ${r}`).join("\n")}

Выведи: 1) краткое резюме заказа, 2) таблицу/список позиций с ценой или плейсхолдером, 3) условия поставки/оплаты — если они есть в документах, 4) срок действия предложения — если задан или предложи формулировку «до даты подачи», если это следует из документов.`;

  return { systemAddendum, userPrompt };
}
