/** Корневая служебная папка внутри выбранного пользователем корня Диска. */
export const LENA_ROOT_FOLDER = "_lena";

/**
 * Подпапки под `_lena/` (латиница — меньше проблем с кодировками и API).
 * - templates — копируемые шаблоны заявок
 * - library — справочники, регламенты, выдержки (не обязательно «шаблоны на копирование»)
 * - context — общий контекст для Лены между тендерами
 * - org-docs — универсальные документы организации на все тендеры (справка банка со сроком, бух. баланс, ОФР и т.п.)
 * - founding-docs — учредительные и «редко меняющиеся» корпоративные документы (свидетельство о регистрации, устав, приказ о назначении директора и т.п.)
 * - tenders — закупки: по умолчанию `_lena/tenders/<ГГГГ>/<tender_id>/…` (год = `LENA_DEFAULT_TENDER_YEAR` или текущий календарный); режим `flat` — без года в пути
 */
export const LENA_SUB = {
  templates: "templates",
  library: "library",
  context: "context",
  orgDocs: "org-docs",
  foundingDocs: "founding-docs",
  tenders: "tenders",
};

/** Внутри каждого тендера (после опционального `tenders/<YYYY>/`).
 * `inputs` — сырой комплект документов закупки с ЭТП/извещения (в продуктовых текстах: «документы заказчика»).
 */
export const TENDER_SUB = {
  inputs: "inputs",
  drafts: "drafts",
  exports: "exports",
  attachments: "attachments",
  notes: "notes",
};

/**
 * @param {string} tenderId
 */
export function tenderFolderName(tenderId) {
  const s = tenderId.trim().replace(/[\\/:*?"<>|]+/g, "_");
  const cut = s.slice(0, 120);
  return cut || "tender";
}

/**
 * Год по умолчанию для путей `tenders/<ГГГГ>/…` (переменная окружения или текущий календарный год).
 * @returns {string}
 */
export function defaultTenderCalendarYear() {
  const env = process.env.LENA_DEFAULT_TENDER_YEAR?.trim();
  if (env && /^\d{4}$/.test(env)) {
    return env;
  }
  return String(new Date().getFullYear());
}

/**
 * @param {string | undefined} year
 * @returns {string}
 */
export function normalizeTenderYear(year) {
  if (!year?.trim()) {
    throw new Error("Год не задан");
  }
  const y = year.trim();
  if (!/^\d{4}$/.test(y)) {
    throw new Error(`Год тендера должен быть четырьмя цифрами (например 2026), получено: ${year}`);
  }
  return y;
}
