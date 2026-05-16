/**
 * Разбиение текста на чанки для RAG (без внешних зависимостей).
 * Ориентир по символам для русского текста без отдельного токенайзера.
 *
 * @param {string} text
 * @param {{ maxChars?: number, overlapChars?: number }} [opts]
 * @returns {string[]}
 */
export function chunkText(text, opts) {
  const maxChars = Math.max(500, opts?.maxChars ?? 3500);
  const overlap = Math.min(
    Math.floor(maxChars * 0.15),
    Math.max(0, opts?.overlapChars ?? Math.floor(maxChars * 0.12)),
  );
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  /** @type {string[]} */
  const chunks = [];
  let buf = "";

  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  const pushLong = (para) => {
    for (let i = 0; i < para.length; ) {
      const end = Math.min(i + maxChars, para.length);
      const slice = para.slice(i, end).trim();
      if (slice) chunks.push(slice);
      if (end >= para.length) break;
      i = Math.max(i + 1, end - overlap);
    }
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      pushLong(para);
      continue;
    }
    const next = buf ? `${buf}\n\n${para}` : para;
    if (next.length <= maxChars) {
      buf = next;
    } else {
      flush();
      if (para.length > maxChars) pushLong(para);
      else buf = para;
    }
  }
  flush();
  return chunks;
}
