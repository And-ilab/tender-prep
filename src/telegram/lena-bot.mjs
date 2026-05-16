/**
 * Бот «Лена» для Telegram: команды к Google Drive (templates, bundle, …).
 *
 * Запуск (из корня репозитория):
 *   set TELEGRAM_BOT_TOKEN=...
 *   set LENA_DRIVE_ROOT=id_или_url_корневой_папки
 *   set GOOGLE_DRIVE_CREDENTIALS=...json
 *   set OPENAI_API_KEY=...   (или LENA_OPENAI_API_KEY; опционально LENA_OPENAI_BASE_URL, LENA_OPENAI_MODEL)
 *   опционально для архива: LENA_RAG_INDEX_DIR, LENA_EMBEDDING_* (см. docs/TELEGRAM.md)
 *   node src/telegram/lena-bot.mjs
 */

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

import { assertCredentialsFile } from "../drive/config.js";
import { resolveDriveId } from "../drive/ids.js";
import { chatCompletion, isLlmConfigured } from "../llm/openaiCompatible.js";
import { runRagAsk } from "../rag/ask.js";
import { runQuery } from "../rag/queryLocal.js";
import {
  buildAgentDriveBundle,
  ingestDriveFolderToTenderInputs,
  listContextFiles,
  listFoundingDocsFiles,
  listLibraryFiles,
  listOrgDocsFiles,
  listTemplateFiles,
} from "../drive/workspace.js";
import {
  analyzeTenderAfterBootstrap,
  formatIceTradeAnalysisForTelegram,
} from "../icetrade/analyzeAfterBootstrap.js";
import { bootstrapIceTradeToDrive } from "../icetrade/bootstrapDrive.js";
import { extractIceTradeViewIds } from "../icetrade/viewIds.js";

