/**
 * Разговорные «скиллы» Лены в Telegram: короткие ответы без привязки к тендеру.
 * Не подменяют /help и не вызывают LLM — только явные бытовые реплики.
 */

/** @typedef {"identity"|"capabilities"|"thanks"|"bye"|"smalltalk"} ConversationIntent */

/**
 * Общая группа, несколько закупок: нет привязки к тендеру — одна короткая подсказка пользователю.
 * Используется ботом и согласована с правилами для LLM (`lena-bot.mjs`).
 */
export function telegramTenderContextMissingHint() {
  return "Неясно, о какой закупке речь. Напишите сообщение через «Ответить» на реплику по этой закупке — так сохранится контекст переписки.";
}

/**
 * @param {string} text
 */
export function normalizeConversationText(text) {
  return text
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Похоже на вопрос по закупке — не перехватывать разговорным скиллом.
 * @param {string} s
 */
function looksLikeProcurementTopic(s) {
  return /закупк|тендер|icetrade|лот|заявк|ндс|конкурс|извещен|документ|матриц|кп\b|цена/i.test(s);
}

/**
 * @param {string} stripped уже нормализованный текст
 * @returns {ConversationIntent | null}
 */
export function classifyConversationIntent(stripped) {
  const s = stripped.trim();
  if (!s || s.length > 140) return null;
  if (looksLikeProcurementTopic(s)) return null;

  if (/^(спасибо|благодарю|thanks|thx|мерси)([\s,.!?…]|$)/iu.test(s)) return "thanks";
  if (/^(пока|до\s+свидания|goodbye|bye)([\s,.!?…]|$)/iu.test(s)) return "bye";
  if (/^(как\s+дела|как\s+ты|how\s+are\s+you)([\s,.!?…]|$)/iu.test(s)) return "smalltalk";

  if (
    /^(кто\s+ты|ты\s+кто|что\s+ты\s+за|как\s+тебя\s+зовут|представь(ся|ься)|who\s+are\s+you|what\s+are\s+you)\b/iu.test(
      s,
    ) ||
    /^кто\s+ты\s*[?.!…]*$/iu.test(s)
  ) {
    return "identity";
  }

  if (
    /^(что\s+умеешь|чем\s+можешь|чем\s+помож|что\s+делаешь|как\s+работаешь|как\s+пользов|что\s+ты\s+умеешь)/iu.test(
      s,
    ) ||
    /^(помоги|help)\b/iu.test(s) ||
    /\bwhat\s+can\s+you\b/iu.test(s)
  ) {
    return "capabilities";
  }

  return null;
}

/**
 * @param {ConversationIntent} intent
 * @param {{ botUsername?: string }} opts
 */
export function buildConversationReply(intent, opts = {}) {
  const user = (opts.botUsername ?? "").trim();
  const at = user ? `@${user}` : "бот";

  switch (intent) {
    case "identity":
      return [
        "Я **Лена** — специалист по подготовке тендерных документов в этом чате.",
        "",
        "Помогаю команде: импорт карточки **IceTrade** на Google Drive, разбор **inputs**, матрица требований, черновики под заявку, запросы к менеджерам по цене и документам.",
        "Юридические решения и подпись заявки — не моя зона; это люди.",
        "",
        "Чтобы начать по закупке — ссылка `…icetrade.by/tenders/all/view/<номер>` или **/help**.",
      ].join("\n");
    case "capabilities":
      return [
        "Кратко, что умею в Telegram:",
        "",
        "• **Ссылка IceTrade** в чат → папка тендера на Drive, файлы в **inputs**",
        "• **«Анализ документов»** / **/tenderextract** → текст из PDF/DOC, при LLM — матрица",
        "• **/bundle**, **/tenderask**, **/tendercard**, **/tenderkp** — работа по `tender_id`",
        "• **/ask** — диалог с моделью; **в группе** при нескольких закупках пишите через «Ответить» на сообщение по нужной закупке",
        "",
        `В группе я читаю все сообщения, кроме начинающихся с @ другого человека. Полный список: **/help**.`,
      ].join("\n");
    case "thanks":
      return "Пожалуйста. Если появится ссылка на закупку или вопрос по конкретному тендеру — пишите.";
    case "bye":
      return "До связи. Когда понадобится помощь по тендеру — ссылка IceTrade или /help.";
    case "smalltalk":
      return `На связи. Я ${at} по тендерам: пришлите ссылку IceTrade или спросите **/help**, чем заняться.`;
    default:
      return "Напишите /help или пришлите ссылку на карточку IceTrade.";
  }
}

/**
 * @param {string} text
 */
export function hasConversationIntent(text) {
  return classifyConversationIntent(normalizeConversationText(text)) !== null;
}
