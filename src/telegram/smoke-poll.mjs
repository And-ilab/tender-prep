/**
 * Минимальный смоук-тест Telegram Bot API (long polling, только fetch).
 * Запуск: TELEGRAM_BOT_TOKEN=... node src/telegram/smoke-poll.mjs
 */

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("Задайте TELEGRAM_BOT_TOKEN (токен от @BotFather). См. docs/TELEGRAM.md");
  process.exit(1);
}

const base = `https://api.telegram.org/bot${token}`;

/**
 * @param {string} method
 * @param {Record<string, unknown>} [body]
 */
async function tg(method, body) {
  const url = `${base}/${method}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = /** @type {Record<string, unknown>} */ (await res.json());
  if (!data.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

async function main() {
  const me = await tg("getMe");
  console.error(`Бот: @${/** @type {{ username?: string }} */ (me.result).username ?? "?"}`);

  let offset = 0;
  console.error("Ожидаю сообщения… (Ctrl+C для выхода)");

  for (;;) {
    const updates = /** @type {{ result?: { update_id: number, message?: { chat: { id: number, type?: string }, text?: string, message_id: number } }[] }} */ (
      await tg(`getUpdates?timeout=30&offset=${offset}`)
    );
    const list = updates.result ?? [];
    for (const u of list) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text || !msg.chat) continue;
      if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") continue;

      const reply =
        `Эхо (smoke): ${msg.text.slice(0, 500)}` +
        `\n\nПодсказка: корень Drive + agent-bundle см. docs/TELEGRAM.md и docs/GOOGLE_DRIVE.md`;

      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: reply,
        reply_to_message_id: msg.message_id,
      });
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
