/**
 * Markdown subset → Telegram HTML (parse_mode: HTML).
 * Only **bold** and [label](url); no _italic_ (underscores break Drive file names).
 * @param {string} text
 */
export function checklistMarkdownToTelegramHtml(text) {
  let s = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safeUrl = url.replace(/&/g, "&amp;");
    return `<a href="${safeUrl}">${label}</a>`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  return s;
}

/**
 * @param {string} html
 * @returns {{ ok: true } | { ok: false, index: number, tag: string, stack: string[] }}
 */
export function validateTelegramHtml(html) {
  const re = /<\/?([a-z]+)(?:\s[^>]*)?>/gi;
  /** @type {string[]} */
  const stack = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const full = m[0];
    const name = m[1].toLowerCase();
    if (full.startsWith("</")) {
      if (!stack.length || stack[stack.length - 1] !== name) {
        return { ok: false, index: m.index, tag: full, stack: [...stack] };
      }
      stack.pop();
    } else if (!full.endsWith("/>")) {
      stack.push(name);
    }
  }
  if (stack.length) {
    return { ok: false, index: html.length, tag: `unclosed:${stack.join(",")}`, stack: [...stack] };
  }
  return { ok: true };
}
