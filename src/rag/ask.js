import { chatCompletion } from "../llm/openaiCompatible.js";
import { runQuery } from "./queryLocal.js";

/**
 * Поиск по индексу + один вызов LLM с подмешанными отрывками.
 * @param {string} indexDir
 * @param {string} userQuestion
 * @param {{ topK?: number }} [opts]
 */
export async function runRagAsk(indexDir, userQuestion, opts) {
  const topK = opts?.topK ?? 10;
  const { manifest, hits } = await runQuery(indexDir, userQuestion, { topK, stripEmbedding: true });
  const blocks = hits.map((h, i) => {
    const meta = /** @type {Record<string, unknown>} */ (h.metadata ?? {});
    const path = typeof meta.sourcePath === "string" ? meta.sourcePath : "?";
    return `[#${i + 1} score=${(/** @type {number} */ (h.score)).toFixed(4)} path=${path}]\n${h.text}`;
  });
  const userContent = [
    "Ниже релевантные отрывки из корпоративного архива (RAG). Опирайся на них; если факта нет в отрывках — так и скажи.",
    "",
    blocks.join("\n\n---\n\n"),
    "",
    `Вопрос пользователя: ${userQuestion.trim()}`,
  ].join("\n");

  const modelNote =
    typeof manifest.embeddingModel === "string"
      ? `Индекс эмбеддингов: ${manifest.embeddingModel}.`
      : "";
  const answer = await chatCompletion(
    [
      {
        role: "system",
        content: [
          "Ты «Лена» — специалист по подготовке тендерных документов: отвечай по-русски, структурировано; по возможности сразу давай формулировки и фрагменты под заявку, а не только общие советы. Запрошенные заказчиком документы: помечай пробелы и риск отклонения; при явно неприменимом требовании — гипотеза и эскалация менеджеру, без самодеятельных писем в комиссию. Пока критичные вложения не в контексте — не раздувай ответ полными пакетами под них; сначала матрица/чеклист и что донести.",
          modelNote,
        ].join(" "),
      },
      { role: "user", content: userContent },
    ],
    { temperature: 0.3, max_tokens: 3072 },
  );
  return { hits, answer };
}
