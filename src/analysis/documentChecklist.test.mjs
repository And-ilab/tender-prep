import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequiredDocumentsList,
  corpusMentionsCommercialProposal,
  corpusRequiresNonCisOriginCertificate,
  filterPreOrgChecklistDocuments,
  formatDocumentCompositionStep1Telegram,
  formatQualificationRequirementsTelegram,
  formatQualificationRequirementTelegramBlock,
  parseQualificationConfirmation,
  dedupeQualificationRequirements,
  splitMergedQualificationRequirements,
  filterStep1SubmissionDocuments,
  documentCoveredByQualificationProof,
  collectQualificationProofLabels,
  looksLikeQualificationProofDocumentItem,
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
            "Опыт на рынке IT/ИИ не менее 3 лет; не менее 3 проектов с ИИ по 180 000 BYN либо один проект от 540 000 BYN",
          evidence:
            "опыт работы на рынке информационных технологий не менее 3 лет, не менее 3 проектов с договорами и актами выполненных работ стоимостью не менее 180000 белорусских рублей либо один проект не менее 540000",
          criteriaNumbers: "180000; 540000; 3 проекта",
          confirmationDocuments: ["копии договоров", "акты выполненных работ"],
        },
        {
          summary:
            "В штате не менее 2 специалистов с высшим образованием, опытом коммерческой разработки от 5 лет и участием в 2+ проектах с ИИ",
          evidence:
            "наличие в штате не менее двух работников с высшим техническим образованием, опытом коммерческой разработки не менее 5 лет, опытом участия не менее чем в 2 проектах с применением технологий искусственного интеллекта с предоставлением копий дипломов о высшем образовании, резюме специалистов, а также информации, подтверждающей их опыт (выписки из трудовых книжек или проектная документация)",
          confirmationDocuments: [
            "копии дипломов о высшем образовании",
            "резюме специалистов",
            "выписки из трудовых книжек или проектная документация",
          ],
        },
      ],
      lenaCanPrepare: [],
      managerMustProvide: [],
    };
    const text = formatQualificationRequirementsTelegram(structured);
    assert.match(text, /Требования к квалификации/);
    assert.match(text, /180 000|180000/);
    assert.match(text, /\[.*540000.*\]/);
    assert.match(text, /дипломов о высшем образовании/);
    assert.match(text, /подтвердить документами/);
    assert.match(text, /- копии дипломов/);
    assert.doesNotMatch(text, /референс-лист/i);
  });

  it("parses confirmation documents from evidence when LLM omitted confirmationDocuments", () => {
    const parsed = parseQualificationConfirmation(
      "наличие в штате не менее двух работников с высшим техническим образованием с предоставлением копий дипломов о высшем образовании, резюме специалистов, а также выписки из трудовых книжек",
    );
    assert.match(parsed.criterionShort, /штате не менее двух/i);
    assert.ok(parsed.confirmationDocuments.length >= 2);
    const block = formatQualificationRequirementTelegramBlock({
      summary: parsed.criterionShort,
      evidence:
        "наличие в штате не менее двух работников с высшим техническим образованием с предоставлением копий дипломов о высшем образовании, резюме специалистов, а также выписки из трудовых книжек",
    });
    assert.match(block, /\[.*штате не менее двух.*\]:/);
    assert.match(block, /• .*дипломов/);
  });

  it("dedupes repeated qualification items with same evidence", () => {
    const item = {
      summary: "Кадры с опытом ИИ",
      evidence: "не менее двух работников с опытом участия в проектах с ИИ",
    };
    const deduped = dedupeQualificationRequirements([item, item, item]);
    assert.equal(deduped.length, 1);
  });

  it("splits merged experience and staff qualification criteria", () => {
    const merged = {
      summary:
        "Опыт на рынке IT не менее 3 лет и наличие в штате не менее двух работников с высшим образованием",
      evidence:
        "опыт работы на рынке информационных технологий не менее 3 (трех) лет, наличие в штате не менее двух работников с высшим техническим образованием с предоставлением копий дипломов",
    };
    const split = splitMergedQualificationRequirements([merged]);
    assert.equal(split.length, 2);
  });

  it("1352058 step1 excludes qual-proof docs from Кроме того к подаче", () => {
    const cp = { ...normalizeToCanonicalDocument("Коммерческое предложение"), source: "lena" };
    const reg = {
      ...normalizeToCanonicalDocument("Свидетельство о государственной регистрации"),
      source: "manager",
    };
    const poa = { ...normalizeToCanonicalDocument("Доверенность на подачу"), source: "manager" };
    const compliance = {
      ...normalizeToCanonicalDocument("Заявление о соответствии требованиям"),
      source: "manager",
    };
    const resume = {
      ...normalizeToCanonicalDocument("Резюме специалистов"),
      source: "manager",
    };
    const labor = {
      ...normalizeToCanonicalDocument("Выписки из трудовых книжек"),
      source: "manager",
    };
    const structured = {
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      qualificationRequirements: [
        {
          summary: "В штате не менее 2 специалистов с опытом ИИ",
          evidence:
            "наличие в штате не менее двух работников с предоставлением копий дипломов, резюме специалистов, выписки из трудовых книжек",
          confirmationDocuments: [
            "копии дипломов о высшем образовании",
            "резюме специалистов",
            "выписки из трудовых книжек",
          ],
        },
      ],
      lenaCanPrepare: [{ name: "Коммерческое предложение", basis: "п.3.2", evidence: "коммерческое предложение" }],
      managerMustProvide: [
        { name: "Свидетельство о государственной регистрации", reason: "п.3.2", criteria: "—", evidence: "свидетельство о государственной регистрации" },
        { name: "Доверенность на подачу", reason: "п.3.2", criteria: "—", evidence: "доверенность" },
        { name: "Заявление о соответствии требованиям", reason: "п.3.2", criteria: "—", evidence: "заявление о соответствии требованиям" },
        { name: "Резюме специалистов", reason: "квалификация", criteria: "—", evidence: "резюме специалистов" },
        { name: "Выписки из трудовых книжек", reason: "квалификация", criteria: "—", evidence: "выписки из трудовых книжек" },
      ],
    };
    const required = [cp, reg, poa, compliance, resume, labor];
    assert.equal(documentCoveredByQualificationProof(resume, collectQualificationProofLabels(structured)), true);
    assert.equal(filterStep1SubmissionDocuments(required, structured).length, 4);
    const text = formatDocumentCompositionStep1Telegram(structured, required, undefined);
    assert.match(text, /Кроме того к подаче/);
    assert.match(text, /Коммерческое предложение/);
    assert.match(text, /Свидетельство о государственной регистрации/);
    assert.doesNotMatch(text, /К подаче:/);
    assert.doesNotMatch(text, /\n- Резюме специалистов/);
    assert.doesNotMatch(text, /\n- Выписки из трудовых книжек/);
  });

  it("drops confirmation-only qualification duplicates into proof documents section", () => {
    const structured = {
      tenderTitle: null,
      sumOrBudget: null,
      submissionOverview: null,
      submissionMethod: null,
      submissionDeadline: null,
      qualificationRequirements: [
        {
          summary: "Опыт на рынке IT/ИИ ≥3 лет; 3 проекта ≥180k BYN",
          evidence: "опыт работы на рынке информационных технологий не менее 3 лет",
          confirmationDocuments: ["копии договоров", "акты выполненных работ"],
        },
        {
          summary:
            "Факт реализации подтверждается копиями договоров и актов выполненных работ",
          evidence:
            "факт реализации и внедрения подтверждается копиями договоров и актов выполненных работ",
        },
        {
          summary:
            "Предоставление копий дипломов, резюме специалистов, выписки из трудовых книжек",
          evidence:
            "с предоставлением копий дипломов о высшем образовании, резюме специалистов, а также выписки из трудовых книжек",
        },
      ],
      lenaCanPrepare: [],
      managerMustProvide: [],
    };
    const text = formatQualificationRequirementsTelegram(structured);
    assert.match(text, /^1\. /m);
    assert.doesNotMatch(text, /^2\. Факт реализации/m);
    assert.match(text, /подтвердить документами/);
    assert.match(text, /- .*договор/);
    assert.match(text, /- .*резюме/i);
  });

  it("relocateQualificationMislabels moves qual-proof other items out of managerMustProvide", () => {
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
          name: "Резюме специалистов",
          reason: "квалификация",
          criteria: "—",
          evidence: "резюме специалистов с опытом участия не менее чем в 2 проектах с ИИ",
        },
      ],
    });
    assert.equal(structured.managerMustProvide.length, 0);
    assert.equal(structured.qualificationRequirements.length, 1);
    assert.ok(looksLikeQualificationProofDocumentItem({ name: "Резюме специалистов", evidence: "резюме квалификация штат" }));
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

  it("step 1 shows Кроме того к подаче including org-bound documents", () => {
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
    assert.match(text, /Кроме того к подаче/);
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
