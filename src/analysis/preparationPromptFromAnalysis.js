/**
 * Входной текст для модуля Preparation (черновик КП): собирается после Analysis,
 * хранится в папке **notes** тендера как `lena-preparation-prompt.md`.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadFile, listChildren, trashDriveFile, uploadFile } from "../drive/ops.js";
import {
  corpusMentionsPriceReductionProcedure,
  corpusSuggestsAbsurdStatedPrice,
} from "./pricingPolicy.js";

export const PREPARATION_PROMPT_FILENAME = "lena-preparation-prompt.md";

/** Фиксация цены менеджером после Analysis, до выбора юрлица и Preparation (КП). */
export const MANAGER_PRICE_QUOTE_FILENAME = "lena-manager-price-quote.md";

/**
 * @param {{
 *   lenaCanPrepare: { name: string; basis: string }[],
 *   managerMustProvide: { name: string; reason: string; criteria: string }[],
 * }} structured
 */
function formatMatrixForPrep(structured) {
  const esc = (s) =>
    String(s || "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ")
      .trim()
      .slice(0, 480);
  const body = [];
  let n = 0;
  for (const x of structured.lenaCanPrepare) {
    n += 1;
    body.push(`| ${n} | ${esc(x.name)} | Лена | ${esc(x.basis)} |`);
  }
  for (const x of structured.managerMustProvide) {
    n += 1;
    const crit = x.criteria && x.criteria !== "—" ? ` ${esc(x.criteria)}` : "";
    body.push(`| ${n} | ${esc(x.name)} | Менеджер | ${esc(x.reason)}${crit} |`);
  }
  if (!body.length) {
    return "_(В распарсенном тексте нет строк матрицы с дословной цитатой.)_";
  }
  return [
    "| № | Требование / документ | Роль | Суть (по документам) |",
    "|---|---|---|---|",
    ...body,
  ].join("\n");
}

/**
 * @param {object} p
 * @param {string} p.tenderId
 * @param {Parameters<typeof formatMatrixForPrep>[0]} p.structured
 * @param {string} p.corpus — корпус для эвристик цены (как при анализе)
 * @param {string} p.generatedAtIso
 */
