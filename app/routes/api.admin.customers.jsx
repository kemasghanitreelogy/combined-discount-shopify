import { unauthenticated } from "../shopify.server";
import { checkAdminSecret, resolveAdminShop } from "../lib/admin-auth.server";
import { GrantError, grantEligibleCustomer } from "../lib/admin-grant.server";

/**
 * POST /api/admin/customers — create (or reuse) a customer and make them
 * eligible for the combined discount without any real order history.
 *
 * Called server-to-server by the Treelogy Workspace admin system; gated by
 * the shared secret in `X-Admin-Secret` (see admin-auth.server.js).
 *
 * Contract and failure modes: see ADMIN_ELIGIBLE_CUSTOMER_FLOW.md §3.2.
 *   401 wrong secret · 422 Shopify userErrors / bad input · 409 no matching
 *   campaign · 500 DB/metafield write failed (safe to retry, idempotent).
 */

const json = (body, status = 200) => Response.json(body, { status });

export const loader = () => json({ error: "method not allowed" }, 405);

export const action = async ({ request }) => {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = checkAdminSecret(request);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const shop = await resolveAdminShop(body?.shop);
  if (!shop) {
    return json({ error: "shop could not be determined; pass `shop` or set ADMIN_SHOP_DOMAIN" }, 400);
  }

  let admin;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    console.error(`No offline session for ${shop}:`, error);
    return json({ error: `no offline session for ${shop}` }, 500);
  }

  try {
    const result = await grantEligibleCustomer({ admin, shop, input: body });
    console.log(`Admin grant for ${shop}:`, JSON.stringify(result));
    return json(result);
  } catch (error) {
    if (error instanceof GrantError) {
      return json({ error: error.message, userErrors: error.userErrors }, error.status);
    }
    console.error(`Admin grant failed for ${shop}:`, error);
    return json({ error: `grant failed: ${error?.message ?? "unknown error"}` }, 500);
  }
};
