/**
 * Бот «Лена» для Telegram: команды к Google Drive (templates, bundle, …).
 *
 * Запуск (из корня репозитория):
 *   set TELEGRAM_BOT_TOKEN=...
 *   set LENA_DRIVE_ROOT=id_или_url_корневой_папки
 *   set GOOGLE_DRIVE_CREDENTIALS=...json
 *   set OPENAI_API_KEY=...   (или LENA_OPENAI_API_KEY; опционально LENA_OPENAI_BASE_URL, LENA_OPENAI_MODEL)
 *   опционально для архива: LENA_RAG_INDEX_DIR, LENA_EMBEDDING_* (см. docs/TELEGRAM.md)
 *   опционально: LENA_TELEGRAM_KP_SKIP_MANAGER_PRICE_GATE=1 — не ждать цену в Telegram перед выбором компании (КП)
 *   node src/telegram/lena-bot.mjs
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve as pathResolve } from "node:path";

/**
 * Подгружает .env из корня репозитория (не перезаписывает уже заданные в shell).
 */
function loadEnvFile() {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    /* LENA_* / GOOGLE_DRIVE_* из .env должны перебивать пустые или устаревшие переменные Windows (иначе, например, Playwright не включается). */
    const fileWins =
      key.startsWith("LENA_") ||
      key.startsWith("GOOGLE_DRIVE_") ||
      key === "TELEGRAM_BOT_TOKEN";
    if (fileWins) process.env[key] = val;
    else if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile();

function tenderPrepVersion() {
  try {
    const p = join(process.cwd(), "package.json");
    const j = JSON.parse(readFileSync(p, "utf8"));
    return typeof j.version === "string" ? j.version : "?";
  } catch {
    return "?";
  }
}

import { assertCredentialsFile } from "../drive/config.js";
import { resolveDriveId } from "../drive/ids.js";
import { chatCompletion, isLlmConfigured } from "../llm/openaiCompatible.js";
import { runRagAsk } from "../rag/ask.js";
import { runQuery } from "../rag/queryLocal.js";
import {
  buildAgentDriveBundle,
  ensureTenderTree,
  ingestDriveFolderToTenderInputs,
  listContextFiles,
  listFoundingDocsFiles,
  listLibraryFiles,
  listOrgDocsFiles,
  listTemplateFiles,
} from "../drive/workspace.js";
import {
  MANAGER_PRICE_QUOTE_FILENAME,
  readManagerPriceQuoteFromNotes,
  readPreparationPromptFromNotes,
  replaceManagerPriceQuoteFile,
} from "../analysis/preparationPromptFromAnalysis.js";
import { buildTelegramManagerPriceDocHints } from "../analysis/pricingPolicy.js";
import {
  extractCommercialTermsHintsFromCorpus,
  paymentHintLooksLikeConcreteTerms,
  warrantyHintLooksLikeConcreteTerms,
  wrapPrefilledFromDocs,
} from "../analysis/commercialTermsGate.js";
import {
  buildTenderTelegramCard,
  formatTenderTelegramCardForTelegram,
} from "../icetrade/tenderTelegramCard.js";
import {
  extractIceTradeViewIds,
  iceTradeBootstrapShouldRun,
  resolveIceTradeViewIdFromMessage,
} from "../icetrade/viewIds.js";
import {
  buildConversationReply,
  classifyConversationIntent,
  normalizeConversationText,
  telegramTenderContextMissingHint,
} from "./lena-conversation.mjs";
import {
  iceTradeImportProgressMessage,
  runIceTradeImportForMarkdown,
  telegramIceTradeImportOnlyEnabled,
} from "../import/iceTradeTelegramImport.js";
import { OFFER_ORG, runCommercialProposalDraftToDrive } from "../analysis/commercialProposalLlm.js";
import { runTenderInputsExtractMarkdown } from "../parse/tenderInputsParseFlow.js";

/** Сжатый дефолт для смоук-тестов; полные правила — docs/LENA_RULES.md. Переопределение: LENA_LLM_SYSTEM_PROMPT. */
const DEFAULT_LLM_SYSTEM = [
  "Ты «Лена» — специалист по подготовке тендерных документов, не универсальный помощник: сама формируешь пакет материалов заявки (требования, матрица, черновики текстов); в чате с командой при необходимости задаёшь короткие уточняющие вопросы, по умолчанию выдаёшь готовые фрагменты и структуру, а не общие рекомендации.",
  "Отвечай по-русски, кратко и по делу. Если не хватает данных — скажи, чего не хватает.",
  "В общем Telegram-чате может быть несколько тендеров: не угадывай закупку. Если привязки нет и из текста неясно, о каком тендере речь — ответь **одной короткой фразой**, как в подсказке бота: попроси написать через «Ответить» на сообщение по нужной закупке, чтобы сохранился контекст; **без** длинных списков вариантов (номера IceTrade, ссылки, команды).",
  "Не выдумывай содержимое файлов на Диске: опирайся только на то, что явно передано в сообщении (например JSON со ссылками).",
  "Если перечисляешь файлы проекта или оцениваешь состав папки: отдельно отметь форматы, которые не входят в поддерживаемый текстовый контур без предобработки (например .pdf, .doc, .docx и любые другие, кроме .txt/.md/.csv/.log и текста после извлечения). Явно предупреди, что их содержимое не учтено как текст до извлечения; как именно сигнализировать (отдельное сообщение, метка, задача) — по договорённости с пользователем.",
  "Универсальные документы организации (справка банка со сроком, бухгалтерский баланс, отчёт о прибылях и убытках) хранятся в `_lena/org-docs` на Google Drive: при запросе загрузки указывай пользователю прямую ссылку на эту папку и webViewLink из бандла; проси подтвердить загрузку ответом «Ответить» на твоё сообщение; при повторной потребности в том же типе документа сначала используй уже загруженный актуальный файл из org-docs, не запрашивай дубликат без причины.",
  "Учредительные и редко меняющиеся документы (свидетельство о регистрации, устав, приказ о назначении директора) — папка `_lena/founding-docs`: те же правила, что для org-docs (ссылка на папку, подтверждение ответом на сообщение, проверка, реестр lena-founding-docs-registry.md, дальше брать из foundingDocsFiles без лишнего запроса).",
  "Ценообразование: процедура снижения — не финализируй цену без контекста; старт заказчика в тексте — можно старт участника чуть ниже с пометкой этапа; иначе запроси менеджера. Валюта и НДС — как в документах закупки (BYN, USD, EUR, RUB и т.д.; по РБ часто НДС 20 % в сумме — если в извещении иначе, следуй извещению).",
  "Переписка с менеджерами по тендеру (согласования, цены, условия) — веди контекстный лог на Drive: один файл notes/telegram-managers-log.md на тендер; после значимых реплик дополняй лог или выдай markdown-блок для вставки оператором.",
  "Документы заказчика: всё запрошенное и реально предоставимое должно быть в комплекте — иначе риск отклонения; рано помечай в матрице, чего нет и что нельзя подделать. Не трать силы на финальные тексты, завязанные на недоступный сертификат и т.п. Если требование выглядит принципиально неприменимым к предмету (пример: сертификат собственного производства при тендере на разработку ПО) — изложи гипотезу и запроси подтверждение у менеджера; письмо в тендерную комиссию за разъяснением не готовь и не инициируй автоматически, только после явного согласования человеком.",
  "Экономия токенов: сначала компактно — структура, матрица, что запросить у менеджера/куда загрузить файлы; длинные черновики разделов, которые завязаны на ещё не полученный документ (справка банка и т.д.), разворачивай после появления файла или текста в контексте, если только команда явно не просит полный черновик с заглушками.",
  "Конвейер (docs/TENDER_PIPELINE.md) фиксирован — не менять: **Import** (ссылка IceTrade или номер → bootstrap, файлы в **inputs/**) → **Extract** (/tenderextract, **inputs/extracted/**) → **Card/Analyze** (notes/, матрица) → черновики в **drafts/**. Запрещено придумывать папки docs/, our-docs/ и сценарий «скопируйте тексты документов в чат» или «загрузите в docs/» — документы заказчика только через Import с IceTrade в **inputs/**.",
].join(" ");

/** @type {Map<string, { role: "user" | "assistant", content: string }[]>} */
const chatHistory = new Map();

const BUNDLE_SNIPPET_MAX = 14_000;

/** Кратко зафиксированный курс продукта (см. docs/PRODUCT_CONTEXT.md). */
const PRODUCT_CONTEXT_NOTE = [
  "Курс продукта (подробно: docs/PRODUCT_CONTEXT.md):",
  "• Целевая ЭТП: IceTrade; артефакты закупки — Google Drive (_lena/tenders/…).",
  "• /archivesearch и /archiveask — по уже собранному локальному индексу; документы новой закупки туда не подмешиваются автоматически.",
  "• В общий корпус для обучения системы имеет смысл добавлять материалы только после готового пакета на участие и явного решения команды (авто-триггер в боте — позже; сейчас индекс обновляют вручную на машине с корпусом).",
].join("\n");

/** База для ссылок на docs/ в /help (переопределение: LENA_DOCS_REPO_URL). */
const LENA_DOCS_REPO_BASE = (
  process.env.LENA_DOCS_REPO_URL?.trim() || "https://github.com/And-ilab/tender-prep/blob/main"
).replace(/\/+$/, "");

const LENA_BUSINESS_PROCESS_DOC_URL = `${LENA_DOCS_REPO_BASE}/docs/USER_SHORT_RU.md`;
const LENA_TENDER_PIPELINE_DOC_URL = `${LENA_DOCS_REPO_BASE}/docs/TENDER_PIPELINE.md`;

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const rootRaw = process.env.LENA_DRIVE_ROOT?.trim();

if (!token) {
  console.error("Нужен TELEGRAM_BOT_TOKEN (токен от @BotFather). См. docs/TELEGRAM.md");
  process.exit(1);
}

if (!rootRaw) {
  console.error("Нужен LENA_DRIVE_ROOT — id или URL корневой папки Google Drive (как в workspace-ensure).");
  process.exit(1);
}

/** Сообщения импорта: кнопка «Анализ документов» снимается после первого нажатия (ключ chatId:message_id). */
const consumedIceTradeParseButton = new Set();

let rootId;
try {
  rootId = resolveDriveId(rootRaw);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const base = `https://api.telegram.org/bot${token}`;

/** Мастер цены: `lena_mwz:<token>:pr|py|dl|wr:0|1` — 0 подставить из документов, 1 свои (ответом). */
const CB_MGR_WIZ = "lena_mwz:";

/** @type {Record<ManagerPriceWizardStep, string>} */
const MGR_WIZ_STEP_CODES = { price: "pr", payment: "py", delivery: "dl", warranty: "wr" };

/** @type {Record<string, ManagerPriceWizardStep>} */
const MGR_WIZ_CODE_TO_STEP = { pr: "price", py: "payment", dl: "delivery", wr: "warranty" };

const MGR_WIZ_STARTER_HINT_MIN_LEN = 12;

/** callback_data для inline-кнопки парсинга после импорта: `lena_parse:<tender_id>` (лимит Telegram 64 B). */
const CB_PARSE_PREFIX = "lena_parse:";

/** Выбор компании для КП: `lena_kpo:s:<token>:0|1` (взаимно одна активна), затем `lena_kpo:g:<token>`. */
const CB_KP_ORG_SELECT = "lena_kpo:s:";
const CB_KP_ORG_GO = "lena_kpo:g:";

const KP_ORG_PENDING_TTL_MS = 60 * 60 * 1000;

/**
 * @typedef {"price" | "payment" | "delivery" | "warranty"} ManagerPriceWizardStep
 * @typedef {Object} ManagerPriceWizardState
 * @property {ManagerPriceWizardStep} step
 * @property {string} [price]
 * @property {string} [payment]
 * @property {string} [delivery]
 * @property {string} [warranty]
 * @property {{ price?: string, payment?: string, delivery?: string, warranty?: string }} [embeddedHints]
 */

/**
 * @typedef {Object} KpOrgPending
 * @property {string} tenderId
 * @property {{ flat?: boolean, year?: string }} opts
 * @property {number} chatId
 * @property {number} ts
 * @property {"gs_retail" | "finselvat" | null} selected
 * @property {"awaiting_manager_price" | "ready"} [kpGatePhase]
 * @property {ManagerPriceWizardState | null} [managerPriceWizard]
 */

/** @type {Map<string, KpOrgPending>} */
const kpOrgPending = new Map();

/** Защита от повторного нажатия «Сформировать КП» по одному токену. */
const kpOrgGoConsumed = new Set();

function pruneKpOrgPendingMap() {
  const now = Date.now();
  for (const [k, v] of kpOrgPending) {
    if (now - v.ts > KP_ORG_PENDING_TTL_MS) kpOrgPending.delete(k);
  }
  if (kpOrgPending.size > 2000) kpOrgPending.clear();
  if (kpOrgGoConsumed.size > 8000) kpOrgGoConsumed.clear();
}

function newKpOrgToken() {
  return randomBytes(4).toString("hex");
}

/**
 * @param {string} token
 * @param {"gs_retail" | "finselvat" | null} selected
 */
function buildKpOrgInlineKeyboard(token, selected) {
  const row1 = [
    {
      text: selected === "gs_retail" ? "✓ ГС Ритейл" : "ГС Ритейл",
      callback_data: `${CB_KP_ORG_SELECT}${token}:0`,
    },
    {
      text: selected === "finselvat" ? "✓ Финсельват" : "Финсельват",
      callback_data: `${CB_KP_ORG_SELECT}${token}:1`,
    },
  ];
  /** @type {{ text: string, callback_data: string }[][]} */
  const rows = [row1];
  if (selected) {
    rows.push([{ text: "Сформировать КП", callback_data: `${CB_KP_ORG_GO}${token}` }]);
  }
  return { inline_keyboard: rows };
}

/**
 * @typedef {Object} ParseOrgPending
 * @property {string} tenderId
 * @property {{ flat?: boolean, year?: string }} opts
 * @property {number} chatId
 * @property {number} ts
 * @property {"gs_retail" | "finselvat" | null} selected
 * @property {"awaiting_manager_price" | "ready"} [kpGatePhase]
 * @property {ManagerPriceWizardState | null} [managerPriceWizard]
 */

/** @type {Map<string, ParseOrgPending>} */
const parseOrgPending = new Map();

/** Выбор компании после парсинга: `lena_porg:s:<token>:0|1`; затем **Сформировать КП**: `lena_porg:g:<token>`. */
const CB_PARSE_ORG_SELECT = "lena_porg:s:";
const CB_PARSE_ORG_GO = "lena_porg:g:";

const PARSE_ORG_PENDING_TTL_MS = 60 * 60 * 1000;

/** Защита от повторного нажатия «Сформировать КП» в цепочке после парсинга. */
const parseOrgGoConsumed = new Set();

function pruneParseOrgPendingMap() {
  const now = Date.now();
  for (const [k, v] of parseOrgPending) {
    if (now - v.ts > PARSE_ORG_PENDING_TTL_MS) parseOrgPending.delete(k);
  }
  if (parseOrgPending.size > 2000) parseOrgPending.clear();
  if (parseOrgGoConsumed.size > 8000) parseOrgGoConsumed.clear();
}

/** Активное сообщение-якорь для ответа ценой: chatId:message_id → flow + token. */
/** @type {Map<string, { flow: "parse" | "kp", token: string }>} */
const managerPriceAnchorByMessage = new Map();

function managerPriceGateDisabled() {
  const v = process.env.LENA_TELEGRAM_KP_SKIP_MANAGER_PRICE_GATE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** @param {KpOrgPending | ParseOrgPending} p */
function kpGateIsReady(p) {
  if (managerPriceGateDisabled()) return true;
  return (p.kpGatePhase ?? "ready") === "ready";
}

/** @param {string} [s] */
function meaningfulManagerStarterHint(s) {
  return String(s ?? "").trim().length >= MGR_WIZ_STARTER_HINT_MIN_LEN;
}

/** @param {ManagerPriceWizardStep} step @param {string} [raw] */
function managerStepQualifiesForDocStarter(step, raw) {
  const r = String(raw ?? "");
  if (step === "payment") return paymentHintLooksLikeConcreteTerms(r);
  if (step === "warranty") return warrantyHintLooksLikeConcreteTerms(r);
  return meaningfulManagerStarterHint(r);
}

/**
 * @param {string} token
 * @param {ManagerPriceWizardStep} step
 * @param {ManagerPriceWizardState | null | undefined} wiz
 */
function buildManagerPriceWizardStarterKeyboard(token, step, wiz) {
  const raw = wiz?.embeddedHints?.[step] ?? "";
  if (!managerStepQualifiesForDocStarter(step, raw)) return undefined;
  const code = MGR_WIZ_STEP_CODES[step];
  return {
    inline_keyboard: [
      [
        { text: "Подставить стартовые", callback_data: `${CB_MGR_WIZ}${token}:${code}:0` },
        { text: "Предложить свои", callback_data: `${CB_MGR_WIZ}${token}:${code}:1` },
      ],
    ],
  };
}

/**
 * @param {ManagerPriceWizardStep} step
 * @param {ManagerPriceWizardState | null | undefined} wiz
 */
function managerPriceStarterHintParagraph(step, wiz) {
  const raw = String(wiz?.embeddedHints?.[step] ?? "").trim();
  if (!managerStepQualifiesForDocStarter(step, raw)) return "";
  const clipped = raw.length > 480 ? `${raw.slice(0, 477)}…` : raw;
  return ["", "Из документов (ориентир):", clipped, "", "Кнопки ниже или ответ «Ответить» своим текстом.", ""].join("\n");
}

/** @param {ManagerPriceWizardStep} step */
function managerPriceWizardNextStep(step) {
  if (step === "price") return "payment";
  if (step === "payment") return "delivery";
  if (step === "delivery") return "warranty";
  return null;
}

/**
 * @param {string} tenderId
 * @param {ManagerPriceWizardStep} step
 * @param {ManagerPriceWizardState | null | undefined} [wiz]
 */
function buildManagerPriceWizardStepBody(tenderId, step, wiz) {
  const hintBlock = managerPriceStarterHintParagraph(step, wiz);
  const noCustomerStarterHint =
    "В документации заказчика отсутствуют стартовые условия. Предложите свои.";
  switch (step) {
    case "price":
      return [
        `Условия для КП, тендер ${tenderId}. После шагов — выбор компании (ГС Ритейл или Финсельват).`,
        "",
        "Ответьте «Ответить» на это сообщение или используйте кнопки, если есть фрагмент из документов.",
        "",
        "Шаг 1 — цена. Укажите сумму в валюте закупки (как у заказчика: BYN, USD, EUR и т.д.) и кратко про НДС, если это важно по документам.",
        hintBlock,
        `Одним сообщением без мастера: /tenderprice ${tenderId} … → файл notes/${MANAGER_PRICE_QUOTE_FILENAME}`,
      ].join("\n");
    case "payment": {
      const hasConcretePayDoc = paymentHintLooksLikeConcreteTerms(wiz?.embeddedHints?.payment ?? "");
      return [
        "Шаг 2 — Условия оплаты.",
        !hasConcretePayDoc ? noCustomerStarterHint : "",
        hintBlock,
        "",
        "Пример (услуги): аванс 30 %, остаток в течение 10 рабочих дней после акта.",
        "",
        "Пример (товар): предоплата 50 %, остаток до отгрузки или N календарных дней после поставки.",
        "",
        "Если оплата по этапам — перечислите доли; укажите календарные или рабочие дни.",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "delivery":
      return ["Шаг 3 — срок поставки или оказания услуг.", hintBlock].join("\n");
    case "warranty": {
      const hasConcreteWarDoc = warrantyHintLooksLikeConcreteTerms(wiz?.embeddedHints?.warranty ?? "");
      return [
        "Шаг 4 — Гарантийные обязательства.",
        !hasConcreteWarDoc ? noCustomerStarterHint : "",
        hintBlock,
        "После ответа данные сохранятся на Drive и появятся кнопки выбора организации.",
      ]
        .filter(Boolean)
        .join("\n");
    }
    default:
      return "";
  }
}

/**
 * Первое сообщение мастера: подсказки по тексту закупки + шаг «цена».
 * @param {string} tenderId
 * @param {string} corpus
 * @param {ManagerPriceWizardState | null | undefined} [wiz]
 */
function buildManagerPriceWizardFirstMessageText(tenderId, corpus, wiz) {
  const hints = buildTelegramManagerPriceDocHints(corpus);
  const hintBlock =
    hints.length > 0 ? ["Кратко по тексту Analysis (не замена полного комплекта):", "", ...hints, "", "—", ""].join("\n") : "";
  return hintBlock + buildManagerPriceWizardStepBody(tenderId, "price", wiz);
}

/**
 * @param {ManagerPriceWizardState} wiz
 * @param {string} tenderId
 * @param {"telegram-reply" | "telegram-command"} source
 * @param {string} stamp
 */
function assembleManagerPriceQuoteMarkdown(wiz, tenderId, source, stamp) {
  return [
    "---",
    "lena: manager-price-quote",
    `source: ${source}`,
    `tender_id: ${tenderId}`,
    `saved_at: ${stamp}`,
    "pricing_note: Валюта и НДС — по документам закупки и ответам ниже (часто для РБ: BYN, НДС 20 % в сумме).",
    "---",
    "",
    "## Цена предложения",
    "",
    String(wiz.price ?? "").trim(),
    "",
    "## Условия оплаты",
    "",
    String(wiz.payment ?? "").trim(),
    "",
    "## Срок поставки / оказания услуг",
    "",
    String(wiz.delivery ?? "").trim(),
    "",
    "## Гарантия",
    "",
    String(wiz.warranty ?? "").trim(),
    "",
  ].join("\n");
}

/**
 * @param {string} corpus — markdown Analysis или Preparation (для выдержек «стартовых» строк).
 * @returns {ManagerPriceWizardState}
 */
function newManagerPriceWizardState(corpus) {
  const h = extractCommercialTermsHintsFromCorpus(corpus);
  return {
    step: "price",
    embeddedHints: {
      price: h.price || "",
      payment: h.payment || "",
      delivery: h.delivery || "",
      warranty: h.warranty || "",
    },
  };
}

/**
 * @param {number} chatId
 * @param {number | undefined} anchorMid
 * @param {{ flow: "parse" | "kp", token: string }} ref
 */
function registerManagerPriceAnchor(chatId, anchorMid, ref) {
  if (typeof anchorMid !== "number") return;
  managerPriceAnchorByMessage.set(`${chatId}:${anchorMid}`, ref);
}

/** @param {string} token */
function unregisterManagerPriceAnchorsForToken(token) {
  for (const [k, v] of [...managerPriceAnchorByMessage.entries()]) {
    if (v.token === token) managerPriceAnchorByMessage.delete(k);
  }
}

/** @param {number} chatId @param {string} tenderId */
function findParseOrgAwaitingPriceForTender(chatId, tenderId) {
  for (const [tok, p] of parseOrgPending) {
    if (p.chatId === chatId && p.tenderId === tenderId && p.kpGatePhase === "awaiting_manager_price") {
      return tok;
    }
  }
  return null;
}

/** @param {number} chatId @param {string} tenderId */
function findKpOrgAwaitingPriceForTender(chatId, tenderId) {
  for (const [tok, p] of kpOrgPending) {
    if (p.chatId === chatId && p.tenderId === tenderId && p.kpGatePhase === "awaiting_manager_price") {
      return tok;
    }
  }
  return null;
}

function newParseOrgToken() {
  return randomBytes(4).toString("hex");
}

/**
 * @param {string} token
 * @param {"gs_retail" | "finselvat" | null} selected
 */
function buildParseOrgInlineKeyboard(token, selected) {
  /** @type {{ text: string, callback_data: string }[][]} */
  const rows = [
    [
      {
        text: selected === "gs_retail" ? "✓ ГС Ритейл" : "ГС Ритейл",
        callback_data: `${CB_PARSE_ORG_SELECT}${token}:0`,
      },
      {
        text: selected === "finselvat" ? "✓ Финсельват" : "Финсельват",
        callback_data: `${CB_PARSE_ORG_SELECT}${token}:1`,
      },
    ],
  ];
  if (selected) {
    rows.push([{ text: "Сформировать КП", callback_data: `${CB_PARSE_ORG_GO}${token}` }]);
  }
  return { inline_keyboard: rows };
}

/** Username бота без @ (для упоминаний в группах). */
let botUsernameNorm = "";

/** User id бота (getMe) — «Ответить» на сообщение бота и text_mention. */
let botUserId = 0;

/** Для супергрупп с темами (forum): передаётся в sendMessage / sendDocument. */
let outboundMessageThreadId = undefined;

/** @type {Set<string> | null} */
let allowedChats = null;
const allow = process.env.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
if (allow) {
  allowedChats = new Set(allow.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean));
  console.error(
    `TELEGRAM_ALLOWED_CHAT_IDS: whitelist (${allowedChats.size} id) — сообщения из других чатов игнорируются без ответа. Разрешено: ${[...allowedChats].join(", ")}`,
  );
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} [body]
 */
async function tgJson(method, body) {
  const url = `${base}/${method}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = /** @type {Record<string, unknown>} */ (await res.json());
  if (!data.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

/**
 * @param {unknown} err
 * @returns {Record<string, unknown> | null}
 */
function telegramApiErrorPayload(err) {
  if (!(err instanceof Error)) return null;
  try {
    const j = JSON.parse(err.message);
    return typeof j === "object" && j !== null ? /** @type {Record<string, unknown>} */ (j) : null;
  } catch {
    return null;
  }
}

/**
 * Ответ на сообщение, которое уже удалено / недоступно (часто в темах или после чистки чата).
 */
function isReplyTargetMissingTelegramError(err) {
  const d = telegramApiErrorPayload(err);
  if (!d || d.ok !== false) return false;
  const code = d.error_code;
  const desc = String(d.description ?? "");
  return (
    code === 400 &&
    /message to be replied not found|replied message not found|reply message not found/i.test(desc)
  );
}

/**
 * @param {string} callbackQueryId
 * @param {string} [text] — короткая подсказка пользователю (до ~200 символов)
 * @param {boolean} [showAlert]
 */
async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  /** @type {Record<string, unknown>} */
  const body = { callback_query_id: callbackQueryId };
  if (text != null && text !== "") {
    body.text = text.slice(0, 200);
    body.show_alert = showAlert;
  }
  await tgJson("answerCallbackQuery", body);
}

/** Значения `action` для sendChatAction — **английские идентификаторы**, как в Bot API (клиент Telegram может локализовать подпись). @see https://core.telegram.org/bots/api#sendchataction */
const CHAT_ACTION = {
  TYPING: "typing",
  UPLOAD_DOCUMENT: "upload_document",
  UPLOAD_PHOTO: "upload_photo",
  FIND_LOCATION: "find_location",
};

const CHAT_ACTION_ALLOWED = new Set([
  "typing",
  "upload_photo",
  "record_video",
  "upload_video",
  "record_voice",
  "upload_voice",
  "upload_document",
  "choose_sticker",
  "find_location",
]);

/**
 * @param {string | undefined} raw
 * @param {string} fallback
 */
function resolveChatAction(raw, fallback) {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return CHAT_ACTION_ALLOWED.has(v) ? v : fallback;
}

/** Импорт с IceTrade → Drive (файлы в inputs). По умолчанию: `upload_document`. */
function chatActionForIceTradeImport() {
  const fromNew = process.env.LENA_TELEGRAM_CHAT_ACTION_IMPORT?.trim();
  if (fromNew) return resolveChatAction(fromNew, CHAT_ACTION.UPLOAD_DOCUMENT);
  const legacy = process.env.LENA_TELEGRAM_BOOTSTRAP_CHAT_ACTION?.trim().toLowerCase();
  if (legacy === "typing") return CHAT_ACTION.TYPING;
  if (legacy && CHAT_ACTION_ALLOWED.has(legacy)) return legacy;
  return CHAT_ACTION.UPLOAD_DOCUMENT;
}

/** Парсинг inputs + Analysis (в основном текст и LLM). По умолчанию: `typing`. */
function chatActionForParsePipeline() {
  return resolveChatAction(process.env.LENA_TELEGRAM_CHAT_ACTION_PARSE?.trim(), CHAT_ACTION.TYPING);
}

/** КП, карточка и прочие вызовы LLM. По умолчанию: `typing`. */
function chatActionForLlmDraft() {
  return resolveChatAction(process.env.LENA_TELEGRAM_CHAT_ACTION_LLM?.trim(), CHAT_ACTION.TYPING);
}

/**
 * @param {number} chatId
 * @param {string} action
 */
async function sendChatAction(chatId, action) {
  /** @type {Record<string, unknown>} */
  const body = { chat_id: chatId, action };
  if (typeof outboundMessageThreadId === "number") body.message_thread_id = outboundMessageThreadId;
  await tgJson("sendChatAction", body);
}

/**
 * Пока идёт долгая операция — с интервалом шлём sendChatAction (индикатор в строке ввода).
 * @param {number} chatId
 * @param {string} [action]
 * @returns {() => void} остановить пульс
 */
function startChatActionPulse(chatId, action = CHAT_ACTION.TYPING) {
  const intervalMs = 4000;
  const tick = () => {
    void sendChatAction(chatId, action).catch(() => {});
  };
  tick();
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}

/**
 * @param {number} chatId
 * @param {number} [replyTo]
 * @param {string} filename
 * @param {unknown} obj
 */
async function sendJsonFile(chatId, replyTo, filename, obj) {
  const text = JSON.stringify(obj, null, 2);
  const trySend = async (/** @type {number | undefined} */ rt) => {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (rt != null && rt !== undefined) fd.append("reply_to_message_id", String(rt));
    if (typeof outboundMessageThreadId === "number") {
      fd.append("message_thread_id", String(outboundMessageThreadId));
    }
    fd.append("document", new Blob([text], { type: "application/json" }), filename);
    const res = await fetch(`${base}/sendDocument`, { method: "POST", body: fd });
    const data = /** @type {Record<string, unknown>} */ (await res.json());
    if (!data.ok) {
      throw new Error(JSON.stringify(data));
    }
  };
  try {
    await trySend(replyTo);
  } catch (e) {
    if (replyTo != null && replyTo !== undefined && isReplyTargetMissingTelegramError(e)) {
      await trySend(undefined);
      return;
    }
    throw e;
  }
}

/**
 * @param {string} text
 */
function parseCommand(text) {
  const t = text.trim();
  const m = t.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/s);
  if (!m) return null;
  let name = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();
  /** Алиасы единым стилем */
  if (name === "askarchive") name = "archiveask";
  if (name === "searcharchive") name = "archivesearch";
  const args = rest.split(/\s+/).filter(Boolean);
  return { name, rest, args };
}

/** Убираем zero-width и нормализуем Юникод — иначе «привет» из клиента иногда не матчится. */
function telegramPlainText(s) {
  return s.replace(/[\u200B-\u200D\uFEFF]/g, "").normalize("NFC").trim();
}

/**
 * Короткое приветствие без слэш-команды. Не используем `\b`: в JS границы слова только для ASCII-`\w`,
 * из‑за этого «привет» и др. по‑кириллически не срабатывали.
 * @param {string} stripped
 */
function isBriefGreeting(stripped) {
  const s = stripped.trim();
  if (!s || s.length > 40) return false;
  if (/^hello(\s|$|[,.!?…])/i.test(s)) return true;
  if (/^hi(\s|$|[,.!?…])/i.test(s)) return true;
  if (/^привет(\s|$|[,.!?…])/i.test(s)) return true;
  if (/^здравствуй(те)?(\s|$|[,.!?…])/i.test(s)) return true;
  if (/^доброе\s+утро(\s|$|[,.!?…])/i.test(s)) return true;
  if (/^добрый(\s+(день|вечер|утро))?(\s|$|[,.!?…])/i.test(s)) return true;
  return false;
}

/**
 * Явное @username бота (entity или подстрока). В группе **не** используется как фильтр «видимости»:
 * все сообщения обрабатываются, кроме начинающихся с @ другого участника (см. groupMessageStartsWithOtherUserMention).
 * В личке для совместимости по-прежнему true на любой текст.
 */
function messageAddressesBot(text, chatType, msg) {
  if (chatType === "private") return true;
  const user = botUsernameNorm.trim().toLowerCase();

  const ents = /** @type {Array<{ type?: string; user?: { id?: number; username?: string } }> | undefined} */ (
    msg?.entities ?? msg?.caption_entities
  );
  if (Array.isArray(ents)) {
    for (const e of ents) {
      if (e?.type === "text_mention" && botUserId > 0 && e.user?.id === botUserId) return true;
      if (e?.type === "mention" && user) {
        const offset = /** @type {number} */ (e.offset ?? 0);
        const length = /** @type {number} */ (e.length ?? 0);
        const chunk = text.slice(offset, offset + length).toLowerCase();
        if (chunk === `@${user}`) return true;
      }
    }
  }

  if (!user) return false;
  return text.toLowerCase().includes(`@${user}`);
}

/**
 * В группе: сообщение **начинается** с @ другого участника (не бота) — не обрабатывать
 * (переписка «в сторону» коллеги). «Ответить» на Лену без @ в начале — не игнорируется.
 * @param {string} text
 * @param {string} chatType
 * @param {{ entities?: unknown[]; caption_entities?: unknown[] } | undefined} msg
 */
function groupMessageStartsWithOtherUserMention(text, chatType, msg) {
  if (chatType !== "group" && chatType !== "supergroup") return false;

  const startPos = text.length - text.trimStart().length;
  const botUser = botUsernameNorm.trim().toLowerCase();
  const ents = /** @type {Array<{ type?: string; offset?: number; length?: number; user?: { id?: number } }>} */ (
    msg?.entities ?? msg?.caption_entities
  );

  if (Array.isArray(ents) && ents.length > 0) {
    const mentions = ents
      .filter((e) => e?.type === "mention" || e?.type === "text_mention")
      .sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
    for (const e of mentions) {
      const off = e.offset ?? 0;
      if (off < startPos) continue;
      const gap = text.slice(startPos, off);
      if (gap.trim().length > 0) return false;
      if (e.type === "text_mention") {
        const uid = e.user?.id;
        if (uid && botUserId > 0 && uid === botUserId) return false;
        return true;
      }
      if (e.type === "mention") {
        const chunk = text.slice(off, off + (e.length ?? 0)).toLowerCase();
        if (botUser && chunk === `@${botUser}`) return false;
        return true;
      }
    }
    return false;
  }

  const trimmed = text.trimStart();
  const m = trimmed.match(/^@([A-Za-z0-9_]{3,})/);
  if (!m) return false;
  return !(botUser && m[1].toLowerCase() === botUser);
}

/** Пользователь ответил на сообщение этого бота (ветка диалога с Леной). */
function replyChainToBot(msg) {
  const rt = /** @type {{ from?: { id?: number } } | undefined} */ (msg?.reply_to_message);
  return botUserId > 0 && rt?.from?.id === botUserId;
}

/**
 * В группе для /ask: привязка к закупке — ответ на Лену, ссылка IceTrade или числовой id в тексте.
 */
function groupAskHasProcurementContext(text, msg) {
  if (replyChainToBot(msg)) return true;
  if (extractIceTradeViewIds(text).length > 0) return true;
  if (/\b\d{6,10}\b/.test(text)) return true;
  return false;
}

/**
 * Разговорная реплика (кто ты, что умеешь, спасибо…) — без LLM и без якоря тендера.
 * @returns {Promise<boolean>}
 */
async function handleConversationTurn(chatId, replyTo, text) {
  const intent = classifyConversationIntent(normalizeConversationText(text));
  if (!intent) return false;
  await sendText(chatId, replyTo, buildConversationReply(intent, { botUsername: botUsernameNorm }));
  return true;
}

/**
 * Импорт карточки IceTrade → Drive (группа и личка; в группе не требует @бота, если в тексте есть ссылка).
 * @returns {Promise<boolean>}
 */
async function handleIceTradeBootstrap(chatId, replyTo, text) {
  const viewId = resolveIceTradeViewIdFromMessage(text);
  if (!viewId) return false;

  const first = viewId;
  /** @type {number | undefined} */
  let progressMid;
  try {
    assertCredentialsFile();
    const importOnly = telegramIceTradeImportOnlyEnabled();
    progressMid = await sendText(chatId, replyTo, iceTradeImportProgressMessage(first, importOnly));
    const stopPulse = startChatActionPulse(chatId, chatActionForIceTradeImport());
    try {
      const { markdown, viewId } = await runIceTradeImportForMarkdown({ rootId, messageText: text });
      const cbData = `${CB_PARSE_PREFIX}${viewId}`;
      /** @type {Record<string, unknown> | undefined} */
      const parseKeyboard =
        cbData.length <= 64
          ? {
              inline_keyboard: [[{ text: "Анализ документов", callback_data: cbData }]],
            }
          : undefined;
      if (!parseKeyboard) {
        console.error(`[lena-bot] callback_data > 64 B, кнопка парсинга не добавлена (${cbData.length})`);
      }
      const chainAnchor = typeof progressMid === "number" ? progressMid : replyTo;
      await sendTextChunks(chatId, chainAnchor, markdown, parseKeyboard);
    } finally {
      stopPulse();
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const errAnchor = typeof progressMid === "number" ? progressMid : replyTo;
    await sendTextChunks(
      chatId,
      errAnchor,
      [
        `IceTrade ${first}: не удалось выполнить bootstrap на Drive.`,
        err.slice(0, 1200),
        "",
        "Проверьте учётные данные Google Drive (OAuth или GOOGLE_DRIVE_CREDENTIALS) и **LENA_DRIVE_ROOT**.",
        `Вручную: \`node src/cli.js tenders icetrade-bootstrap <root> "${first}"\``,
      ].join("\n"),
    );
  }
  return true;
}

/**
 * Сообщения без слэш-команды: упоминание + IceTrade или короткое приветствие.
 * @returns {Promise<boolean>}
 */
async function handlePlainMention(chatId, replyTo, text, chatType, msg) {
  if (iceTradeBootstrapShouldRun(text)) {
    return handleIceTradeBootstrap(chatId, replyTo, text);
  }

  const isGroup = chatType === "group" || chatType === "supergroup";
  const stripped = normalizeConversationText(text);
  if (isBriefGreeting(stripped) && (chatType === "private" || isGroup)) {
    await sendText(
      chatId,
      replyTo,
      "Привет. Пришлите ссылку на карточку IceTrade (…icetrade.by/tenders/all/view/<номер>) или напишите /help.",
    );
    return true;
  }

  return false;
}

/**
 * Текст запроса и опционально top-K последним целым словом (как в rag query).
 * @param {string} rest
 * @returns {{ queryText: string, topK: number }}
 */
function parseArchiveQuery(rest) {
  const raw = rest.trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const envK = Number.parseInt(process.env.LENA_RAG_TOP_K?.trim() ?? "", 10);
  const defaultK = Number.isFinite(envK) && envK > 0 ? Math.min(24, envK) : 8;
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) {
      const k = Number.parseInt(last, 10);
      return {
        queryText: parts.slice(0, -1).join(" ").trim(),
        topK: Math.min(24, Math.max(1, k)),
      };
    }
  }
  return { queryText: raw, topK: defaultK };
}