export function buildPreparationPromptMarkdown({ tenderId, structured, corpus, generatedAtIso }) {
  const hasReduction = corpusMentionsPriceReductionProcedure(corpus);
  const absurd = corpusSuggestsAbsurdStatedPrice(corpus);

  /** @type {string[]} */
  const priceRules = [];
  if (absurd) {
    priceRules.push(
      "- В тексте закупки встречается **подозрительно малая цена или заглушка**. До файла **lena-manager-price-quote.md** **не подставляй** сумму из документов самостоятельно — только **[согласовать с менеджером]**; после заполнения файла используй согласованные значения.",
    );
  } else if (hasReduction) {
    priceRules.push(
      "- По тексту закупки **предусмотрена процедура снижения** (или переговоры / улучшение цены). В КП укажи **только стартовую цену участника**, опираясь на **начальную (предельную) цену заказчика или порядок её определения** из документов — **без** самовольных скидок (в т.ч. «−1–2 %»), если это прямо не следует из текста.",
      "- Явно сформулируй, что указанная сумма — **старт для этапа снижения**, не финальная цена по политике участника.",
    );
  } else {
    priceRules.push(
      "- По переданному тексту **процедура снижения не выявлена**. Пока нет файла **lena-manager-price-quote.md** от менеджера — **не указывай** итоговую сумму участника в КП; после заполнения файла в Telegram используй значения из него (**цена с НДС 20 %**, включённым в сумму).",
    );
  }
  priceRules.push(
    "- Любые суммы — **только** с явной отсылкой к разделу документов заказчика **или** из **lena-manager-price-quote.md**; иначе пометка **[согласовать с менеджером]** без числа.",
    "- После заполнения **lena-manager-price-quote.md** модуль Preparation **обязан** подставить эти цифры и формулировки в КП; ограничения выше про «не указывать сумму» на них **не распространяются**.",
  );

  return [
    "---",
    "lena: preparation-prompt-from-analysis",
    `tender_id: ${tenderId}`,
    `generated_at: ${generatedAtIso}`,
    "---",
    "",
    "# Вход для модуля Preparation (коммерческое предложение)",
    "",
    "Дальше в запросе к LLM передаётся **полный корпус** документов заказчика. **Этот файл** — сводка и правила после модуля **Analysis**; выполняй их вместе с системным промптом Preparation.",
    "",
    "## Тендер",
    `- **tender_id (IceTrade view):** ${tenderId}`,
    "",
    "## Сводка по документам (Analysis)",
    `- **Наименование / предмет:** ${structured.tenderTitle || "—"}`,
    `- **Сумма / бюджет в тексте:** ${structured.sumOrBudget || "—"}`,
    `- **Способ подачи:** ${structured.submissionMethod || "—"}`,
    `- **Дедлайн приёма:** ${structured.submissionDeadline || "—"}`,
    structured.submissionOverview
      ? `- **Перечень / подача (кратко):** ${structured.submissionOverview}`
      : "",
    "",
    "## Политика цены в КП (обязательно)",
    ...priceRules,
    "",
    "## Компания-участник",
    "После Analysis менеджер **сначала** проходит в Telegram **мастер коммерческих условий** (цена → оплата → срок → гарантия) или **/tenderprice**; запись — в **notes/lena-manager-price-quote.md**. Указанная цена — **с НДС 20 %** (налог включён в сумму), отдельный шаг «с НДС или без» не требуется.",
    "Затем выбирается **ровно одна** организация: **ГС Ритейл** или **Финсельват** (кнопки под результатом парсинга или **/tenderkp**), затем **«Сформировать КП»**.",
    "**Обе — резиденты Республики Беларусь.** Требования закупки, которые по тексту относятся **исключительно к нерезидентам**, **не учитывай**: не включай в ожидаемые вложения и не дублируй в КП; работай по ветке **резидента** или по общим требованиям ко всем участникам.",
    "Пока в сессии не передан выбор компании — **не заполняй** юридическое имя, реквизиты и подписанта участника из памяти; используй пометки **[по шаблону выбранной компании на Drive]**.",
    "",
    "## Матрица требований (только с опорой на текст inputs)",
    "",
    formatMatrixForPrep(structured),
    "",
    "## Что закрывает менеджер / внешние данные (по тексту закупки)",
    structured.managerMustProvide.length
      ? structured.managerMustProvide
          .map((x) => {
            const crit =
              x.criteria && x.criteria !== "—"
                ? `\n  - Сроки / форма: ${x.criteria}`
                : "";
            return `- **${x.name}** — ${x.reason}${crit}`;
          })
          .join("\n")
      : "—",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Оставить в папке не больше одной актуальной версии (фиксированное имя).
 * @param {string} notesFolderId
 * @param {string} markdownText
 */
export async function replacePreparationPromptFile(notesFolderId, markdownText) {
  const kids = await listChildren(notesFolderId);
  for (const f of kids) {
    if (String(f.name) === PREPARATION_PROMPT_FILENAME && f.id) {
      await trashDriveFile(String(f.id));
    }
  }
  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-prepprom-"));
  const localPath = join(tmpRoot, PREPARATION_PROMPT_FILENAME);
  try {
    await writeFile(localPath, markdownText, "utf8");
    return await uploadFile(notesFolderId, localPath, PREPARATION_PROMPT_FILENAME);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} notesFolderId
 * @returns {Promise<string | null>}
 */
export async function readPreparationPromptFromNotes(notesFolderId) {
  const kids = await listChildren(notesFolderId);
  const hits = kids.filter((f) => String(f.name) === PREPARATION_PROMPT_FILENAME && f.id);
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.modifiedTime ?? "").localeCompare(String(a.modifiedTime ?? "")));
  const hit = hits[0];
  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-prepprom-r-"));
  const localPath = join(tmpRoot, PREPARATION_PROMPT_FILENAME);
  try {
    await downloadFile(String(hit.id), localPath);
    const t = (await readFile(localPath, "utf8")).trim();
    return t || null;
  } catch {
    return null;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Запись цены менеджера в notes (перезапись одного файла).
 * @param {string} notesFolderId
 * @param {string} markdownText
 */
export async function replaceManagerPriceQuoteFile(notesFolderId, markdownText) {
  const kids = await listChildren(notesFolderId);
  for (const f of kids) {
    if (String(f.name) === MANAGER_PRICE_QUOTE_FILENAME && f.id) {
      await trashDriveFile(String(f.id));
    }
  }
  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-mgrprice-"));
  const localPath = join(tmpRoot, MANAGER_PRICE_QUOTE_FILENAME);
  try {
    await writeFile(localPath, markdownText, "utf8");
    return await uploadFile(notesFolderId, localPath, MANAGER_PRICE_QUOTE_FILENAME);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Текст цены без YAML-шапки (для промпта КП).
 * @param {string} notesFolderId
 * @returns {Promise<string | null>}
 */
export async function readManagerPriceQuoteFromNotes(notesFolderId) {
  const kids = await listChildren(notesFolderId);
  const hits = kids.filter((f) => String(f.name) === MANAGER_PRICE_QUOTE_FILENAME && f.id);
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.modifiedTime ?? "").localeCompare(String(a.modifiedTime ?? "")));
  const hit = hits[0];
  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-mgrprice-r-"));
  const localPath = join(tmpRoot, MANAGER_PRICE_QUOTE_FILENAME);
  try {
    await downloadFile(String(hit.id), localPath);
    let t = (await readFile(localPath, "utf8")).trim();
    if (!t) return null;
    t = t.replace(/^---[\s\S]*?^---\s*/m, "").trim();
    return t || null;
  } catch {
    return null;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}
