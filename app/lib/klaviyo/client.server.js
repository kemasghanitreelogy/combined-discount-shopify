/**
 * Minimal Klaviyo REST transport.
 *
 * It never retries by itself: the outbox owns retries, so a failure here is
 * recorded, backed off and survives a restart instead of looping in memory.
 * What it does do is say *whether* a failure is worth retrying.
 */

const BASE_URL = "https://a.klaviyo.com/api";
// Pinned so a Klaviyo release can't change payload semantics under us.
export const KLAVIYO_REVISION = "2026-07-15";
const TIMEOUT_MS = 10_000;

export class KlaviyoError extends Error {
  constructor(message, { status = null, retryable, retryAfterMs = null } = {}) {
    super(message);
    this.name = "KlaviyoError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function klaviyoApiKey() {
  return process.env.KLAVIYO_PRIVATE_API_KEY || null;
}

export function klaviyoEnabled() {
  return Boolean(klaviyoApiKey());
}

function retryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(at - Date.now(), 0) : null;
}

function errorDetail(body) {
  const first = body?.errors?.[0];
  if (!first) return "";
  return [first.code, first.detail || first.title].filter(Boolean).join(": ");
}

/**
 * Sends one request. Resolves to the parsed body (or null for 202/204);
 * rejects with a KlaviyoError carrying `retryable`.
 */
export async function klaviyoRequest(method, path, body = undefined) {
  const key = klaviyoApiKey();
  if (!key)
    throw new KlaviyoError("KLAVIYO_PRIVATE_API_KEY is not set", {
      retryable: false,
    });

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        accept: "application/vnd.api+json",
        "content-type": "application/vnd.api+json",
        revision: KLAVIYO_REVISION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // DNS, TCP reset, TLS, timeout: the network, not the request, is at fault.
    throw new KlaviyoError(
      `${method} ${path}: ${error.cause?.code || error.name}: ${error.message}`,
      {
        retryable: true,
      },
    );
  }

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (response.ok) return parsed;

  const status = response.status;
  throw new KlaviyoError(
    `${method} ${path} → ${status}${errorDetail(parsed) ? ` ${errorDetail(parsed)}` : ""}`,
    {
      status,
      retryable: status === 408 || status === 429 || status >= 500,
      retryAfterMs: retryAfterMs(response),
    },
  );
}