/**
 * @param {string} dirAbs
 */
async function ragIndexDirReady(dirAbs) {
  try {
    await access(join(dirAbs, "manifest.json"));
    await access(join(dirAbs, "chunks.jsonl"));
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {string | null} абсолютный путь или null
 */
function resolvedRagIndexDir() {
  const raw = process.env.LENA_RAG_INDEX_DIR?.trim();
  if (!raw) return null;
  return pathResolve(raw);
}

/**
 * Убирает markdown-символы из текста: в Telegram без parse_mode ** ` _ не превращаются в оформление.
 * @param {string} text
 */
function stripAssistantMarkdownForTelegram(text) {
  let s = String(text ?? "");
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/^#{1,6}\s+/gm, "");
  for (let pass = 0; pass < 6; pass++) {
    const next = s
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
    if (next === s) break;
    s = next;
  }
  s = s.replace(/(^|[\s>"'(,:])_([^_\n]+)_([\s)<"',.:!?]|$)/g, "$1$2$3");
  return s;
}

/**
 * @param {number} chatId
 * @param {number} [replyTo]
 * @param {string} text
 * @param {Record<string, unknown>} [replyMarkup] — объект **reply_markup** для Telegram (`{ inline_keyboard: … }`) или обёртка `{ reply_markup: … }` (обе формы поддерживаются)
 * @returns {Promise<number | undefined>} message_id отправленного сообщения
 */
async function sendText(chatId, replyTo, text, replyMarkup) {
  const max = 3900;
  const cleaned = stripAssistantMarkdownForTelegram(text);
  const chunk = cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}\n\n…(обрезано)`;
  /** @type {Record<string, unknown>} */
  const body = {
    chat_id: chatId,
    text: chunk,
    disable_web_page_preview: true,
  };
  if (replyTo != null && replyTo !== undefined) body.reply_to_message_id = replyTo;
  if (typeof outboundMessageThreadId === "number") body.message_thread_id = outboundMessageThreadId;
  if (replyMarkup && typeof replyMarkup === "object") {
    const wrapped = /** @type {{ reply_markup?: unknown }} */ (replyMarkup).reply_markup;
    body.reply_markup = wrapped !== undefined && wrapped !== null ? wrapped : replyMarkup;
  }
  let data;
  try {
    data = await tgJson("sendMessage", body);
  } catch (e) {
    if (replyTo != null && replyTo !== undefined && isReplyTargetMissingTelegramError(e)) {
      delete body.reply_to_message_id;
      if (process.env.LENA_TELEGRAM_DEBUG?.trim() === "1") {
        console.error("[lena-bot] sendMessage: сообщение для reply удалено или недоступно — повтор без reply_to.");
      }
      data = await tgJson("sendMessage", body);
    } else {
      throw e;
    }
  }
  const result = /** @type {{ message_id?: number }} */ (data.result ?? {});
  return typeof result.message_id === "number" ? result.message_id : undefined;
}

/**
 * Несколько сообщений, если текст длиннее лимита Telegram (~4096).
 * Каждый следующий чанк — ответ на предыдущий (линейная цепочка от replyTo).
 * @param {number} chatId
 * @param {number} [replyTo] — первая опора цепочки (напр. исходное сообщение со ссылкой IceTrade)
 * @param {string} text
 * @param {Record<string, unknown>} [replyMarkupLast] — только на последний чанк
 * @returns {Promise<number | undefined>} message_id последнего отправленного чанка
 */
async function sendTextChunks(chatId, replyTo, text, replyMarkupLast) {
  const max = 3800;
  if (text.length <= max) {
    return sendText(chatId, replyTo, text, replyMarkupLast);
  }
  let i = 0;
  let part = 0;
  /** @type {number | undefined} */
  let chainTo = replyTo;
  /** @type {number | undefined} */
  let lastMid;
  while (i < text.length) {
    const slice = text.slice(i, i + max);
    i += max;
    part += 1;
    const prefix = part > 1 ? `(продолжение ${part})\n` : "";
    const isLast = i >= text.length;
    const mid = await sendText(
      chatId,
      chainTo,
      `${prefix}${slice}`,
      isLast ? replyMarkupLast : undefined,
    );
    if (typeof mid === "number") {
      chainTo = mid;
      lastMid = mid;
    }
  }
  return lastMid;
}

/**
 * Сохраняет значение текущего шага мастера, переходит к следующему или финализирует и шлёт клавиатуру организаций.
 * @param {number} chatId
 * @param {number | undefined} chainReplyTo
 * @param {{ flow: "parse" | "kp", token: string }} ref
 * @param {ParseOrgPending | KpOrgPending} pending
 * @param {string} value — текст для текущего `wiz.step`
 */
async function advanceManagerPriceWizard(chatId, chainReplyTo, ref, pending, value) {
  const wiz = pending.managerPriceWizard;
  if (!wiz) return;

  const tenderId = pending.tenderId;
  const treeOpts = pending.opts;
  const token = ref.token;
  const step = wiz.step;
  const v = String(value ?? "").trim();

  if (step === "price") wiz.price = v;
  else if (step === "payment") wiz.payment = v;
  else if (step === "delivery") wiz.delivery = v;
  else wiz.warranty = v;

  unregisterManagerPriceAnchorsForToken(token);

  const nextStep = managerPriceWizardNextStep(step);
  if (nextStep) {
    wiz.step = nextStep;
    pending.ts = Date.now();
    await sendText(chatId, chainReplyTo, "Принято.");
    const body = buildManagerPriceWizardStepBody(tenderId, nextStep, wiz);
    const kb = buildManagerPriceWizardStarterKeyboard(token, nextStep, wiz);
    const nextMid = await sendText(chatId, chainReplyTo, body, kb ? { reply_markup: kb } : undefined);
    if (typeof nextMid === "number") {
      registerManagerPriceAnchor(chatId, nextMid, ref);
    }
    return;
  }

  assertCredentialsFile();
  const { tender } = await ensureTenderTree(rootId, tenderId, treeOpts);
  const stamp = new Date().toISOString();
  const fileBody = assembleManagerPriceQuoteMarkdown(wiz, tenderId, "telegram-reply", stamp);
  await replaceManagerPriceQuoteFile(tender.notesId, fileBody);

  pending.kpGatePhase = "ready";
  pending.managerPriceWizard = null;
  pending.ts = Date.now();

  if (ref.flow === "parse") {
      await sendText(
      chatId,
      chainReplyTo,
      `Условия сохранены → notes/${MANAGER_PRICE_QUOTE_FILENAME}. Выберите компанию и нажмите «Сформировать КП».`,
      { reply_markup: buildParseOrgInlineKeyboard(token, null) },
    );
  } else {
    await sendText(
      chatId,
      chainReplyTo,
      `Условия сохранены. Выберите организацию и «Сформировать КП».`,
      { reply_markup: buildKpOrgInlineKeyboard(token, null) },
    );
  }
}

/**
 * После Analysis: при активном gate сначала запрос цены, затем кнопки организации.
 * @param {number} chatId
 * @param {number | undefined} chainReplyTo
 * @param {string} analysisMd
 * @param {string} pToken
 * @param {string} tenderId
 * @param {{ flat?: boolean, year?: string }} opts
 */
async function sendAnalysisResultThenMaybePriceGate(chatId, chainReplyTo, analysisMd, pToken, tenderId, opts) {
  pruneParseOrgPendingMap();
  const gateOn = !managerPriceGateDisabled();
  const wizForGate = gateOn ? newManagerPriceWizardState(analysisMd) : null;
  parseOrgPending.set(pToken, {
    tenderId,
    opts,
    chatId,
    ts: Date.now(),
    selected: null,
    kpGatePhase: gateOn ? "awaiting_manager_price" : "ready",
    managerPriceWizard: wizForGate,
  });

  const footerBase = `${analysisMd}\n\nДальше: в Telegram четыре коротких шага (цена → оплата → срок → гарантия), затем выбор компании. Или одним сообщением: /tenderprice ${tenderId} …`;

  if (!gateOn) {
    await sendTextChunks(chatId, chainReplyTo, footerBase, buildParseOrgInlineKeyboard(pToken, null));
    return;
  }

  const lastMid = await sendTextChunks(chatId, chainReplyTo, footerBase, undefined);
  const gateText = buildManagerPriceWizardFirstMessageText(tenderId, analysisMd, wizForGate);
  const gateKb = buildManagerPriceWizardStarterKeyboard(pToken, "price", wizForGate);
  const gateMid = await sendText(chatId, lastMid ?? chainReplyTo, gateText, gateKb ? { reply_markup: gateKb } : undefined);
  const pend = parseOrgPending.get(pToken);
  if (pend && typeof gateMid === "number") {
    registerManagerPriceAnchor(chatId, gateMid, { flow: "parse", token: pToken });
  }
}

/**
 * Ответ «Ответить» на якорь с запросом цены → Drive → кнопки организации.
 * @param {Record<string, unknown>} msg
 * @param {string} bodyText
 * @param {number} chatId
 * @param {number} replyToMsgId
 */
async function tryConsumeManagerPriceGateReply(msg, bodyText, chatId, replyToMsgId) {
  const rtObj = /** @type {{ message_id?: number } | undefined} */ (
    /** @type {Record<string, unknown>} */ (msg).reply_to_message
  );
  const rt = typeof rtObj?.message_id === "number" ? rtObj.message_id : null;
  if (rt == null) return false;

  const ttrim = bodyText.trim();
  if (!ttrim || ttrim.startsWith("/")) return false;

  const ref = managerPriceAnchorByMessage.get(`${chatId}:${rt}`);
  if (!ref) return false;

  const token = ref.token;
  /** @type {ParseOrgPending | KpOrgPending | undefined} */
  let pending;
  if (ref.flow === "parse") {
    pending = parseOrgPending.get(token);
    if (!pending || pending.chatId !== chatId || pending.kpGatePhase !== "awaiting_manager_price") {
      managerPriceAnchorByMessage.delete(`${chatId}:${rt}`);
      return false;
    }
  } else {
    pending = kpOrgPending.get(token);
    if (!pending || pending.chatId !== chatId || pending.kpGatePhase !== "awaiting_manager_price") {
      managerPriceAnchorByMessage.delete(`${chatId}:${rt}`);
      return false;
    }
  }

  if (!pending.managerPriceWizard) {
    pending.managerPriceWizard = newManagerPriceWizardState("");
  }

  managerPriceAnchorByMessage.delete(`${chatId}:${rt}`);
  await advanceManagerPriceWizard(chatId, replyToMsgId, ref, pending, ttrim);
  return true;
}

/**
 * @param {string} rest — текст после /tenderprice
 * @returns {{ tenderId: string, opts: { flat?: boolean, year?: string }, priceText: string } | null}
 */
function parseTenderPriceCommand(rest) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const tenderId = parts[0];
  if (!/^\d{4,15}$/.test(tenderId)) return null;
  let i = 1;
  /** @type {{ flat?: boolean, year?: string }} */
  const opts = {};
  if (/^\d{4}$/.test(parts[i] ?? "")) {
    opts.year = parts[i];
    i += 1;
  } else if ((parts[i] ?? "").toLowerCase() === "flat") {
    opts.flat = true;
    i += 1;
  }
  const priceText = parts.slice(i).join(" ").trim();
  if (!priceText) return null;
  return { tenderId, opts, priceText };
}

/**
 * @param {number} chatId
 * @param {number | undefined} replyTo
 * @param {string} rest
 */
async function cmdTenderPrice(chatId, replyTo, rest) {
  const parsed = parseTenderPriceCommand(rest);
  if (!parsed) {
    await sendText(
      chatId,
      replyTo,
      "Использование: /tenderprice <tender_id> [ГГГГ|flat] <весь текст условий одним сообщением> — обходит мастер; валюта и НДС — как в вашем тексте и документах закупки.",
    );
    return;
  }
  assertCredentialsFile();
  const { tender } = await ensureTenderTree(rootId, parsed.tenderId, parsed.opts);
  const stamp = new Date().toISOString();
  const fileBody = [
    "---",
    "lena: manager-price-quote",
    "source: telegram-command",
    `tender_id: ${parsed.tenderId}`,
    `saved_at: ${stamp}`,
    "pricing_note: Single Telegram message; currency/VAT per text below and procurement docs",
    "---",
    "",
    "## Коммерческие условия (одним сообщением, /tenderprice)",
    "",
    parsed.priceText,
    "",
  ].join("\n");
  await replaceManagerPriceQuoteFile(tender.notesId, fileBody);

  let notified = false;
  const pTok = findParseOrgAwaitingPriceForTender(chatId, parsed.tenderId);
  if (pTok) {
    unregisterManagerPriceAnchorsForToken(pTok);
    const p = parseOrgPending.get(pTok);
    if (p) {
      p.kpGatePhase = "ready";
      p.managerPriceWizard = null;
      p.ts = Date.now();
    }
    await sendText(
      chatId,
      replyTo,
      `Условия сохранены (/tenderprice). Выберите компанию и «Сформировать КП».`,
      { reply_markup: buildParseOrgInlineKeyboard(pTok, null) },
    );
    notified = true;
  }
  const kTok = findKpOrgAwaitingPriceForTender(chatId, parsed.tenderId);
  if (kTok) {
    unregisterManagerPriceAnchorsForToken(kTok);
    const p = kpOrgPending.get(kTok);
    if (p) {
      p.kpGatePhase = "ready";
      p.managerPriceWizard = null;
      p.ts = Date.now();
    }
    await sendText(
      chatId,
      replyTo,
      `Условия сохранены (/tenderprice). Выберите организацию и «Сформировать КП».`,
      { reply_markup: buildKpOrgInlineKeyboard(kTok, null) },
    );
    notified = true;
  }
  if (!notified) {
    await sendText(
      chatId,
      replyTo,
      `Условия сохранены → notes/${MANAGER_PRICE_QUOTE_FILENAME}. Если ждёте кнопок после парсинга или /tenderkp, укажите тот же tender_id.`,
    );
  }
}

/**
 * Inline-кнопки (callback_query): парсинг **inputs/** после импорта.
 * @param {Record<string, unknown>} cq
 */
async function handleCallbackQuery(cq) {
  const id = String(cq.id ?? "");
  const data = typeof cq.data === "string" ? cq.data : "";
  const msg = /** @type {{ text?: string; chat?: { id: number; type?: string }; message_id?: number; message_thread_id?: number } | undefined} */ (
    cq.message
  );
  if (!id || !msg?.chat || typeof msg.chat.id !== "number") {
    if (id) await answerCallbackQuery(id).catch(() => {});
    return;
  }
  const chatId = msg.chat.id;
  if (allowedChats && !allowedChats.has(String(chatId))) {
    await answerCallbackQuery(id).catch(() => {});
    return;
  }
  const t = msg.chat.type;
  if (t !== "private" && t !== "group" && t !== "supergroup") {
    await answerCallbackQuery(id).catch(() => {});
    return;
  }
  outboundMessageThreadId = undefined;
  if ((t === "supergroup" || t === "group") && typeof msg.message_thread_id === "number") {
    outboundMessageThreadId = msg.message_thread_id;
  }
  const replyTo = typeof msg.message_id === "number" ? msg.message_id : undefined;
  if (replyTo == null) {
    await answerCallbackQuery(id).catch(() => {});
    return;
  }
  const msgId = replyTo;

  if (data.startsWith(CB_MGR_WIZ)) {
    const rest = data.slice(CB_MGR_WIZ.length);
    const parts = rest.split(":");
    if (parts.length !== 3) {
      await answerCallbackQuery(id).catch(() => {});
      return;
    }
    const [wizToken, stepCode, action] = parts;
    /** @type {ManagerPriceWizardStep | undefined} */
    const wizStep = MGR_WIZ_CODE_TO_STEP[stepCode];
    if (!wizToken || !wizStep || (action !== "0" && action !== "1")) {
      await answerCallbackQuery(id).catch(() => {});
      return;
    }

    let pending = parseOrgPending.get(wizToken);
    /** @type {"parse" | "kp"} */
    let flow = "parse";
    if (!pending) {
      pending = kpOrgPending.get(wizToken);
      flow = "kp";
    }
    if (!pending || pending.chatId !== chatId || pending.kpGatePhase !== "awaiting_manager_price") {
      await answerCallbackQuery(id, "Запрос устарел.", true);
      return;
    }
    const wizState = pending.managerPriceWizard;
    if (!wizState || wizState.step !== wizStep) {
      await answerCallbackQuery(id, "Шаг уже не актуален — смотрите последнее сообщение Лены.", true);
      return;
    }

    const rawHint = wizState.embeddedHints?.[wizStep] ?? "";

    if (action === "1") {
      await answerCallbackQuery(id, "Ответьте «Ответить» на это сообщение своим текстом.");
      try {
        /** @type {Record<string, unknown>} */
        const rmBody = {
          chat_id: chatId,
          message_id: msgId,
          reply_markup: { inline_keyboard: [] },
        };
        if (typeof outboundMessageThreadId === "number") rmBody.message_thread_id = outboundMessageThreadId;
        await tgJson("editMessageReplyMarkup", rmBody);
      } catch {
        /* ignore */
      }
      return;
    }

    if (!managerStepQualifiesForDocStarter(wizStep, rawHint)) {
      await answerCallbackQuery(id, "В тексте не нашла строку для подстановки — введите условия текстом.", true);
      return;
    }

    await answerCallbackQuery(id, "Подставлено из документов.");
    try {
      /** @type {Record<string, unknown>} */
      const rmBody = {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [] },
      };
      if (typeof outboundMessageThreadId === "number") rmBody.message_thread_id = outboundMessageThreadId;
      await tgJson("editMessageReplyMarkup", rmBody);
    } catch {
      /* ignore */
    }

    await advanceManagerPriceWizard(chatId, msgId, { flow, token: wizToken }, pending, wrapPrefilledFromDocs(rawHint));
    return;
  }

  if (data.startsWith(CB_KP_ORG_SELECT)) {
    const rest = data.slice(CB_KP_ORG_SELECT.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon <= 0) {
      await answerCallbackQuery(id).catch(() => {});
      return;
    }
    const token = rest.slice(0, lastColon).trim();
    const orgIdx = Number.parseInt(rest.slice(lastColon + 1).trim(), 10);
    pruneKpOrgPendingMap();
    const pending = kpOrgPending.get(token);
    if (!pending || pending.chatId !== chatId) {
      await answerCallbackQuery(id, "Запрос устарел. Повторите /tenderkp", true);
      return;
    }
    if (Date.now() - pending.ts > KP_ORG_PENDING_TTL_MS) {
      kpOrgPending.delete(token);
      await answerCallbackQuery(id, "Запрос устарел. Повторите /tenderkp", true);
      return;
    }
    if (!kpGateIsReady(pending)) {
      await answerCallbackQuery(
        id,
        "Сначала завершите мастер условий (4 ответа Лене) или /tenderprice …",
        true,
      );
      return;
    }
    if (orgIdx !== 0 && orgIdx !== 1) {
      await answerCallbackQuery(id).catch(() => {});
      return;
    }
    pending.selected = orgIdx === 0 ? "gs_retail" : "finselvat";
    pending.ts = Date.now();
    const label = OFFER_ORG[pending.selected].label;
    await answerCallbackQuery(id, `Выбрано: ${label}`);
    try {
      /** @type {Record<string, unknown>} */
      const rmBody = {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: buildKpOrgInlineKeyboard(token, pending.selected),
      };
      if (typeof outboundMessageThreadId === "number") rmBody.message_thread_id = outboundMessageThreadId;
      await tgJson("editMessageReplyMarkup", rmBody);
    } catch {
      /* ignore */
    }
    return;
  }

  if (data.startsWith(CB_KP_ORG_GO)) {
    const token = data.slice(CB_KP_ORG_GO.length).trim();
    pruneKpOrgPendingMap();
    const pending = kpOrgPending.get(token);
    if (!pending || pending.chatId !== chatId) {
      await answerCallbackQuery(id, "Запрос устарел. Повторите /tenderkp", true);
      return;
    }
    if (Date.now() - pending.ts > KP_ORG_PENDING_TTL_MS) {
      kpOrgPending.delete(token);
      await answerCallbackQuery(id, "Запрос устарел. Повторите /tenderkp", true);
      return;
    }
    if (!kpGateIsReady(pending)) {
      await answerCallbackQuery(
        id,
        "Сначала завершите мастер условий (4 ответа Лене) или /tenderprice …",
        true,
      );
      return;
    }
    if (!pending.selected) {
      await answerCallbackQuery(id, "Сначала выберите компанию", true);
      return;
    }
    if (kpOrgGoConsumed.has(token)) {
      await answerCallbackQuery(id, "Уже выполняется…", true);
      return;
    }
    kpOrgGoConsumed.add(token);
    kpOrgPending.delete(token);
    unregisterManagerPriceAnchorsForToken(token);

    const tenderId = pending.tenderId;
    const treeOpts = pending.opts;
    const offerOrg = pending.selected;
    const orgLabel = OFFER_ORG[offerOrg].label;

    await answerCallbackQuery(id, "Формирую черновик…");

    const headText = `КП ${tenderId}\n\nКомпания: ${orgLabel}\n\nФормирую черновик…`;
    try {
      /** @type {Record<string, unknown>} */
      const editBody = {
        chat_id: chatId,
        message_id: msgId,
        text: headText,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [] },
      };
      if (typeof outboundMessageThreadId === "number") editBody.message_thread_id = outboundMessageThreadId;
      await tgJson("editMessageText", editBody);
    } catch {
      try {
        /** @type {Record<string, unknown>} */
        const rmBody = { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } };
        if (typeof outboundMessageThreadId === "number") rmBody.message_thread_id = outboundMessageThreadId;
        await tgJson("editMessageReplyMarkup", rmBody);
      } catch {
        /* ignore */
      }
    }

    const stopPulse = startChatActionPulse(chatId, chatActionForLlmDraft());
    try {
      assertCredentialsFile();
      const r = await runCommercialProposalDraftToDrive(rootId, tenderId, { ...treeOpts, offerOrg });
      if (!r.ok) {
        const w = r.warnings?.length ? `\n\n${r.warnings.slice(0, 5).join(" | ")}` : "";
        await sendText(chatId, msgId, `КП: ошибка — ${r.error || "неизвестно"}${w}`);
        return;
      }
      const w = r.warnings?.length ? `\n\nПредупреждения: ${r.warnings.slice(0, 6).join(" | ")}` : "";
      const mdExtra =
        r.markdownFileName && r.googleDocWebViewLink
          ? `\n\nТакже Markdown: ${r.markdownFileName}`
          : "";
      const baseHead =
        r.googleDocWebViewLink && r.googleDocFileName
          ? `Коммерческое предложение в Google Doc: ${r.googleDocFileName} (папка drafts тендера).`
          : `Черновик КП загружен: ${r.fileName} (папка drafts).`;
      const linkOut = r.googleDocWebViewLink ?? r.webViewLink;
      const linkLine = linkOut
        ? `\n\n${r.googleDocWebViewLink ? "Ссылка на Google Doc:" : "Ссылка на файл в Drive:"} ${linkOut}`
        : "";
      await sendText(chatId, msgId, [baseHead, linkLine, mdExtra, w].filter(Boolean).join(""));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await sendText(chatId, msgId, `КП: ошибка — ${err.slice(0, 3500)}`);
    } finally {
      stopPulse();
    }
    return;
  }

  if (data.startsWith(CB_PARSE_ORG_SELECT)) {
    const rest = data.slice(CB_PARSE_ORG_SELECT.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon <= 0) {
      await answerCallbackQuery(id).catch(() => {});
      return;
    }
    const token = rest.slice(0, lastColon).trim();
    const orgIdx = Number.parseInt(rest.slice(lastColon + 1).trim(), 10);
    pruneParseOrgPendingMap();
    const pending = parseOrgPending.get(token);
    if (!pending || pending.chatId !== chatId) {
      await answerCallbackQuery(id, "Сообщение устарело.", true);
      return;
    }
    if (Date.now() - pending.ts > PARSE_ORG_PENDING_TTL_MS) {
      parseOrgPending.delete(token);
      await answerCallbackQuery(id, "Сообщение устарело.", true);
      return;
    }
    if (!kpGateIsReady(pending)) {
      await answerCallbackQuery(
        id,
        "Сначала завершите мастер условий (4 ответа Лене) или /tenderprice …",
        true,
      );
      return;
    }
    if (orgIdx !== 0 && orgIdx !== 1) {
      await answerCallbackQuery(id).catch(() => {});
      return;
    }
    pending.selected = orgIdx === 0 ? "gs_retail" : "finselvat";
    pending.ts = Date.now();
    const label = OFFER_ORG[pending.selected].label;
    await answerCallbackQuery(id, `Выбрано: ${label}. Нажмите «Сформировать КП».`);
    try {
      /** @type {Record<string, unknown>} */
      const rmBody = {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: buildParseOrgInlineKeyboard(token, pending.selected),
      };
      if (typeof outboundMessageThreadId === "number") rmBody.message_thread_id = outboundMessageThreadId;
      await tgJson("editMessageReplyMarkup", rmBody);
    } catch {
      /* ignore */
    }
    return;
  }

  if (data.startsWith(CB_PARSE_ORG_GO)) {
    const token = data.slice(CB_PARSE_ORG_GO.length).trim();
    pruneParseOrgPendingMap();
    const pending = parseOrgPending.get(token);
    if (!pending || pending.chatId !== chatId) {
      await answerCallbackQuery(id, "Сообщение устарело. Запустите парсинг снова или /tenderkp.", true);
      return;
    }
    if (Date.now() - pending.ts > PARSE_ORG_PENDING_TTL_MS) {
      parseOrgPending.delete(token);
      await answerCallbackQuery(id, "Сообщение устарело. Запустите парсинг снова или /tenderkp.", true);
      return;
    }
    if (!kpGateIsReady(pending)) {
      await answerCallbackQuery(
        id,
        "Сначала завершите мастер условий (4 ответа Лене) или /tenderprice …",
        true,
      );
      return;
    }
    if (!pending.selected) {
      await answerCallbackQuery(id, "Сначала выберите компанию", true);
      return;
    }
    if (parseOrgGoConsumed.has(token)) {
      await answerCallbackQuery(id, "Уже выполняется…", true);
      return;
    }
    parseOrgGoConsumed.add(token);
    parseOrgPending.delete(token);
    unregisterManagerPriceAnchorsForToken(token);

    const tenderId = pending.tenderId;
    const treeOpts = pending.opts;
    const offerOrg = pending.selected;
    const orgLabel = OFFER_ORG[offerOrg].label;

    await answerCallbackQuery(id, "Формирую черновик…");

    try {
      /** @type {Record<string, unknown>} */
      const rmBody = {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [] },
      };
      if (typeof outboundMessageThreadId === "number") rmBody.message_thread_id = outboundMessageThreadId;
      await tgJson("editMessageReplyMarkup", rmBody);
    } catch {
      /* ignore */
    }

    const headMid = await sendText(
      chatId,
      msgId,
      `КП ${tenderId} · ${orgLabel}\n\nФормирую черновик…`,
    );

    const stopPulse = startChatActionPulse(chatId, chatActionForLlmDraft());
    try {
      assertCredentialsFile();
      const r = await runCommercialProposalDraftToDrive(rootId, tenderId, { ...treeOpts, offerOrg });
      if (!r.ok) {
        const w = r.warnings?.length ? `\n\n${r.warnings.slice(0, 5).join(" | ")}` : "";
        await sendText(chatId, headMid ?? msgId, `КП: ошибка — ${r.error || "неизвестно"}${w}`);
        return;
      }
      const w = r.warnings?.length ? `\n\nПредупреждения: ${r.warnings.slice(0, 6).join(" | ")}` : "";
      const mdExtra =
        r.markdownFileName && r.googleDocWebViewLink
          ? `\n\nТакже Markdown: ${r.markdownFileName}`
          : "";
      const baseHead =
        r.googleDocWebViewLink && r.googleDocFileName
          ? `Коммерческое предложение в Google Doc: ${r.googleDocFileName} (папка drafts тендера).`
          : `Черновик КП загружен: ${r.fileName} (папка drafts).`;
      const linkOut = r.googleDocWebViewLink ?? r.webViewLink;
      const linkLine = linkOut
        ? `\n\n${r.googleDocWebViewLink ? "Ссылка на Google Doc:" : "Ссылка на файл в Drive:"} ${linkOut}`
        : "";
      await sendText(chatId, headMid ?? msgId, [baseHead, linkLine, mdExtra, w].filter(Boolean).join(""));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await sendText(chatId, headMid ?? msgId, `КП: ошибка — ${err.slice(0, 3500)}`);
    } finally {
      stopPulse();
    }
    return;
  }

  if (data.startsWith(CB_PARSE_PREFIX)) {
    const tenderId = data.slice(CB_PARSE_PREFIX.length).trim();
    if (!/^[0-9]+$/.test(tenderId) || tenderId.length < 4 || tenderId.length > 15) {
      await answerCallbackQuery(id, "Некорректный номер закупки");
      return;
    }
    const consumeKey = `${chatId}:${msgId}`;
    if (consumedIceTradeParseButton.has(consumeKey)) {
      await answerCallbackQuery(id, "Анализ документов по этому сообщению уже запускался.", true);
      return;
    }
    consumedIceTradeParseButton.add(consumeKey);
    if (consumedIceTradeParseButton.size > 5000) consumedIceTradeParseButton.clear();

    await answerCallbackQuery(id, "Запускаю парсинг…");

    const oldText = typeof msg.text === "string" ? msg.text : "";
    const suffix = "\n\n🟩 Анализ документов — запущен.";
    let newText = oldText + suffix;
    if (newText.length > 4096) {
      newText = `${oldText.slice(0, Math.max(0, 4096 - suffix.length - 8))}…${suffix}`;
    }
    try {
      /** @type {Record<string, unknown>} */
      const editBody = {
        chat_id: chatId,
        message_id: msgId,
        text: newText,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [] },
      };
      if (typeof outboundMessageThreadId === "number") editBody.message_thread_id = outboundMessageThreadId;
      await tgJson("editMessageText", editBody);
    } catch {
      try {
        /** @type {Record<string, unknown>} */
        const rmBody = { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } };
        if (typeof outboundMessageThreadId === "number") rmBody.message_thread_id = outboundMessageThreadId;
        await tgJson("editMessageReplyMarkup", rmBody);
      } catch {
        /* ignore */
      }
    }

    const stopPulse = startChatActionPulse(chatId, chatActionForParsePipeline());
    try {
      assertCredentialsFile();
      const md = await runTenderInputsExtractMarkdown({ rootId, tenderId, opts: {} });
      const pToken = newParseOrgToken();
      await sendAnalysisResultThenMaybePriceGate(chatId, replyTo, md, pToken, tenderId, {});
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await sendText(chatId, replyTo, `Парсинг: ошибка — ${err.slice(0, 3500)}`);
    } finally {
      stopPulse();
    }
    return;
  }

  await answerCallbackQuery(id).catch(() => {});
}

/**
 * @param {{ name?: string, webViewLink?: string, lenaContextSource?: string }} f
 */
function contextFileLine(f) {
  if (!f?.name) return "";
  const tag =
    f.lenaContextSource && f.lenaContextSource !== "_lena/context" ? ` [${f.lenaContextSource}]` : "";
  const link = f.webViewLink ? ` ${f.webViewLink}` : "";
  return `• ${f.name}${tag}${link}`;
}

/**
 * @param {{ name?: string, webViewLink?: string }} f
 */
function fileLine(f) {
  if (!f?.name) return "";
  const link = f.webViewLink ? ` ${f.webViewLink}` : "";
  return `• ${f.name}${link}`;
}

async function cmdTemplates(chatId, replyTo) {
  assertCredentialsFile();
  const { templatesFolderId, files } = await listTemplateFiles(rootId);
  if (!templatesFolderId) {
    await sendText(chatId, replyTo, "Папка _lena/templates не найдена. Выполните: node src/cli.js drive workspace-ensure …");
    return;
  }
  const lines = ["Шаблоны (_lena/templates):", `folderId: ${templatesFolderId}`, ""];
  for (const f of files.slice(0, 40)) {
    lines.push(fileLine(f));
  }
  if (files.length > 40) lines.push(`… и ещё ${files.length - 40} файлов`);
  if (files.length === 0) lines.push("(пусто — положите сюда бланк и другие шаблоны)");
  await sendText(chatId, replyTo, lines.join("\n"));
}

async function cmdContext(chatId, replyTo) {
  assertCredentialsFile();
  const { contextFolderId, files, extraContextRoots } = await listContextFiles(rootId);
  if (!contextFolderId && (!files || files.length === 0)) {
    await sendText(
      chatId,
      replyTo,
      "Нет контекста: папка _lena/context не найдена и LENA_EXTRA_CONTEXT_FOLDERS не задана или недоступна. См. docs/GOOGLE_DRIVE.md",
    );
    return;
  }
  const lines = ["Контекст (объединённый список):", ""];
  if (contextFolderId) lines.push(`_lena/context: ${contextFolderId}`);
  if (extraContextRoots && extraContextRoots > 0) {
    lines.push(`Доп. папки из LENA_EXTRA_CONTEXT_FOLDERS: задано корней — ${extraContextRoots}`);
  }
  lines.push("");
  for (const f of files.slice(0, 50)) {
    lines.push(contextFileLine(f));
  }
  if (files.length > 50) lines.push(`… и ещё ${files.length - 50}`);
  if (files.length === 0) lines.push("(нет файлов в корнях контекста)");
  await sendText(chatId, replyTo, lines.join("\n"));
}

async function cmdLibrary(chatId, replyTo) {
  assertCredentialsFile();
  const { libraryFolderId, files } = await listLibraryFiles(rootId);
  if (!libraryFolderId) {
    await sendText(chatId, replyTo, "Папка _lena/library не найдена. Обновите: drive workspace-ensure.");
    return;
  }
  const lines = ["Справочники (_lena/library):", `folderId: ${libraryFolderId}`, ""];
  for (const f of files.slice(0, 40)) {
    lines.push(fileLine(f));
  }
  if (files.length > 40) lines.push(`… и ещё ${files.length - 40}`);
  if (files.length === 0) lines.push("(пусто)");
  await sendText(chatId, replyTo, lines.join("\n"));
}

async function cmdOrgDocs(chatId, replyTo) {
  assertCredentialsFile();
  const { orgDocsFolderId, files } = await listOrgDocsFiles(rootId);
  if (!orgDocsFolderId) {
    await sendText(chatId, replyTo, "Папка _lena/org-docs не найдена. Выполните: node src/cli.js drive workspace-ensure …");
    return;
  }
  const lines = [
    "Универсальные документы организации (_lena/org-docs):",
    `folderId: ${orgDocsFolderId}`,
    "См. docs/LENA_RULES.md — раздел про org-docs.",
    "",
  ];
  for (const f of files.slice(0, 40)) {
    lines.push(fileLine(f));
  }
  if (files.length > 40) lines.push(`… и ещё ${files.length - 40}`);
  if (files.length === 0) lines.push("(пусто — загрузите справку банка, баланс, ОФР и т.д.)");
  await sendText(chatId, replyTo, lines.join("\n"));
}

async function cmdFoundingDocs(chatId, replyTo) {
  assertCredentialsFile();
  const { foundingDocsFolderId, files } = await listFoundingDocsFiles(rootId);
  if (!foundingDocsFolderId) {
    await sendText(chatId, replyTo, "Папка _lena/founding-docs не найдена. Выполните: node src/cli.js drive workspace-ensure …");
    return;
  }
  const lines = [
    "Учредительные документы (_lena/founding-docs):",
    `folderId: ${foundingDocsFolderId}`,
    "См. docs/LENA_RULES.md — §6c.",
    "",
  ];
  for (const f of files.slice(0, 40)) {
    lines.push(fileLine(f));
  }
  if (files.length > 40) lines.push(`… и ещё ${files.length - 40}`);
  if (files.length === 0) lines.push("(пусто — свидетельство о регистрации, устав, приказ о директоре и т.д.)");
  await sendText(chatId, replyTo, lines.join("\n"));
}

/**
 * @param {string[]} args
 */
function parseBundleOpts(args) {
  const tenderId = args[0];
  if (!tenderId) return null;
  const second = args[1]?.trim();
  let flat = false;
  /** @type {string | undefined} */
  let year;
  if (second?.toLowerCase() === "flat") {
    flat = true;
  } else if (second && /^\d{4}$/.test(second)) {
    year = second;
  }
  return { tenderId, opts: { flat, year } };
}

/**
 * /tenderask <tender_id> [ГГГГ|flat] дальше текст вопроса
 * @param {string} rest — текст после команды
 * @returns {{ tenderId: string, opts: { flat?: boolean, year?: string }, question: string } | null}
 */
function parseTenderAskRest(rest) {
  const t = rest.trim();
  if (!t) return null;
  const m = /^(\S+)\s+([\s\S]*)$/.exec(t);
  if (!m) return null;
  const tenderId = m[1];
  let tail = m[2].trim();
  if (!tail) return { tenderId, opts: {}, question: "" };
  const first = tail.split(/\s+/)[0] ?? "";
  /** @type {{ flat?: boolean, year?: string }} */
  const opts = {};
  if (/^\d{4}$/.test(first)) {
    opts.year = first;
    tail = tail.slice(first.length).trim();
  } else if (first.toLowerCase() === "flat") {
    opts.flat = true;
    tail = tail.slice(first.length).trim();
  }
  return { tenderId, opts, question: tail };
}

async function cmdBundle(chatId, replyTo, args) {
  const parsed = parseBundleOpts(args);
  if (!parsed) {
    await sendText(
      chatId,
      replyTo,
      "Использование: /bundle <tender_id> [ГГГГ|flat]\nГод по умолчанию — текущий календарный (см. GOOGLE_DRIVE.md).",
    );
    return;
  }
  assertCredentialsFile();
  const bundle = await buildAgentDriveBundle(rootId, parsed.tenderId, parsed.opts);
  const safeName = `lena-bundle-${parsed.tenderId.replace(/[^\w.-]+/g, "_")}.json`;
  await sendJsonFile(chatId, replyTo, safeName, { ok: true, bundle });
}

async function cmdTenderExtract(chatId, replyTo, args) {
  const parsed = parseBundleOpts(args);
  if (!parsed) {
    await sendText(
      chatId,
      replyTo,
      "Использование: /tenderextract <tender_id> [ГГГГ|flat]\nПарсинг **inputs/**: если есть PDF/DOC/Google-файлы — текст в **inputs/extracted/**; если только «нативный» текст — **extracted** не создаётся. Статус → **tender-pipeline-state.json** в корне тендера. При заданном ключе LLM — сразу **анализ комплекта** и **матрица требований** (строго из распарсенного текста); иначе только извлечение.",
    );
    return;
  }
  assertCredentialsFile();
  const statusMid = await sendText(chatId, replyTo, `Парсинг **${parsed.tenderId}**: сканирую **inputs/** …`);
  const stopPulse = startChatActionPulse(chatId, chatActionForParsePipeline());
  try {
    const md = await runTenderInputsExtractMarkdown({
      rootId,
      tenderId: parsed.tenderId,
      opts: parsed.opts,
    });
    const pToken = newParseOrgToken();
    await sendAnalysisResultThenMaybePriceGate(chatId, statusMid ?? replyTo, md, pToken, parsed.tenderId, parsed.opts);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await sendText(chatId, statusMid ?? replyTo, `Парсинг: ошибка — ${err.slice(0, 3500)}`);
  } finally {
    stopPulse();
  }
}

async function cmdTenderKp(chatId, replyTo, args) {
  const parsed = parseBundleOpts(args);
  if (!parsed) {
    await sendText(
      chatId,
      replyTo,
      [
        "Использование: /tenderkp <tender_id> [ГГГГ|flat]",
        "Нужен **парсинг** **inputs/** (**/tenderextract**) — в корне тендера должен быть **tender-pipeline-state.json**.",
        "После Analysis сначала пройдите **мастер условий** в Telegram (цена → оплата → срок → гарантия) или **/tenderprice**, затем выберите компанию (**ГС Ритейл** / **Финсельват**) и **Сформировать КП**. Черновик: **Google Doc** по шаблону (если настроен) + опционально Markdown в **drafts/**.",
      ].join("\n"),
    );
    return;
  }
  assertCredentialsFile();
  if (!isLlmConfigured()) {
    await sendText(chatId, replyTo, "Нужен OPENAI_API_KEY или LENA_OPENAI_API_KEY для КП.");
    return;
  }
  pruneKpOrgPendingMap();
  const token = newKpOrgToken();

  const { tender } = await ensureTenderTree(rootId, parsed.tenderId, parsed.opts);
  const prepCorpus = (await readPreparationPromptFromNotes(tender.notesId)) ?? "";
  const hasStoredPrice =
    !managerPriceGateDisabled() &&
    ((await readManagerPriceQuoteFromNotes(tender.notesId)) ?? "").trim().length > 0;

  const gateOn = !managerPriceGateDisabled() && !hasStoredPrice;
  const wizForGate = gateOn ? newManagerPriceWizardState(prepCorpus) : null;

  /** @type {KpOrgPending} */
  const pendEntry = {
    tenderId: parsed.tenderId,
    opts: parsed.opts,
    chatId,
    ts: Date.now(),
    selected: null,
    kpGatePhase: gateOn ? "awaiting_manager_price" : "ready",
    managerPriceWizard: wizForGate,
  };
  kpOrgPending.set(token, pendEntry);

  const intro = [
    `КП ${parsed.tenderId}: от какой компании подаётся предложение?`,
    "",
    "Шаблоны и вложения зависят от выбора. Материалы держите в подпапках gs-retail и finselvat в _lena/templates, _lena/org-docs, _lena/founding-docs (появятся после drive workspace-ensure).",
    "Одна организация за раз; переключение — другой кнопкой.",
    "",
    "После выбора нажмите «Сформировать КП».",
  ].join("\n");

  if (kpGateIsReady(pendEntry)) {
    await sendText(chatId, replyTo, intro, { reply_markup: buildKpOrgInlineKeyboard(token, null) });
    return;
  }

  const introShort = [
    `КП ${parsed.tenderId}: четыре коротких ответа про условия или одной командой /tenderprice ${parsed.tenderId} …`,
    "",
    "Цена — в валюте закупки (BYN, USD, EUR и т.д.), НДС — как в документации. Потом выберите компанию кнопками.",
  ].join("\n");
  await sendText(chatId, replyTo, introShort);
  const gateText = buildManagerPriceWizardFirstMessageText(parsed.tenderId, prepCorpus, wizForGate);
  const gateKb = buildManagerPriceWizardStarterKeyboard(token, "price", wizForGate);
  const gateMid = await sendText(chatId, replyTo, gateText, gateKb ? { reply_markup: gateKb } : undefined);
  const pend = kpOrgPending.get(token);
  if (pend && typeof gateMid === "number") {
    registerManagerPriceAnchor(chatId, gateMid, { flow: "kp", token });
  }
}

