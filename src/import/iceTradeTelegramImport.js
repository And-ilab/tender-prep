/**
 * Модуль **Импорт**: IceTrade → Google Drive (inputs + снимок) и опциональные пост-шаги.
 * Вызывается из Telegram-бота; тот же API пригоден оркестрации (CLI, воркфлоу) без привязки к чату.
 */

import {
  analyzeTenderAfterBootstrap,
  formatIceTradeAnalysisForTelegram,
} from "../icetrade/analyzeAfterBootstrap.js";
import { bootstrapIceTradeToDrive } from "../icetrade/bootstrapDrive.js";
import {
  iceTradeCustomerValueIsDocReference,
  pickIceTradeCustomerOrganizationName,
} from "../icetrade/importPageMeta.js";
import {
  buildTenderTelegramCard,
  formatTenderTelegramCardForTelegram,
} from "../icetrade/tenderTelegramCard.js";
import { isLlmConfigured } from "../llm/openaiCompatible.js";

/** @param {NodeJS.ProcessEnv} [env] */
export function telegramCardAfterBootstrapEnabled(env = process.env) {
  const v = env.LENA_TELEGRAM_CARD_AFTER_BOOTSTRAP?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** @param {NodeJS.ProcessEnv} [env] */
export function icetradeAnalyzeEnabled(env = process.env) {
  const v = env.LENA_ICETRADE_ANALYZE?.trim().toLowerCase() ?? "";
  if (!v) return true;
  return !["0", "false", "no", "off"].includes(v);
}

/**
 * По ссылке IceTrade в Telegram: только импорт по умолчанию.
 * Полный конвейер: **LENA_TELEGRAM_ICETRADE_IMPORT_ONLY=0** и при необходимости флаги анализа / extract / карточки.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function telegramIceTradeImportOnlyEnabled(env = process.env) {
  const v = env.LENA_TELEGRAM_ICETRADE_IMPORT_ONLY?.trim().toLowerCase() ?? "";
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

export function errorsIndicateDriveServiceAccountQuota(errors) {
  return errors.some((e) =>
    /storageQuotaExceeded|Service Accounts do not have storage quota/i.test(String(e)),
  );
}

/**
 * Короткая строка для Telegram вместо полотна JSON от Drive.
 * @param {unknown} err
 */
export function shortenIceTradeBootstrapError(err) {
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
 * Что проверить в `.env`, если с IceTrade не скачались вложения (HTML вместо PDF и т.п.).
 * @param {{ uploaded: unknown[], candidateUrls: unknown[], cardFetchVia?: string }} r
 */
export function iceTradeSessionEnvHint(r) {
  const lines = [
    "**Если вложения не качаются (в т.ч. «HTML вместо PDF» в предупреждениях):**",
    "• Опционально **как у браузера**: **LENA_ICETRADE_COOKIE** (заголовок Cookie из DevTools) или **LENA_ICETRADE_PLAYWRIGHT_STORAGE** после `npm run icetrade:playwright-auth` — помогает, если площадка режет «голый» fetch. ЛК для публичных карточек обычно не обязателен.",
  ];
  lines.push("• Тяжёлая карточка IceTrade: **LENA_ICETRADE_PLAYWRIGHT=1** и `npx playwright install chromium` (перезапуск бота после смены `.env`).");
  if (r.cardFetchVia === "playwright") {
    lines.push(
      "• Уже идёт Playwright; если файлы всё равно не бинарники — увеличьте **LENA_ICETRADE_PLAYWRIGHT_DOWNLOAD_PRIME_MS**, **LENA_ICETRADE_FETCH_TIMEOUT_MS**, **LENA_ICETRADE_PLAYWRIGHT_SETTLE_MS**; при необходимости снимите **Cookie** из браузера или обновите **STORAGE**.",
    );
  } else {
    lines.push(
      "• Сейчас карточка **без** Playwright — для подгрузки документов включите **LENA_ICETRADE_PLAYWRIGHT=1**, затем снова пришлите ссылку.",
    );
  }
  return lines.join("\n");
}

/**
 * @param {string[]} errors
 */
export function formatIceTradeErrorsForTelegram(errors) {
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
 * Неблокирующая сводка ошибок bootstrap для короткого сообщения пользователю.
 * @param {string[]} errors
 */
export function formatIceTradeErrorsBriefForUser(errors) {
  if (errors.length === 0) return "";
  if (errorsIndicateDriveServiceAccountQuota(errors)) {
    return "\n\n⚠ Вложения на Google Drive не сохранены (403 / нет квоты у SA). Перенесите корень на **Shared drive** — см. docs/GOOGLE_DRIVE.md.";
  }
  return `\n\n⚠ ${errors.length} служебных уведомл. — детали в **notes** на Drive.`;
}

/**
 * @param {unknown} snap
 */
function snapshotCustomerLine(snap) {
  if (!snap || typeof snap !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (snap);
  const labeled = o.labeledFields && typeof o.labeledFields === "object" ? /** @type {Record<string, string>} */ (o.labeledFields) : null;
  const ranked = labeled ? pickIceTradeCustomerOrganizationName(labeled) : null;
  if (ranked) return ranked.trim().slice(0, 480);

  const st = o.structured && typeof o.structured === "object" ? /** @type {Record<string, unknown>} */ (o.structured) : null;
  const customer = st?.customer && typeof st.customer === "object" ? /** @type {Record<string, unknown>} */ (st.customer) : null;
  const unp = typeof customer?.customerNameAddressUnp === "string" ? customer.customerNameAddressUnp.trim() : "";
  if (unp && !iceTradeCustomerValueIsDocReference(unp)) return unp.slice(0, 480);
  const conducted = typeof customer?.procurementConductedBy === "string" ? customer.procurementConductedBy.trim() : "";
  if (conducted && !iceTradeCustomerValueIsDocReference(conducted)) return conducted.slice(0, 480);
  return null;
}

/**
 * @param {unknown} snap
 */
function snapshotSumLine(snap) {
  if (!snap || typeof snap !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (snap);
  const st = o.structured && typeof o.structured === "object" ? /** @type {Record<string, unknown>} */ (o.structured) : null;
  const proc = st?.procedure && typeof st.procedure === "object" ? /** @type {Record<string, unknown>} */ (st.procedure) : null;
  const fromStruct = typeof proc?.estimatedTotalValue === "string" ? proc.estimatedTotalValue.trim() : "";
  if (fromStruct) return fromStruct.slice(0, 400);
  const hints = o.priceHints;
  if (Array.isArray(hints) && hints[0] != null) return String(hints[0]).trim().slice(0, 400);
  const labeled = o.labeledFields && typeof o.labeledFields === "object" ? /** @type {Record<string, string>} */ (o.labeledFields) : null;
  if (labeled) {
    for (const [k, val] of Object.entries(labeled)) {
      if (/стоимост|нмц|цен\w*\s+лот|ориентировочн/i.test(k) && val?.trim()) return val.trim().slice(0, 400);
    }
  }
  return null;
}

/**
 * @param {unknown} snap
 */
function snapshotDeadlineLine(snap) {
  if (!snap || typeof snap !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (snap);
  const st = o.structured && typeof o.structured === "object" ? /** @type {Record<string, unknown>} */ (o.structured) : null;
  const proc = st?.procedure && typeof st.procedure === "object" ? /** @type {Record<string, unknown>} */ (st.procedure) : null;
  const fromStruct = typeof proc?.bidsDeadlineAt === "string" ? proc.bidsDeadlineAt.trim() : "";
  if (fromStruct) return fromStruct.slice(0, 400);
  const labeled = o.labeledFields && typeof o.labeledFields === "object" ? /** @type {Record<string, string>} */ (o.labeledFields) : null;
  if (labeled) {
    for (const [k, val] of Object.entries(labeled)) {
      if (/окончани|подач|прием\w*\s+предложен/i.test(k) && val?.trim()) return val.trim().slice(0, 400);
    }
  }
  return null;
}

/** Заголовок стадии в Telegram (окно конвейера «Import»). */
export const ICE_TRADE_TELEGRAM_IMPORT_STAGE_TITLE = "**Import** · импорт данных на Drive";

/**
 * Сжатое сообщение после импорта: только поля, нужные менеджеру.
 * @param {{
 *   viewId: string,
 *   inputsFolderWebViewLink?: string,
 *   tenderRootWebViewLink?: string,
 *   iceTradeUrl?: string,
 *   uploaded: { name?: string }[],
 *   candidateUrls: unknown[],
 *   importSnapshot?: unknown,
 * }} r
 */
export function formatIceTradeImportShortSummary(r) {
  const snap = r.importSnapshot;
  const o = snap && typeof snap === "object" ? /** @type {Record<string, unknown>} */ (snap) : null;
  const titleRaw = o && typeof o.title === "string" ? o.title.trim() : "";
  const title =
    titleRaw && titleRaw.length >= 8
      ? titleRaw.slice(0, 500)
      : `Закупка ${r.viewId} (IceTrade)`;
  const customer = snapshotCustomerLine(snap) ?? "—";
  const sum = snapshotSumLine(snap) ?? "—";
  const deadline = snapshotDeadlineLine(snap) ?? "—";
  let docLine = "";
  if (r.inputsFolderWebViewLink) {
    docLine = `Документация (файлы на Drive): ${r.inputsFolderWebViewLink}`;
  } else if (o && Array.isArray(o.documentLinks) && o.documentLinks.length > 0) {
    const first = /** @type {{ href?: string; name?: string }} */ (o.documentLinks[0]);
    if (first?.href) docLine = `Документация (ссылка с карточки): ${first.href}`;
  }
  if (!docLine && r.iceTradeUrl) docLine = `Карточка закупки: ${r.iceTradeUrl}`;
  if (!docLine) docLine = "Ссылка на комплект: —";

  const lines = [
    ICE_TRADE_TELEGRAM_IMPORT_STAGE_TITLE,
    "",
    "**Импорт выполнен**",
    "",
    `**Наименование:** ${title}`,
    `**Заказчик:** ${customer}`,
    `**Сумма / стоимость:** ${sum}`,
    `**Дата подачи / дедлайн:** ${deadline}`,
    docLine,
    "",
    `**Номер на IceTrade:** ${r.viewId}`,
  ];
  if (r.uploaded.length === 0 && r.candidateUrls.length > 0) {
    lines.push("", "_Файлы с площадки не сохранены в inputs — проверьте настройки Drive / Playwright (см. notes)._");
  }
  return lines.join("\n");
}

/**
 * Текст «идёт импорт» для чата (Telegram и т.п.).
 * @param {string} viewId
 * @param {boolean} importOnly
 */
export function iceTradeImportProgressMessage(viewId, importOnly) {
  const body = importOnly
    ? `IceTrade **${viewId}**: скачиваю вложения и пишу **inputs/icetrade-import-snapshot.json** на Google Drive…`
    : `IceTrade **${viewId}**: создаю папку тендера на Drive, сохраняю **inputs/icetrade-import-snapshot.json** (поля карточки и события) и пробую скачать вложения в **inputs**…`;
  return `${ICE_TRADE_TELEGRAM_IMPORT_STAGE_TITLE}\n\n${body}`;
}

/**
 * Полный ответ пользователю после успешного bootstrap и опциональных пост-шагов.
 * @param {{ rootId: string, messageText: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ markdown: string, viewId: string }>}
 */
export async function runIceTradeImportForMarkdown(opts) {
  const { rootId, messageText, env = process.env } = opts;
  const importOnly = telegramIceTradeImportOnlyEnabled(env);

  const r = await bootstrapIceTradeToDrive(rootId, messageText, {});
  const driveSaQuota = errorsIndicateDriveServiceAccountQuota(r.errors);
  const errBrief = formatIceTradeErrorsBriefForUser(r.errors);

  let analysisTail = "";
  if (!importOnly && icetradeAnalyzeEnabled(env)) {
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
  if (!importOnly && driveSaQuota && r.uploaded.length === 0 && icetradeAnalyzeEnabled(env)) {
    analysisTail += `\n\n_Блок «анализ» выше опирается на **inputs** на Drive; пока **403 SA**, там пусто — после **Shared drive** пришлите ссылку снова._`;
  }

  let cardTail = "";
  if (
    !importOnly &&
    telegramCardAfterBootstrapEnabled(env) &&
    isLlmConfigured() &&
    r.uploaded.length > 0
  ) {
    try {
      const cr = await buildTenderTelegramCard(rootId, r.viewId, { runExtract: false });
      cardTail = `\n\n---\n\n${formatTenderTelegramCardForTelegram(cr)}`;
      if (cr.ok && cr.noteFile?.name) {
        cardTail += `\n\nКарточка в **notes**: \`${cr.noteFile.name}\``;
      }
      if (cr.ok && cr.noteUploadError) {
        cardTail += `\n\n_(Заметка на Drive: ${String(cr.noteUploadError).slice(0, 400)})_`;
      }
    } catch (ce) {
      const msg = ce instanceof Error ? ce.message : String(ce);
      cardTail = `\n\n_(Карточка тендера: ${msg.slice(0, 500)})_`;
    }
  }

  const skipped = Array.isArray(r.skippedExistingOnDrive) ? r.skippedExistingOnDrive : [];
  const skippedHint =
    skipped.length > 0
      ? `\n_Уже были в inputs (**${skipped.length}** имён) — повторно не качали._`
      : "";

  const footerLines = importOnly
    ? ["", "Кнопка **«Анализ документов»** — извлечение текста из файлов (включая OCR)."]
    : [
        "",
        `Также: **/tenderextract ${r.viewId}**, **/tendercard**, **/bundle**.`,
        "_Полный режим после ссылки: **LENA_TELEGRAM_ICETRADE_IMPORT_ONLY=0**._",
      ];

  const core = formatIceTradeImportShortSummary({
    viewId: r.viewId,
    inputsFolderWebViewLink: r.inputsFolderWebViewLink,
    tenderRootWebViewLink: r.tenderRootWebViewLink,
    iceTradeUrl: r.iceTradeUrl,
    uploaded: r.uploaded,
    candidateUrls: r.candidateUrls,
    importSnapshot: r.importSnapshot,
  });

  const lines = [
    core,
    skippedHint,
    errBrief,
    ...footerLines,
    analysisTail,
    cardTail,
  ].filter((x) => typeof x === "string" && x.length > 0);

  return { markdown: lines.join("\n"), viewId: String(r.viewId) };
}
