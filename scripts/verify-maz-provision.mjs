/**
 * Локальная проверка gate для MAZ / Belapb / обычного тендера (без Telegram/Drive).
 * Запуск: node scripts/verify-maz-provision.mjs
 */
import {
  buildProvisionCorpus,
  resolveProvisionGate,
  resolvePostExtractProvisionGate,
} from "../src/icetrade/competitiveDocsProvision.js";

const MAZ_SUBJECT =
  "Документы и техническое задание по процедуре проведения конкурса можно получить по запросу на электронную почту uit-zakupki@maz.by";
const MAZ_ISSUANCE =
  "Выдача конкурсных документов: до 15ч.00мин. (минское время) 18.06.2026г.; Конкурсные документы предоставляются: в электронном виде - .PDF после получения письменного запроса на электронную почту - uit-zakupki@maz.by ;";

const mazSnap = {
  emails: ["uit-zakupki@maz.by"],
  labeledFields: {
    "Краткое описание предмета закупки": MAZ_SUBJECT,
    "Выдача конкурсных документов": MAZ_ISSUANCE,
  },
};

const belapbSnap = {
  emails: ["tender2@belapb.by"],
  structured: {
    competitiveDocuments: {
      provisionTerms:
        "Конкурсные документы выдаются при условии поступления письменного запроса по электронной почте на адрес tender2@belapb.by; нарочным способом от представителя Участника",
    },
  },
};

const normalSnap = {
  structured: {
    competitiveDocuments: {
      provisionTerms: "Документы размещены на сайте icetrade, скачать без запроса.",
    },
  },
};

/** @param {string} title @param {unknown} snap @param {string[]} uploaded */
function checkImport(title, snap, uploaded) {
  const gate = resolveProvisionGate({
    snap,
    uploadedNames: uploaded,
    inputsFolderWebViewLink: "https://drive.google.com/drive/folders/EXAMPLE",
  });
  console.log(`\n=== ${title} ===`);
  console.log("corpus length:", buildProvisionCorpus(snap).length);
  console.log("importAction:", gate.importAction);
  console.log("attachmentClass:", gate.attachmentClass);
  console.log("email:", gate.email);
  console.log("show Analyze button:", gate.importAction !== "block_analyze");
  console.log("show Docs uploaded:", gate.importAction === "block_analyze" || gate.postExtractAction === "show_request_and_wait");
  if (gate.message) {
    console.log("\n--- message ---");
    console.log(gate.message);
  }
  return gate;
}

console.log("verify-maz-provision: локальная симуляция Import");

const mazGate = checkImport("MAZ · нет вложений", mazSnap, ["icetrade-import-snapshot.json"]);
const belapbGate = checkImport("Belapb · нет вложений", belapbSnap, []);
const normalGate = checkImport("Обычный · документы на сайте", normalSnap, []);

const mazPost = resolvePostExtractProvisionGate({
  snap: mazSnap,
  fileNames: ["Образец заявления на получение документов.docx"],
  inputsFolderWebViewLink: "https://drive.google.com/drive/folders/EXAMPLE",
});
console.log("\n=== MAZ · после Analyze, только образец ===");
console.log("postExtractAction:", mazPost.postExtractAction);

/** @type {string[]} */
const failures = [];
if (mazGate.importAction !== "block_analyze") failures.push("MAZ: expected block_analyze");
if (mazGate.email !== "uit-zakupki@maz.by") failures.push("MAZ: wrong email");
if (belapbGate.importAction !== "block_analyze") failures.push("Belapb: expected block_analyze");
if (normalGate.importAction !== "normal") failures.push("Normal: expected normal importAction");
if (mazPost.postExtractAction !== "show_request_and_wait") failures.push("MAZ sample: expected show_request_and_wait");

if (failures.length) {
  console.error("\nFAIL:", failures.join("; "));
  process.exit(1);
}
console.log("\nOK: все сценарии прошли локальную проверку");
