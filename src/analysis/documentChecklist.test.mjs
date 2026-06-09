import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequiredDocumentsList,
  isExplicitConformityDeclarationRequirement,
  isExplicitReferenceListRequirement,
  isKpEmbeddedChecklistItem,
  shouldIncludeChecklistItem,
} from "./documentChecklist.js";
import { normalizeToCanonicalDocument } from "./canonicalDocumentTypes.js";

describe("isKpEmbeddedChecklistItem", () => {
  it("flags payment terms and warranty as KP-embedded", () => {
    assert.equal(isKpEmbeddedChecklistItem({ id: "payment_terms" }), true);
    assert.equal(isKpEmbeddedChecklistItem({ id: "warranty_letter" }), true);
    assert.equal(isKpEmbeddedChecklistItem({ id: "commercial_proposal" }), false);
  });
});

describe("isExplicitReferenceListRequirement", () => {
  it("requires explicit reference list wording", () => {
    assert.equal(
      isExplicitReferenceListRequirement({
        name: "Референс-лист",
        evidence: "участник представляет референс-лист выполненных работ",
      }),
      true,
    );
    assert.equal(
      isExplicitReferenceListRequirement({
        name: "Опыт выполнения аналогичных работ",
        evidence: "наличие опыта выполнения аналогичных контрактов",
      }),
      false,
    );
  });
});

describe("isExplicitConformityDeclarationRequirement", () => {
  it("requires explicit declaration of conformity wording", () => {
    assert.equal(
      isExplicitConformityDeclarationRequirement({
        name: "Декларации соответствия",
        evidence: "копии деклараций соответствия на оборудование",
      }),
      true,
    );
    assert.equal(
      isExplicitConformityDeclarationRequirement({
        name: "Документы, указанные в техническом задании",
        evidence: "документы, указанные в техническом задании",
      }),
      false,
    );
  });
});

describe("shouldIncludeChecklistItem", () => {
  it("excludes KP-embedded documents", () => {
    const n = normalizeToCanonicalDocument("Условия оплаты");
    assert.equal(shouldIncludeChecklistItem({ name: "Условия оплаты" }, n), false);
  });

  it("excludes reference list without explicit wording", () => {
    const n = normalizeToCanonicalDocument("Опыт выполнения аналогичных работ");
    assert.equal(
      shouldIncludeChecklistItem(
        { name: "Опыт выполнения аналогичных работ", evidence: "аналогичный опыт" },
        n,
      ),
      false,
    );
  });

  it("excludes conformity declarations without explicit wording", () => {
    const n = normalizeToCanonicalDocument("Декларации соответствия");
    assert.equal(
      shouldIncludeChecklistItem(
        { name: "Документы по ТЗ", evidence: "документы, указанные в техническом задании" },
        n,
      ),
      false,
    );
  });
});

describe("buildRequiredDocumentsList", () => {
  it("drops payment terms and warranty even when LLM returns them", () => {
    const list = buildRequiredDocumentsList({
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      lenaCanPrepare: [
        { name: "Техническое предложение", basis: "п.3.2" },
        { name: "Условия оплаты", basis: "п.3.2" },
        { name: "Гарантийные обязательства", basis: "п.3.2" },
      ],
      managerMustProvide: [],
    });
    const ids = list.map((d) => d.id);
    assert.ok(!ids.includes("payment_terms"));
    assert.ok(!ids.includes("warranty_letter"));
    assert.ok(ids.includes("technical_proposal"));
  });

  it("drops reference list without explicit reference wording", () => {
    const list = buildRequiredDocumentsList({
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      lenaCanPrepare: [],
      managerMustProvide: [
        {
          name: "Опыт выполнения аналогичных работ",
          reason: "квалификация",
          criteria: null,
        },
      ],
    });
    assert.ok(!list.some((d) => d.id === "reference_list"));
  });

  it("keeps reference list with explicit wording", () => {
    const list = buildRequiredDocumentsList({
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      lenaCanPrepare: [],
      managerMustProvide: [
        {
          name: "Референс-лист",
          reason: "п.3.2",
          criteria: null,
        },
      ],
    });
    assert.ok(list.some((d) => d.id === "reference_list"));
  });

  it("drops conformity declarations without explicit wording", () => {
    const list = buildRequiredDocumentsList({
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      lenaCanPrepare: [],
      managerMustProvide: [
        {
          name: "Документы, указанные в техническом задании",
          reason: "п.3.2",
          criteria: null,
        },
      ],
    });
    assert.ok(!list.some((d) => d.id === "conformity_declarations"));
  });

  it("keeps certificate of origin when normalized from non-CIS clause", () => {
    const list = buildRequiredDocumentsList({
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      lenaCanPrepare: [],
      managerMustProvide: [
        {
          name: "Сертификат о происхождении товара",
          reason: "п.3.2",
          criteria: null,
        },
      ],
    });
    assert.ok(list.some((d) => d.id === "certificate_of_origin"));
  });
});
