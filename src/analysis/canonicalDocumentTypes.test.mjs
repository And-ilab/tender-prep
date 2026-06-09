import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeToCanonicalDocument } from "./canonicalDocumentTypes.js";
import {
  isManufacturerOnlyRequirement,
  isNonResidentOnlyRequirement,
  submissionDisplayTitle,
} from "./documentChecklist.js";

describe("normalizeToCanonicalDocument", () => {
  it("maps conformity declarations", () => {
    const r = normalizeToCanonicalDocument("Декларации соответствия");
    assert.equal(r.id, "conformity_declarations");
  });

  it("maps written consent variants", () => {
    const r = normalizeToCanonicalDocument("Заявление о согласии с условиями проекта договора");
    assert.equal(r.id, "written_consent_contract");
  });

  it("maps dealer representative docs from combined KD wording", () => {
    const r = normalizeToCanonicalDocument(
      "Документы, подтверждающие статус производителя или официального торгового представителя",
    );
    assert.equal(r.id, "dealer_representative_docs");
  });

  it("maps dealer agreement", () => {
    const r = normalizeToCanonicalDocument("Дилерское соглашение");
    assert.equal(r.id, "dealer_representative_docs");
  });

  it("maps state registration certificate", () => {
    const r = normalizeToCanonicalDocument("Свидетельство о государственной регистрации");
    assert.equal(r.id, "state_registration_certificate");
  });

  it("maps compliance statement", () => {
    const r = normalizeToCanonicalDocument("Заявление о соответствии");
    assert.equal(r.id, "compliance_statement");
  });

  it("maps certificate of origin from non-CIS clause", () => {
    const r = normalizeToCanonicalDocument(
      "сертификат о происхождении товара для государств, не являющихся участниками СНГ",
    );
    assert.equal(r.id, "certificate_of_origin");
  });
});

describe("isNonResidentOnlyRequirement", () => {
  it("filters trade register extract for residents", () => {
    assert.equal(
      isNonResidentOnlyRequirement({
        name: "Выписка из торгового реестра",
        evidence:
          "Копия свидетельства о государственной регистрации участника, для нерезидентов — выписка из торгового реестра",
      }),
      true,
    );
  });
});

describe("isManufacturerOnlyRequirement", () => {
  it("filters TPP certificate for manufacturers only", () => {
    assert.equal(
      isManufacturerOnlyRequirement({ name: "Справка ТПП для производителей" }),
      true,
    );
  });

  it("keeps combined producer or representative wording", () => {
    assert.equal(
      isManufacturerOnlyRequirement({
        name: "Документы, подтверждающие статус производителя или официального торгового представителя",
      }),
      false,
    );
  });
});

describe("submissionDisplayTitle", () => {
  it("shortens TZ document list placeholder", () => {
    const title = submissionDisplayTitle({
      id: "other",
      title: "long",
      rawName:
        "Документы, указанные в техническом задании (технических спецификациях) для закупки оборудования",
    });
    assert.equal(title, "Документы по техническому заданию");
  });
});
