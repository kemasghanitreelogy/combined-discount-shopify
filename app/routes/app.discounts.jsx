import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const FUNCTION_HANDLE = "combined-discount";

async function findCombinedDiscountFunctionId(admin) {
  const response = await admin.graphql(
    `#graphql
      query FindFunction {
        shopifyFunctions(first: 50) {
          nodes { id title apiType }
        }
      }`,
  );
  const json = await response.json();
  const nodes = json?.data?.shopifyFunctions?.nodes ?? [];
  const match = nodes.find(
    (fn) =>
      fn.apiType === "discount" &&
      (fn.title === FUNCTION_HANDLE || fn.title?.includes("combined-discount")),
  );
  return match?.id ?? null;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const functionId = await findCombinedDiscountFunctionId(admin);

  const response = await admin.graphql(
    `#graphql
      query CombinedDiscounts {
        discountNodes(first: 100) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountCodeApp {
                title
                status
                startsAt
                endsAt
                discountClasses
                appliesOncePerCustomer
                appDiscountType { functionId }
                codes(first: 1) { nodes { code } }
              }
              ... on DiscountAutomaticApp {
                title
                status
                startsAt
                endsAt
                discountClasses
                appDiscountType { functionId }
              }
            }
          }
        }
      }`,
  );
  const json = await response.json();
  const graphqlErrors = json?.errors ?? [];
  const rawNodes = json?.data?.discountNodes?.nodes ?? [];
  const nodes = rawNodes
    .filter(
      (n) =>
        n.discount?.__typename === "DiscountCodeApp" ||
        n.discount?.__typename === "DiscountAutomaticApp",
    )
    .map((n) => ({ id: n.id, codeDiscount: n.discount }));
  const appNodes = nodes;
  const matchingFunctionId = (id) =>
    !functionId || !id ? true : String(id) === String(functionId);

  const rows = appNodes
    .filter((n) => matchingFunctionId(n.codeDiscount.appDiscountType?.functionId))
    .map((n) => {
      const d = n.codeDiscount;
      const isAutomatic = d?.__typename === "DiscountAutomaticApp";
      return {
        id: n.id,
        method: isAutomatic ? "Automatic" : "Code",
        code: isAutomatic ? "—" : d.codes?.nodes?.[0]?.code ?? "(no code)",
        title: d.title ?? "",
        status: d.status ?? "",
        startsAt: d.startsAt ?? null,
        endsAt: d.endsAt ?? null,
        discountClasses: d.discountClasses ?? [],
        appliesOncePerCustomer: Boolean(d.appliesOncePerCustomer),
        fnId: d.appDiscountType?.functionId ?? null,
      };
    });

  return {
    rows,
    functionId,
    totalAppDiscounts: appNodes.length,
    totalAll: nodes.length,
    graphqlErrors: graphqlErrors.map((e) => e.message).slice(0, 5),
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const id = String(formData.get("id") || "");

  if (intent !== "delete" || !id) {
    return { userErrors: [{ message: "Invalid request." }] };
  }

  const isAutomatic = String(id).includes("DiscountAutomaticNode");
  if (isAutomatic) {
    const response = await admin.graphql(
      `#graphql
        mutation DeleteAutomatic($id: ID!) {
          discountAutomaticDelete(id: $id) {
            deletedAutomaticDiscountId
            userErrors { field message }
          }
        }`,
      { variables: { id } },
    );
    const json = await response.json();
    return {
      deletedId: json?.data?.discountAutomaticDelete?.deletedAutomaticDiscountId ?? null,
      userErrors: json?.data?.discountAutomaticDelete?.userErrors ?? [],
    };
  }

  const response = await admin.graphql(
    `#graphql
      mutation DeleteDiscount($id: ID!) {
        discountCodeDelete(id: $id) {
          deletedCodeDiscountId
          userErrors { field message }
        }
      }`,
    { variables: { id } },
  );
  const json = await response.json();
  return {
    deletedId: json?.data?.discountCodeDelete?.deletedCodeDiscountId ?? null,
    userErrors: json?.data?.discountCodeDelete?.userErrors ?? [],
  };
};

function statusTone(status) {
  if (status === "ACTIVE") return "success";
  if (status === "EXPIRED") return "critical";
  if (status === "SCHEDULED") return "info";
  return "neutral";
}

function formatDate(value) {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

export default function DiscountsList() {
  const { rows, functionId, totalAppDiscounts, totalAll, graphqlErrors } = useLoaderData();
  const deleteFetcher = useFetcher();

  const onDelete = (id) => {
    const form = new FormData();
    form.set("intent", "delete");
    form.set("id", id);
    deleteFetcher.submit(form, { method: "POST" });
  };

  const isDeleting = deleteFetcher.state === "submitting";

  return (
    <s-page heading="Combined discounts">
      <s-button slot="primary-action" href="/app/combined-discount">
        Create combined discount
      </s-button>

      <s-section heading={`${rows.length} code(s) created by this app`}>
        {rows.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              No combined discounts yet. Create one to get started.
            </s-paragraph>
            <s-button variant="primary" href="/app/combined-discount">
              Create combined discount
            </s-button>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header list-slot="primary">Code</s-table-header>
              <s-table-header>Title</s-table-header>
              <s-table-header>Method</s-table-header>
              <s-table-header list-slot="inline">Status</s-table-header>
              <s-table-header>Types</s-table-header>
              <s-table-header>Starts</s-table-header>
              <s-table-header>Ends</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/discounts/${encodeURIComponent(r.id)}`}>
                      <s-text type="strong">{r.code}</s-text>
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/discounts/${encodeURIComponent(r.id)}`}>
                      {r.title}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={r.method === "Automatic" ? "info" : "neutral"}>
                      {r.method}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(r.status)}>{r.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-100">
                      {r.discountClasses.length === 0 ? (
                        <s-text tone="neutral">—</s-text>
                      ) : (
                        r.discountClasses.map((c) => (
                          <s-badge key={c}>{c}</s-badge>
                        ))
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatDate(r.startsAt)}</s-table-cell>
                  <s-table-cell>{formatDate(r.endsAt)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-100">
                      <s-button
                        variant="tertiary"
                        href={`/app/combined-discount?id=${encodeURIComponent(r.id)}`}
                      >
                        Edit
                      </s-button>
                      <s-button
                        variant="tertiary"
                        onClick={() => onDelete(r.id)}
                        {...(isDeleting ? { loading: true } : {})}
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="About this list">
        <s-paragraph>
          Only code discounts created by the combined-discount Shopify Function appear here.
          Native Shopify discounts are not included.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Debug">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            <s-text type="strong">Function ID:</s-text> {functionId || "(not found)"}
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">App-type discounts in shop:</s-text> {totalAppDiscounts}
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">All code discounts scanned:</s-text> {totalAll}
          </s-paragraph>
          {graphqlErrors?.length ? (
            <s-paragraph tone="critical">
              GraphQL errors: {graphqlErrors.join("; ")}
            </s-paragraph>
          ) : null}
        </s-stack>
      </s-section>

      {deleteFetcher.data?.userErrors?.length ? (
        <s-section heading="Errors">
          <s-box padding="base" border-radius="base" background="subdued">
            <pre style={{ margin: 0 }}>
              <code>{JSON.stringify(deleteFetcher.data.userErrors, null, 2)}</code>
            </pre>
          </s-box>
        </s-section>
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
