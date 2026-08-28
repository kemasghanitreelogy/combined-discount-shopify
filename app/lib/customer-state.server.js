import {
  CUSTOMER_STATE_KEY,
  CUSTOMER_STATE_NAMESPACE,
  serializeCustomerState,
} from "./combined-discount.server";

const READ_CUSTOMER_STATE = `#graphql
  query CombinedDiscountCustomerState($id: ID!, $namespace: String!, $key: String!) {
    customer(id: $id) {
      id
      metafield(namespace: $namespace, key: $key) {
        jsonValue
        compareDigest
      }
    }
  }`;

const WRITE_CUSTOMER_STATE = `#graphql
  mutation CombinedDiscountSetCustomerState($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        compareDigest
      }
      userErrors {
        field
        message
        code
      }
    }
  }`;

/** Reads the state document plus the digest needed to write it back safely. */
export async function readCustomerState(admin, customerId) {
  const response = await admin.graphql(READ_CUSTOMER_STATE, {
    variables: {
      id: customerId,
      namespace: CUSTOMER_STATE_NAMESPACE,
      key: CUSTOMER_STATE_KEY,
    },
  });
  const json = await response.json();
  if (json?.errors?.length) {
    throw new Error(
      `Reading customer state failed: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const metafield = json?.data?.customer?.metafield ?? null;
  return {
    exists: Boolean(json?.data?.customer),
    state: metafield?.jsonValue ?? null,
    compareDigest: metafield?.compareDigest ?? null,
  };
}

/**
 * Read-modify-write of the customer state metafield under compare-and-swap.
 *
 * Orders arrive concurrently and every one of them mutates the same document,
 * so a blind write would silently drop a redemption. `compareDigest` makes the
 * write fail with `STALE_OBJECT` instead, and we replay `mutate` against the
 * value that won.
 *
 * @param {(state: object|null) => object|null} mutate receives the current
 *   document and returns the next one, or `null` to leave it untouched.
 */
export async function updateCustomerState(admin, customerId, mutate, attempts = 4) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { exists, state, compareDigest } = await readCustomerState(admin, customerId);
    if (!exists) {
      throw new Error(`Customer ${customerId} not found`);
    }

    const next = mutate(state);
    if (next === null || next === undefined) {
      return { skipped: true, state };
    }

    const serialized = serializeCustomerState(next);
    const response = await admin.graphql(WRITE_CUSTOMER_STATE, {
      variables: {
        metafields: [
          {
            ownerId: customerId,
            namespace: CUSTOMER_STATE_NAMESPACE,
            key: CUSTOMER_STATE_KEY,
            type: "json",
            value: JSON.stringify(serialized),
            // Omitted on first write: there is no prior value to compare against.
            ...(compareDigest ? { compareDigest } : {}),
          },
        ],
      },
    });
    const json = await response.json();
    const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];

    if (!userErrors.length && !json?.errors?.length) {
      return { skipped: false, state: serialized };
    }

    const stale = userErrors.some(
      (e) => e.code === "STALE_OBJECT" || e.code === "INVALID_COMPARE_DIGEST",
    );
    lastError = [
      ...userErrors.map((e) => `${e.code ?? "ERROR"}: ${e.message}`),
      ...(json?.errors ?? []).map((e) => e.message),
    ].join("; ");

    if (!stale) break;
    // Someone else won the race — re-read and replay the mutation.
  }

  throw new Error(`Writing customer state failed: ${lastError ?? "unknown error"}`);
}
