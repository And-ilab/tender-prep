import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cardRequiresCustomerRequest,
  classifyInputAttachmentSet,
  formatCustomerDocRequestMessage,
  pickProvisionEmail,
  pickProvisionMethod,
  resolvePostExtractProvisionGate,
  resolveProvisionGate,
} from "./competitiveDocsProvision.js";

const BELAPB_TERMS =
  "Конкурсные документы выдаются Заказчиком участнику конкурса на русском языке бесплатно до конечного срока подачи конкурсных предложений при условии поступления от Участника письменного запроса, подписанного руководителем, одним из следующих способов: по электронной почте на адрес tender2@belapb.by с приложением файла в формате pdf; нарочным способом от представителя Участника";

const MAZ_SUBJECT =
  "Документы и техническое задание по процедуре проведения конкурса можно получить по запросу на электронную почту uit-zakupki@maz.by";

const MAZ_ISSUANCE =
  "Выдача конкурсных документов: до 15ч.00мин. (минское время) 18.06.2026г.; Конкурсные документы предоставляются: в электронном виде - .PDF после получения письменного запроса на электронную почту - uit-zakupki@maz.by ;";

function snapWithTerms(terms, emails = ["tender2@belapb.by"]) {
  return {
    emails,
    structured: {
      competitiveDocuments: {
        provisionTerms: terms,
      },
    },
  };
}

function snapMazLabeledFields() {
  return {
    emails: ["uit-zakupki@maz.by"],
    labeledFields: {
      "Краткое описание предмета закупки": MAZ_SUBJECT,
      "Выдача конкурсных документов": MAZ_ISSUANCE,
    },
  };
}

describe("cardRequiresCustomerRequest", () => {
  it("detects email + in-person request from belapb example", () => {
    assert.equal(cardRequiresCustomerRequest(snapWithTerms(BELAPB_TERMS)), true);
  });

  it("returns false when provision terms missing", () => {
    assert.equal(cardRequiresCustomerRequest({ structured: {} }), false);
  });

  it("detects MAZ text from labeledFields without provisionTerms", () => {
    assert.equal(cardRequiresCustomerRequest(snapMazLabeledFields()), true);
  });

  it("detects request on electronic mail phrasing without written request", () => {
    const t = "Документы можно получить по запросу на электронную почту zakupki@example.by";
    assert.equal(cardRequiresCustomerRequest(snapWithTerms(t, ["zakupki@example.by"])), true);
  });
});

describe("pickProvisionMethod", () => {
  it("prefers email when both email and in-person mentioned", () => {
    assert.equal(pickProvisionMethod(BELAPB_TERMS, ["tender2@belapb.by"]), "email");
  });

  it("picks in_person without email", () => {
    const t = "Документы выдаются при условии поступления письменного запроса нарочным способом";
    assert.equal(pickProvisionMethod(t), "in_person");
  });
});

describe("pickProvisionEmail", () => {
  it("extracts email from text", () => {
    assert.equal(pickProvisionEmail(BELAPB_TERMS), "tender2@belapb.by");
  });
});

describe("classifyInputAttachmentSet", () => {
  it("empty when only snapshot artifact", () => {
    assert.equal(classifyInputAttachmentSet(["icetrade-import-snapshot.json"]), "empty");
  });

  it("sample_only for single sample request file", () => {
    assert.equal(
      classifyInputAttachmentSet(["Образец заявления на получение конкурсных документов.docx"]),
      "sample_only",
    );
  });

  it("full_documentation for notice + tz", () => {
    assert.equal(
      classifyInputAttachmentSet(["Извещение о закупке.pdf", "Техническое задание.docx"]),
      "full_documentation",
    );
  });

  it("full_documentation when sample plus full kd", () => {
    assert.equal(
      classifyInputAttachmentSet([
        "Образец заявления.docx",
        "Конкурсная документация.pdf",
      ]),
      "full_documentation",
    );
  });
});

describe("formatCustomerDocRequestMessage", () => {
  it("includes email and drive link", () => {
    const msg = formatCustomerDocRequestMessage({
      method: "email",
      email: "tender2@belapb.by",
      inputsFolderWebViewLink: "https://drive.google.com/folder/abc",
      provisionExcerpt: "Выдача конкурсных документов: до 15ч.00мин. 18.06.2026",
    });
    assert.match(msg, /tender2@belapb\.by/);
    assert.match(msg, /drive\.google\.com/);
    assert.match(msg, /Порядок выдачи/);
  });
});

describe("resolveProvisionGate", () => {
  it("blocks analyze when card requires request and no files", () => {
    const gate = resolveProvisionGate({
      snap: snapWithTerms(BELAPB_TERMS),
      uploadedNames: [],
      inputsFolderWebViewLink: "https://drive.google.com/folder/x",
    });
    assert.equal(gate.importAction, "block_analyze");
    assert.equal(gate.attachmentClass, "empty");
    assert.ok(gate.message);
  });

  it("continues analyze when attachments exist", () => {
    const gate = resolveProvisionGate({
      snap: snapWithTerms(BELAPB_TERMS),
      uploadedNames: ["sample.docx"],
    });
    assert.equal(gate.importAction, "continue_analyze");
  });

  it("normal when card does not require request", () => {
    const gate = resolveProvisionGate({
      snap: { structured: { competitiveDocuments: { provisionTerms: "Документы размещены на сайте" } } },
      uploadedNames: [],
    });
    assert.equal(gate.importAction, "normal");
  });

  it("blocks analyze for MAZ with empty inputs", () => {
    const gate = resolveProvisionGate({
      snap: snapMazLabeledFields(),
      uploadedNames: ["icetrade-import-snapshot.json"],
      inputsFolderWebViewLink: "https://drive.google.com/folder/maz",
    });
    assert.equal(gate.importAction, "block_analyze");
    assert.equal(gate.email, "uit-zakupki@maz.by");
    assert.match(gate.message ?? "", /uit-zakupki@maz\.by/);
    assert.match(gate.message ?? "", /Порядок выдачи/);
  });
});

describe("resolvePostExtractProvisionGate", () => {
  it("shows request after extract when only sample", () => {
    const gate = resolvePostExtractProvisionGate({
      snap: snapWithTerms(BELAPB_TERMS),
      fileNames: ["Запрос на предоставление тендерных документов.docx"],
      inputsFolderWebViewLink: "https://drive.google.com/folder/y",
    });
    assert.equal(gate.postExtractAction, "show_request_and_wait");
    assert.ok(gate.message);
  });

  it("normal when full kd despite card text", () => {
    const gate = resolvePostExtractProvisionGate({
      snap: snapWithTerms(BELAPB_TERMS),
      fileNames: ["Извещение.pdf", "ТЗ.docx"],
    });
    assert.equal(gate.postExtractAction, "normal");
    assert.equal(gate.message, null);
  });
});
