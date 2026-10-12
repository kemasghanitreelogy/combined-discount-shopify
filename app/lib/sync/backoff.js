/** Retry policy for outbox jobs. Pure, so it can be unit-tested. */

export const MAX_ATTEMPTS = 15;
const BASE_MS = 30_000;
const CAP_MS = 60 * 60_000;

/**
 * Delay before the next attempt, after `attempts` failures so far.
 * Exponential from 30 s, capped at 1 h, ±20 % jitter so a burst of failures
 * does not come back as a burst. A server-supplied Retry-After wins.
 */
export function nextDelayMs(
  attempts,
  retryAfterMs = null,
  random = Math.random,
) {
  if (retryAfterMs != null && retryAfterMs > 0)
    return Math.min(retryAfterMs, CAP_MS);
  const exp = Math.min(BASE_MS * 2 ** Math.max(attempts - 1, 0), CAP_MS);
  return Math.round(exp * (0.8 + random() * 0.4));
}

/** Whether a job that just failed should be given up on. */
export function shouldGiveUp({ attempts, retryable }) {
  return !retryable || attempts >= MAX_ATTEMPTS;
}

/**
 * One readable line from an error. Prisma messages open with a blank line and
 * an "Invalid `prisma.x()` invocation:" preamble; the cause comes after it.
 */
export function summarizeError(error) {
  const text = String(error?.message ?? error ?? "unknown error")
    .replace(/Invalid `prisma\.[^`]*` invocation:/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "unknown error").slice(0, 500);
}
