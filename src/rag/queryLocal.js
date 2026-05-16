import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cosineSimilarity } from "./cosine.js";
import { embedAll } from "./embeddings.js";

/**
 * @typedef {{ chunkId: string, text: string, embedding: number[], metadata: Record<string, unknown> }} ChunkRow
 */

/**
 * @param {string} indexDir
 * @param {string} queryText
 * @param {{ topK?: number, stripEmbedding?: boolean }} [opts]
 * @returns {Promise<{ manifest: Record<string, unknown>, hits: Record<string, unknown>[] }>}
 */
export async function runQuery(indexDir, queryText, opts) {
  const topK = Math.max(1, opts?.topK ?? 12);
  const stripEmbedding = opts?.stripEmbedding !== false;

  const manifestPath = join(indexDir, "manifest.json");
  const chunksPath = join(indexDir, "chunks.jsonl");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = /** @type {Record<string, unknown>} */ (JSON.parse(manifestRaw));

  const chunksRaw = await readFile(chunksPath, "utf8");
  /** @type {ChunkRow[]} */
  const rows = [];
  for (const line of chunksRaw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(/** @type {ChunkRow} */ (JSON.parse(t)));
    } catch {
      /* skip bad line */
    }
  }
  if (rows.length === 0) {
    throw new Error("Индекс пуст: нет строк в chunks.jsonl");
  }

  const expectedDim = Number(manifest.dimensions);
  const dimFromRow = rows[0]?.embedding?.length ?? 0;
  const dim = Number.isFinite(expectedDim) && expectedDim > 0 ? expectedDim : dimFromRow;

  const qVectors = await embedAll([queryText.trim()]);
  const qvec = qVectors[0];
  if (!qvec?.length) {
    throw new Error("Не удалось получить эмбеддинг запроса");
  }
  if (dim > 0 && qvec.length !== dim) {
    throw new Error(
      `Размерность запроса (${qvec.length}) не совпадает с индексом (${dim}). Та же модель и LENA_EMBEDDING_DIMENSIONS, что при index.`,
    );
  }

  /** @type {{ chunkId: string, text: string, embedding: number[], metadata: Record<string, unknown>, score: number }[]} */
  const scored = [];
  for (const r of rows) {
    if (!Array.isArray(r.embedding) || r.embedding.length !== qvec.length) continue;
    const score = cosineSimilarity(qvec, r.embedding);
    scored.push({ ...r, score });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    throw new Error(
      "Ни один чанк не соответствует размерности эмбеддинга запроса: проверьте ту же LENA_EMBEDDING_MODEL и LENA_EMBEDDING_DIMENSIONS, что при index.",
    );
  }
  const top = scored.slice(0, topK);

  const hits = top.map((h) => {
    /** @type {Record<string, unknown>} */
    const o = {
      chunkId: h.chunkId,
      text: h.text,
      score: h.score,
      metadata: h.metadata,
    };
    if (!stripEmbedding) o.embedding = h.embedding;
    return o;
  });

  return { manifest, hits };
}
