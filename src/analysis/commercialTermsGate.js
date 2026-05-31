/**
 * Планирование сбора коммерческих условий в Telegram (мастер / автоподстановка из корпуса Analysis).
 * Три режима по процедуре снижения и «фейковой» цене в тексте закупки.
 */

import {
  corpusMentionsPriceReductionProcedure,
  corpusSuggestsAbsurdStatedPrice,
} from "./pricingPolicy.js";

/** @typedef {"price" | "payment" | "delivery" | "warranty"} CommercialTermsSlot */

/**
 * @typedef {"reduction_docs_ok" | "reduction_fake_price" | "no_reduction"} CommercialTermsGateMode
 */

/**
 * @typedef {Object} EmbeddedCommercialHints
 * @property {string} price
 * @property {string} payment
 * @property {string} delivery
 * @property {string} warranty
 */

/**
 * @typedef {Object} CommercialTermsGatePlan
 * @property {CommercialTermsGateMode} mode
 * @property {CommercialTermsSlot[]} stepsQueue — только то, что нужно спросить у менеджера
 * @property {Partial<Record<CommercialTermsSlot, string>>} prefilled — подставляется в файл без вопроса
 * @property {EmbeddedCommercialHints} embeddedHints — сырой текст из документов (для подсказок в режиме без снижения)
 */

const DOC_AUTO_PREFIX = "По документам закупки (автовыдержка из текста Analysis; проверьте по полному комплекту):";

const MIN_HINT_LEN = 12;
const MAX_HINT_LEN = 420;

/**
 * @param {string} line
 */
function cleanHintLine(line) {
  return String(line || "")
    .replace(/^[\s>*\-•]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HINT_LEN);
}

/**
 * Перечень того, что участник обязан указать в КП/предложении, а не готовые условия заказчика.
 * @param {string} line
 */
function looksLikeProposalCompositionRequirementLine(line) {
  const s = String(line || "");
  if (/предложен\w*\s+должн\w*\s+содержать/i.test(s)) return true;
  if (
    /должн\w*\s+содержать/i.test(s) &&
    /коммерческ|технико-\s*коммерческ|цен|стоимост|платеж|оплат|гарантийн\w*\s+обязательств/i.test(s)
  )
    return true;
  if (/к\s+подаче/i.test(s) && /суть/i.test(s)) return true;
  if (/требован\w*\s+к\s+составу/i.test(s)) return true;
  if (/должн\w*\s+включать/i.test(s) && /коммерческ\w*\s+предложен/i.test(s)) return true;
  return false;
}

/**
 * В извещении перечислено, что КП «должно содержать» темы (стоимость, порядок платежей и т.д.) —
 * это не график оплаты заказчика.
 * @param {string} line
 */
function looksLikeMandatoryCpContentsNotActualPaymentTerms(line) {
  const s = String(line || "");
  if (/должн\w*\s+содержать/i.test(s) && /платеж|оплат/i.test(s)) return true;
  if (/должн\w*\s+содержать/i.test(s) && /условия\s+и\s+сроки/i.test(s)) return true;
  if (/должн\w*\s+включать/i.test(s) && /коммерческ\w*\s+предложен/i.test(s) && /оплат|платеж/i.test(s))
    return true;
  if (/требован\w*\s+к\s+составу/i.test(s) && /оплат|платеж|расч[её]т/i.test(s)) return true;
  if (/состав\w*\s+(?:заявк|предложен)/i.test(s) && /порядок\s+платеж/i.test(s)) return true;
  return false;
}

/**
 * Строка из документов описывает реальный график/форму оплаты (доли, сроки), а не только факт,
 * что участник должен указать оплату в КП.
 * @param {string} line
 */
