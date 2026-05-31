/**
 * Черновик коммерческого предложения (КП) по тексту документов заказчика после парсинга inputs.
 * Результат: **Google Doc** (копия шаблона + подстановка текста) при наличии шаблона и включённом Docs API;
 * дополнительно по умолчанию — markdown в **drafts/** на Drive.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG } from "../drive/layoutConstants.js";
import { getMetadata, listChildren, uploadFile } from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";
import { chatCompletion, isLlmConfigured } from "../llm/openaiCompatible.js";
import { buildParsedInputsCorpus } from "./parsedInputsCorpus.js";
import { buildCommercialPricingPromptSection } from "./pricingPolicy.js";
import {
  PREPARATION_PROMPT_FILENAME,
  readManagerPriceQuoteFromNotes,
  readPreparationPromptFromNotes,
} from "./preparationPromptFromAnalysis.js";
import {
  copyTemplateAndFillCommercialProposalDoc,
  KP_BODY_PLACEHOLDER,
  KP_TEMPLATE_BODY,
  resolveCommercialProposalGoogleDocTemplateId,
} from "./commercialProposalGoogleDoc.js";
import {
  allocateNextDocumentSerial,
  formatCommercialProposalOutgoingRef,
  formatDocumentCounterDate,
} from "./documentCounterDrive.js";
import {
  formatCustomerHeaderMultiline,
  guessCustomerLineFromCorpus,
  loadCpSnapshotHints,
} from "./cpSnapshotHints.js";
import { loadOrgRequisitesFromEnv } from "./orgRequisitesDrive.js";

const SUB_GS = LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG.gs_retail;
const SUB_FN = LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG.finselvat;

/** @typedef {"gs_retail" | "finselvat"} OfferOrgKey */

/**
 * Компании-участники (выбор в Telegram перед генерацией КП): шаблоны и состав вложений.
 * @type {Record<OfferOrgKey, { key: OfferOrgKey, label: string, promptBlock: string }>}
 */
export const OFFER_ORG = {
  gs_retail: {
    key: "gs_retail",
    label: "ГС Ритейл",
    promptBlock: [
      "## Организация-участник (подтверждено кнопкой в Telegram)",
      "Черновик коммерческого предложения оформляется **от имени ГС Ритейл**.",
      "**Статус:** организация — **резидент РБ**. Требования документации, относящиеся **только** к нерезидентам, **не применяй** к этому КП; не включай их в перечни к подаче и не запрашивай по ним документы.",
      `Учитывай, что **шаблоны бланков, сопроводительных писем и типовой перечень вложений** к заявке (устав, выписка, приказ, доверенность и т.д.) должны соответствовать практике **этой** организации: ориентир — \`_lena/templates/${SUB_GS}/\`, \`_lena/org-docs/${SUB_GS}/\`, \`_lena/founding-docs/${SUB_GS}/\` на Google Drive (статика **ГС Ритейл** — только здесь, не смешивать с \`${SUB_FN}\`).`,
      `Юридическое наименование, реквизиты, подписанта **не выдумывай** и не подставляй из памяти: если в корпусе документов заказчика их нет — явно пометь **[взять из актуального шаблона в \`_lena/templates/${SUB_GS}/\` или org-docs / founding-docs этой компании / уточнить у менеджера]**.`,
      "В конце КП добавь раздел **«Приложение к коммерческому предложению»** (перечень документов к подаче; заголовок **«Ожидаемые вложения»** не используй): что требует заказчик по корпусу + что обычно нужно для **ГС Ритейл** (без фантазий вне текста закупки).",
    ].join("\n"),
  },
  finselvat: {
    key: "finselvat",
    label: "Финсельват",
    promptBlock: [
      "## Организация-участник (подтверждено кнопкой в Telegram)",
      "Черновик коммерческого предложения оформляется **от имени Финсельват**.",
      "**Статус:** организация — **резидент РБ**. Требования документации, относящиеся **только** к нерезидентам, **не применяй** к этому КП; не включай их в перечни к подаче и не запрашивай по ним документы.",
      `Учитывай, что **шаблоны бланков, сопроводительных писем и типовой перечень вложений** к заявке (устав, выписка, приказ, доверенность и т.д.) должны соответствовать практике **этой** организации: ориентир — \`_lena/templates/${SUB_FN}/\`, \`_lena/org-docs/${SUB_FN}/\`, \`_lena/founding-docs/${SUB_FN}/\` на Google Drive (статика **Финсельват** — только здесь, не смешивать с \`${SUB_GS}\`).`,
      `Юридическое наименование, реквизиты, подписанта **не выдумывай** и не подставляй из памяти: если в корпусе документов заказчика их нет — явно пометь **[взять из актуального шаблона в \`_lena/templates/${SUB_FN}/\` или org-docs / founding-docs этой компании / уточнить у менеджера]**.`,
      "В конце КП добавь раздел **«Приложение к коммерческому предложению»** (перечень документов к подаче; заголовок **«Ожидаемые вложения»** не используй): что требует заказчик по корпусу + что обычно нужно для **Финсельват** (без фантазий вне текста закупки).",
    ].join("\n"),
  },
};

