import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequiredDocumentsList,
  corpusMentionsCommercialProposal,
  corpusRequiresNonCisOriginCertificate,
  filterPreOrgChecklistDocuments,
  formatDocumentCompositionStep1Telegram,
  formatQualificationRequirementsTelegram,
  relocateQualificationMislabels,
  isExplicitComplianceStatementRequirement,
  isExplicitConformityDeclarationRequirement,
  isExplicitDealerRepresentativeRequirement,
  isExplicitReferenceListRequirement,
  isKpEmbeddedChecklistItem,
  isOrgBoundChecklistDocument,
  shouldIncludeChecklistItem,
} from "./documentChecklist.js";
import { shouldShowInLenaPrepareBlock } from "./verifyDocumentAvailability.js";
import { normalizeToCanonicalDocument } from "./canonicalDocumentTypes.js";

describe("isKpEmbeddedChecklistItem", () => {
  it("flags payment terms and warranty as KP-embedded", () => {
    assert.equal(isKpEmbeddedChecklistItem({ id: "payment_terms" }), true);
    assert.equal(isKpEmbeddedChecklistItem({ id: "warranty_letter" }), true);
    assert.equal(isKpEmbeddedChecklistItem({ id: "commercial_proposal" }), false);
  });
});

describe("isExplicitReferenceListRequirement", () => {
  it("requires reference list wording in evidence only", () => {
    assert.equal(
      isExplicitReferenceListRequirement({
        name: "Референс-лист",
        evidence: "участник представляет референс-лист выполненных работ",
      }),
      true,
    );
    assert.equal(
      isExplicitReferenceListRequirement({
        name: "Референс-лист",
        evidence: "дилерское соглашение, уполномочивающее на реализацию товара",
      }),
      false,
    );
    assert.equal(
      isExplicitReferenceListRequirement({
        name: "Опыт выполнения аналогичных работ",
        evidence: "наличие опыта выполнения аналогичных контрактов",
      }),
      false,
    );
    assert.equal(isExplicitReferenceListRequirement({ name: "Референс-лист" }), false);
  });
});

describe("isExplicitConformityDeclarationRequirement", () => {
  it("requires declaration wording in evidence only", () => {
    assert.equal(
      isExplicitConformityDeclarationRequirement({
        name: "Декларации соответствия",
        evidence: "копии деклараций соответствия на оборудование",
      }),
      true,
    );
    assert.equal(
      isExplicitConformityDeclarationRequirement({
        name: "Декларации соответствия",
        evidence: "документы, указанные в техническом задании",
      }),
      false,
    );
    assert.equal(isExplicitConformityDeclarationRequirement({ name: "Декларации соответствия" }), false);
  });
});

describe("corpusRequiresNonCisOriginCertificate", () => {
  it("detects non-CIS origin branch in corpus", () => {
    const snippet =
      "для товаров, происходящих из государств, не являющихся участниками Содружества Независимых Государств, сертификат о происхождении товара";
    assert.equal(corpusRequiresNonCisOriginCertificate(snippet), true);
    assert.equal(corpusRequiresNonCisOriginCertificate("коммерческое предложение участника"), false);
  });
});