async function cmdTenderCard(chatId, replyTo, args) {
  const parsed = parseBundleOpts(args);
  if (!parsed) {
    await sendText(
      chatId,
      replyTo,
      "Использование: /tendercard <tender_id> [ГГГГ|flat]\nНужен текст в **inputs/** (нативный) или в **inputs/extracted/** после **/tenderextract**. Опционально: **LENA_TENDER_CARD_RUN_EXTRACT=1** или `tender-card --extract` — сначала парсинг.",
    );
    return;
  }
  assertCredentialsFile();
  if (!isLlmConfigured()) {
    await sendText(chatId, replyTo, "Нужен OPENAI_API_KEY или LENA_OPENAI_API_KEY для карточки.");
    return;
  }
  const statusMid = await sendText(
    chatId,
    replyTo,
    `Карточка **${parsed.tenderId}**: текст из **inputs/** или **inputs/extracted** + HTML IceTrade → LLM…`,
  );
  try {
    const cr = await buildTenderTelegramCard(rootId, parsed.tenderId, {
      ...parsed.opts,
      runExtract: false,
    });
    let msg = formatTenderTelegramCardForTelegram(cr);
    if (cr.ok && cr.noteFile?.name) {
      msg += `\n\n**notes:** \`${cr.noteFile.name}\``;
    }
    if (cr.ok && cr.noteUploadError) {
      msg += `\n\n_(Запись заметки: ${String(cr.noteUploadError).slice(0, 500)})_`;
    }
    await sendTextChunks(chatId, statusMid ?? replyTo, msg);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await sendText(chatId, statusMid ?? replyTo, `Карточка: ошибка — ${err.slice(0, 3500)}`);
  }
}

