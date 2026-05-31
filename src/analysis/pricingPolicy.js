/**
 * Детерминированные правила для черновика КП: процедура снижения / переговоры,
 * пороги явного согласования цены с менеджером.
 */

/**
 * Извлечь числовую сумму из фрагмента строки с маркером валюты (BYN, USD, EUR …).
 * @param {string} line
 * @returns {number}
 */
function parseMoneyAmountFromPriceLine(line) {
  const tail =
    /\b(\d{1,3}(?:[\s\u00A0]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:BYN|руб\.?|бел\.?\s*руб|Br|USD|US\$|\$|EUR|€|евро|CNY|CN¥|юан|юаней|RUB|российск\w*\s*руб|₽)\b/i;
  let m = line.match(tail);
  if (m) return Number.parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
  const head =
    /\b(?:USD|US\$|\$|EUR|€)\s*(\d{1,3}(?:[\s\u00A0]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\b/i;
  m = line.match(head);
  if (m) return Number.parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
  return NaN;
}

/**
 * Процедура улучшения / добровольного снижения цены и т.п. (эвристика по тексту корпуса).
 * @param {string} corpus
 */
export function corpusMentionsPriceReductionProcedure(corpus) {
  const c = String(corpus || "");
  /** @type {RegExp[]} */
  const patterns = [
    /процедур\w*\s+улучшен/i,
    /улучшен\w*\s+предложен/i,
    /ценов\w*\s+предложен\w*\s+участник/i,
    /добровольн\w*\s+снижен/i,
    /снижен\w*\s+цен/i,
    /цен\w*\s+снижен/i,
    /снижен\w*\s+начальн/i,
    /снижен\w*\s+ценов\w*\s+предложен/i,
    /переговор\w*(\s+и|\s+по|\s+в)?\s*улучшен/i,
    /переговор\w*\s+об\s+улучшен/i,
    /торг\w*\s+на\s+понижен/i,
    /этап\w*\s+снижен/i,
    /этап\w*\s+улучшен/i,
    /повторн\w*\s+подач\w*\s+ценов/i,
    /повторн\w*\s+предложен/i,
  ];
  return patterns.some((rx) => rx.test(c));
}

/**
 * Эвристика: в тексте закупки встречается подозрительно малая «цена» (1 / 0,1 …) или явная заглушка.
 * Порог maxAbsurd: положительные суммы ≤ этого значения с маркером валюты считаются подозрительными.
 * @param {string} corpus
 * @param {{ maxAbsurd?: number }} [opts]
 */
export function corpusSuggestsAbsurdStatedPrice(corpus, opts = {}) {
  const fromEnv = Number.parseFloat(
    String(process.env.LENA_CP_ABSURD_PRICE_MAX ?? "").trim() || "5",
  );
  const maxAbsurd =
    opts.maxAbsurd ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 5);
  const c = String(corpus || "");
  if (
    /\b(?:начальн\w+|максимальн\w+|предельн\w+|стартов\w+)\s+[^\n]{0,120}?\b(0[,.]1|1)(?:\s*(?:руб|byn|бел|₽))?/i.test(
      c,
    )
  ) {
    return true;
  }
  if (
    /\bцена(?:\s+единицы)?\s+[^\n]{0,60}?\b(?:0[,.]1|1)\s*(?:руб|BYN|бел|₽)/i.test(c)
  ) {
    return true;
  }
  const rx = /\b(\d+(?:[.,]\d+)?)\s*(?:руб|BYN|бел|рубл|BYR|₽)\b/gi;
  let m;
  while ((m = rx.exec(c)) !== null) {
    const n = Number.parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(n) && n > 0 && n <= maxAbsurd) return true;
  }
  return false;
}

/**
 * Строки корпуса, похожие на НМЦ / цену лота / стоимость закупки: сумма BYN < порога → согласование с менеджером.
 * @param {string} corpus
 * @param {number} [thresholdBYN]
 */
export function corpusStatedMajorPriceBelowCoordinationThreshold(corpus, thresholdBYN) {
  const env = Number.parseFloat(String(process.env.LENA_CP_COORDINATION_PRICE_BELOW_BYN ?? "").trim());
  const thr =
    typeof thresholdBYN === "number" && thresholdBYN > 0
      ? thresholdBYN
      : Number.isFinite(env) && env > 0
        ? env
        : 10_000;
  const c = String(corpus || "");
  const lines = c.split(/\n/);
  const kw =
    /нмц|начальн\w*(?:\s+максимальн\w*)?\s+цен|предельн\w*\s+цен|ориентировочн\w*\s+стоимост|стоимост\w*\s+закупк|цен\w*\s+лот|единицы\s+цен|ценов\w*\s+предложен/i;
  const bynAmt =
    /\b(\d{1,3}(?:[\s\u00A0]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:BYN|руб\.?|бел\.?\s*руб|Br)\b/i;

  for (const line of lines) {
    if (!kw.test(line)) continue;
    const m = line.match(bynAmt);
    if (!m) continue;
    const n = Number.parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(n) && n > 0 && n < thr) return true;
  }
  return false;
}

/**
 * Есть ли в корпусе строка, похожая на НМЦ / предельную (стартовую) цену заказчика с суммой в BYN не ниже порога «пустышки».
 * @param {string} corpus
 * @param {{ minAmount?: number }} [opts]
 */
export function corpusHasProbableCustomerPriceCeiling(corpus, opts = {}) {
  const minAmount =
    typeof opts.minAmount === "number" && opts.minAmount > 0 ? opts.minAmount : 50;
  const c = String(corpus || "");
  const lines = c.split(/\n/);
  const kw =
    /нмц|начальн\w*(?:\s+максимальн\w*)?\s+цен|предельн\w*\s+цен|стартов\w*\s+цен|ориентировочн\w*\s+стоимост|стоимост\w*\s+закупк|цен\w*\s+лот|единицы\s+цен|ценов\w*\s+предложен/i;

  for (const line of lines) {
    if (!kw.test(line)) continue;
    const n = parseMoneyAmountFromPriceLine(line);
    if (Number.isFinite(n) && n >= minAmount) return true;
  }
  return false;
}

/**
 * Короткие bullet-строки для Telegram: что автоматика **не увидела** в тексте Analysis / Preparation (не замена полного комплекта).
 * @param {string} corpus
 * @returns {string[]}
 */
export function buildTelegramManagerPriceDocHints(corpus) {
  const c = String(corpus || "");
  const hasCeiling = corpusHasProbableCustomerPriceCeiling(c);
  const hasReduction = corpusMentionsPriceReductionProcedure(c);
  /** @type {string[]} */
  const out = [];
  if (!hasCeiling) {
    out.push(
      "• Стартовую / предельную / НМЦ с суммой в тексте не нашла (валюта может быть USD, EUR, BYN, RUB и др.). Имеет смысл сверить полный комплект документов.",
    );
  }
  if (!hasReduction) {
    out.push(
      "• Явных формулировок про снижение цены, улучшение предложения или переговоры по цене в тексте не видно — если в закупке это есть, ориентируйтесь на полный комплект.",
    );
  }
  if (hasCeiling && hasReduction) {
    out.push(
      "• В тексте есть и ориентир по цене заказчика, и процедура улучшения/снижения — учитывайте при выборе стартовой цены участника.",
    );
  }
  return out;
}

/**
 * Нужно явное согласование суммы КП с менеджером (Analysis / диалог).
 * Триггеры: заведомо заниженная цена в документах; сумма по ключевым строкам < порога (по умолчанию 10 000 BYN);
 * отсутствие в корпусе признаков процедуры улучшения / переговоров о цене / снижения.
 *
 * @param {string} corpus
 */
export function corpusNeedsExplicitPriceCoordination(corpus) {
  const hasReduction = corpusMentionsPriceReductionProcedure(corpus);
  const absurd = corpusSuggestsAbsurdStatedPrice(corpus);
  const belowThr = corpusStatedMajorPriceBelowCoordinationThreshold(corpus);
  const noProcedure = !hasReduction;
  return {
    absurd,
    belowCoordinationThreshold: belowThr,
    noMandatoryImprovementOrNegotiation: noProcedure,
    needsCoordination: absurd || belowThr || noProcedure,
    hasReduction,
  };
}

/**
 * Блок для пользовательского промпта (модель обязана следовать; детали цены — из документов).
 * @param {string} corpus
 * @param {{ hasManagerPriceQuote?: boolean }} [opts] — если true, менеджер уже передал **lena-manager-price-quote.md** (приоритет над эвристиками корпуса).
 */
export function buildCommercialPricingPromptSection(corpus, opts = {}) {
  if (opts.hasManagerPriceQuote) {
    const coord = corpusNeedsExplicitPriceCoordination(corpus);
    const reductionNote = coord.hasReduction
      ? "- В корпусе закупки есть **процедура снижения / улучшения цены** — оформи согласованную сумму как **стартовое ценовое предложение участника** под эту процедуру, если иное прямо не следует из блока менеджера."
      : "";
    return [
      "## Политика цены в этом черновике КП",
      "",
      "- В блоке **«Вход от модуля Analysis (Preparation)»** уже есть **согласованные с менеджером** коммерческие условия (файл **notes/lena-manager-price-quote.md**).",
      "- В разделе КП **«2. Стоимость и условия оплаты»** воспроизведи подпункты **2.1–2.4** по этому блоку: **2.1 Цена предложения** (цифрами и **в скобках прописью для BYN**), **2.2 Условия оплаты**, **2.3 Срок поставки/услуг**, **2.4 Гарантия**. Допускается лёгкая литературная правка под стиль КП **без изменения суммы и смысла**.",
      "- **Запрещено** использовать заглушки **[согласовать сумму и условия НДС с менеджером]**, **[согласовать с менеджером]** и аналогичные для этих четырёх пунктов — данные уже согласованы.",
      "- Явно укажи в стоимостном блоке: **«НДС 20 %, входящий в стоимость»** и сумму НДС **прописью**, исходя из согласованной общей суммы (режим по умолчанию для участников в этом продукте).",
      reductionNote,
      "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const coord = corpusNeedsExplicitPriceCoordination(corpus);
  const hasReduction = coord.hasReduction;
  /** @type {string[]} */
  const lines = [
    "## Политика цены в этом черновике КП (выполни строго; не противоречь документам заказчика)",
    "",
  ];

  if (coord.needsCoordination) {
    /** @type {string[]} */
    const trig = [];
    if (coord.absurd) trig.push("в тексте есть **нереалистично малые** суммы (например **1** или **0,1** BYN) или явная заглушка");
    if (coord.belowCoordinationThreshold) {
      const thr =
        Number.parseFloat(String(process.env.LENA_CP_COORDINATION_PRICE_BELOW_BYN ?? "").trim()) || 10_000;
      trig.push(`по строкам с НМЦ / ценой лота встречается сумма **ниже ${thr} BYN**`);
    }
    if (coord.noMandatoryImprovementOrNegotiation) {
      trig.push(
        "в переданном тексте **не найдено** явных признаков обязательной процедуры **улучшения предложения**, **переговоров о цене** или **снижения цены**",
      );
    }
    lines.push(
      `- **Требуется явное согласование цены с менеджером** (этап Analysis / диалог): ${trig.join("; ")}.`,
      "- В стоимостном блоке **не указывай конкретную итоговую сумму участника** без пометки согласования; используй формулировку **[согласовать сумму с менеджером]** и перечисли, какие данные нужны (цена **с НДС 20 %** по умолчанию задаётся после согласования в Telegram).",
      "",
    );
  } else if (hasReduction) {
    lines.push(
      "- В документации **есть признаки** процедуры снижения цены / переговоров / улучшения предложения — в КП укажи **только стартовую цену участника** по **начальной (предельной) цене заказчика или порядку из документов**; **не придумывай** дополнительное снижение (в т.ч. фиксированные «−1–2 %»), если этого нет в тексте закупки.",
      "- Поясни кратко: сумма — **старт для процедуры снижения**, не итог без этапов закупки.",
      "- Ставку и базу НДС формулируй **только** как в документации заказчика; если уместно **20 % НДС** — явно: **«НДС 20 %, входящий в стоимость»**, суммы **прописью**.",
      "",
    );
  }

  lines.push(
    "- **Формулировки про состав цены — только утвердительные**, из вида: «стоимость **включает в себя** …», «цена **учитывает** …»; **не используй** «стоимость **должна включать**» и аналогичные модальные конструкции.",
    "- Раздел **«2. Стоимость и условия оплаты»** оформляй **структурно** с вложенной нумерацией: **2.1 Цена предложения** (цифрами и в скобках прописью для BYN); **2.2 Условия оплаты**; **2.3 Срок поставки или оказания услуг** — по контексту закупки; **2.4 Гарантийный срок** на работы/услуги — из документации или пометка на уточнение.",
    "- Если действует стандартная ставка **20 % НДС в РБ** и это следует из документов или общего режима закупки без противоречий — укажи: **«НДС 20 %, входящий в стоимость»** и сумму НДС прописью там, где приводишь итог.",
    "- Любые цифры стоимости в КП — **либо** с явной отсылкой к разделу/цитате из документов заказчика, **либо** пометка **согласования с менеджером** без самовольной суммы.",
    "- Не придумывай сроки действия предложения, гарантии, штрафы и объёмы: только из документации или пометка на уточнение.",
  );
  return lines.join("\n");
}
