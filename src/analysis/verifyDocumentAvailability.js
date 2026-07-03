import { findChildFolderId } from "../drive/folders.js";
import { getMetadata, listChildren } from "../drive/ops.js";
import { LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG } from "../drive/layoutConstants.js";
import { ensureLenaTree, ensureTenderTree } from "../drive/workspace.js";
import { normalizeToCanonicalDocument } from "./canonicalDocumentTypes.js";
import { attachmentSlugForDocId } from "./ensureDocumentUploadTargets.js";
import {
  computeLastReportingQuarterHint,
  extractAndIdentifyDriveFile,
  findFileForCanonicalId,
  isReportingPeriodValid,
} from "./identifyUploadedDocuments.js";
import { fileMatchesCanonicalType, resolveDocumentFormSource } from "./resolveDocumentFormSource.js";
import { checklistDebug714167 } from "../debug/checklistDebug714167.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** @typedef {"found_org" | "found_org_valid" | "found_org_expired" | "found_org_unparsed" | "found_founding" | "found_tender" | "form_customer" | "form_template" | "lena_draft" | "missing"} VerifyStatus */

/**
 * @typedef {Object} DocumentVerifyResult
 * @property {VerifyStatus} status
 * @property {string} canonicalId
 * @property {string} title
 * @property {string} [fileName]
 * @property {string} [webViewLink]
 * @property {string} [note]
 * @property {string} [documentDateIso]
 */

const PERIODIC_ORG_IDS = new Set(["bank_reference", "balance_sheet", "income_statement"]);
const ORG_INDEX_SCOPE = ["bank_reference", "balance_sheet", "income_statement", "reliability_letter"];

/**
 * @param {Map<string, import("./identifyUploadedDocuments.js").IdentifiedDocument>} index
 * @param {{ id?: string, name?: string, mimeType?: string }} file
 * @param {string[]} scopeIds
 */
async function ensureFileInIndex(index, file, scopeIds) {
  const id = String(file.id ?? "");
  if (!id) return undefined;
  const cached = index.get(id);
  if (cached) return cached;
  const identified = await extractAndIdentifyDriveFile(id, String(file.name ?? ""), file.mimeType, {
    scopeIds,
  });
  index.set(id, identified);
  return identified;
}
const FORM_DRAFT_ORG_IDS = new Set(["reliability_letter"]);

/**
 * @param {import("./documentChecklist.js").NormalizedDoc} doc
 * @param {import("./documentChecklist.js").AnalysisStructured} structured
 */
export function isLenaPreparedChecklistItem(doc, structured) {
  const lenaFromAnalysis = new Set(
    structured.lenaCanPrepare.map((x) => {
      const n = normalizeToCanonicalDocument(String(x.name ?? "").trim());
      return n.id !== "other" ? n.id : `other:${n.rawName}`;
    }),
  );
  const key = doc.id !== "other" ? doc.id : `other:${doc.rawName}`;
  const fromLena =
    doc.source === "lena" || lenaFromAnalysis.has(key) || doc.preparedByDefault === "lena";
  return fromLena && doc.preparedByDefault !== "manager";
}

/**
 * @param {import("./documentChecklist.js").NormalizedDoc} doc
 * @param {DocumentVerifyResult} verify
 * @param {import("./documentChecklist.js").AnalysisStructured} structured
 */
