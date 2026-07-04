import { getCanonicalTypeById } from "./canonicalDocumentTypes.js";
import {
  computeBankReferenceMaxDateIso,
  extractFirstDateIso,
  isBankReferenceDateValid,
} from "./verifyDocumentAvailability.js";
import { computeLastReportingQuarterHint, isReportingPeriodValid } from "./identifyUploadedDocuments.js";

const PERIODIC_ORG_IDS = new Set(["bank_reference", "balance_sheet", "income_statement"]);

/**
 * @typedef {Object} ValidationContext
 * @property {import("./documentChecklist.js").AnalysisStructured} [structured]
 * @property {string | null} [expectedCanonicalId]
 */

/**
 * @typedef {Object} ValidationResult
 * @property {"valid" | "needsReview" | "rejected"} status
 * @property {string} [note]
 * @property {string | null} [documentDateIso]
 * @property {string | null} [reportingPeriod]
 */

/**
 * @param {string | null | undefined} expiryIso
 * @param {string | null | undefined} submissionDeadline
 */
export function isPoaValidForSubmission(expiryIso, submissionDeadline) {
  if (!expiryIso) return null;
  const subIso = extractFirstDateIso(String(submissionDeadline ?? ""));
  if (!subIso) return true;
  return expiryIso >= subIso;
}

/**
 * @param {import("./identifyUploadedDocuments.js").IdentifiedDocument} identified
 * @param {ValidationContext} ctx
 * @returns {ValidationResult}
 */
export function validateIdentifiedDocument(identified, ctx = {}) {
  const canonicalId = identified.canonicalId;
  if (!canonicalId) {
    return { status: "rejected", note: "тип документа не распознан" };
  }
  if (ctx.expectedCanonicalId && ctx.expectedCanonicalId !== canonicalId) {
    return {
      status: "rejected",
      note: `ожидался ${getCanonicalTypeById(ctx.expectedCanonicalId)?.title ?? ctx.expectedCanonicalId}, распознан ${identified.title ?? canonicalId}`,
    };
  }

  const structured = ctx.structured;
  const submissionDeadline = structured?.submissionDeadline ?? null;

  if (canonicalId === "bank_reference") {
    const maxDate =
      structured?.bankReferenceDateRule?.computedDeadlineHint ??
      computeBankReferenceMaxDateIso(submissionDeadline);
    const docDate = identified.documentDateIso;
    if (!docDate) {
      return {
        status: identified.needsReview ? "needsReview" : "rejected",
        note: "не удалось определить дату справки",
        documentDateIso: docDate,
      };
    }
    if (!maxDate) {
      return { status: "needsReview", note: "сверьте дату справки по КД", documentDateIso: docDate };
    }
    const ok = isBankReferenceDateValid(docDate, maxDate);
    if (ok === false) {
      return {
        status: "rejected",
        note: `дата ${docDate} позже ${maxDate}`,
        documentDateIso: docDate,
      };
    }
    return {
      status: ok === true ? "valid" : "needsReview",
      documentDateIso: docDate,
      note: ok === true ? `дата ${docDate}, крайняя ${maxDate}` : undefined,
    };
  }

  if (canonicalId === "balance_sheet" || canonicalId === "income_statement") {
    const rule =
      canonicalId === "balance_sheet"
        ? structured?.balanceSheetPeriodRule
        : structured?.incomeStatementPeriodRule;
    const expected = rule?.computedPeriodHint ?? computeLastReportingQuarterHint(submissionDeadline);
    const periodOk = isReportingPeriodValid(identified.reportingPeriod, expected, rule);
    if (periodOk === false) {
      return {
        status: "rejected",
        note: `период ${identified.reportingPeriod ?? "—"} не подходит (ожидался ${expected ?? "—"})`,
        reportingPeriod: identified.reportingPeriod,
      };
    }
    if (!identified.reportingPeriod && identified.needsReview) {
      return { status: "needsReview", note: "нужен OCR для отчётного периода" };
    }
    return {
      status: periodOk === true || !expected ? "valid" : "needsReview",
      reportingPeriod: identified.reportingPeriod,
      documentDateIso: identified.documentDateIso,
    };
  }

  if (canonicalId === "power_of_attorney") {
    const expiryIso = identified.documentDateIso;
    const ok = isPoaValidForSubmission(expiryIso, submissionDeadline);
    if (ok === false) {
      return {
        status: "rejected",
        note: `доверенность истекает ${expiryIso}, раньше срока подачи`,
        documentDateIso: expiryIso,
      };
    }
    if (!expiryIso && identified.needsReview) {
      return { status: "needsReview", note: "не удалось определить срок действия доверенности" };
    }
    return {
      status: ok === true || expiryIso ? "valid" : "needsReview",
      documentDateIso: expiryIso,
    };
  }

  if (PERIODIC_ORG_IDS.has(canonicalId)) {
    return { status: identified.needsReview ? "needsReview" : "valid" };
  }

  const t = getCanonicalTypeById(canonicalId);
  if (t?.storage === "founding" || t?.storage === "org") {
    if (identified.needsReview && !identified.title) {
      return { status: "needsReview", note: "низкая уверенность OCR" };
    }
    return { status: "valid" };
  }

  return { status: identified.needsReview ? "needsReview" : "valid" };
}

/**
 * @param {import("./verifyDocumentAvailability.js").VerifyStatus} verifyStatus
 * @param {string} [canonicalId]
 */
export function verifyStatusIsValidForPackage(verifyStatus, canonicalId) {
  if (verifyStatus === "found_org_valid" || verifyStatus === "found_founding") return true;
  if (verifyStatus === "found_tender") return true;
  if (verifyStatus === "found_org") {
    if (!canonicalId) return true;
    return !PERIODIC_ORG_IDS.has(canonicalId) && canonicalId !== "power_of_attorney";
  }
  return false;
}
