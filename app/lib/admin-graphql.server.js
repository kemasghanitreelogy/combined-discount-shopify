/**
 * Admin API calls that survive Shopify's rate limiter.
 *
 * Shopify meters the Admin API with a leaky bucket and answers `THROTTLED`
 * when it is empty. Without a retry the caller sees a plain failure, and in
 * this app that means an `orders/create` webhook returning 500. Shopify then
 * redelivers, which adds load to an API that is already refusing work — during
 * an order burst that feedback loop is what turns a brief throttle into lost
 * redemptions once redelivery gives up.
 */

const THROTTLE_BASE_MS = 1000;
const MAX_ATTEMPTS = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(json) {
  return (json?.errors ?? []).some(
    (e) => e?.extensions?.code === "THROTTLED" || /throttled/i.test(e?.message ?? ""),
  );
}

/** Seconds until the bucket holds `cost`, from the throttle status Shopify returns. */
function waitForCapacity(json, attempt) {
  const status = json?.extensions?.cost?.throttleStatus;
  const requested = json?.extensions?.cost?.requestedQueryCost;
  if (status?.restoreRate > 0 && requested > 0) {
    const deficit = requested - (status.currentlyAvailable ?? 0);
    if (deficit > 0) {
      // Cap it so a wildly expensive query can't stall a webhook indefinitely.
      return Math.min(Math.ceil((deficit / status.restoreRate) * 1000) + 250, 10000);
    }
  }
  return THROTTLE_BASE_MS * 2 ** attempt;
}

/**
 * Runs a GraphQL operation, backing off and retrying while Shopify throttles.
 *
 * Only throttling is retried. Everything else — bad query, missing scope,
 * userErrors — is the caller's to handle, and retrying those would just burn
 * the same budget again.
 *
 * @returns the parsed JSON body
 */
export async function adminGraphql(admin, query, variables = undefined) {
  let last = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    const json = await response.json();
    last = json;

    if (!isThrottled(json)) return json;

    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(waitForCapacity(json, attempt));
    }
  }

  throw new Error(
    `Shopify kept throttling after ${MAX_ATTEMPTS} attempts: ` +
      (last?.errors ?? []).map((e) => e.message).join("; "),
  );
}