async function cmdProduct(chatId, replyTo) {
  await sendTextChunks(chatId, replyTo, PRODUCT_CONTEXT_NOTE);
}

async function cmdHelp(chatId, replyTo) {
  const ragDir = resolvedRagIndexDir();
  const ragOk = ragDir && (await ragIndexDirReady(ragDir));
  const ragLine = ragOk
    ? `RAG-архив: ${ragDir}`
    : ragDir
      ? `RAG: папка задана, но нет manifest.json/chunks.jsonl — ${ragDir}`
      : "RAG: не задан LENA_RAG_INDEX_DIR — /archivesearch и /archiveask недоступны.";
  const llm = isLlmConfigured()
    ? "LLM: задан ключ — /tendercard, /tenderkp и **анализ с матрицей** после **/tenderextract** / «Анализ документов»."
    : "LLM: ключ не задан — /ask, /tenderask, /tendercard, /tenderkp и /archiveask недоступны; **/tenderextract** / «Анализ документов» только извлекают текст.";
  await sendText(
    chatId,
    replyTo,
    [
      "Лена — команды:",
      `Бизнес-процесс (стадии, роли, ожидания от менеджера): ${LENA_BUSINESS_PROCESS_DOC_URL}`,
      `Конвейер шагов Import → Extract → … (артефакты на Drive): ${LENA_TENDER_PIPELINE_DOC_URL}`,
      "В группе бот видит все сообщения, кроме начинающихся с @ другого участника. Ссылка IceTrade (…/view/<номер>) — импорт в **inputs** на Drive. Парсинг — **«Анализ документов»** или **/tenderextract**. Расширенный режим: **LENA_TELEGRAM_ICETRADE_IMPORT_ONLY=0**.",
      "/templates — список файлов в _lena/templates (проверка бланка и др.)",
      "/library — _lena/library",
      "/orgdocs — _lena/org-docs (универсальные документы на все тендеры)",
      "/foundingdocs — _lena/founding-docs (учредительные, устав, свидетельство о регистрации, приказ о директоре)",
      "/context — _lena/context + опционально LENA_EXTRA_CONTEXT_FOLDERS",
      "/bundle <tender_id> [ГГГГ|flat] — JSON agent-bundle файлом",
      "/ingest <tender_id> [ГГГГ|flat] <ссылка_на_папку_Drive> — копировать файлы из папки в inputs тендера",
      "/ask … — вопрос нейросети (краткая память в чате); следующие реплики можно писать обычным текстом (без повторного /ask), пока не сбросите диалог через /newchat. **В группе** бот видит все сообщения, кроме начинающихся с @ **другого** участника; без контекста закупки попросит повторить через «Ответить» на сообщение по нужной закупке — см. docs/LENA_RULES.md §6a.",
      "/archivesearch (или /searcharchive) … [число] — поиск по локальному RAG-архиву (фрагменты + пути; см. LENA_RAG_INDEX_DIR и эмбеддинги).",
      "/archiveask (или /askarchive) … [число] — тот же поиск + ответ LLM по найденным отрывкам (нужен ключ LLM и сервер эмбеддингов).",
      "/tenderask <tender_id> [ГГГГ|flat] …вопрос — бандл с явным tender_id + вопрос модели",
      "/tenderextract <tender_id> [ГГГГ|flat] — парсинг **inputs/**; при ключе LLM — **анализ** и **матрица**; затем в Telegram — **мастер условий** (4 шага) или **/tenderprice**, потом выбор компании",
      "/tenderprice <tender_id> [ГГГГ|flat] <текст> — сохранить условия в **notes/** одним сообщением (обход мастера; сумма **с НДС 20 %**)",
      "/tendercard <tender_id> [ГГГГ|flat] — карточка: текст из **inputs/** или **inputs/extracted** + HTML IceTrade + LLM",
      "/tenderkp <tender_id> [ГГГГ|flat] — КП (LLM): при необходимости мастер **цена → оплата → срок → гарантия** или **/tenderprice**; затем **ГС Ритейл** / **Финсельват** → **Сформировать КП** → **Google Doc** + Markdown в **drafts/** (**сначала** /tenderextract)",
      "/newchat — сбросить память для /ask в этом чате",
      "/product — цель продукта (IceTrade, Drive, политика RAG-корпуса)",
      "/help — это сообщение",
      "",
      PRODUCT_CONTEXT_NOTE,
      "",
      llm,
      ragLine,
      "",
      `Корень Drive: ${rootId}`,
    ].join("\n"),
  );
}

