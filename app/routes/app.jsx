import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  // eslint-disable-next-line no-undef
  console.log("[app.jsx] LOADER start", {
    path: url.pathname,
    hasIdToken: url.searchParams.has("id_token"),
    hasShop: url.searchParams.has("shop"),
    embedded: url.searchParams.get("embedded"),
  });
  try {
    const result = await authenticate.admin(request);
    // eslint-disable-next-line no-undef
    console.log("[app.jsx] auth SUCCESS", {
      shop: result?.session?.shop,
      hasAccessToken: !!result?.session?.accessToken,
    });
  } catch (e) {
    if (e instanceof Response) {
      // eslint-disable-next-line no-undef
      console.log("[app.jsx] auth THROWN RESPONSE", {
        status: e.status,
        location: e.headers.get("location"),
        reauth: e.headers.get("x-shopify-api-request-failure-reauthorize"),
      });
    } else {
      // eslint-disable-next-line no-undef
      console.error("[app.jsx] auth THROWN ERROR", e?.message, e?.stack);
    }
    throw e;
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/discounts">Discounts list</s-link>
        <s-link href="/app/combined-discount">Create combined discount</s-link>
        <s-link href="/app/additional">Additional page</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
