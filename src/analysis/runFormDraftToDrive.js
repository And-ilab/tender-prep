import { resolveDocumentFormSource } from "./resolveDocumentFormSource.js";
import { buildTenderDocumentFormattingPromptSection } from "./tenderDocumentFormattingPrompt.js";

/** @typedef {"application_form" | "budget_debt_statement" | "written_consent_contract" | "reliability_letter"} FormDraftCanonicalId */

/**
 * Каркас генерации форм: приоритет customer inputs → архив → org templates → missing.
 * Полное LLM-заполнение — отдельный шаг (как у КП).
 *
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ id: FormDraftCanonicalId, title: string, rawName?: string }} doc
 * @param {{ inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string, attachedFormHint?: string }} [opts]
 */
export async function runFormDraftToDrive(userRootId, offerOrg, doc, opts = {}) {
  const pickTemplateStrategy =
    doc.id === "budget_debt_statement" ? "most_complete" : "best_match";
  const form = await resolveDocumentFormSource(userRootId, offerOrg, doc, {
    ...opts,
    pickTemplateStrategy,
  });
  const hasFormSource = form.formSource !== "missing";
  return {
    ok: hasFormSource,
    form,
    message:
      form.formSource === "customer"
        ? "Заполнить форму заказчика из inputs"
        : form.formSource === "archive"
          ? "Адаптировать по образу из архива"
          : form.formSource === "template"
            ? "Адаптировать образец org из _lena/templates"
            : "Нет образца в КД и аналога в архиве",
    formattingPrompt: hasFormSource ? buildTenderDocumentFormattingPromptSection() : undefined,
  };
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string, attachedFormHint?: string }} opts
 */
export async function runApplicationFormDraftToDrive(userRootId, offerOrg, opts = {}) {
  return runFormDraftToDrive(
    userRootId,
    offerOrg,
    { id: "application_form", title: "Заявка на участие" },
    opts,
  );
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string }} opts
 */
export async function runBudgetDebtStatementDraftToDrive(userRootId, offerOrg, opts = {}) {
  return runFormDraftToDrive(
    userRootId,
    offerOrg,
    { id: "budget_debt_statement", title: "Заявление об отсутствии задолженности по платежам в бюджет" },
    opts,
  );
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string }} opts
 */
export async function runWrittenConsentDraftToDrive(userRootId, offerOrg, opts = {}) {
  return runFormDraftToDrive(
    userRootId,
    offerOrg,
    { id: "written_consent_contract", title: "Письменное согласие заключить договор" },
    opts,
  );
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string }} opts
 */
export async function runReliabilityLetterDraftToDrive(userRootId, offerOrg, opts = {}) {
  return runFormDraftToDrive(
    userRootId,
    offerOrg,
    { id: "reliability_letter", title: "Письмо о благонадёжности" },
    opts,
  );
}