function systemPrompt() {
  const custom = process.env.LENA_LLM_SYSTEM_PROMPT?.trim();
  return custom || DEFAULT_LLM_SYSTEM;
}

/** @param {number} chatId */
function historyKey(chatId) {
  return String(chatId);
}

/**
 * @param {number} chatId
 * @param {string} userText
 * @param {string} assistantText
 */
function appendHistory(chatId, userText, assistantText) {
  const k = historyKey(chatId);
  const h = chatHistory.get(k) ?? [];
  h.push({ role: "user", content: userText }, { role: "assistant", content: assistantText });
  while (h.length > 10) h.splice(0, 2);
  chatHistory.set(k, h);
}

/**
 * @param {number} chatId
 * @param {number} replyTo
 * @param {string} rest
 * @param {{ telegramReplyToMessageId?: number }} [opts]
 */
async function cmdAsk(chatId, replyTo, rest, opts) {
  let q = rest.trim();
  if (!q) {
    await sendText(chatId, replyTo, "Использование: /ask ваш вопрос (можно несколько строк).");
    return;
  }
  if (!isLlmConfigured()) {
    await sendText(
      chatId,
      replyTo,
      "Нейросеть не настроена: задайте OPENAI_API_KEY или LENA_OPENAI_API_KEY (см. docs/TELEGRAM.md).",
    );
    return;
  }
  const tid = opts?.telegramReplyToMessageId;
  if (tid != null) {
    q = `[Пользователь ответил в Telegram на сообщение #${tid}]\n\n${q}`;
  }
  const k = historyKey(chatId);
  const prior = chatHistory.get(k) ?? [];
  /** @type {{ role: "system" | "user" | "assistant", content: string }[]} */
  const messages = [{ role: "system", content: systemPrompt() }, ...prior, { role: "user", content: q }];
  const answer = await chatCompletion(messages);
  appendHistory(chatId, q, answer);
  await sendTextChunks(chatId, replyTo, answer);
}

