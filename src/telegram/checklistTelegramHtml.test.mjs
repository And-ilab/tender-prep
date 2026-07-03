import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checklistMarkdownToTelegramHtml,
  validateTelegramHtml,
} from "./checklistTelegramHtml.js";

/** Old deployed converter — reproduces Telegram 400 on underscore file names. */
function checklistMarkdownToTelegramHtmlLegacy(text) {
  let s = checklistMarkdownToTelegramHtml(text);
  return s.replace(/_([^_\n]+)_/g, "<i>$1</i>");
}

describe("checklistMarkdownToTelegramHtml", () => {
  it("keeps valid HTML when Drive file names contain underscores", () => {
    const md =
      "- Заявка — (форма: шаблон org — [my_file.pdf](https://drive.google.com/file/d/x/view))";
    const html = checklistMarkdownToTelegramHtml(md);
    const v = validateTelegramHtml(html);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.match(html, /my_file\.pdf/);
  });

  it("legacy italic conversion breaks on underscore file names (regression guard)", () => {
    const md =
      "- Заявка _форма: шаблон org — [my_file.pdf](https://drive.google.com/file/d/x/view)_";
    const html = checklistMarkdownToTelegramHtmlLegacy(md);
    const v = validateTelegramHtml(html);
    assert.equal(v.ok, false);
    assert.equal(v.tag, "</i>");
  });
});
