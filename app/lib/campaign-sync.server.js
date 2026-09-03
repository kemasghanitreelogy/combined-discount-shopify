import db from "../db.server";
import { adminGraphql } from "./admin-graphql.server";

const SYNC_QUERY = `#graphql
  query CombinedDiscountCampaignSync($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on DiscountCodeNode {
        id
        codeDiscount {
          ... on DiscountCodeApp {
            title
            status
            codes(first: 1) {
              nodes {
                code
              }
            }
          }
        }
      }
      ... on DiscountAutomaticNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticApp {
            title
            status
          }
        }
      }
    }
  }`;

/**
 * Realigns each campaign row with the discount it points at.
 *
 * Orders identify a discount only by the code the shopper typed, or by the
 * title for automatic discounts — Shopify exposes no discount ID on
 * `discountApplications`. So matching has to go through code/title, and a
 * merchant renaming either one directly in the Shopify admin (rather than
 * through this app) would silently stop every redemption from being counted:
 * no error, no failed webhook, just a cap that quietly stops enforcing.
 *
 * `discountId` is the one identifier that never changes, so it is the anchor.
 * Re-reading code and title from it before matching turns that silent failure
 * into a self-healing one.
 *
 * A discount that has been deleted in Shopify comes back as a null node; its
 * campaign is archived so it stops participating without losing its ledger.
 */
export async function syncCampaigns(admin, shop, campaigns) {
  if (!campaigns.length) return campaigns;

  const json = await adminGraphql(admin, SYNC_QUERY, {
    ids: campaigns.map((c) => c.discountId),
  });
  if (json?.errors?.length) {
    // Matching on the stored values is still better than dropping the order.
    console.warn(
      `Campaign sync failed for ${shop}: ${json.errors.map((e) => e.message).join("; ")}`,
    );
    return campaigns;
  }

  const live = new Map();
  for (const node of json?.data?.nodes ?? []) {
    if (!node?.id) continue;
    const discount = node.codeDiscount ?? node.automaticDiscount ?? {};
    live.set(node.id, {
      title: discount.title ?? null,
      code: discount.codes?.nodes?.[0]?.code ?? null,
      status: discount.status ?? null,
    });
  }

  const synced = [];
  for (const campaign of campaigns) {
    const current = live.get(campaign.discountId);

    if (!current) {
      await db.discountCampaign.update({
        where: { id: campaign.id },
        data: { archived: true },
      });
      console.warn(
        `Campaign ${campaign.campaignKey} archived: ${campaign.discountId} no longer exists`,
      );
      continue;
    }

    const drifted =
      (current.title ?? campaign.title) !== campaign.title ||
      (current.code ?? null) !== (campaign.code ?? null);

    if (drifted) {
      const data = {
        title: current.title ?? campaign.title,
        code: current.code ?? null,
      };
      await db.discountCampaign.update({ where: { id: campaign.id }, data });
      console.log(
        `Campaign ${campaign.campaignKey} realigned: ` +
          `code ${campaign.code} -> ${data.code}, title "${campaign.title}" -> "${data.title}"`,
      );
      synced.push({ ...campaign, ...data });
    } else {
      synced.push(campaign);
    }
  }

  return synced;
}
