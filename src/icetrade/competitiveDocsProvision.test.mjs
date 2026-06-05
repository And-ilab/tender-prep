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

describe("cardRequiresCustomerRequest", () => {
  it("detects email + in-person request from belapb example", () => {
    assert.equal(cardRequiresCustomerRequest(snapWithTerms(BELAPB_TERMS)), true);
  });

  it("returns false when provision terms missing", () => {
    assert.equal(cardRequiresCustomerRequest({ structured: {} }), false);
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
    });
    assert.match(msg, /tender2@belapb\.by/);
    assert.match(msg, /drive\.google\.com/);
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
