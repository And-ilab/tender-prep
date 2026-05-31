/**
 * Матрица требований после Analysis — два блока списком (Telegram / Drive / Preparation).
 */

/**
 * Упоминание менеджера в заголовке второго блока матрицы.
 * Задаётся через **LENA_MANAGER_TELEGRAM_MENTION** (например `@username`).
 * Если переменная **не** задана — при тестировании в текст **не** подставляется явный `@…`.
 */
export function resolveManagerTelegramMention() {
  return process.env.LENA_MANAGER_TELEGRAM_MENTION?.trim() ?? "";
}

/**
 * @param {{
 *   lenaCanPrepare: { name: string; basis: string }[],
 *   managerMustProvide: { name: string; reason: string; criteria: string }[],
 * }} structured
 */
export function formatAnalysisMatrixBullets(structured) {
  const lines = [];
  lines.push("**Подготовлю сама:**");
  lines.push(
    "_Документы и тексты, которые Лена может подготовить по образцам и формулировкам из документации заказчика (есть опора в inputs)._",
  );
  if (!structured.lenaCanPrepare.length) {
    lines.push(
      "- _(нет пунктов с дословной цитатой в тексте — проверьте **inputs** и парсинг.)_",
    );
  } else {
    for (const x of structured.lenaCanPrepare) {
      lines.push(`- **${x.name}** — ${x.basis}`);
    }
  }
  lines.push("");
  const mgrMention = resolveManagerTelegramMention();
  lines.push(
    mgrMention
      ? `**Требуется помощь менеджера (${mgrMention}):**`
      : "**Требуется помощь менеджера:**",
  );
  lines.push(
    "_Документы и данные, которые Лена не генерирует сама (справка банка, оригиналы, выписки и т.п.) — нужно предоставить менеджеру._",
  );
  if (!structured.managerMustProvide.length) {
    lines.push(
      "- _(по тексту не выделены документы, которые нужно получить от менеджера / третьих лиц — или всё в блоке «Подготовлю сама».)_",
    );
  } else {
    for (const x of structured.managerMustProvide) {
      let row = `- **${x.name}** — ${x.reason}`;
      if (x.criteria && x.criteria !== "—") row += ` _(${x.criteria})_`;
      lines.push(row);
    }
  }
  return lines.join("\n");
}