async function cmdTenderAsk(chatId, replyTo, rest) {
  const trimmed = rest.trim();
  const defaultUsage =
    "Использование: /tenderask <tender_id> [ГГГГ|flat] ваш вопрос\nПример: /tenderask gs-retail-2026 Что положить в drafts?";
  if (!trimmed) {
    await sendText(
      chatId,
      replyTo,
      [
        "После команды нужны tender_id и текст вопроса в одном сообщении.",
        defaultUsage,
        "(Только `/tenderask` или `/tenderask@бот` без текста — недостаточно.)",
      ].join("\n"),
    );
    return;
  }

  const parsedEarly = parseTenderAskRest(rest);
  if (!parsedEarly || !parsedEarly.question.trim()) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      await sendText(
        chatId,
        replyTo,
        [
          `Указан только tender_id «${parts[0]}», но нет вопроса после него.`,
          "Добавьте пробел и формулировку, например:",
          `/tenderask ${parts[0]} какие файлы проверить в drafts?`,
          "",
          defaultUsage,
        ].join("\n"),
      );
      return;
    }
    if (parts.length === 2 && /^\d{4}$/.test(parts[1])) {
      await sendText(
        chatId,
        replyTo,
        [
          `Есть tender_id «${parts[0]}» и год «${parts[1]}», но нет текста вопроса.`,
          "Пример:",
          `/tenderask ${parts[0]} ${parts[1]} что должно быть в матрице соответствия?`,
        ].join("\n"),
      );
      return;
    }
    if (parts.length === 2 && parts[1].toLowerCase() === "flat") {
      await sendText(
        chatId,
        replyTo,
        [
          `Есть tender_id «${parts[0]}» и режим flat, но нет вопроса.`,
          "Пример:",
          `/tenderask ${parts[0]} flat что проверить в exports?`,
        ].join("\n"),
      );
      return;
    }
    await sendText(chatId, replyTo, defaultUsage);
    return;
  }

  const parsed = parsedEarly;
  if (!isLlmConfigured()) {
    await sendText(
      chatId,
      replyTo,
      "Нейросеть не настроена: задайте OPENAI_API_KEY или LENA_OPENAI_API_KEY.",
    );
    return;
  }
  assertCredentialsFile();
  const bundle = await buildAgentDriveBundle(rootId, parsed.tenderId, parsed.opts);
  let snippet = JSON.stringify(bundle, null, 2);
  if (snippet.length > BUNDLE_SNIPPET_MAX) {
    snippet = `${snippet.slice(0, BUNDLE_SNIPPET_MAX)}\n…[усечено, полный бандл: /bundle]`;
  }
  const userBlock = [
    "Ниже JSON «agent-bundle» (папки Google Drive, шаблоны, контекст, тендер). Ответь на вопрос пользователя.",
    "",
    snippet,
    "",
    `Вопрос: ${parsed.question.trim()}`,
  ].join("\n");
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userBlock },
  ];
  const answer = await chatCompletion(messages);
  await sendTextChunks(chatId, replyTo, answer);
}

