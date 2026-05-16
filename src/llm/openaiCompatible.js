/**
 * Chat Completions через OpenAI-compatible HTTP API (fetch, без SDK).
 *
 * Переменные:
 * - LENA_OPENAI_API_KEY или OPENAI_API_KEY
 * - LENA_OPENAI_BASE_URL (по умолчанию https://api.openai.com/v1)
 * - LENA_OPENAI_MODEL (по умолчанию gpt-4o-mini)
 *
 * Для `rag index` / эмбеддингов (отдельно от чата):
 * - LENA_EMBEDDING_BASE_URL, LENA_EMBEDDING_API_KEY — если эмбеддинги у другого хоста/ключа (см. resolveEmbeddingApiKey).
 */

/**
 * @typedef {{ role: "system" | "user" | "assistant", content: string }} ChatMessage
 */

/**
 * @returns {string}
 */
export function resolveLlmApiKey() {
  return (process.env.LENA_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

/**
 * @returns {boolean}
 */
export function isLlmConfigured() {
  return resolveLlmApiKey().length > 0;
}

/**
 * Ключ для `POST …/embeddings` (RAG). Если не задан — тот же, что для чата.
 * @returns {string}
 */
export function resolveEmbeddingApiKey() {
  return (
    (process.env.LENA_EMBEDDING_API_KEY || "").trim() ||
    (process.env.LENA_OPENAI_API_KEY || "").trim() ||
    (process.env.OPENAI_API_KEY || "").trim()
  );
}

/**
 * @returns {string}
 */
function baseUrl() {
  const u = (process.env.LENA_OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  return u || "https://api.openai.com/v1";
}

/**
 * @returns {string}
 */
function model() {
  return (process.env.LENA_OPENAI_MODEL || "gpt-4o-mini").trim() || "gpt-4o-mini";
}

/**
 * @param {ChatMessage[]} messages
 * @param {{ temperature?: number, max_tokens?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function chatCompletion(messages, opts) {
  const key = resolveLlmApiKey();
  if (!key) {
    throw new Error("Не задан API-ключ: LENA_OPENAI_API_KEY или OPENAI_API_KEY");
  }
  const url = `${baseUrl()}/chat/completions`;
  const body = {
    model: model(),
    messages,
    temperature: opts?.temperature ?? 0.35,
    max_tokens: opts?.max_tokens ?? 2048,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  /** @type {Record<string, unknown>} */
  let data;
  try {
    data = /** @type {Record<string, unknown>} */ (JSON.parse(raw));
  } catch {
    throw new Error(`LLM: не JSON (${res.status}): ${raw.slice(0, 500)}`);
  }
  if (!res.ok) {
    const err = data.error && typeof data.error === "object" && "message" in data.error
      ? String(/** @type {{ message?: unknown }} */ (data.error).message)
      : raw.slice(0, 800);
    throw new Error(`LLM ${res.status}: ${err}`);
  }
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("LLM: пустой choices");
  }
  const c0 = /** @type {Record<string, unknown>} */ (choices[0]);
  const msg = c0.message && typeof c0.message === "object" ? /** @type {Record<string, unknown>} */ (c0.message) : null;
  const content = msg && typeof msg.content === "string" ? msg.content : "";
  if (!content.trim()) {
    throw new Error("LLM: пустой ответ модели");
  }
  return content;
}