export function paymentHintLooksLikeConcreteTerms(line) {
  const s = String(line || "").trim();
  if (s.length < MIN_HINT_LEN) return false;
  if (looksLikeProposalCompositionRequirementLine(s)) return false;
  if (looksLikeMandatoryCpContentsNotActualPaymentTerms(s)) return false;
  if (looksLikeCpStructureOrPricingAnnexNotPaymentTerms(s)) return false;
  if (looksLikeBankSecurityNotPaymentOrWarranty(s)) return false;
  if (/\d{1,3}\s*%|\d+\s*\/\s*\d+|половин\w*\s+сумм|треть\s+сумм/i.test(s)) return true;
  if (/\d+\s*(?:рабоч|календарн)\w*\s*дн/i.test(s)) return true;
  if (/\d+\s*дн\w*\s+после/i.test(s)) return true;
  if (/аванс|предоплат|постоплат|отсроч\w*\s+платеж|рассрочк|аккредитив/i.test(s)) return true;
  if (/после\s+(?:утвержден|подписан|согласован)\w*\s+акт/i.test(s)) return true;
  if (/до\s+отгрузк|при\s+отгрузк|перед\s+отгрузк|после\s+поставк/i.test(s)) return true;
  return false;
}

/**
 * В документах указан реальный срок/объём гарантии на работы/товар, а не только требование включить «гарантийные обязательства» в КП.
 * @param {string} line
 */
export function warrantyHintLooksLikeConcreteTerms(line) {
  const s = String(line || "").trim();
  if (s.length < MIN_HINT_LEN) return false;
  if (!/гарантийн|гарантия|срок\s+гарант/i.test(s)) return false;
  if (looksLikeProposalCompositionRequirementLine(s)) return false;
  if (looksLikeBankSecurityNotPaymentOrWarranty(s)) return false;
  if (/\d+\s*(?:мес|месяц|лет|года?|г\.|календарн|рабоч)\w*/i.test(s)) return true;
  if (/срок\s+гарант/i.test(s) && /\d/.test(s)) return true;
  if (/гарантийн\w*\s+(?:срок|период)/i.test(s) && /\d/.test(s)) return true;
  if (/не\s+менее\s+\d+/i.test(s)) return true;
  if (/гарантия\s+(?:на\s+)?(?:узел|изделие|оборудован|работ|услуг|результат)/i.test(s)) return true;
  return false;
}

/**
 * Строка про содержание/перечень документов КП или расчёт цены в предложении — не график оплат между сторонами.
 * @param {string} line
 */
function looksLikeCpStructureOrPricingAnnexNotPaymentTerms(line) {
  const s = String(line || "");
  if (/расч[её]т\s+стоимости/i.test(s)) return true;
  if (/стоимости\s+услуг\s+с\s+включением/i.test(s)) return true;
  if (/включени\w*\s+всех\s+расходов/i.test(s)) return true;
  if (/калькуляц/i.test(s) && /(?:услуг|работ|товар)/i.test(s)) return true;
  if (/требован\w*\s+к\s+оформлен\w*\s+коммерческ/i.test(s)) return true;
  if (/пункт\s+\d+\s+перечня\s+документ/i.test(s)) return true;
  if (/перечн\w*\s+документов/i.test(s) && /коммерческ\w*\s+предложен/i.test(s)) return true;
  return false;
}

/**
 * Банковская гарантия / обеспечение возврата аванса — не «условия оплаты» и не потребительская гарантия на товар/работы.
 * @param {string} line
 */
function looksLikeBankSecurityNotPaymentOrWarranty(line) {
  const s = String(line || "");
  if (/банковск\w*\s+гарант/i.test(s)) return true;
  if (/гарантия\s+на\s+возврат\s+аванс/i.test(s)) return true;
  if (/обязательств\w*\s+предоставить\s+банковск/i.test(s)) return true;
  if (/обеспечени\w*\s+(?:заявк|участник|исполнен|контракт)/i.test(s) && /банковск|гарант/i.test(s))
    return true;
  if (/возврат\s+авансов/i.test(s) && /банковск|гарант/i.test(s)) return true;
  return false;
}

