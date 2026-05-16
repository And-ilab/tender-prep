import { runIndexBuild } from "./indexBuild.js";
import { runQuery } from "./queryLocal.js";
import { runRagAsk } from "./ask.js";

function usage() {
  console.error(
    [
      "lena rag — локальный RAG: чанки + эмбеддинги (OpenAI-compatible) + поиск по косинусу",
      "",
      "Переменные: LENA_OPENAI_API_KEY или OPENAI_API_KEY; LENA_OPENAI_BASE_URL; LENA_OPENAI_MODEL (чат).",
      "  LENA_EMBEDDING_BASE_URL — базовый URL для POST …/embeddings (если отличается от чата/региона); иначе как LENA_OPENAI_BASE_URL.",
      "  LENA_EMBEDDING_API_KEY — опционально, если ключ для эмбеддингов не тот же, что для чата.",
      "  LENA_EMBEDDING_MODEL (по умолчанию text-embedding-3-small); опционально LENA_EMBEDDING_DIMENSIONS.",
      "Индексируются только текстовые файлы: .txt .md .csv .log (например выгрузка corpus-pull).",
      "",
      "Возобновление после сбоя: если есть chunks.jsonl, но нет manifest.json — индекс дописывается, уже записанные чанки не считаются заново.",
      "  Состояние: .lena-rag-build-state.json (папка индекса). Полная пересборка: удалите chunks.jsonl, manifest.json и этот файл.",
      "  Отключить автовозобновление (перезаписать chunks с нуля): set LENA_RAG_INDEX_RESUME=0",
      "",
      "  node src/cli.js rag index <локальнаяПапкаКорпуса> <папкаИндекса>",
      "      [maxChars] [overlapChars] [maxFiles]",
      "",
      "  node src/cli.js rag query <папкаИндекса> <текст запроса...> [topK]",
      "",
      "  node src/cli.js rag ask <папкаИндекса> <вопрос...> [topK]",
      "      — поиск + один вызов LLM (нужен ключ; чат — LENA_OPENAI_MODEL).",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

/**
 * @param {string[]} tail — аргументы после `query` или `ask`
 * @returns {{ indexDir: string, text: string, topK: number }}
 */
function parseIndexDirQueryTopK(tail) {
  const indexDir = tail[0];
  if (!indexDir) {
    throw new Error("Не указана папка индекса");
  }
  let topK = 12;
  let qparts = tail.slice(1);
  if (qparts.length === 0) {
    throw new Error("Пустой запрос");
  }
  const last = qparts[qparts.length - 1];
  if (qparts.length >= 2 && /^\d+$/.test(last.trim())) {
    topK = Number.parseInt(last.trim(), 10);
    qparts = qparts.slice(0, -1);
  }
  const text = qparts.join(" ").trim();
  if (!text) {
    throw new Error("Пустой запрос");
  }
  return { indexDir, text, topK };
}

/**
 * @param {string[]} args — аргументы после `rag`
 */
export async function runRag(args) {
  const [cmd, ...rest] = args;
  if (!cmd) {
    usage();
    return;
  }

  try {
    if (cmd === "index") {
      const [sourceDir, outDir, c, d, e] = rest;
      if (!sourceDir || !outDir) {
        usage();
        return;
      }
      const maxChars = c && /^\d+$/.test(c.trim()) ? Number.parseInt(c.trim(), 10) : undefined;
      const overlapChars = d && /^\d+$/.test(d.trim()) ? Number.parseInt(d.trim(), 10) : undefined;
      const maxFiles = e && /^\d+$/.test(e.trim()) ? Number.parseInt(e.trim(), 10) : undefined;
      const onProgress = (msg) => console.error(`[rag] ${msg}`);
      const manifest = await runIndexBuild(sourceDir, outDir, {
        maxChars: maxChars !== undefined && !Number.isNaN(maxChars) ? maxChars : undefined,
        overlapChars: overlapChars !== undefined && !Number.isNaN(overlapChars) ? overlapChars : undefined,
        maxFiles: maxFiles !== undefined && !Number.isNaN(maxFiles) ? maxFiles : undefined,
        onProgress,
      });
      console.log(JSON.stringify({ ok: true, manifest }, null, 2));
      return;
    }

    if (cmd === "query") {
      if (rest.length < 2) {
        usage();
        return;
      }
      const { indexDir, text, topK } = parseIndexDirQueryTopK(rest);
      const { manifest, hits } = await runQuery(indexDir, text, { topK, stripEmbedding: true });
      console.log(JSON.stringify({ ok: true, manifest, hits }, null, 2));
      return;
    }

    if (cmd === "ask") {
      if (rest.length < 2) {
        usage();
        return;
      }
      const { indexDir, text, topK } = parseIndexDirQueryTopK(rest);
      const { hits, answer } = await runRagAsk(indexDir, text, { topK });
      console.log(JSON.stringify({ ok: true, hitCount: hits.length, answer }, null, 2));
      return;
    }

    usage();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