/**
 * @param {unknown} x
 * @returns {x is OfferOrgKey}
 */
export function isOfferOrgKey(x) {
  return x === "gs_retail" || x === "finselvat";
}

const CP_SYSTEM_PROMPT = [
  "Ты «Лена» — готовишь **черновик коммерческого предложения (КП)** для участия в закупке.",
  "Источник фактов о закупке — **только** фрагменты документации заказчика в сообщении пользователя (корпус). Не опирайся на внешние знания о законе, рынке или «типовые» формулировки, если их нет в корпусе.",
  "**Резидент РБ:** черновик готовится от имени компании, которая по настройкам продукта всегда **резидент Республики Беларусь** (**ГС Ритейл** или **Финсельват**). **Не распространяй** на наш участок документа требования, которые по тексту закупки относятся **только** к нерезидентам / иностранным участникам (справки, валюта, особые процедуры для нерезидентов и т.п.) — **игнорируй** такие ветки; ориентируйся на требования к **резиденту**, если они выделены в корпусе, иначе на общие требования ко всем участникам.",
  "Если в запросе есть блок «Вход от модуля Analysis (Preparation)» — это **обязательный конспект** этапа Analysis (политика цены, матрица, запросы к менеджеру, напоминание про выбор компании). Следуй ему для структуры и ограничений; **цифры и цитаты** всё равно сверяй с корпусом документов.",
  "Если внутри этого блока есть подраздел **«Согласованная цена и условия»** (менеджер, Telegram) — данные оттуда для стоимостного блока КП **обязательны** и **перекрывают** общие фразы Preparation про «не указывать цену» или плейсхолдеры согласования.",
  "**Шапка Google Doc** задаётся блоком «Шапка документа»: там уже есть **исходящий номер и дата**, **заказчик** и **двухстрочный заголовок** («Коммерческое предложение» / «на поставку …»). В теле Markdown **не дублируй** эти элементы: **не ставь** отдельной строкой снова «Коммерческое предложение», **не повторяй** подзаголовок предмета закупки и **не начинай** тело с `#`/«Коммерческое предложение…».",
  "**Вступление (обязательно):** перед разделом «1. …» добавь **один** деловой абзац: обращение («Уважаемые дамы и господа,» / «Уважаемые дамы и господа!»), затем **настоящим направляем в Ваш адрес коммерческое предложение** на участие в закупочной процедуре — с **конкретным названием процедуры и номером** (если они есть в корпусе или в блоке пользователя «Ссылка на процедуру для вступления»). Стиль — связный, повествовательный, деловой.",
  "**Абзацы:** между абзацами **ровно одна** пустая строка (не больше). Заголовки верхнего уровня **«1. …»**, **«2. …»** и вложенные **«2.1 …»**, **«2.2 …»** — **без** красной строки (табуляции в начале строки заголовка нет). Обычный текст после заголовка раздела и после строк подпункта оформляй с **красной строкой** (**\\t** или четыре пробела). Маркеры списка «• …» — **без** принудительной красной строки.",
  "**Раздел о цене и оплате:** заголовок раздела — **«2. Стоимость и условия оплаты»** (именно такая формулировка). Внутри — **вложенная нумерация**: **2.1 Цена предложения**, **2.2 Условия оплаты**, **2.3 Срок поставки товара или оказания услуг** (по контексту закупки), **2.4 Гарантийный срок**. Формат «(1) Цена» **не используй** — только **2.1–2.4** под разделом 2.",
  "**Жирное выделение (Markdown):** строки заголовков разделов и подпунктов (например **«2. Стоимость и условия оплаты»**, **«2.1 Цена предложения»**) оформляй **целиком жирным** (`**…**`). Под каждым подпунктом содержательный текст (суммы, график оплаты, сроки, гарантия) тоже выделяй **жирным**, чтобы ключевые условия были сразу видны.",
  "НДС и налоговый режим указывай **как в документации закупки**; если без противоречий применимо **НДС 20 % в РБ** — явно: **«НДС 20 %, входящий в стоимость»** и сумму НДС **прописью** там, где даёшь итог.",
  "Формулировки о составе цены — **утвердительные**: «стоимость **включает в себя** …», «цена **учитывает** …»; **не используй** «стоимость **должна включать**» и аналогичные модальные конструкции.",
  "**Содержание подпунктов 2.1–2.4:** в **2.1** — сумма **в валюте закупки** (BYN, USD, EUR, RUB, CNY и т.д.), цифрами и **в скобках прописью** на русском для целых единиц валюты; **2.2–2.4** — по документам закупки.",
  "Структура КП: логичная для закупки (предмет/объём, характеристики или услуги как в ТЗ, сроки/этапы если есть в документах). Блок **«2. Стоимость и условия оплаты»** с подпунктами **2.1–2.4**: если есть согласованный блок менеджера — только он; иначе по блоку «Политика цены» и корпусу (без противоречий). Заверши документ разделом **«Приложение к коммерческому предложению»** вместо формулировки «Ожидаемые вложения».",
  "В конце документа кратко перечисли, **какие разделы** опираются на какие файлы/фрагменты корпуса (имена файлов).",
  "Язык ответа: русский. Формат: один цельный **Markdown**-документ без обёртки ```.",
  "Если в запросе есть блок «Организация-участник» — это выбор менеджера: от какой компании подаётся предложение; учитывай его при структуре КП и перечне вложений (шаблоны на Drive), не игнорируй.",
].join("\n");