async function cmdIngest(chatId, replyTo, rest) {
  const parsed = parseTenderAskRest(rest);
  if (!parsed || !parsed.question.trim()) {
    await sendText(
      chatId,
      replyTo,
      [
        "Использование: /ingest <tender_id> [ГГГГ|flat] <ссылка_на_папку_Google_Drive>",
        "Копирует **файлы** из этой папки в `_lena/tenders/…/inputs` (подпапки пропускаются).",
        "Папку нужно расшарить на email сервисного аккаунта из GOOGLE_DRIVE_CREDENTIALS.",
        "Пример: /ingest my-tender-001 https://drive.google.com/drive/folders/…",
      ].join("\n"),
    );
    return;
  }
  assertCredentialsFile();
  const sourceRaw = parsed.question.trim();
  const r = await ingestDriveFolderToTenderInputs(rootId, parsed.tenderId, sourceRaw, parsed.opts);

  const lines = [
    `Ингест: тендер ${parsed.tenderId} → inputs`,
    `Источник folderId: ${r.sourceFolderId}, скопировано файлов: ${r.copied.length}`,
    "",
  ];
  for (const c of r.copied.slice(0, 25)) {
    lines.push(c.webViewLink ? `• ${c.name}\n  ${c.webViewLink}` : `• ${c.name}`);
  }
  if (r.copied.length > 25) lines.push(`… и ещё ${r.copied.length - 25}`);
  if (r.skippedFolders.length) {
    lines.push("", `Пропущены подпапки (${r.skippedFolders.length}): ${r.skippedFolders.slice(0, 15).join(", ")}${r.skippedFolders.length > 15 ? "…" : ""}`);
  }
  if (r.errors.length) {
    lines.push("", "Ошибки копирования:");
    for (const e of r.errors.slice(0, 12)) lines.push(`• ${e}`);
    if (r.errors.length > 12) lines.push(`… и ещё ${r.errors.length - 12}`);
  }

  if (isLlmConfigured() && (r.copied.length > 0 || r.errors.length > 0)) {
    const names = r.copied.map((c) => c.name).join("\n");
    const userLlm = [
      "По списку имён файлов (содержимое не читалось) дай краткую обратную связь по-русски:",
      "— чего часто не хватает в комплекте закупки;",
      "— что стоит проверить человеку;",
      "— 2–4 следующих шага в работе.",
      "Не выдумывай текст внутри файлов, только логичные предположения по названиям.",
      "",
      "Файлы:",
      names || "(ничего не скопировано)",
      r.errors.length ? `\nОшибки:\n${r.errors.slice(0, 8).join("\n")}` : "",
    ].join("\n");
    try {
      const digest = await chatCompletion(
        [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userLlm },
        ],
        { max_tokens: 900 },
      );
      lines.push("", "---", "Кратко (LLM по списку файлов):", digest);
    } catch (e) {
      lines.push("", `(LLM: ${e instanceof Error ? e.message : String(e)})`);
    }
  } else if (!isLlmConfigured() && r.copied.length) {
    lines.push("", "(Задайте ключ LLM — добавится краткий комментарий по списку файлов.)");
  }

  await sendTextChunks(chatId, replyTo, lines.join("\n"));
}

async function cmdNewChat(chatId, replyTo) {
  chatHistory.delete(historyKey(chatId));
  await sendText(chatId, replyTo, "Память диалога для /ask в этом чате сброшена.");
}

/**
 * @param {number} chatId
 * @param {number} replyTo
 * @param {string} rest
 */
async function cmdArchiveSearch(chatId, replyTo, rest) {
  const dir = resolvedRagIndexDir();
  if (!dir) {
    await sendText(
      chatId,
      replyTo,
      [
        "Поиск по архиву не настроен.",
        "Задайте LENA_RAG_INDEX_DIR — папку с manifest.json и chunks.jsonl (как у node src/cli.js rag index …).",
        "Для эмбеддингов запроса: LENA_EMBEDDING_BASE_URL, LENA_EMBEDDING_API_KEY, LENA_EMBEDDING_MODEL (как при rag query).",
        "См. docs/TELEGRAM.md.",
      ].join("\n"),
    );
    return;
  }
  if (!(await ragIndexDirReady(dir))) {
    await sendText(
      chatId,
      replyTo,
      `Индекс неполон или путь неверный:\n${dir}\nОжидаются manifest.json и chunks.jsonl.`,
    );
    return;
  }
  const { queryText, topK } = parseArchiveQuery(rest);
  if (!queryText) {
    await sendText(
      chatId,
      replyTo,
      "Использование: /archivesearch ваш запрос [число_topK]\nПример: /archivesearch техническое задание КНС 10",
    );
    return;
  }
  const { hits } = await runQuery(dir, queryText, { topK, stripEmbedding: true });
  const lines = [`Запрос: ${queryText}`, `Фрагментов: ${hits.length} (topK=${topK})`, ""];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const meta = /** @type {Record<string, unknown>} */ (h.metadata ?? {});
    const path = typeof meta.sourcePath === "string" ? meta.sourcePath : "?";
    const body = String(h.text ?? "");
    const snip = body.replace(/\s+/g, " ").slice(0, 520);
    lines.push(`#${i + 1} score=${Number(/** @type {number} */ (h.score)).toFixed(3)} — ${path}`);
    lines.push(snip + (body.length > 520 ? " …" : ""));
    lines.push("");
  }
  await sendTextChunks(chatId, replyTo, lines.join("\n").trimEnd());
}

