import { authenticate } from "../shopify.server";
import { projectOrder } from "../lib/purchase-projection.server";

/**
 * Keeps each customer's `$app:combined-discount-state` metafield in step with
 * their order history. The Rust discount function reads that metafield to
 * enforce the "purchased before <date>" gate and the per-customer order cap —
 * Functions are pure, so they cannot look any of this up themselves.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  if (!admin) {
    // The app has been uninstalled; nothing left to project onto.
    console.log(`Ignoring ${topic} for ${shop}: no admin context`);
    return new Response();
  }

  try {
    const result = await projectOrder({ admin, shop, payload });
    console.log(`Projected ${topic} for ${shop}:`, JSON.stringify(result));
  } catch (error) {
    // Returning 500 asks Shopify to retry, which is what we want for a
    // transient Admin API failure or a lost compare-and-swap race.
    console.error(`Failed to project ${topic} for ${shop}:`, error);
    return new Response("projection failed", { status: 500 });
  }

  return new Response();
};