/**
 * @param {unknown} e
 * @returns {string}
 */
function formatCommercialProposalGoogleDocError(e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Google Docs API has not been used|it is disabled/i.test(msg)) {
    const m = msg.match(
      /https:\/\/console\.developers\.google\.com\/apis\/api\/docs\.googleapis\.com\/overview\?project=\d+/,
    );
    const link =
      m?.[0] ??
      "https://console.cloud.google.com/apis/library/docs.googleapis.com (выберите проект с ключом Drive)";
    return `Включите **Google Docs API** в том же GCP-проекте, откуда ключ/OAuth для Drive. Ссылка из ответа Google: ${link} — после включения подождите 1–3 минуты и сформируйте КП снова.`;
  }
  return msg.slice(0, 450);
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {{ flat?: boolean; year?: string; offerOrg?: OfferOrgKey; preparationPrompt?: string }} [opts]
 */
export async function runCommercialProposalDraftToDrive(userRootId, tenderId, opts = {}) {
  assertCredentialsFile();
  if (!isLlmConfigured()) {
    return { ok: false, error: "Нужен LENA_OPENAI_API_KEY или OPENAI_API_KEY для КП." };
  }

  const maxFiles =
    Number.parseInt(process.env.LENA_CP_MAX_PIPELINE_ITEMS?.trim() ?? "40", 10) || 40;
  const maxTotal =
    Number.parseInt(process.env.LENA_CP_MAX_CORPUS_CHARS?.trim() ?? "100000", 10) || 100_000;
  const maxPerFile =
    Number.parseInt(process.env.LENA_CP_MAX_CHARS_PER_FILE?.trim() ?? "65000", 10) || 65_000;
  const minTotal =
    Number.parseInt(process.env.LENA_CP_MIN_INPUT_CHARS?.trim() ?? "400", 10) || 400;
  const maxTokens =
    Number.parseInt(process.env.LENA_CP_MAX_TOKENS?.trim() ?? "6000", 10) || 6000;

  const treeOpts = { flat: opts.flat, year: opts.year };
  const offerOrg = opts.offerOrg;

  const parsed = await buildParsedInputsCorpus(userRootId, tenderId, treeOpts, {
    maxFiles,
    maxTotalChars: maxTotal,
    maxPerFileChars: maxPerFile,
  });

  if (!parsed.usedPipeline) {
    return {
      ok: false,
      error:
        "Нет **tender-pipeline-state.json** в корне тендера. Сначала парсинг: **/tenderextract** или кнопка «Анализ документов».",
    };
  }

  const corpus = parsed.corpus.trim();
  const warnings = parsed.warnings;
  const corpusWs = corpus.replace(/\s+/g, " ").trim();
  if (corpusWs.length < minTotal) {
    return {
      ok: false,
      error: `Мало текста документов заказчика после парсинга (~${corpusWs.length} знаков, нужно ≥${minTotal}). Проверьте **inputs/** и повторите **/tenderextract**.`,
      warnings,
    };
  }

  const hints = await loadCpSnapshotHints(parsed.inputsId);
  /** @type {{ seq: number; serialLine: string; dateLabel: string }} */
  let serialPack = {
    seq: 0,
    dateLabel: formatDocumentCounterDate(),
    serialLine: formatCommercialProposalOutgoingRef(0, formatDocumentCounterDate(), offerOrg),
  };
  try {
    const allocated = await allocateNextDocumentSerial(userRootId);
    serialPack = {
      ...allocated,
      serialLine: formatCommercialProposalOutgoingRef(allocated.seq, allocated.dateLabel, offerOrg),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(
      `Сквозной счётчик документов на Drive недоступен (${msg.slice(0, 220)}); в шапке использован резервный исходящий номер (позиция 0000).`,
    );
  }

  const reqCorp = await loadOrgRequisitesFromEnv();
  for (const w of reqCorp.warnings) warnings.push(w);

  const customerMerged =
    (hints.customerName || "").trim() || guessCustomerLineFromCorpus(corpus);
  const templateCustomerRaw =
    customerMerged.trim() || "[уточнить полное наименование заказчика по извещению]";
  const templateCustomer = formatCustomerHeaderMultiline(templateCustomerRaw);
  const subjectSlice = hints.procurementTitle?.trim().slice(0, 280) ?? "";
  const templateDocTitle = subjectSlice
    ? `Коммерческое предложение\nна поставку «${subjectSlice}»`
    : "Коммерческое предложение\n(уточнить наименование предмета закупки по корпусу и вторую строку заголовка)";
  const procedureIntroHint =
    subjectSlice || "[полное название закупки / процедуры и номер по документам заказчика]";

  const headerBridge = [
    "### Шапка документа (подстановки в Google Doc — не дублируй в тексте КП)",
    `- **Исходящий номер и дата:** «${serialPack.serialLine}».`,
    `- **Наименование заказчика** (в шаблоне допускаются переносы строк): «${templateCustomer}».`,
    `- **Заголовок документа** (две строки в поле шаблона, через перевод строки): «${templateDocTitle.replace(/\n/g, " \\n ")}».`,
    `- **Ссылка на процедуру для вступления:** используй в первом абзаце формулировку про участие в процедуре — ориентир: «${procedureIntroHint}».`,
    "Пиши **только** содержательную часть: сначала **вступление**, затем «1. …» и далее (см. системные правила). **Не** повторяй строку «Коммерческое предложение» отдельно.",
    "",
  ].join("\n");

  const requisitesBridge = reqCorp.text.trim()
    ? [
        "### Реквизиты организации-участника (файлы с Google Drive)",
        reqCorp.text.trim().slice(0, 14_000),
        "",
        "---",
        "",
      ].join("\n")
    : "";

  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);
  const mgrPrice = (await readManagerPriceQuoteFromNotes(tender.notesId))?.trim() ?? "";

  /** @type {string} */
  let prepBlock = "";
  if (typeof opts.preparationPrompt === "string" && opts.preparationPrompt.trim()) {
    prepBlock = opts.preparationPrompt.trim();
  } else {
    prepBlock = (await readPreparationPromptFromNotes(tender.notesId)) ?? "";
    if (!prepBlock.trim() && !mgrPrice) {
      warnings.push(
        `В **notes** нет **${PREPARATION_PROMPT_FILENAME}** — сначала этап Analysis (парсинг с LLM) или передайте **preparationPrompt** вручную.`,
      );
    }
  }

  if (mgrPrice) {
    prepBlock = [
      "### Согласованная цена и условия (менеджер; после Analysis, до выбора компании)",
      "",
      "_Эти значения обязательно перенеси в раздел КП **«2. Стоимость и условия оплаты»** в подпункты **2.1–2.4**; не заменяй их плейсхолдерами согласования._",
      "",
      mgrPrice,
      "",
      "---",
      "",
      prepBlock,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const pricingBlock = buildCommercialPricingPromptSection(corpus, { hasManagerPriceQuote: Boolean(mgrPrice) });

  const prepHeader =
    prepBlock.trim().length > 0
      ? ["### Вход от модуля Analysis (Preparation)", "", prepBlock.trim(), "", "---", ""].join("\n")
      : "";

  const orgBlock =
    offerOrg && isOfferOrgKey(offerOrg)
      ? OFFER_ORG[offerOrg].promptBlock
      : [
          "## Организация-участник",
          "Компания-участник **не указана** — оформи черновик КП нейтрально по документации заказчика; корпоративные шаблоны и полный перечень вложений пометь как **[уточнить у менеджера]**.",
          "**Статус (продукт):** варианты участия — только **резиденты РБ** (**ГС Ритейл** / **Финсельват**). Требования **только для нерезидентов** в КП **не отражай**.",
        ].join("\n");

  const userMsg = [
    `Тендер: **${tenderId}**`,
    "",
    prepHeader,
    orgBlock,
    "",
    headerBridge,
    requisitesBridge,
    pricingBlock,
    "",
    warnings.length ? `**Предупреждения:** ${warnings.join(" | ")}` : "",
    "",
    "## Корпус (документация заказчика)",
    "",
    corpus,
  ]
    .filter(Boolean)
    .join("\n");

  const messages = [
    { role: "system", content: CP_SYSTEM_PROMPT },
    { role: "user", content: userMsg },
  ];

  let md;
  try {
    md = await chatCompletion(messages, { temperature: 0.25, max_tokens: maxTokens });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 2000), warnings };
  }

  md = md.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!md) {
    return { ok: false, error: "Модель вернула пустой текст КП.", warnings };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeId = tenderId.replace(/[^\w.-]+/g, "_").slice(0, 80);
  const outName = `commercial-proposal-${safeId}-${stamp}.md`;
  const driveCopyTitle =
    serialPack.seq > 0 ? `КП-${serialPack.seq}-${safeId}-${stamp}` : `КП-${safeId}-${stamp}`;

  /** @type {string | undefined} */
  let googleDocWebViewLink;
  /** @type {string | undefined} */
  let googleDocFileName;

  if (offerOrg && isOfferOrgKey(offerOrg)) {
    const templateId = await resolveCommercialProposalGoogleDocTemplateId(userRootId, offerOrg);
    if (!templateId) {
      warnings.push(
        "Шаблон **Google Doc** для КП не найден: задайте **LENA_CP_DOC_TEMPLATE_FOLDER_ID** (папка с подпапками **gs-retail** / **finselvat**) или **LENA_CP_DOC_TEMPLATE_ID_GS_RETAIL** / **LENA_CP_DOC_TEMPLATE_ID_FINSELVAT**, либо положите шаблон-Doc в **_lena/templates/(gs-retail|finselvat)**. Включите **Google Docs API** в GCP и при OAuth выполните **drive oauth-login** заново (scope с documents).",
      );
    } else {
      try {
        const doc = await copyTemplateAndFillCommercialProposalDoc({
          templateFileId: templateId,
          draftsFolderId: parsed.draftsId,
          destTitle: driveCopyTitle,
          markdownBody: md,
          headerReplacements: {
            numberDateLine: serialPack.serialLine,
            customerName: templateCustomer,
            documentTitle: templateDocTitle,
          },
        });
        googleDocWebViewLink = doc.webViewLink;
        googleDocFileName = doc.fileName;
        if (doc.fillMode === "append") {
          warnings.push(
            `В шаблоне нет **${KP_BODY_PLACEHOLDER}** или **${KP_TEMPLATE_BODY}** — текст КП дописан в конец документа.`,
          );
        }
      } catch (e) {
        warnings.push(`Google Doc по шаблону не создан: ${formatCommercialProposalGoogleDocError(e)}`);
      }
    }
  }

  const saveMd =
    !process.env.LENA_CP_SAVE_MARKDOWN?.trim() || process.env.LENA_CP_SAVE_MARKDOWN.trim() !== "0";

  if (saveMd) {
    const upTmp = await mkdtemp(join(tmpdir(), "lena-kp-up-"));
    const localPath = join(upTmp, outName);
    try {
      const orgYaml =
        offerOrg && isOfferOrgKey(offerOrg) ? `offer_org: ${offerOrg}\n` : "offer_org: \"\"\n";
      const header = `---\nlena: commercial-proposal-draft\ntender_id: ${tenderId}\ndocument_serial: ${serialPack.serialLine}\n${orgYaml}generated_at: ${new Date().toISOString()}\n---\n\n`;
      await writeFile(localPath, `${header}${md}`, "utf8");
      await uploadFile(parsed.draftsId, localPath, outName);
    } finally {
      await rm(upTmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  let webViewLink = googleDocWebViewLink;
  let fileName = googleDocFileName;
  if (!webViewLink && saveMd) {
    const kids = await listChildren(parsed.draftsId);
    const uploaded = kids.find((f) => String(f.name ?? "") === outName);
    const meta = uploaded?.id ? await getMetadata(String(uploaded.id)) : null;
    webViewLink = meta && typeof meta.webViewLink === "string" ? meta.webViewLink : undefined;
    fileName = outName;
  }

  return {
    ok: true,
    fileName: fileName ?? outName,
    webViewLink,
    googleDocWebViewLink,
    googleDocFileName,
    markdownFileName: saveMd ? outName : undefined,
    draftsFolderId: parsed.draftsId,
    warnings,
    previewChars: Math.min(500, md.length),
  };
}