/**
 * @param {number} chatId
 * @param {number} replyTo
 * @param {string} rest
 */
async function cmdArchiveAsk(chatId, replyTo, rest) {
  if (!isLlmConfigured()) {
    await sendText(
      chatId,
      replyTo,
      "Нейросеть не настроена: задайте OPENAI_API_KEY или LENA_OPENAI_API_KEY. /archiveask сочетает RAG + LLM.",
    );
    return;
  }
  const dir = resolvedRagIndexDir();
  if (!dir) {
    await sendText(
      chatId,
      replyTo,
      "Задайте LENA_RAG_INDEX_DIR — папку индекса (manifest.json + chunks.jsonl). См. docs/TELEGRAM.md.",
    );
    return;
  }
  if (!(await ragIndexDirReady(dir))) {
    await sendText(
      chatId,
      replyTo,
      `Индекс неполон:\n${dir}`,
    );
    return;
  }
  const { queryText, topK } = parseArchiveQuery(rest);
  if (!queryText) {
    await sendText(
      chatId,
      replyTo,
      "Использование: /archiveask ваш вопрос [число_topK]\nПример: /archiveask как оформить отзыв заказчика 8",
    );
    return;
  }
  const { hits, answer } = await runRagAsk(dir, queryText, { topK });
  const sources = hits
    .slice(0, 6)
    .map((h, i) => {
      const meta = /** @type {Record<string, unknown>} */ (h.metadata ?? {});
      const path = typeof meta.sourcePath === "string" ? meta.sourcePath : "?";
      return `${i + 1}. ${path} (${Number(/** @type {number} */ (h.score)).toFixed(3)})`;
    })
    .join("\n");
  const full = [answer.trim(), "", "---", "Источники (фрагменты архива):", sources].join("\n");
  await sendTextChunks(chatId, replyTo, full);
}

async function main() {
  try {
    assertCredentialsFile();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error("Для бота нужен GOOGLE_DRIVE_CREDENTIALS на той же машине.");
    process.exit(1);
  }

  const me = await tgJson("getMe");
  const meResult = /** @type {{ username?: string; id?: number }} */ (me.result);
  const rawUsername = meResult.username;
  botUsernameNorm = rawUsername && /^[A-Za-z0-9_]+$/.test(rawUsername) ? rawUsername.trim() : "";
  botUserId = typeof meResult.id === "number" ? meResult.id : 0;

  const hookState = await tgJson("getWebhookInfo");
  const wh = /** @type {{ url?: string }} */ (hookState.result ?? {});
  const hookUrl = typeof wh.url === "string" ? wh.url.trim() : "";
  if (hookUrl) {
    console.error(
      `Telegram: был настроен webhook → long polling не получал апдейты. Удаляю webhook: ${hookUrl}`,
    );
    await tgJson("deleteWebhook", { drop_pending_updates: false });
  }

  const un = rawUsername ?? "?";
  console.error(`tender-prep v${tenderPrepVersion()}`);
  console.error(`Лена-бот: @${un}, корень Drive: ${rootId}`);
  const rd = resolvedRagIndexDir();
  if (rd) {
    const ok = await ragIndexDirReady(rd);
    console.error(ok ? `RAG-индекс: ${rd}` : `RAG: папка без manifest/chunks: ${rd}`);
  } else {
    console.error("RAG: LENA_RAG_INDEX_DIR не задан — /archivesearch и /archiveask недоступны.");
  }
  console.error(
    "Продукт: IceTrade → Drive; пополнение RAG-корпуса — после пакета и явного решения (/product).",
  );
  console.error("Ожидание сообщений… Ctrl+C — выход.");
  console.error(
    "Диагностика молчания: LENA_TELEGRAM_DEBUG=1 — лог входящих; в логе Conflict — второй процесс или webhook на том же токене.",
  );

  const groupAskRequireReply =
    process.env.LENA_TELEGRAM_GROUP_ASK_REQUIRE_REPLY?.trim() === "1" ||
    process.env.LENA_TELEGRAM_GROUP_ASK_REQUIRE_REPLY?.toLowerCase() === "true";

  let offset = 0;
  const tgDebug = process.env.LENA_TELEGRAM_DEBUG?.trim() === "1";
  for (;;) {
    /** @type {Record<string, unknown>} */
    let updates;
    try {
      const res = await fetch(`${base}/getUpdates?timeout=45&offset=${offset}`);
      updates = /** @type {Record<string, unknown>} */ (await res.json());
    } catch (e) {
      console.error("getUpdates: ошибка сети или разбор ответа:", e instanceof Error ? e.message : String(e));
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!updates.ok) {
      const desc =
        typeof updates.description === "string" ? updates.description : JSON.stringify(updates);
      console.error("Telegram getUpdates:", desc);
      if (/conflict|terminated by other getupdates/i.test(desc)) {
        console.error(
          "Подсказка: уже есть другой процесс с этим TELEGRAM_BOT_TOKEN (или webhook). Остановите второй экземпляр бота.",
        );
      }
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const list = /** @type {{ update_id: number, message?: Record<string, unknown> }[]} */ (
      updates.result ?? []
    );
    for (const u of list) {
      outboundMessageThreadId = undefined;
      offset = u.update_id + 1;

      const rawCq = /** @type {{ callback_query?: Record<string, unknown> }} */ (u).callback_query;
      if (rawCq && typeof rawCq === "object" && rawCq.id != null) {
        try {
          await handleCallbackQuery(rawCq);
        } catch (e) {
          console.error("[lena-bot] callback_query:", e instanceof Error ? e.message : String(e));
        }
        continue;
      }

      const msg = /** @type {Record<string, unknown> & { chat?: { id: number; type?: string }; text?: string; caption?: string; message_id?: number; entities?: unknown[]; caption_entities?: unknown[]; reply_to_message?: { message_id?: number }; message_thread_id?: number }} */ (
        u.message ??
        /** @type {{ edited_message?: typeof u.message }} */ (u).edited_message ??
        /** @type {{ business_message?: typeof u.message }} */ (u).business_message
      );
      if (!msg?.chat) continue;

      const bodyTextRaw =
        typeof msg.text === "string" && msg.text !== ""
          ? msg.text
          : typeof msg.caption === "string"
            ? msg.caption
            : "";
      const bodyText = telegramPlainText(bodyTextRaw);
      if (!bodyText) continue;

      const msgForEntity = {
        ...msg,
        entities: msg.entities ?? msg.caption_entities,
      };
      const chatId = msg.chat.id;
      if (allowedChats && !allowedChats.has(String(chatId))) {
        if (tgDebug) {
          console.error(
            `[lena-bot tg] skip: chat_id ${chatId} нет в TELEGRAM_ALLOWED_CHAT_IDS (${[...allowedChats].join(", ")})`,
          );
        }
        continue;
      }
      const t = msg.chat.type;
      if (t !== "private" && t !== "group" && t !== "supergroup") continue;

      if ((t === "supergroup" || t === "group") && typeof msg.message_thread_id === "number") {
        outboundMessageThreadId = msg.message_thread_id;
      }

      if (tgDebug) {
        console.error(
          `[lena-bot tg] chat=${chatId} type=${String(t)} thread=${outboundMessageThreadId ?? "-"} ${bodyText.slice(0, 120)}`,
        );
      }

      const isGroup = t === "group" || t === "supergroup";
      if (isGroup && groupMessageStartsWithOtherUserMention(bodyText, t, msgForEntity)) {
        if (tgDebug) {
          console.error("[lena-bot tg] skip: в начале сообщения тег другого участника (не бот)");
        }
        continue;
      }

      const replyTo = msg.message_id;
      if (typeof replyTo !== "number") continue;
      try {
        if (await tryConsumeManagerPriceGateReply(msg, bodyText, chatId, replyTo)) continue;
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await sendText(chatId, replyTo, `Ошибка: ${err.slice(0, 3500)}`);
        continue;
      }
      const parsed = parseCommand(bodyText);
      if (!parsed) {
        if (iceTradeBootstrapShouldRun(bodyText) && (t === "private" || isGroup)) {
          try {
            const handledIce = await handleIceTradeBootstrap(chatId, replyTo, bodyText);
            if (handledIce) continue;
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            await sendText(chatId, replyTo, `Ошибка: ${err.slice(0, 3500)}`);
            continue;
          }
        }
        const hk = historyKey(chatId);
        const hasAskHistory = (chatHistory.get(hk) ?? []).length > 0;
        if (await handleConversationTurn(chatId, replyTo, bodyText)) continue;

        const continueAskDialog = hasAskHistory && (t === "private" || isGroup);
        if (continueAskDialog) {
          if (iceTradeBootstrapShouldRun(bodyText)) {
            try {
              const handledIce = await handleIceTradeBootstrap(chatId, replyTo, bodyText);
              if (handledIce) continue;
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              await sendText(chatId, replyTo, `Ошибка: ${err.slice(0, 3500)}`);
              continue;
            }
          }
          if (isGroup && !groupAskHasProcurementContext(bodyText, msgForEntity)) {
            await sendText(chatId, replyTo, telegramTenderContextMissingHint());
            continue;
          }
          try {
            await cmdAsk(chatId, replyTo, bodyText, {
              telegramReplyToMessageId: msg.reply_to_message?.message_id,
            });
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            await sendText(chatId, replyTo, `Ошибка: ${err.slice(0, 3500)}`);
          }
          continue;
        }
        try {
          const handled = await handlePlainMention(chatId, replyTo, bodyText, t, msgForEntity);
          if (handled) continue;
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          await sendText(chatId, replyTo, `Ошибка: ${err.slice(0, 3500)}`);
          continue;
        }
        if (isLlmConfigured() && (t === "private" || isGroup)) {
          if (await handleConversationTurn(chatId, replyTo, bodyText)) continue;
          if (iceTradeBootstrapShouldRun(bodyText)) {
            try {
              const handledIce = await handleIceTradeBootstrap(chatId, replyTo, bodyText);
              if (handledIce) continue;
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              await sendText(chatId, replyTo, `Ошибка: ${err.slice(0, 3500)}`);
              continue;
            }
          }
          if (isGroup && !groupAskHasProcurementContext(bodyText, msgForEntity)) {
            await sendText(chatId, replyTo, telegramTenderContextMissingHint());
            continue;
          }
          try {
            await cmdAsk(chatId, replyTo, bodyText, {
              telegramReplyToMessageId: msg.reply_to_message?.message_id,
            });
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            await sendText(chatId, replyTo, `Ошибка: ${err.slice(0, 3500)}`);
          }
          continue;
        }
        if (isGroup) {
          await sendText(
            chatId,
            replyTo,
            "Сообщение получено. Для вопросов к модели задайте OPENAI_API_KEY (или LENA_OPENAI_API_KEY). Иначе: ссылка IceTrade, /help, /tenderask <tender_id> …",
          );
          continue;
        }
        continue;
      }

      if (parsed.rest?.trim() && (await handleConversationTurn(chatId, replyTo, parsed.rest))) {
        continue;
      }

      if (parsed.name === "ask" && groupAskRequireReply && isGroup && !msg.reply_to_message) {
        await sendText(chatId, replyTo, telegramTenderContextMissingHint());
        continue;
      }

      if (
        parsed.name === "ask" &&
        isGroup &&
        parsed.rest.trim() &&
        !groupAskHasProcurementContext(parsed.rest, msgForEntity)
      ) {
        await sendText(chatId, replyTo, telegramTenderContextMissingHint());
        continue;
      }

      try {
        switch (parsed.name) {
          case "start":
          case "help":
            await cmdHelp(chatId, replyTo);
            break;
          case "product":
            await cmdProduct(chatId, replyTo);
            break;
          case "templates":
            await cmdTemplates(chatId, replyTo);
            break;
          case "context":
            await cmdContext(chatId, replyTo);
            break;
          case "library":
            await cmdLibrary(chatId, replyTo);
            break;
          case "orgdocs":
            await cmdOrgDocs(chatId, replyTo);
            break;
          case "foundingdocs":
            await cmdFoundingDocs(chatId, replyTo);
            break;
          case "bundle":
            await cmdBundle(chatId, replyTo, parsed.args);
            break;
          case "ask":
            await cmdAsk(chatId, replyTo, parsed.rest, {
              telegramReplyToMessageId: msg.reply_to_message?.message_id,
            });
            break;
          case "tenderask":
            await cmdTenderAsk(chatId, replyTo, parsed.rest);
            break;
          case "tendercard":
            await cmdTenderCard(chatId, replyTo, parsed.args);
            break;
          case "tenderextract":
            await cmdTenderExtract(chatId, replyTo, parsed.args);
            break;
          case "tenderkp":
            await cmdTenderKp(chatId, replyTo, parsed.args);
            break;
          case "tenderprice":
            await cmdTenderPrice(chatId, replyTo, parsed.rest);
            break;
          case "ingest":
            await cmdIngest(chatId, replyTo, parsed.rest);
            break;
          case "newchat":
            await cmdNewChat(chatId, replyTo);
            break;
          case "archivesearch":
            await cmdArchiveSearch(chatId, replyTo, parsed.rest);
            break;
          case "archiveask":
            await cmdArchiveAsk(chatId, replyTo, parsed.rest);
            break;
          default:
            break;
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await sendText(chatId, replyTo, `Ошибка: ${err.slice(0, 3500)}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
