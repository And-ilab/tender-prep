const MS_PER_HOUR = 60 * 60 * 1000;
const MIN_HOURS = 1;
const MAX_HOURS = 168;

/**
 * TTL inline-сессий бота (parseOrgPending, importDocsPending, kpOrgPending).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [defaultHours]
 * @returns {number}
 */
export function parseTelegramPendingTtlMs(env = process.env, defaultHours = 48) {
  const raw = env.LENA_TELEGRAM_PENDING_TTL_HOURS?.trim();
  let hours = defaultHours;
  if (raw) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) hours = parsed;
  }
  hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, hours));
  return Math.round(hours * MS_PER_HOUR);
}

export { MIN_HOURS as TELEGRAM_PENDING_TTL_MIN_HOURS, MAX_HOURS as TELEGRAM_PENDING_TTL_MAX_HOURS };