export function shouldShowInLenaPrepareBlock(doc, verify, structured) {
  if (isLenaPreparedChecklistItem(doc, structured)) return true;
  if (
    FORM_DRAFT_ORG_IDS.has(doc.id) &&
    (verify.status === "form_customer" ||
      verify.status === "form_template" ||
      verify.status === "lena_draft")
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} parentFolderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 */
async function listCompanySubfolderFiles(parentFolderId, offerOrg) {
  const subName = LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG[offerOrg];
  const companyFolderId = await findChildFolderId(parentFolderId, subName);
  if (!companyFolderId) return [];
  const items = await listChildren(companyFolderId);
  return items.filter((f) => f.mimeType !== FOLDER_MIME);
}

/**
 * @param {{ name?: string, id?: string, mimeType?: string }[]} files
 * @param {string} canonicalId
 */
export function findMatchingDriveFile(files, canonicalId) {
  for (const f of files) {
    const name = String(f.name ?? "");
    const id = String(f.id ?? "");
    if (!id) continue;
    if (fileMatchesCanonicalType(name, canonicalId) || name.toLowerCase().startsWith(`${canonicalId}__`)) {
      return { id, name };
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function extractFirstDateIso(text) {
  const s = String(text ?? "");
  const dmy = s.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    return `${dmy[3]}-${mm}-${dd}`;
  }
  const ymd = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  return null;
}

/**
 * @param {string | null | undefined} submissionDeadline
 * @returns {string | null}
 */
export function computeBankReferenceMaxDateIso(submissionDeadline) {
  const raw = String(submissionDeadline ?? "").trim();
  if (!raw) return null;
  const iso = extractFirstDateIso(raw);
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const prev = m === 0 ? { year: y - 1, month: 11 } : { year: y, month: m - 1 };
  const mm = String(prev.month + 1).padStart(2, "0");
  return `${prev.year}-${mm}-01`;
}

/**
 * @param {string | null | undefined} documentDateIso
 * @param {string | null | undefined} maxDateIso
 */
export function isBankReferenceDateValid(documentDateIso, maxDateIso) {
  if (!documentDateIso || !maxDateIso) return null;
  return documentDateIso <= maxDateIso;
}

/**
 * @param {string} fileId
 */
async function fileMetaLink(fileId) {
  const meta = await getMetadata(fileId).catch(() => null);
  return {
    webViewLink: typeof meta?.webViewLink === "string" ? meta.webViewLink : undefined,
  };
}

/**
 * @param {import("./identifyUploadedDocuments.js").IdentifiedDocument | undefined} identified
 * @param {string} fileName
 */
function metadataFromIdentified(identified, fileName) {
  return {
    documentDateIso: identified?.documentDateIso ?? extractFirstDateIso(fileName),
    reportingPeriod: identified?.reportingPeriod ?? null,
    needsReview: identified?.needsReview ?? false,
  };
}

/**
 * @param {import("./documentChecklist.js").NormalizedDoc} doc
 * @param {{ id: string, name: string }} match
 * @param {import("./identifyUploadedDocuments.js").IdentifiedDocument | undefined} identified
 * @param {{ bankReferenceDateRule?: { summary?: string; computedDeadlineHint?: string } | null, balanceSheetPeriodRule?: { summary?: string; computedPeriodHint?: string } | null, submissionDeadline?: string | null }} ctx
 * @returns {Promise<DocumentVerifyResult>}
 */
async function verifyPeriodicOrgDocument(doc, match, identified, ctx) {
  const base = { canonicalId: doc.id, title: doc.title };
  const { webViewLink } = await fileMetaLink(match.id);
  const meta = metadataFromIdentified(identified, match.name);

  if (doc.id === "bank_reference") {
    const maxDate =
      ctx.bankReferenceDateRule?.computedDeadlineHint ??
      computeBankReferenceMaxDateIso(ctx.submissionDeadline);
    const docDate = meta.documentDateIso;

    if (!maxDate) {
      return {
        status: "found_org",
        ...base,
        fileName: match.name,
        webViewLink,
        note: docDate ? `дата на документе: ${docDate}` : "сверьте дату по КД вручную",
        documentDateIso: docDate ?? undefined,
      };
    }
    if (!docDate) {
      return {
        status: "found_org_unparsed",
        ...base,
        fileName: match.name,
        webViewLink,
        note: "файл есть; нужен OCR/текст для проверки даты справки",
      };
    }
    const valid = isBankReferenceDateValid(docDate, maxDate);
    if (valid === true) {
      return {
        status: "found_org_valid",
        ...base,
        fileName: match.name,
        webViewLink,
        documentDateIso: docDate,
        note: `дата ${docDate}, крайняя по КД: ${maxDate}`,
      };
    }
    if (valid === false) {
      return {
        status: "found_org_expired",
        ...base,
        fileName: match.name,
        webViewLink,
        documentDateIso: docDate,
        note: `дата ${docDate} позже ${maxDate} — запросите новую справку в банк`,
      };
    }
    return { status: "found_org", ...base, fileName: match.name, webViewLink };
  }

  const periodRule =
    doc.id === "balance_sheet"
      ? ctx.balanceSheetPeriodRule
      : doc.id === "income_statement"
        ? ctx.incomeStatementPeriodRule
        : null;
  const expectedPeriod =
    periodRule?.computedPeriodHint ?? computeLastReportingQuarterHint(ctx.submissionDeadline);

  if (!meta.reportingPeriod && !meta.documentDateIso && meta.needsReview) {
    return {
      status: "found_org_unparsed",
      ...base,
      fileName: match.name,
      webViewLink,
      note: "файл есть; нужен OCR для проверки отчётного периода",
    };
  }

  const periodOk = isReportingPeriodValid(meta.reportingPeriod, expectedPeriod, periodRule);
  if (periodOk === false) {
    return {
      status: "found_org_expired",
      ...base,
      fileName: match.name,
      webViewLink,
      note: `период ${meta.reportingPeriod ?? meta.documentDateIso} не подходит — запросите актуальный баланс у менеджера`,
      documentDateIso: meta.documentDateIso ?? undefined,
    };
  }
  if (periodOk === true || !expectedPeriod) {
    return {
      status: periodOk === true ? "found_org_valid" : "found_org",
      ...base,
      fileName: match.name,
      webViewLink,
      note: meta.reportingPeriod
        ? `период: ${meta.reportingPeriod}`
        : meta.documentDateIso
          ? `дата: ${meta.documentDateIso}`
          : undefined,
      documentDateIso: meta.documentDateIso ?? undefined,
    };
  }

  return {
    status: "found_org_unparsed",
    ...base,
    fileName: match.name,
    webViewLink,
    note: "не удалось определить отчётный период — проверьте вручную",
  };
}

/**
 * @param {import("./documentChecklist.js").NormalizedDoc} doc
 * @param {{ name?: string, id?: string, mimeType?: string }[]} orgFiles
 * @param {Map<string, import("./identifyUploadedDocuments.js").IdentifiedDocument>} orgIndex
 * @param {object} ctx
 * @returns {Promise<DocumentVerifyResult>}
 */
async function verifyOrgDocument(doc, orgFiles, orgIndex, ctx) {
  const base = { canonicalId: doc.id, title: doc.title };
  const match =
    findFileForCanonicalId(orgFiles, orgIndex, doc.id) ?? findMatchingDriveFile(orgFiles, doc.id);
  if (!match) {
    return { status: "missing", ...base, note: "нет файла в lena/org-docs" };
  }
  let identified = orgIndex.get(match.id);
  if (PERIODIC_ORG_IDS.has(doc.id) && !identified) {
    const file = orgFiles.find((f) => String(f.id ?? "") === match.id);
    if (file) {
      identified = await ensureFileInIndex(orgIndex, file, ORG_INDEX_SCOPE);
    }
  }

  if (PERIODIC_ORG_IDS.has(doc.id)) {
    return verifyPeriodicOrgDocument(doc, match, identified, ctx);
  }

  const { webViewLink } = await fileMetaLink(match.id);
  return { status: "found_org", ...base, fileName: match.name, webViewLink };
}

/**
 * @param {import("./documentChecklist.js").NormalizedDoc} doc
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string, pickTemplateStrategy?: "best_match" | "most_complete" }} ctx
 * @returns {Promise<DocumentVerifyResult>}
 */
async function verifyOrgFormDraftFallback(doc, userRootId, offerOrg, ctx) {
  const base = { canonicalId: doc.id, title: doc.title };
  const form = await resolveDocumentFormSource(userRootId, offerOrg, doc, {
    inputFiles: ctx.inputFiles,
    corpus: ctx.corpus ?? "",
    pickTemplateStrategy: ctx.pickTemplateStrategy ?? "best_match",
  });
  if (form.formSource === "customer") {
    return {
      status: "form_customer",
      ...base,
      fileName: form.fileName,
      webViewLink: form.webViewLink,
      note: "форма заказчика в inputs",
    };
  }
  if (form.formSource === "template") {
    return {
      status: "form_template",
      ...base,
      fileName: form.fileName,
      webViewLink: form.webViewLink,
      note: "образец org в lena/templates",
    };
  }
  return {
    status: "lena_draft",
    ...base,
    note: "нужна форма в inputs или образец в lena/templates",
  };
}

/**
 * @param {import("./documentChecklist.js").NormalizedDoc} doc
 * @param {boolean} lenaPrepares
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ flat?: boolean, year?: string }} treeOpts
 * @param {object} ctx
 * @returns {Promise<DocumentVerifyResult>}
 */
export async function verifyDocumentItem(
  doc,
  lenaPrepares,
  userRootId,
  tenderId,
  offerOrg,
  treeOpts,
  ctx,
) {
  const base = { canonicalId: doc.id, title: doc.title };

  if (doc.storage === "org") {
    const result = await verifyOrgDocument(doc, ctx.orgFiles, ctx.orgIndex, ctx);
    if (FORM_DRAFT_ORG_IDS.has(doc.id) && result.status === "missing") {
      return verifyOrgFormDraftFallback(doc, userRootId, offerOrg, ctx);
    }
    return result;
  }

  if (doc.storage === "founding") {
    const match =
      findFileForCanonicalId(ctx.foundingFiles, ctx.foundingIndex, doc.id) ??
      findMatchingDriveFile(ctx.foundingFiles, doc.id);
    if (!match) {
      return { status: "missing", ...base, note: "нет файла в lena/founding-docs" };
    }
    const { webViewLink } = await fileMetaLink(match.id);
    return { status: "found_founding", ...base, fileName: match.name, webViewLink };
  }

  if (lenaPrepares) {
    return verifyOrgFormDraftFallback(doc, userRootId, offerOrg, ctx);
  }

  const tender = ctx.tender ?? (await ensureTenderTree(userRootId, tenderId, treeOpts)).tender;
  const slug = attachmentSlugForDocId(doc.id);
  const folderId = tender.attachmentsId ? await findChildFolderId(tender.attachmentsId, slug) : null;
  const files = folderId ? await listChildren(folderId) : [];
  const match = findMatchingDriveFile(
    files.filter((f) => f.mimeType !== FOLDER_MIME),
    doc.id,
  );
  if (!match) {
    return { status: "missing", ...base, note: "нет файла в attachments тендера" };
  }
  const { webViewLink } = await fileMetaLink(match.id);
  return { status: "found_tender", ...base, fileName: match.name, webViewLink };
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {import("./documentChecklist.js").NormalizedDoc[]} requiredDocuments
 * @param {import("./documentChecklist.js").AnalysisStructured} structured
 * @param {{ flat?: boolean, year?: string, inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string }} [opts]
 */
export async function verifyDocumentsForChecklist(
  userRootId,
  tenderId,
  offerOrg,
  requiredDocuments,
  structured,
  opts = {},
) {
  const treeOpts = { flat: opts.flat, year: opts.year };
  const { layout } = await ensureLenaTree(userRootId);

  const orgFiles = layout.orgDocsId
    ? await listCompanySubfolderFiles(layout.orgDocsId, offerOrg)
    : [];
  const foundingFiles = layout.foundingDocsId
    ? await listCompanySubfolderFiles(layout.foundingDocsId, offerOrg)
    : [];

  // #region agent log
  checklistDebug714167(
    "verifyDocumentAvailability.js:verifyDocumentsForChecklist",
    "drive file lists loaded",
    {
      tenderId,
      offerOrg,
      orgFileCount: orgFiles.length,
      foundingFileCount: foundingFiles.length,
    },
    "H1",
  );
  // #endregion

  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);

  let inputFiles = opts.inputFiles;
  if (!inputFiles?.length) {
    inputFiles = await listChildren(tender.inputsId);
  }

  /** @type {Map<string, import("./identifyUploadedDocuments.js").IdentifiedDocument>} */
  const orgIndex = new Map();
  /** @type {Map<string, import("./identifyUploadedDocuments.js").IdentifiedDocument>} */
  const foundingIndex = new Map();

  const ctx = {
    orgFiles,
    foundingFiles,
    orgIndex,
    foundingIndex,
    inputFiles,
    tender,
    corpus: opts.corpus ?? "",
    bankReferenceDateRule: structured.bankReferenceDateRule ?? null,
    balanceSheetPeriodRule: structured.balanceSheetPeriodRule ?? null,
    incomeStatementPeriodRule: structured.incomeStatementPeriodRule ?? null,
    submissionDeadline: structured.submissionDeadline ?? null,
  };

  /** @type {{ doc: import("./documentChecklist.js").NormalizedDoc, verify: DocumentVerifyResult }[]} */
  const out = [];
  const tVerify = Date.now();
  for (const doc of requiredDocuments) {
    const lenaPrepares = isLenaPreparedChecklistItem(doc, structured);
    const pickTemplateStrategy =
      doc.id === "budget_debt_statement" ? "most_complete" : "best_match";
    const verify = await verifyDocumentItem(doc, lenaPrepares, userRootId, tenderId, offerOrg, treeOpts, {
      ...ctx,
      pickTemplateStrategy,
    });
    out.push({ doc, verify });
  }
  // #region agent log
  checklistDebug714167(
    "verifyDocumentAvailability.js:verifyDocumentsForChecklist",
    "verify loop done",
    {
      tenderId,
      docCount: out.length,
      orgIndexSize: orgIndex.size,
      ms: Date.now() - tVerify,
    },
    "H1",
  );
  // #endregion
  return out;
}

/**
 * @param {VerifyStatus} status
 */
export function isVerifyStatusAlreadyHave(status) {
  return (
    status === "found_org" ||
    status === "found_org_valid" ||
    status === "found_founding" ||
    status === "found_tender"
  );
}

/**
 * @param {VerifyStatus} status
 */
export function isVerifyStatusNeedsUpload(status) {
  return status === "missing" || status === "found_org_expired" || status === "found_org_unparsed";
}

/**
 * @param {DocumentVerifyResult} verify
 */
export function formatVerifyTelegramSuffix(verify) {
  if (verify.webViewLink && verify.fileName) {
    return ` — [${verify.fileName}](${verify.webViewLink})`;
  }
  if (verify.note) return ` — _${verify.note}_`;
  return "";
}
