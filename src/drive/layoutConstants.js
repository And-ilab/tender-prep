/** Корневая служебная папка внутри выбранного пользователем корня Диска. */
export const LENA_ROOT_FOLDER = "_lena";

/** Подпапки (латиница — меньше проблем с кодировками и API). */
export const LENA_SUB = {
  templates: "templates",
  context: "context",
  tenders: "tenders",
};

/** Внутри каждого тендера. */
export const TENDER_SUB = {
  inputs: "inputs",
  drafts: "drafts",
  exports: "exports",
};

/**
 * @param {string} tenderId
 */
export function tenderFolderName(tenderId) {
  const s = tenderId.trim().replace(/[\\/:*?"<>|]+/g, "_");
  const cut = s.slice(0, 120);
  return cut || "tender";
}
