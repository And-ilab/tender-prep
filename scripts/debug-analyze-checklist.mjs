import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnvFile() {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile();

const tenderId = process.argv[2] ?? "1352058";
const rootRaw = process.env.LENA_DRIVE_ROOT?.trim();
if (!rootRaw) {
  console.error("LENA_DRIVE_ROOT missing");
  process.exit(1);
}

const { resolveDriveId } = await import("../src/drive/ids.js");
const { analyzeTenderAfterBootstrap } = await import("../src/icetrade/analyzeAfterBootstrap.js");
const { buildRequiredDocumentsList, formatDocumentCompositionStep1Telegram } = await import(
  "../src/analysis/documentChecklist.js"
);

const rootId = resolveDriveId(rootRaw);
const ar = await analyzeTenderAfterBootstrap(rootId, tenderId, {});
if (!ar.ok) {
  console.error(JSON.stringify(ar, null, 2));
  process.exit(2);
}
if ("insufficientInputText" in ar && ar.insufficientInputText) {
  console.error(JSON.stringify(ar, null, 2));
  process.exit(3);
}

const corpus = typeof ar.corpus === "string" ? ar.corpus : "";
const required = buildRequiredDocumentsList(ar.structured, { corpus });
const step1 = formatDocumentCompositionStep1Telegram(
  ar.structured,
  required,
  ar.inputsFolderWebViewLink,
);

console.log(
  JSON.stringify(
    {
      tenderId,
      corpusChars: corpus.length,
      qualification: ar.structured.qualificationRequirements,
      lenaCanPrepare: ar.structured.lenaCanPrepare,
      managerMustProvide: ar.structured.managerMustProvide,
      requiredIds: required.map((d) => d.id),
      requiredTitles: required.map((d) => d.title),
      step1Text: step1,
    },
    null,
    2,
  ),
);
