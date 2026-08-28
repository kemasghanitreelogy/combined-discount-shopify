/**
 * Shared vocabulary between the admin UI, the orders webhook and the Rust
 * discount function. Everything the function reads is written from here.
 */

export const FUNCTION_HANDLE = "combined-discount";

/** Discount metafield holding the function configuration. */
export const CONFIG_NAMESPACE = "$app";
export const CONFIG_KEY = "function-configuration";

/**
 * Customer metafield holding the projected purchase history and redemption
 * counters. One metafield for every campaign, so the function makes a single
 * read per cart.
 */
export const CUSTOMER_STATE_NAMESPACE = "$app";
export const CUSTOMER_STATE_KEY = "combined-discount-state";

/**
 * The function input schema exposes no discount ID, so each discount carries a
 * generated key in its own configuration. That key namespaces the campaign's
 * counters inside the shared customer state metafield.
 */
export function newCampaignKey() {
  const random = Math.random().toString(36).slice(2, 10);
  return `cd_${Date.now().toString(36)}${random}`;
}

/** Normalises an ISO timestamp or date to the `YYYY-MM-DD` day the function compares. */
export function toDay(value) {
  if (!value) return null;
  const text = typeof value === "string" ? value : new Date(value).toISOString();
  const day = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Returns the earlier of two `YYYY-MM-DD` days, ignoring blanks. */
export function earlierDay(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

export function parseIdList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
  } catch {
    // Fall through to the comma-separated form used by the hidden form fields.
  }
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reads the per-campaign entry out of a customer state document.
 * Campaigns are stored as an array rather than a keyed object because the
 * function's deserializer handles arrays of structs, not maps.
 */
export function findCampaignState(state, campaignKey) {
  if (!state || !Array.isArray(state.campaigns)) return null;
  return state.campaigns.find((entry) => entry?.key === campaignKey) ?? null;
}

/** Returns a new state document with `campaignKey`'s entry merged in. */
export function upsertCampaignState(state, campaignKey, patch) {
  const base = state && typeof state === "object" ? state : {};
  const campaigns = Array.isArray(base.campaigns) ? [...base.campaigns] : [];
  const index = campaigns.findIndex((entry) => entry?.key === campaignKey);
  const existing = index >= 0 ? campaigns[index] : { key: campaignKey };
  const merged = { ...existing, key: campaignKey, ...patch };
  if (index >= 0) campaigns[index] = merged;
  else campaigns.push(merged);
  return { ...base, campaigns };
}

/**
 * Strips the state document down to what the function actually deserializes.
 * Keeps the metafield small and stops unknown keys from breaking the strict
 * Rust deserializer if the shape ever drifts.
 */
export function serializeCustomerState(state) {
  const out = {};
  const firstPurchaseAt = toDay(state?.firstPurchaseAt);
  if (firstPurchaseAt) out.firstPurchaseAt = firstPurchaseAt;
  const campaigns = (Array.isArray(state?.campaigns) ? state.campaigns : [])
    .filter((entry) => entry?.key)
    .map((entry) => {
      const item = { key: String(entry.key) };
      const qualifiedAt = toDay(entry.qualifiedAt);
      if (qualifiedAt) item.qualifiedAt = qualifiedAt;
      const uses = Number(entry.uses);
      if (Number.isFinite(uses) && uses > 0) item.uses = Math.trunc(uses);
      return item;
    })
    .filter((entry) => entry.qualifiedAt || entry.uses);
  if (campaigns.length) out.campaigns = campaigns;
  return out;
}
