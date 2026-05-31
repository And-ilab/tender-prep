/** Корневая служебная папка внутри выбранного пользователем корня Диска. */
export const LENA_ROOT_FOLDER = "_lena";

/**
 * Подпапки под `_lena/` (латиница — меньше проблем с кодировками и API).
 * - templates — шаблоны заявок и бланки: внутри — подпапки **`gs-retail`**, **`finselvat`** под материалы соответствующего юрлица (плюс при необходимости файлы в корне `templates`)
 * - library — справочники, регламенты, выдержки (не обязательно «шаблоны на копирование»)
 * - context — общий контекст для Лены между тендерами
 * - org-docs — документы организации на тендеры (справка банка, баланс, ОФР): внутри — **подпапки по юрлицу** (`gs-retail`, `finselvat`), см. `LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG`
 * - founding-docs — учредительные и редко меняющиеся документы: те же **подпапки по компании** внутри каталога
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

/**
 * Подпапки юрлиц на Drive внутри `_lena/templates`, `_lena/org-docs`, `_lena/founding-docs` (вариант A).
 * Ключ = `offerOrg` из Telegram (`/tenderkp`). Значение = имя каталога (латиница).
 * @type {Record<"gs_retail" | "finselvat", string>}
 */
export const LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG = {
  gs_retail: "gs-retail",
  finselvat: "finselvat",
};

/**
 * Уникальные имена подпапок компаний (для `workspace-ensure`).
 * @returns {string[]}
 */
export function lenaCompanyDriveSubfolderNames() {
  return [...new Set(Object.values(LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG))];
}

/**
 * @param {string} offerOrgKey
 * @returns {string | undefined}
 */
export function lenaCompanyFolderName(offerOrgKey) {
  return LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG[/** @type {"gs_retail" | "finselvat"} */ (offerOrgKey)];
}

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
