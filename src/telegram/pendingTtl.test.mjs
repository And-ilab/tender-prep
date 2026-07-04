import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseTelegramPendingTtlMs,
  TELEGRAM_PENDING_TTL_MAX_HOURS,
  TELEGRAM_PENDING_TTL_MIN_HOURS,
} from "./pendingTtl.js";

const MS_PER_HOUR = 60 * 60 * 1000;

describe("parseTelegramPendingTtlMs", () => {
  it("defaults to 48 hours", () => {
    assert.equal(parseTelegramPendingTtlMs({}), 48 * MS_PER_HOUR);
  });

  it("reads LENA_TELEGRAM_PENDING_TTL_HOURS from env", () => {
    assert.equal(parseTelegramPendingTtlMs({ LENA_TELEGRAM_PENDING_TTL_HOURS: "72" }), 72 * MS_PER_HOUR);
  });

  it("clamps below minimum to 1 hour", () => {
    assert.equal(parseTelegramPendingTtlMs({ LENA_TELEGRAM_PENDING_TTL_HOURS: "0.5" }), MS_PER_HOUR);
  });

  it("clamps above maximum to 168 hours", () => {
    assert.equal(
      parseTelegramPendingTtlMs({ LENA_TELEGRAM_PENDING_TTL_HOURS: "999" }),
      TELEGRAM_PENDING_TTL_MAX_HOURS * MS_PER_HOUR,
    );
  });

  it("falls back to defaultHours when env value is invalid", () => {
    assert.equal(parseTelegramPendingTtlMs({ LENA_TELEGRAM_PENDING_TTL_HOURS: "abc" }, 24), 24 * MS_PER_HOUR);
  });

  it("exports min/max hour constants", () => {
    assert.equal(TELEGRAM_PENDING_TTL_MIN_HOURS, 1);
    assert.equal(TELEGRAM_PENDING_TTL_MAX_HOURS, 168);
  });
});
