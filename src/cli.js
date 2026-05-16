#!/usr/bin/env node
import { buildComplianceMatrix } from "./matrix/compliance.js";
import { readJsonFile, writeJsonFile } from "./io/jsonFile.js";
import { toSnapshot } from "./normalize/snapshot.js";
import { validateTenderParseResult } from "./validate/parserResult.js";
import { validateTenderParseRequest } from "./validate/tenderInput.js";

function usage() {
  const lines = [
    "lena — локальный CLI без Windmill",
    "",
    "  node src/cli.js validate-input <file.json>     — проверка входа закупки (TenderParseRequest)",
    "  node src/cli.js validate-result <file.json>   — проверка результата парсера (TenderParseResult)",
    "  node src/cli.js snapshot <result.json> <out>  — нормализация в TenderSnapshot",
    "  node src/cli.js matrix <result.json> <out>    — матрица соответствия из результата парсера",
    "",
    "  node src/cli.js drive …                        — Google Drive (см. node src/cli.js drive)",
    "  node src/cli.js tenders …                     — IceTrade → Drive (см. node src/cli.js tenders)",
    "  node src/cli.js rag …                          — RAG: индекс по локальному корпусу, query, ask (см. node src/cli.js rag)",
    "",
  ];
  console.error(lines.join("\n"));
  process.exitCode = 1;
}

/**
 * @param {string[]} argv
 */
async function main(argv) {
  const [, , cmd, a, b] = argv;
  if (!cmd) {
    usage();
    return;
  }

  try {
    if (cmd === "drive") {
      const { runDrive } = await import("./drive/cli.js");
      await runDrive(argv.slice(3));
      return;
    }

    if (cmd === "rag") {
      const { runRag } = await import("./rag/cli.js");
      await runRag(argv.slice(3));
      return;
    }

    if (cmd === "tenders") {
      const { runTendersCli } = await import("./tenders/cli.js");
      await runTendersCli(argv.slice(3));
      return;
    }

    if (cmd === "validate-input") {
      if (!a) usage();
      else {
        const parsed = readJsonFile(a);
        const r = validateTenderParseRequest(parsed);
        if (!r.ok) {
          console.error(JSON.stringify({ ok: false, issues: r.issues }, null, 2));
          process.exitCode = 2;
        } else {
          console.log(JSON.stringify({ ok: true }, null, 2));
        }
      }
      return;
    }

    if (cmd === "validate-result") {
      if (!a) usage();
      else {
        const parsed = readJsonFile(a);
        const r = validateTenderParseResult(parsed);
        if (!r.ok) {
          console.error(JSON.stringify({ ok: false, issues: r.issues }, null, 2));
          process.exitCode = 2;
        } else {
          console.log(JSON.stringify({ ok: true }, null, 2));
        }
      }
      return;
    }

    if (cmd === "snapshot") {
      if (!a || !b) usage();
      else {
        const parsed = readJsonFile(a);
        const r = validateTenderParseResult(parsed);
        if (!r.ok) {
          console.error(JSON.stringify({ ok: false, issues: r.issues }, null, 2));
          process.exitCode = 2;
          return;
        }
        const snap = toSnapshot(r.value);
        writeJsonFile(b, snap);
        console.error(`Записано: ${b}`);
      }
      return;
    }

    if (cmd === "matrix") {
      if (!a || !b) usage();
      else {
        const parsed = readJsonFile(a);
        const r = validateTenderParseResult(parsed);
        if (!r.ok) {
          console.error(JSON.stringify({ ok: false, issues: r.issues }, null, 2));
          process.exitCode = 2;
          return;
        }
        const snap = toSnapshot(r.value);
        const matrix = buildComplianceMatrix(snap);
        writeJsonFile(b, matrix);
        console.error(`Записано: ${b}`);
      }
      return;
    }

    usage();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

main(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
