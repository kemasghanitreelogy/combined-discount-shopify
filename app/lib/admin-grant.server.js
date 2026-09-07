import db from "../db.server";
import { adminGraphql } from "./admin-graphql.server";
import {
  earlierDay,
  findCampaignState,
  toDay,
  upsertCampaignState,
} from "./combined-discount.server";
import { updateCustomerState } from "./customer-state.server";

/**
 * Admin-created customers that are eligible from day one.
 *
 * The Function derives eligibility from the customer state metafield, and the
 * `orders/create` projection recomputes that metafield from the Prisma facts.
 * So "make this customer eligible" has to land in BOTH places, facts first —
 * a metafield-only write survives exactly until the customer's first order,
 * at which point `projectOrder` finds no fact row and overwrites
 * `firstPurchaseAt` with the order day. That is the whole reason this lives in
 * the app instead of in whichever admin system is calling us.
 *
 * Idempotent by construction: existing customers are reused (not an error),
 * facts merge with `earlierDay`, the metafield write is compare-and-swap.
 */

/** Far enough in the past to pass any sane cutoff, and obviously not a real order day. */
export const SEED_SENTINEL = "2000-01-01";
export const ADMIN_CREATED_TAG = "admin-created";

export class GrantError extends Error {
  constructor(status, message, userErrors = []) {
    super(message);
    this.status = status;
    this.userErrors = userErrors;
  }
}

const FIND_CUSTOMER = `#graphql
  query AdminFindCustomerByEmail($query: String!) {
    customers(first: 5, query: $query) {
      nodes {
        id
        tags
        defaultEmailAddress {
          emailAddress
        }
      }
    }
  }`;

/**
 * Direct lookups — NOT the search index.
 *
 * `customers(query: "email:…")` reads Shopify's search index, which lags a
 * freshly created customer by seconds. The Workspace creates the customer and
 * calls us immediately, so the search missed it, we tried customerCreate, and
 * Shopify answered "Email has already been taken" (seen live, 7 of 14 rows on
 * the first real import). `customerByIdentifier` and `customer(id:)` read
 * the primary store and are consistent right away.
 */
const CUSTOMER_BY_EMAIL = `#graphql
  query AdminCustomerByEmail($identifier: CustomerIdentifierInput!) {
    customerByIdentifier(identifier: $identifier) {
      id
      tags
      defaultEmailAddress {
        emailAddress
      }
    }
  }`;

const CUSTOMER_BY_ID = `#graphql
  query AdminCustomerById($id: ID!) {
    customer(id: $id) {
      id
      tags
      defaultEmailAddress {
        emailAddress
      }
    }
  }`;

const CREATE_CUSTOMER = `#graphql
  mutation AdminCreateEligibleCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        tags
        defaultEmailAddress {
          emailAddress
        }
      }
      userErrors {
        field
        message
      }
    }
  }`;

const ADD_TAGS = `#graphql
  mutation AdminTagEligibleCustomer($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const EMAIL_RE = /^[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z0-9-]{2,}$/i;

const uniq = (list) => [...new Set(list)];

function throwOnErrors(json, what) {
  if (json?.errors?.length) {
    throw new Error(`${what} failed: ${json.errors.map((e) => e.message).join("; ")}`);
  }
}

function mapCustomer(node) {
  return {
    id: String(node.id),
    email: String(node?.defaultEmailAddress?.emailAddress ?? "").toLowerCase(),
    tags: Array.isArray(node.tags) ? node.tags.map(String) : [],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exact-email lookup: direct identifier read first, search index as a fallback. */
async function findByEmail(admin, email) {
  const direct = await adminGraphql(admin, CUSTOMER_BY_EMAIL, {
    identifier: { emailAddress: email },
  });
  throwOnErrors(direct, "customer lookup");
  if (direct?.data?.customerByIdentifier) return mapCustomer(direct.data.customerByIdentifier);

  const json = await adminGraphql(admin, FIND_CUSTOMER, {
    query: `email:"${email.replace(/"/g, "")}"`,
  });
  throwOnErrors(json, "customer lookup");
  const nodes = json?.data?.customers?.nodes ?? [];
  return nodes.map(mapCustomer).find((c) => c.email === email) ?? null;
}

/** Lookup by GID; only trusted when the record's email is the one requested. */
async function findById(admin, customerId, email) {
  const json = await adminGraphql(admin, CUSTOMER_BY_ID, { id: customerId });
  throwOnErrors(json, "customer lookup");
  const node = json?.data?.customer;
  if (!node) return null;
  const customer = mapCustomer(node);
  return customer.email === email ? customer : null;
}

async function createCustomer(admin, { email, firstName, lastName, tags }) {
  const json = await adminGraphql(admin, CREATE_CUSTOMER, {
    input: {
      email,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      tags,
    },
  });
  throwOnErrors(json, "customerCreate");
  const payload = json?.data?.customerCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length || !payload?.customer) {
    // "Email has already been taken" means the customer exists but no lookup
    // saw it yet — re-read directly a few times before giving up.
    if (userErrors.some((e) => /already been taken/i.test(e?.message ?? ""))) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(1000 * (attempt + 1));
        const found = await findByEmail(admin, email);
        if (found) return found;
      }
    }
    throw new GrantError(
      422,
      `customerCreate rejected: ${userErrors.map((e) => e.message).join("; ") || "no customer returned"}`,
      userErrors,
    );
  }
  return mapCustomer(payload.customer);
}