describe("shouldIncludeChecklistItem", () => {
  it("excludes KP-embedded documents", () => {
    const n = normalizeToCanonicalDocument("Условия оплаты");
    assert.equal(shouldIncludeChecklistItem({ name: "Условия оплаты" }, n), false);
  });

  it("excludes reference list when evidence lacks reference wording", () => {
    const n = normalizeToCanonicalDocument("Референс-лист");
    assert.equal(
      shouldIncludeChecklistItem(
        {
          name: "Референс-лист",
          evidence: "дилерское соглашение, уполномочивающее на реализацию товара",
        },
        n,
      ),
      false,
    );
  });

  it("excludes reference list when KD offers contracts as alternative (1352058-like)", () => {
    const n = normalizeToCanonicalDocument("Референс-лист");
    assert.equal(
      shouldIncludeChecklistItem(
        {
          name: "Референс-лист",
          evidence:
            "референс-лист или копии договоров и актов выполненных работ стоимостью не менее 180000",
        },
        n,
      ),
      false,
    );
    assert.equal(
      shouldIncludeChecklistItem(
        {
          name: "Референс-лист",
          evidence: "не менее 3 проектов с договорами и актами выполненных работ",
        },
        n,
      ),
      false,
    );
  });

  it("excludes conformity declarations without explicit evidence wording", () => {
    const n = normalizeToCanonicalDocument("Декларации соответствия");
    assert.equal(
      shouldIncludeChecklistItem(
        { name: "Декларации соответствия", evidence: "документы, указанные в техническом задании" },
        n,
      ),
      false,
    );
  });

  it("excludes compliance statement without explicit evidence wording", () => {
    const n = normalizeToCanonicalDocument("Заявление о соответствии");
    assert.equal(
      shouldIncludeChecklistItem(
        { name: "Заявление о соответствии", evidence: "документы по п.3.2 конкурсной документации" },
        n,
      ),
      false,
    );
    assert.equal(
      isExplicitComplianceStatementRequirement({
        evidence: "заявление о соответствии требованиям конкурсной документации",
      }),
      true,
    );
  });

  it("excludes dealer docs when evidence is power of attorney only", () => {
    const n = normalizeToCanonicalDocument("Дилерское соглашение");
    assert.equal(
      shouldIncludeChecklistItem(
        { name: "Доверенность", evidence: "доверенность на подачу конкурсного предложения" },
        n,
      ),
      false,
    );
    assert.equal(
      isExplicitDealerRepresentativeRequirement({
        evidence: "дилерское соглашение с производителем оборудования",
      }),
      true,
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

  it("drops reference list when name says reference but evidence does not", () => {
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
          evidence: "дилерское соглашение, уполномочивающее на реализацию товара со сроком действия",
        },
      ],
    });
    assert.ok(!list.some((d) => d.id === "reference_list"));
  });

  it("keeps reference list when evidence contains reference list wording", () => {
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
          evidence: "участник представляет референс-лист выполненных работ за последние три года",
        },
      ],
    });
    assert.ok(list.some((d) => d.id === "reference_list"));
  });

  it("drops conformity declarations when evidence lacks declaration wording", () => {
    const list = buildRequiredDocumentsList({
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      lenaCanPrepare: [],
      managerMustProvide: [
        {
          name: "Декларации соответствия",
          reason: "п.3.2",
          criteria: null,
          evidence: "документы, указанные в техническом задании для закупки оборудования",
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

  it("auto-injects certificate of origin from corpus when LLM missed it", () => {
    const corpus =
      "для товаров, происходящих из государств, не являющихся участниками Содружества Независимых Государств, сертификат о происхождении товара";
    const list = buildRequiredDocumentsList(
      {
        tenderTitle: null,
        sumOrBudget: null,
        submissionOverview: null,
        submissionMethod: null,
        submissionDeadline: null,
        lenaCanPrepare: [{ name: "Коммерческое предложение", basis: "п.3.2" }],
        managerMustProvide: [],
      },
      { corpus },
    );
    assert.ok(list.some((d) => d.id === "certificate_of_origin"));
  });

  it("does not auto-inject commercial proposal without corpus mention", () => {
    const list = buildRequiredDocumentsList({
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      lenaCanPrepare: [{ name: "Техническое предложение", basis: "п.3.2", evidence: "техническое предложение" }],
      managerMustProvide: [],
    });
    assert.ok(!list.some((d) => d.id === "commercial_proposal"));
  });

  it("adds commercial proposal when corpus mentions it", () => {
    assert.equal(corpusMentionsCommercialProposal("участник представляет коммерческое предложение"), true);
    const list = buildRequiredDocumentsList(
      {
        tenderTitle: null,
        sumOrBudget: null,
        submissionOverview: null,
        submissionMethod: null,
        submissionDeadline: null,
        lenaCanPrepare: [{ name: "Техническое предложение", basis: "п.2" }],
        managerMustProvide: [],
      },
      { corpus: "коммерческое предложение по форме приложения 1" },
    );
    assert.ok(list.some((d) => d.id === "commercial_proposal"));
  });
});

describe("formatQualificationRequirementsTelegram", () => {
  it("relocateQualificationMislabels moves mislabeled reference list to qualification", () => {
    const structured = relocateQualificationMislabels({
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      qualificationRequirements: [],
      lenaCanPrepare: [],
      managerMustProvide: [
        {
          name: "Референс-лист",
          reason: "подтверждение квалификации",
          criteria: "—",
          evidence:
            "не менее 3 проектов с договорами и актами выполненных работ стоимостью не менее 180000",
        },
      ],
    });
    assert.equal(structured.managerMustProvide.length, 0);
    assert.equal(structured.qualificationRequirements.length, 1);
    const list = buildRequiredDocumentsList(structured, {});
    assert.ok(!list.some((d) => d.id === "reference_list"));
    const text = formatQualificationRequirementsTelegram(structured);
    assert.match(text, /180000|180 000/);
  });

  it("renders 1352058-like qualification summaries without reference list title", () => {
    const structured = {
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      qualificationRequirements: [
        {
          summary:
            "Предоставить не менее 3 копий договоров и актов по проектам с ИИ; стоимость каждого не менее 180 000 бел. руб. либо один проект не менее 540 000 бел. руб.",
          evidence:
            "не менее 3 проектов с договорами и актами выполненных работ стоимостью не менее 180000 белорусских рублей либо один проект не менее 540000",
          criteriaNumbers: "180000; 540000; 3 проекта",
        },
      ],
      lenaCanPrepare: [],
      managerMustProvide: [],
    };
    const text = formatQualificationRequirementsTelegram(structured);
    assert.match(text, /Требования к квалификации/);
    assert.match(text, /180 000/);
    assert.doesNotMatch(text, /референс-лист/i);
  });
});

describe("pre-org checklist filtering", () => {
  it("flags org-bound documents and filters them from step 1", () => {
    const bank = normalizeToCanonicalDocument("Справка из банка");
    const tp = normalizeToCanonicalDocument("Техническое предложение");
    assert.equal(isOrgBoundChecklistDocument(bank), true);
    assert.equal(isOrgBoundChecklistDocument(tp), false);
    const filtered = filterPreOrgChecklistDocuments([
      { ...bank, source: "manager" },
      { ...tp, source: "lena" },
    ]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "technical_proposal");
  });

  it("step 1 shows full K podache list including org-bound documents", () => {
    const bank = { ...normalizeToCanonicalDocument("Справка из банка"), source: "manager" };
    const text = formatDocumentCompositionStep1Telegram(
      {
        tenderTitle: null,
        sumOrBudget: null,
        submissionOverview: null,
        submissionMethod: null,
        submissionDeadline: "15.03.2026",
        qualificationRequirements: [
          { summary: "Опыт не менее 3 лет в IT", evidence: "опыт работы в сфере IT не менее 3 лет" },
        ],
        bankReferenceDateRule: {
          summary: "не ранее 1-го числа месяца, предшествующего месяцу окончания приёма заявок",
          evidence: "справка из банка не ранее 1 числа месяца",
        },
        lenaCanPrepare: [],
        managerMustProvide: [{ name: "Справка из банка", reason: "п.3.2", criteria: "—", evidence: "справка из банка" }],
      },
      [bank],
      undefined,
    );
    assert.match(text, /Требования к квалификации/);
    assert.match(text, /Справка из банка/);
    assert.match(text, /не ранее 1-го числа/i);
    assert.match(text, /после выбора.*участника/i);
  });
});

describe("reliability_letter step2 routing", () => {
  it("shouldShowInLenaPrepareBlock for form_customer and form_template", () => {
    const doc = { ...normalizeToCanonicalDocument("Письмо о благонадёжности"), source: "manager" };
    const structured = {
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      qualificationRequirements: [],
      lenaCanPrepare: [],
      managerMustProvide: [],
    };
    assert.equal(
      shouldShowInLenaPrepareBlock(doc, { status: "form_customer", canonicalId: "reliability_letter", title: doc.title }, structured),
      true,
    );
    assert.equal(
      shouldShowInLenaPrepareBlock(doc, { status: "form_template", canonicalId: "reliability_letter", title: doc.title }, structured),
      true,
    );
    assert.equal(
      shouldShowInLenaPrepareBlock(doc, { status: "missing", canonicalId: "reliability_letter", title: doc.title }, structured),
      false,
    );
  });
});