/**
 * Выдержки из корпуса, похожие на оплату / срок / гарантию / цену заказчика.
 * Эвристики; не замена полного чтения документов.
 * @param {string} corpus
 * @returns {EmbeddedCommercialHints}
 */
export function extractCommercialTermsHintsFromCorpus(corpus) {
  /** @type {EmbeddedCommercialHints} */
  const out = { price: "", payment: "", delivery: "", warranty: "" };
  const raw = String(corpus || "");
  const lines = raw.split(/\r?\n/).map((l) => cleanHintLine(l)).filter((l) => l.length >= MIN_HINT_LEN);

  const priceKw =
    /нмц|начальн\w*(?:\s+максимальн\w*)?\s+цен|предельн\w*\s+цен|стартов\w*\s+цен|цен\w*\s+лот|ориентировочн\w*\s+стоимост|стоимост\w*\s+закупк|единиц\w*\s+цен/i;
  /** Сумма с явной валютой (в т.ч. USD/EUR — не только BYN). */
  const priceMoneyKw =
    /\b(?:\d{1,3}(?:[\s\u00A0]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:BYN|руб\.?|бел\.?\s*руб|Br|USD|US\$|\$|EUR|€|евро|CNY|CN¥|юан|юаней|RUB|российск\w*\s*руб|₽)\b|\b(?:USD|US\$|\$|EUR|€)\s*(?:\d{1,3}(?:[\s\u00A0]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\b/i;
  /** Без голого «расчёт» — иначе цепляются «расчёт стоимости» в перечне документов к КП. */
  const payKw =
    /оплат|платеж|платёж|аванс|предоплат|отсроч|перечислен|порядок\s+расч[её]тов|условия\s+оплат|окончательн\w*\s+расч[её]т|расч[её]ты?\s+(?:производ|осуществл)/i;
  const delKw =
    /срок\s+поставк|поставк\w*\s+товар|срок\s+оказан|оказан\w*\s+услуг|календарн\w*\s+дн|рабоч\w*\s+дн|в\s+течение\s+\d+|не\s+более\s+\d+\s+дн/i;
  const warKw = /гарантийн|гарантия|срок\s+гарант/i;

  for (const line of lines) {
    if (!out.price && priceKw.test(line) && (priceMoneyKw.test(line) || /\d/.test(line))) {
      out.price = line;
      continue;
    }
    if (
      !out.payment &&
      payKw.test(line) &&
      !priceKw.test(line) &&
      !looksLikeCpStructureOrPricingAnnexNotPaymentTerms(line) &&
      !looksLikeBankSecurityNotPaymentOrWarranty(line) &&
      !looksLikeMandatoryCpContentsNotActualPaymentTerms(line) &&
      paymentHintLooksLikeConcreteTerms(line)
    ) {
      out.payment = line;
      continue;
    }
    if (!out.delivery && delKw.test(line)) {
      out.delivery = line;
      continue;
    }
    if (
      !out.warranty &&
      warKw.test(line) &&
      !looksLikeBankSecurityNotPaymentOrWarranty(line) &&
      warrantyHintLooksLikeConcreteTerms(line)
    ) {
      out.warranty = line;
    }
  }

  return out;
}

/**
 * @param {string} s
 */
function meaningfulHint(s) {
  return Boolean(s && String(s).trim().length >= MIN_HINT_LEN);
}

/**
 * @param {string} hint
 */
export function wrapPrefilledFromDocs(hint) {
  const t = String(hint || "").trim();
  if (!t) return "";
  return `${DOC_AUTO_PREFIX}\n${t}`;
}

/**
 * Классификация по пользовательским правилам продукта.
 * @param {string} corpus
 * @returns {{ mode: CommercialTermsGateMode, hasReduction: boolean, absurdPrice: boolean }}
 */
export function classifyCommercialTermsGateMode(corpus) {
  const c = String(corpus || "");
  const hasReduction = corpusMentionsPriceReductionProcedure(c);
  const absurdPrice = corpusSuggestsAbsurdStatedPrice(c);
  /** @type {CommercialTermsGateMode} */
  let mode = "no_reduction";
  if (hasReduction && !absurdPrice) mode = "reduction_docs_ok";
  else if (hasReduction && absurdPrice) mode = "reduction_fake_price";
  else mode = "no_reduction";
  return { mode, hasReduction, absurdPrice };
}

/**
 * @param {string} corpus
 * @returns {CommercialTermsGatePlan}
 */
export function planCommercialTermsGate(corpus) {
  const { mode } = classifyCommercialTermsGateMode(corpus);
  const embeddedHints = extractCommercialTermsHintsFromCorpus(corpus);

  /** @type {CommercialTermsSlot[]} */
  const stepsQueue = [];
  /** @type {Partial<Record<CommercialTermsSlot, string>>} */
  const prefilled = {};

  const havePrice = meaningfulHint(embeddedHints.price);
  const havePay =
    meaningfulHint(embeddedHints.payment) && paymentHintLooksLikeConcreteTerms(embeddedHints.payment);
  const haveDel = meaningfulHint(embeddedHints.delivery);
  const haveWar =
    meaningfulHint(embeddedHints.warranty) && warrantyHintLooksLikeConcreteTerms(embeddedHints.warranty);

  if (mode === "no_reduction") {
    stepsQueue.push("price", "payment", "delivery", "warranty");
    return { mode, stepsQueue, prefilled, embeddedHints };
  }

  if (mode === "reduction_fake_price") {
    stepsQueue.push("price");
    if (!havePay) stepsQueue.push("payment");
    else prefilled.payment = wrapPrefilledFromDocs(embeddedHints.payment);
    if (!haveDel) stepsQueue.push("delivery");
    else prefilled.delivery = wrapPrefilledFromDocs(embeddedHints.delivery);
    if (!haveWar) stepsQueue.push("warranty");
    else prefilled.warranty = wrapPrefilledFromDocs(embeddedHints.warranty);
    return { mode, stepsQueue, prefilled, embeddedHints };
  }

  // reduction_docs_ok — как у заказчика; спрашиваем только пробелы
  if (!havePrice) stepsQueue.push("price");
  else prefilled.price = wrapPrefilledFromDocs(embeddedHints.price);
  if (!havePay) stepsQueue.push("payment");
  else prefilled.payment = wrapPrefilledFromDocs(embeddedHints.payment);
  if (!haveDel) stepsQueue.push("delivery");
  else prefilled.delivery = wrapPrefilledFromDocs(embeddedHints.delivery);
  if (!haveWar) stepsQueue.push("warranty");
  else prefilled.warranty = wrapPrefilledFromDocs(embeddedHints.warranty);

  return { mode, stepsQueue, prefilled, embeddedHints };
}

/**
 * Пояснение режима для первого сообщения в Telegram.
 * @param {CommercialTermsGatePlan} plan
 */
export function commercialTermsGateModeExplain(plan) {
  switch (plan.mode) {
    case "reduction_docs_ok":
      return [
        "**Режим:** в тексте видна **процедура снижения / улучшения цены**, суммы не выглядят явной заглушкой.",
        "Условия **по возможности берём из документов заказчика**; в Telegram спросим **только то**, что в распознанном тексте **не нашли** (проверьте полный комплект на Drive).",
      ].join("\n");
    case "reduction_fake_price":
      return [
        "**Режим:** процедура снижения есть, но в тексте — **подозрительно малые суммы / заглушка**.",
        "**Цену участника** нужно согласовать отдельным шагом; **оплату / срок / гарантию** подставим из документов, если есть явные строки — иначе спросим.",
      ].join("\n");
    default:
      return [
        "**Режим:** процедура снижения по тексту **не выявлена**.",
        "Нужны **коммерческие условия участника** по каждому значимому пункту; под каждым шагом покажем **что уже нашли в документах** как ориентир (если нашли).",
      ].join("\n");
  }
}