/** Сжатый дефолт для смоук-тестов; полные правила — docs/LENA_RULES.md. Переопределение: LENA_LLM_SYSTEM_PROMPT. */
const DEFAULT_LLM_SYSTEM = [
  "Ты «Лена» — специалист по подготовке тендерных документов, не универсальный помощник: сама формируешь пакет материалов заявки (требования, матрица, черновики текстов); в чате с командой при необходимости задаёшь короткие уточняющие вопросы, по умолчанию выдаёшь готовые фрагменты и структуру, а не общие рекомендации.",
  "Отвечай по-русски, кратко и по делу. Если не хватает данных — скажи, чего не хватает.",
  "В общем Telegram-чате команда может вести несколько тендеров сразу: чтобы не путать закупки, пользователь должен писать через «Ответить» на сообщение по нужному тендеру (например на выдачу бота или закреп с tender_id). Если привязки нет и из текста неочевидно, о каком тендере речь — не принимай запрос: откажись и попроси повторить с «Ответить» или с командой /tenderask <tender_id> …; если пользователь даёт указание, но неясно, к какому тендеру оно относится — запроси явно tender_id или ссылку на закупку/тендер; время от времени напоминай об этом правиле.",
  "Не выдумывай содержимое файлов на Диске: опирайся только на то, что явно передано в сообщении (например JSON со ссылками).",
  "Если перечисляешь файлы проекта или оцениваешь состав папки: отдельно отметь форматы, которые не входят в поддерживаемый текстовый контур без предобработки (например .pdf, .doc, .docx и любые другие, кроме .txt/.md/.csv/.log и текста после извлечения). Явно предупреди, что их содержимое не учтено как текст до извлечения; как именно сигнализировать (отдельное сообщение, метка, задача) — по договорённости с пользователем.",
  "Универсальные документы организации (справка банка со сроком, бухгалтерский баланс, отчёт о прибылях и убытках) хранятся в `_lena/org-docs` на Google Drive: при запросе загрузки указывай пользователю прямую ссылку на эту папку и webViewLink из бандла; проси подтвердить загрузку ответом «Ответить» на твоё сообщение; при повторной потребности в том же типе документа сначала используй уже загруженный актуальный файл из org-docs, не запрашивай дубликат без причины.",
  "Учредительные и редко меняющиеся документы (свидетельство о регистрации, устав, приказ о назначении директора) — папка `_lena/founding-docs`: те же правила, что для org-docs (ссылка на папку, подтверждение ответом на сообщение, проверка, реестр lena-founding-docs-registry.md, дальше брать из foundingDocsFiles без лишнего запроса).",
  "Ценообразование: если в закупке явно есть процедура снижения цены или переговоры по снижению — не выводи «точную» финальную цену; если стартовая цена заказчика есть в тексте/бандле, задай стартовую сама на 1–2 % ниже неё с пометкой про этап снижения; если стартовой нет — не выдумывай, запроси менеджера. Если про снижение явно не сказано — кратко подсвети это и запроси цену у менеджера в Telegram, в запросе явно: с НДС 20% или без НДС (если в документах другой НДС — как в документах).",
  "Переписка с менеджерами по тендеру (согласования, цены, условия) — веди контекстный лог на Drive: один файл notes/telegram-managers-log.md на тендер; после значимых реплик дополняй лог или выдай markdown-блок для вставки оператором.",
  "Документы заказчика: всё запрошенное и реально предоставимое должно быть в комплекте — иначе риск отклонения; рано помечай в матрице, чего нет и что нельзя подделать. Не трать силы на финальные тексты, завязанные на недоступный сертификат и т.п. Если требование выглядит принципиально неприменимым к предмету (пример: сертификат собственного производства при тендере на разработку ПО) — изложи гипотезу и запроси подтверждение у менеджера; письмо в тендерную комиссию за разъяснением не готовь и не инициируй автоматически, только после явного согласования человеком.",
  "Экономия токенов: сначала компактно — структура, матрица, что запросить у менеджера/куда загрузить файлы; длинные черновики разделов, которые завязаны на ещё не полученный документ (справка банка и т.д.), разворачивай после появления файла или текста в контексте, если только команда явно не просит полный черновик с заглушками.",
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

let rootId;
try {
  rootId = resolveDriveId(rootRaw);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const base = `https://api.telegram.org/bot${token}`;

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
 * @param {number} chatId
 * @param {number} [replyTo]
 * @param {string} filename
 * @param {unknown} obj
 */
async function sendJsonFile(chatId, replyTo, filename, obj) {
  const text = JSON.stringify(obj, null, 2);
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (replyTo) fd.append("reply_to_message_id", String(replyTo));
  if (typeof outboundMessageThreadId === "number") {
    fd.append("message_thread_id", String(outboundMessageThreadId));
  }
  fd.append("document", new Blob([text], { type: "application/json" }), filename);
  const res = await fetch(`${base}/sendDocument`, { method: "POST", body: fd });
  const data = /** @type {Record<string, unknown>} */ (await res.json());
  if (!data.ok) {
    throw new Error(JSON.stringify(data));
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
 * В группе считаем обращением только явное @username (подстрока или entity mention/text_mention).
 * Цепочка «Ответить» на Лену обрабатывается отдельно (см. replyChainToBot + continueAskDialog).
 * В личке — на любое сообщение с текстом.
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

/** Анализ комплекта после IceTrade bootstrap. Отключить: LENA_ICETRADE_ANALYZE=0|false|no|off */
function icetradeAnalyzeEnabled() {
  const v = process.env.LENA_ICETRADE_ANALYZE?.trim().toLowerCase() ?? "";
  if (!v) return true;
  return !["0", "false", "no", "off"].includes(v);
}

function tenderAnchorHintReply() {
  const user = botUsernameNorm.trim();
  const at = user ? `@${user}` : "@username_бота";
  return [
    "Неясно, о какой закупке речь.",
    "",
    "В общем чате:",
    `• обращайтесь к Лене явно — ${at} в тексте (или упоминание через меню);`,
    "• чтобы не перепутать тендеры, продолжайте **«Ответить»** на сообщение Лены по нужной закупке **или** укажите **номер закупки** (например 1336119), либо ссылку IceTrade …/tenders/all/view/<номер>;",
    "• надёжно: **/tenderask <tender_id> …** — tender_id задаётся в команде.",
  ].join("\n");
}

function errorsIndicateDriveServiceAccountQuota(errors) {
  return errors.some((e) =>
    /storageQuotaExceeded|Service Accounts do not have storage quota/i.test(String(e)),
  );
}

/**
 * Короткая строка для Telegram вместо полотна JSON от Drive.
 * @param {unknown} err
 */
function shortenIceTradeBootstrapError(err) {
  const s = String(err);
  const drive403 =
    /Drive upload 403|storageQuotaExceeded|Service Accounts do not have storage quota/i.test(s);
  const urlMatch = s.match(/^https?:\/\/[^\s]+/);
  if (drive403 && urlMatch) {
    return `${urlMatch[0]} — **Drive 403** (нет квоты у SA на этот корень → **Shared drive**).`;
  }
  if (drive403) {
    return "**Drive 403** — сервисный аккаунт не может писать: корень должен быть на **общем диске**.";
  }
  if (s.length > 380) return `${s.slice(0, 380)}…`;
  return s;
}

/**
 * @param {string[]} errors
 */
function formatIceTradeErrorsForTelegram(errors) {
  if (errors.length === 0) return "";
  if (errorsIndicateDriveServiceAccountQuota(errors)) {
    const urls = [];
    for (const e of errors) {
      const m = String(e).match(/^https?:\/\/[^\s]+/);
      if (m) urls.push(m[0]);
    }
    const unique = [...new Set(urls)];
    if (unique.length > 0) {
      return [
        "",
        "**Предупреждения:**",
        "Сервисный аккаунт **не может загрузить файлы** в текущий корень Drive (**403, нет квоты у SA**). С **IceTrade** загрузка ссылок прошла — сбой только при записи в **inputs**.",
        "",
        `Уникальных вложений: **${unique.length}**. Примеры:`,
        ...unique.slice(0, 4).map((u) => `• ${u}`),
        unique.length > 4 ? `• … и ещё ${unique.length - 4}` : "",
        "",
        "**Что сделать:** перенесите корень «Лены» на **Google Shared drive**, добавьте **client_email** из JSON ключа участником (редактор), обновите **LENA_DRIVE_ROOT** и повторите ссылку.",
        "Кратко: docs/GOOGLE_DRIVE.md (общие диски).",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }
  return `\n\nПредупреждения (до 6):\n${errors
    .slice(0, 6)
    .map((e) => `• ${shortenIceTradeBootstrapError(e)}`)
    .join("\n")}`;
}

/**
 * Сообщения без слэш-команды: упоминание + IceTrade или короткое приветствие.
 * @returns {Promise<boolean>}
 */
async function handlePlainMention(chatId, replyTo, text, chatType, msg) {
  if (!messageAddressesBot(text, chatType, msg)) return false;

  const ids = extractIceTradeViewIds(text);
  if (ids.length > 0) {
    const first = ids[0];
    try {
      assertCredentialsFile();
      await sendText(
        chatId,
        replyTo,
        `IceTrade **${first}**: создаю папку тендера на Drive и пробую скачать вложения в **inputs** (документы заказчика)…`,
      );
      const r = await bootstrapIceTradeToDrive(rootId, text, {});
      const noteName =
        r.noteFile && typeof r.noteFile === "object" && r.noteFile !== null && "name" in r.noteFile
          ? String(/** @type {{ name?: string }} */ (r.noteFile).name ?? "")
          : "";
      const driveSaQuota = errorsIndicateDriveServiceAccountQuota(r.errors);
      const errTail = formatIceTradeErrorsForTelegram(r.errors);

      let analysisTail = "";
      if (icetradeAnalyzeEnabled()) {
        if (isLlmConfigured()) {
          try {
            const ar = await analyzeTenderAfterBootstrap(rootId, r.viewId, {});
            analysisTail = `\n\n${formatIceTradeAnalysisForTelegram(ar)}`;
          } catch (ae) {
            const am = ae instanceof Error ? ae.message : String(ae);
            analysisTail = `\n\n**Анализ комплекта:** ошибка — ${am.slice(0, 800)}`;
          }
        } else {
          analysisTail =
            "\n\n_(Анализ комплекта по inputs не запущен: задайте OPENAI_API_KEY или LENA_OPENAI_API_KEY.)_";
        }
      }
      if (driveSaQuota && r.uploaded.length === 0 && icetradeAnalyzeEnabled()) {
        analysisTail += `\n\n_Блок «анализ» выше опирается на **inputs** на Drive; пока **403 SA**, там пусто — после **Shared drive** пришлите ссылку снова._`;
      }

      const lines = [
        `Готово: закупка **${r.viewId}** на Drive (**tender_id** = номер на IceTrade).`,
        "",
        `**Карточка (HTML):** ${r.cardFetchVia ? `получена через **${r.cardFetchVia}**` : "—"}.`,
        "",
        `**inputs:** загружено файлов — **${r.uploaded.length}**${r.uploaded.length ? `: ${r.uploaded.map((x) => x.name).join(", ")}` : ""}.`,
        r.uploaded.length === 0 && r.candidateUrls.length === 0
          ? [
              "На HTML-карточке не нашлось прямых ссылок (часто вложения подгружаются скриптами или только после входа в ЛК). Положите комплект в **inputs** вручную.",
              r.cardFetchVia === "playwright"
                ? "_(Playwright уже был: попробуйте **LENA_ICETRADE_PLAYWRIGHT_STORAGE** после `npm run icetrade:playwright-auth` и увеличьте **LENA_ICETRADE_PLAYWRIGHT_SETTLE_MS**.)_"
                : "_(Для Chromium: **LENA_ICETRADE_PLAYWRIGHT=1** в `.env` и перезапуск бота; значения **LENA_…** и **GOOGLE_DRIVE_…** из `.env` теперь перебивают переменные Windows.)_",
            ].join("\n")
          : r.uploaded.length === 0 && driveSaQuota && r.candidateUrls.length > 0
            ? "Вложения с площадки **распознаны** (есть прямые ссылки), но **Google Drive не принял загрузку**: у сервисного аккаунта **нет квоты** на текущий корень. Перенесите **LENA_DRIVE_ROOT** на **общий диск (Shared drive)** и добавьте ключ SA участником — см. **docs/GOOGLE_DRIVE.md**."
            : r.uploaded.length === 0
              ? "Ссылки-кандидаты есть, но автоматически скачать не получилось — см. заметку в **notes** и при необходимости скачайте вручную."
              : "",
        "",
        noteName
          ? `В **notes**: \`${noteName}\` — список того, что **нужно запросить у менеджера** (Лена не подготовит сама без этих данных/файлов).`
          : `В **notes** добавлена заметка bootstrap с чеклистом для менеджера.`,
        "",
        `Дальше: **/tenderask ${r.viewId}** … или **/bundle ${r.viewId}**.`,
        errTail,
        analysisTail,
      ].filter(Boolean);
      await sendTextChunks(chatId, replyTo, lines.join("\n"));
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await sendTextChunks(
        chatId,
        replyTo,
        [
          `IceTrade ${first}: не удалось выполнить bootstrap на Drive.`,
          err.slice(0, 1200),
          "",
          "Проверьте GOOGLE_DRIVE_CREDENTIALS и корень LENA_DRIVE_ROOT.",
          `Вручную: \`node src/cli.js tenders icetrade-bootstrap <root> "${first}"\``,
        ].join("\n"),
      );
    }
    return true;
  }

  const stripped = text.replace(/@\w+/g, " ").replace(/\s+/g, " ").trim();
  if (isBriefGreeting(stripped)) {
    await sendText(
      chatId,
      replyTo,
      "Привет. Пришлите ссылку на карточку IceTrade (…icetrade.by/tenders/all/view/<номер>) или напишите /help.",
    );
    return true;
  }

  if (chatType === "private") return false;

  await sendText(chatId, replyTo, tenderAnchorHintReply());
  return true;
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
 * @param {number} chatId
 * @param {number} [replyTo]
 * @param {string} text
 */
async function sendText(chatId, replyTo, text) {
  const max = 3900;
  const chunk = text.length <= max ? text : `${text.slice(0, max)}\n\n…(обрезано)`;
  /** @type {Record<string, unknown>} */
  const body = {
    chat_id: chatId,
    text: chunk,
    disable_web_page_preview: true,
  };
  if (replyTo != null && replyTo !== undefined) body.reply_to_message_id = replyTo;
  if (typeof outboundMessageThreadId === "number") body.message_thread_id = outboundMessageThreadId;
  await tgJson("sendMessage", body);
}

/**
 * Несколько сообщений, если текст длиннее лимита Telegram (~4096).
 * @param {number} chatId
 * @param {number} [replyTo]
 * @param {string} text
 */
async function sendTextChunks(chatId, replyTo, text) {
  const max = 3800;
  if (text.length <= max) {
    await sendText(chatId, replyTo, text);
    return;
  }
  let i = 0;
  let part = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + max);
    i += max;
    part += 1;
    const prefix = part > 1 ? `(продолжение ${part})\n` : "";
    await sendText(chatId, part === 1 ? replyTo : undefined, `${prefix}${slice}`);
  }
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
    ? "LLM: задан ключ (OPENAI_API_KEY или LENA_OPENAI_API_KEY)."
    : "LLM: ключ не задан — /ask, /tenderask и /archiveask недоступны.";
  await sendText(
    chatId,
    replyTo,
    [
      "Лена — команды:",
      "В группе можно написать @бот и ссылку IceTrade (…/tenders/all/view/<номер>) — подтвердит id и подскажет команды.",
      "/templates — список файлов в _lena/templates (проверка бланка и др.)",
      "/library — _lena/library",
      "/orgdocs — _lena/org-docs (универсальные документы на все тендеры)",
      "/foundingdocs — _lena/founding-docs (учредительные, устав, свидетельство о регистрации, приказ о директоре)",
      "/context — _lena/context + опционально LENA_EXTRA_CONTEXT_FOLDERS",
      "/bundle <tender_id> [ГГГГ|flat] — JSON agent-bundle файлом",
      "/ingest <tender_id> [ГГГГ|flat] <ссылка_на_папку_Drive> — копировать файлы из папки в inputs тендера",
      "/ask … — вопрос нейросети (краткая память в чате); следующие реплики можно писать обычным текстом (без повторного /ask), пока не сбросите диалог через /newchat. **В личке** тот же режим: можно сразу писать задачу текстом — при настроенном LLM она уходит в модель (или используйте явный /ask …). **В группе:** явно обращайтесь к Лене через @username в тексте; без номера закупки/ссылки IceTrade продолжайте цепочкой «Ответить» на сообщение Лены по нужному тендеру или укажите номер (например 1336119) — иначе бот попросит уточнить закупку. См. docs/LENA_RULES.md §6a.",
      "/archivesearch (или /searcharchive) … [число] — поиск по локальному RAG-архиву (фрагменты + пути; см. LENA_RAG_INDEX_DIR и эмбеддинги).",
      "/archiveask (или /askarchive) … [число] — тот же поиск + ответ LLM по найденным отрывкам (нужен ключ LLM и сервер эмбеддингов).",
      "/tenderask <tender_id> [ГГГГ|flat] …вопрос — бандл с явным tender_id + вопрос модели",
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
      if (allowedChats && !allowedChats.has(String(chatId))) continue;
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

      const replyTo = msg.message_id;
      if (typeof replyTo !== "number") continue;
      const isGroup = t === "group" || t === "supergroup";
      const parsed = parseCommand(bodyText);
      if (!parsed) {
        const hk = historyKey(chatId);
        const hasAskHistory = (chatHistory.get(hk) ?? []).length > 0;
        const continueAskDialog =
          hasAskHistory &&
          (t === "private" ||
            messageAddressesBot(bodyText, t, msgForEntity) ||
            (isGroup && replyChainToBot(msgForEntity)));
        if (continueAskDialog) {
          if (isGroup && !groupAskHasProcurementContext(bodyText, msgForEntity)) {
            await sendText(chatId, replyTo, tenderAnchorHintReply());
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
        if (t === "private" && isLlmConfigured()) {
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
        continue;
      }

      if (parsed.name === "ask" && groupAskRequireReply && isGroup && !msg.reply_to_message) {
        await sendText(
          chatId,
          replyTo,
          [
            "В этой группе для /ask включено правило: нужно ответить через «Ответить» на сообщение по нужному тендеру (например на прошлый ответ бота или на /bundle по этой закупке).",
            "Иначе непонятно, о каком тендере речь. Либо используйте /tenderask <tender_id> … — там tender_id задаётся явно.",
            "Подробнее: docs/LENA_RULES.md (раздел про Telegram).",
          ].join("\n"),
        );
        continue;
      }

      if (
        parsed.name === "ask" &&
        isGroup &&
        parsed.rest.trim() &&
        !groupAskHasProcurementContext(parsed.rest, msgForEntity)
      ) {
        await sendText(chatId, replyTo, tenderAnchorHintReply());
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
