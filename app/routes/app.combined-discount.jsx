import { useEffect, useState } from "react";
import { useFetcher, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const FUNCTION_HANDLE = "combined-discount";
const METAFIELD_NAMESPACE = "$app:function-configuration";
const METAFIELD_KEY = "function-configuration";

async function findCombinedDiscountFunctionId(admin) {
  const response = await admin.graphql(
    `#graphql
      query FindFunction {
        shopifyFunctions(first: 50) {
          nodes {
            id
            title
            apiType
            app {
              title
            }
          }
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
  return { functionId };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const code = String(formData.get("code") || "").trim();
  const title = String(formData.get("title") || "").trim();
  const amountOff = Number(formData.get("amountOff") || 0);
  const usageLimit = formData.get("usageLimit")
    ? Number(formData.get("usageLimit"))
    : null;

  if (!code || !title || !amountOff || amountOff <= 0) {
    return { userErrors: [{ message: "Code, title and amount off are required." }] };
  }

  const functionId = await findCombinedDiscountFunctionId(admin);
  if (!functionId) {
    return {
      userErrors: [
        {
          message:
            "Could not find the combined-discount function. Run `shopify app deploy` to register it with this shop.",
        },
      ],
    };
  }

  const response = await admin.graphql(
    `#graphql
      mutation CreateCombinedCode($codeAppDiscount: DiscountCodeAppInput!) {
        discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
          codeAppDiscount {
            discountId
            title
            status
            codes(first: 1) { nodes { code } }
          }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        codeAppDiscount: {
          title,
          code,
          functionId,
          appliesOncePerCustomer: false,
          discountClasses: ["ORDER", "SHIPPING"],
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: true,
            shippingDiscounts: false,
          },
          startsAt: new Date().toISOString(),
          ...(usageLimit ? { usageLimit } : {}),
          metafields: [
            {
              namespace: METAFIELD_NAMESPACE,
              key: METAFIELD_KEY,
              type: "json",
              value: JSON.stringify({ amountOff }),
            },
          ],
        },
      },
    },
  );
  const json = await response.json();
  const result = json?.data?.discountCodeAppCreate;
  return {
    codeAppDiscount: result?.codeAppDiscount ?? null,
    userErrors: result?.userErrors ?? [],
  };
};

export default function CombinedDiscount() {
  const loaderFetcher = useFetcher();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [code, setCode] = useState("SAVE100K");
  const [title, setTitle] = useState("100k off + Free Shipping");
  const [amountOff, setAmountOff] = useState("100000");
  const [usageLimit, setUsageLimit] = useState("");

  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.codeAppDiscount?.discountId) {
      shopify.toast.show("Combined discount created");
    } else if (fetcher.data?.userErrors?.length) {
      shopify.toast.show(fetcher.data.userErrors[0].message, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const submit = () => {
    const form = new FormData();
    form.set("code", code);
    form.set("title", title);
    form.set("amountOff", amountOff);
    if (usageLimit) form.set("usageLimit", usageLimit);
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <s-page heading="Combined discount">
      <s-section heading="Create one code: amount off + free shipping">
        <s-paragraph>
          Generates a single discount code that applies a fixed amount off the order
          subtotal <em>and</em> free shipping when a customer enters it at checkout.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          <s-text-field
            label="Code"
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <s-text-field
            label="Title (admin only)"
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <s-text-field
            label="Amount off (shop currency)"
            name="amountOff"
            type="number"
            value={amountOff}
            onChange={(e) => setAmountOff(e.target.value)}
          />
          <s-text-field
            label="Usage limit (optional)"
            name="usageLimit"
            type="number"
            value={usageLimit}
            onChange={(e) => setUsageLimit(e.target.value)}
          />
          <s-button
            onClick={submit}
            {...(isSubmitting ? { loading: true } : {})}
          >
            Create combined discount
          </s-button>
        </s-stack>

        {fetcher.data?.userErrors?.length ? (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="critical"
          >
            <pre style={{ margin: 0 }}>
              <code>{JSON.stringify(fetcher.data.userErrors, null, 2)}</code>
            </pre>
          </s-box>
        ) : null}

        {fetcher.data?.codeAppDiscount ? (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <pre style={{ margin: 0 }}>
              <code>
                {JSON.stringify(fetcher.data.codeAppDiscount, null, 2)}
              </code>
            </pre>
          </s-box>
        ) : null}
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-paragraph>
          Behind the scenes this app creates a Shopify Function discount with two
          targets: <code>cart.lines.discounts.generate.run</code> (amount off) and{" "}
          <code>cart.delivery-options.discounts.generate.run</code> (free shipping).
          The amount is stored in an app-owned JSON metafield on the discount.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
