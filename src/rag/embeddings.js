import { resolveEmbeddingApiKey } from "../llm/openaiCompatible.js";

/**
 * База для POST /embeddings (можно отдельно от чата, если провайдер другой / другой регион).
 * @returns {string}
 */
function embeddingBaseUrl() {
  const u = (
    process.env.LENA_EMBEDDING_BASE_URL ||
    process.env.LENA_OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  )
    .trim()
    .replace(/\/+$/, "");
  return u || "https://api.openai.com/v1";
}

/**
 * @returns {string}
 */
export function embeddingModel() {
  return (process.env.LENA_EMBEDDING_MODEL || "text-embedding-3-small").trim() || "text-embedding-3-small";
}

/**
 * Одна пачка эмбеддингов (OpenAI-compatible POST /v1/embeddings).
 * @param {string[]} inputs
 * @param {{ onErrorDetail?: (s: string) => void }} [opts]
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(inputs, opts) {
  const key = resolveEmbeddingApiKey();
  if (!key) {
    const base = embeddingBaseUrl().toLowerCase();
    const localHint =
      base.includes("127.0.0.1") || base.includes("localhost")
        ? " Для локального CPU-сервера задайте любой непустой LENA_EMBEDDING_API_KEY (например sk-local), если на сервере не включён LOCAL_EMBEDDINGS_API_KEY — см. scripts/local_openai_embeddings/README.md."
        : "";
    throw new Error(
      `Не задан ключ для embeddings: LENA_EMBEDDING_API_KEY или LENA_OPENAI_API_KEY / OPENAI_API_KEY.${localHint}`,
    );
  }
  if (inputs.length === 0) return [];
  const url = `${embeddingBaseUrl()}/embeddings`;
  /** @type {Record<string, unknown>} */
  const body = {
    model: embeddingModel(),
    input: inputs,
  };
  const dimEnv = process.env.LENA_EMBEDDING_DIMENSIONS?.trim();
  if (dimEnv && /^\d+$/.test(dimEnv)) {
    body.dimensions = Number.parseInt(dimEnv, 10);
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
    const msg = e instanceof Error ? e.message : String(e);
    const base = embeddingBaseUrl().toLowerCase();
    const localHint =
      base.includes("127.0.0.1") || base.includes("localhost")
        ? ` Проверьте, что запущен локальный сервер: python scripts/local_openai_embeddings/server.py и curl ${base.replace(/\/v1$/, "")}/health`
        : "";
    throw new Error(`Embeddings: запрос не удался (${msg}${cause ? `; ${cause}` : ""}). URL: ${url}.${localHint}`);
  }
  const raw = await res.text();
  /** @type {Record<string, unknown>} */
  let data;
  try {
    data = /** @type {Record<string, unknown>} */ (JSON.parse(raw));
  } catch {
    throw new Error(`Embeddings: не JSON (${res.status}): ${raw.slice(0, 500)}`);
  }
  if (!res.ok) {
    const err =
      data.error && typeof data.error === "object" && "message" in /** @type {object} */ (data.error)
        ? String(/** @type {{ message?: unknown }} */ (data.error).message)
        : raw.slice(0, 800);
    opts?.onErrorDetail?.(raw.slice(0, 2000));
    const em = err.toLowerCase();
    let hint = "";
    if (
      res.status === 403 &&
      (em.includes("country") || em.includes("region") || em.includes("territory") || em.includes("not supported"))
    ) {
      hint +=
        " Провайдер не обслуживает ваш регион для этого endpoint: задайте LENA_EMBEDDING_BASE_URL на зеркало/прокси в разрешённом регионе или другой API эмбеддингов (совместимый с POST /v1/embeddings).";
    }
    if (res.status === 404 && url.toLowerCase().includes("deepseek")) {
      hint +=
        " У DeepSeek в OpenAI-совместимом API обычно нет `/embeddings` — задайте LENA_EMBEDDING_BASE_URL (и при необходимости LENA_EMBEDDING_API_KEY) на сервис с эмбеддингами.";
    }
    throw new Error(`Embeddings ${res.status}: ${err}${hint}`);
  }
  const list = data.data;
  if (!Array.isArray(list)) {
    throw new Error("Embeddings: нет поля data[]");
  }
  /** @type {{ index: number, embedding: number[] }[]} */
  const rows = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    const idx = typeof o.index === "number" ? o.index : rows.length;
    const emb = o.embedding;
    if (!Array.isArray(emb)) continue;
    rows.push({ index: idx, embedding: emb.map((x) => Number(x)) });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows.map((r) => r.embedding);
}

/**
 * @param {string[]} inputs
 * @param {{ batchSize?: number, onProgress?: (done: number, total: number) => void }} [opts]
 */
export async function embedAll(inputs, opts) {
  const batchSize = Math.min(128, Math.max(1, opts?.batchSize ?? 64));
  /** @type {number[][]} */
  const out = [];
  const total = inputs.length;
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const vectors = await embedBatch(batch);
    if (vectors.length !== batch.length) {
      throw new Error(`Embeddings: ожидалось ${batch.length} векторов, пришло ${vectors.length}`);
    }
    out.push(...vectors);
    opts?.onProgress?.(Math.min(i + batch.length, total), total);
  }
  return out;
}
