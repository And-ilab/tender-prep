import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  archiveStemFromFileName,
  detectArchiveKindFromBuffer,
  driveNameForArchiveMember,
  isArchiveFileName,
  shouldSkipArchiveMemberPath,
} from "./archiveUtils.js";
import { detectAttachmentBufferKind, validateAttachmentBuffer } from "./fetchPage.js";

describe("archiveUtils", () => {
  it("isArchiveFileName recognizes zip/rar/7z", () => {
    assert.equal(isArchiveFileName("desktop(1781087880).rar"), true);
    assert.equal(isArchiveFileName("docs.zip"), true);
    assert.equal(isArchiveFileName("pack.7z"), true);
    assert.equal(isArchiveFileName("file.pdf"), false);
  });

  it("driveNameForArchiveMember prefixes with archive stem", () => {
    assert.equal(
      driveNameForArchiveMember("desktop(1781087880).rar", "TZ/ТЗ.pdf"),
      "desktop(1781087880)__TZ__ТЗ.pdf",
    );
  });

  it("archiveStemFromFileName strips extension", () => {
    assert.equal(archiveStemFromFileName("desktop(1781087880).rar"), "desktop(1781087880)");
  });

  it("shouldSkipArchiveMemberPath skips service paths", () => {
    assert.equal(shouldSkipArchiveMemberPath("__MACOSX/foo"), true);
    assert.equal(shouldSkipArchiveMemberPath("docs/readme.pdf"), false);
  });

  it("detectArchiveKindFromBuffer reads RAR signature", () => {
    const buf = Buffer.from("Rar!\x1a\x07\x00", "latin1");
    assert.equal(detectArchiveKindFromBuffer(buf), "rar");
  });
});

describe("fetchPage archive validation", () => {
  it("detectAttachmentBufferKind returns rar for RAR header", () => {
    const buf = Buffer.from("Rar!\x1a\x07\x00padding", "latin1");
    assert.equal(detectAttachmentBufferKind(buf), "rar");
  });

  it("validateAttachmentBuffer accepts .rar with RAR signature", () => {
    const buf = Buffer.from("Rar!\x1a\x07\x00" + "x".repeat(32), "latin1");
    const v = validateAttachmentBuffer(buf, "desktop(1781087880).rar", "application/x-rar-compressed");
    assert.equal(v.ok, true);
  });
});
