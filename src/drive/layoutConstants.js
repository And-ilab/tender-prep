/** Корневая служебная папка внутри выбранного пользователем корня Диска. */
export const LENA_ROOT_FOLDER = "_lena";

/**
 * Подпапки под `_lena/` (латиница — меньше проблем с кодировками и API).
 * - templates — копируемые шаблоны заявок
 * - library — справочники, регламенты, выдержки (не обязательно «шаблоны на копирование»)
 * - context — общий контекст для Лены между тендерами
 * - tenders — все закупки; внутри опционально год, затем id тендера
 */
export const LENA_SUB = {
  templates: "templates",
  library: "library",
  context: "context",
  tenders: "tenders",
};

/** Внутри каждого тендера (после опционального `tenders/<YYYY>/`). */
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
 * @param {string | undefined} year
 * @returns {string | undefined}
 */
export function normalizeTenderYear(year) {
  if (!year?.trim()) return undefined;
  const y = year.trim();
  if (!/^\d{4}$/.test(y)) {
    throw new Error(`Год тендера должен быть четырьмя цифрами (например 2026), получено: ${year}`);
  }
  return y;
}