async function ensureTags(admin, customer, wanted) {
  const have = new Set(customer.tags.map((t) => t.toLowerCase()));
  const missing = wanted.filter((t) => !have.has(t.toLowerCase()));
  if (!missing.length) return customer.tags;
  const json = await adminGraphql(admin, ADD_TAGS, { id: customer.id, tags: missing });
  throwOnErrors(json, "tagsAdd");
  const userErrors = json?.data?.tagsAdd?.userErrors ?? [];
  if (userErrors.length) {
    throw new GrantError(422, `tagsAdd rejected: ${userErrors.map((e) => e.message).join("; ")}`, userErrors);
  }
  return [...customer.tags, ...missing];
}

/**
 * @param {object} args
 * @param {object} args.admin   offline Admin API client for `shop`
 * @param {string} args.shop    myshopify domain the campaigns belong to
 * @param {object} args.input   { email, customerId?, firstName?, lastName?, tags?, campaignKeys?, seedDate? }
 *   `customerId` (GID) is optional and skips the email lookup when it matches.
 */
export async function grantEligibleCustomer({ admin, shop, input }) {
  const email = String(input?.email ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw new GrantError(422, "email is missing or invalid");

  const seedDate = input?.seedDate ? toDay(String(input.seedDate)) : SEED_SENTINEL;
  if (!seedDate) throw new GrantError(422, "seedDate must be YYYY-MM-DD");

  const firstName = String(input?.firstName ?? "").trim().slice(0, 120);
  const lastName = String(input?.lastName ?? "").trim().slice(0, 120);
  const tags = uniq(
    [ADMIN_CREATED_TAG, ...(Array.isArray(input?.tags) ? input.tags : [])]
      .map((t) => String(t).trim())
      .filter(Boolean),
  );
  const requestedKeys =
    Array.isArray(input?.campaignKeys) && input.campaignKeys.length
      ? input.campaignKeys.map(String)
      : null;

  // --- 1. campaigns ----------------------------------------------------------
  // Checked BEFORE touching Shopify: a rejected request (409) must not leave a
  // freshly created customer behind as a side effect.
  const active = await db.discountCampaign.findMany({ where: { shop, archived: false } });
  const campaigns = requestedKeys
    ? active.filter((c) => requestedKeys.includes(c.campaignKey))
    : active;
  if (requestedKeys && !campaigns.length) {
    throw new GrantError(409, "no active campaign matches campaignKeys");
  }

  // --- 2. customer ---------------------------------------------------------
  const givenId = typeof input?.customerId === "string" && /^gid:\/\/shopify\/Customer\/\d+$/.test(input.customerId)
    ? input.customerId
    : null;
  let customer = (givenId ? await findById(admin, givenId, email) : null) ?? (await findByEmail(admin, email));
  let created = false;
  if (customer) {
    customer = { ...customer, tags: await ensureTags(admin, customer, tags) };
  } else {
    customer = await createCustomer(admin, { email, firstName, lastName, tags });
    created = true;
  }

  // --- 3. facts — the source of truth, written BEFORE the read model --------
  const where = { shop_customerId: { shop, customerId: customer.id } };
  const existing = await db.customerPurchaseFact.findUnique({ where });

  const firstPurchaseDay = earlierDay(toDay(existing?.firstPurchaseAt ?? null), seedDate);
  let qualifiedAt = {};
  try {
    qualifiedAt = JSON.parse(existing?.qualifiedAt ?? "{}") || {};
  } catch {
    qualifiedAt = {};
  }
  for (const campaign of campaigns) {
    qualifiedAt[campaign.campaignKey] = earlierDay(
      toDay(qualifiedAt[campaign.campaignKey]),
      seedDate,
    );
  }

  await db.customerPurchaseFact.upsert({
    where,
    create: {
      shop,
      customerId: customer.id,
      firstPurchaseAt: new Date(`${firstPurchaseDay}T00:00:00.000Z`),
      qualifiedAt: JSON.stringify(qualifiedAt),
    },
    update: {
      firstPurchaseAt: new Date(`${firstPurchaseDay}T00:00:00.000Z`),
      qualifiedAt: JSON.stringify(qualifiedAt),
    },
  });

  // --- 4. read model -----------------------------------------------------------
  await updateCustomerState(admin, customer.id, (current) => {
    let next = {
      ...(current ?? {}),
      firstPurchaseAt: earlierDay(toDay(current?.firstPurchaseAt), seedDate),
    };
    for (const campaign of campaigns) {
      const state = findCampaignState(next, campaign.campaignKey);
      next = upsertCampaignState(next, campaign.campaignKey, {
        qualifiedAt: earlierDay(toDay(state?.qualifiedAt), seedDate),
        uses: state?.uses ?? 0,
      });
    }
    return next;
  });

  return {
    customerId: customer.id,
    created,
    seeded: {
      firstPurchaseAt: firstPurchaseDay,
      campaigns: campaigns.map((c) => ({
        key: c.campaignKey,
        qualifiedAt: qualifiedAt[c.campaignKey],
      })),
    },
    // Seeding firstPurchaseAt is still worth doing with no campaign saved yet —
    // it applies to every future campaign that gates on it — but the caller
    // should know the campaign list came back empty.
    warnings: active.length ? [] : ["no_active_campaign"],
  };
}
