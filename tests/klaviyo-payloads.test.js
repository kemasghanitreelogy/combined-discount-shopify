import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REDEEMED_METRIC,
  campaignLabel,
  campaignProperties,
  listMembershipBody,
  profileImportBody,
  redemptionEventBody,
} from "../app/lib/klaviyo/payloads.js";

const campaign = {
  campaignKey: "ck1",
  code: "HARGATETAP",
  title: "Harga Tetap",
  maxOrdersPerCustomer: 3,
};

test("label prefers code, then title, then key", () => {
  assert.equal(campaignLabel(campaign), "HARGATETAP");
  assert.equal(campaignLabel({ title: "Auto", campaignKey: "k" }), "Auto");
  assert.equal(campaignLabel({ campaignKey: "k" }), "k");
});

test("properties match the names used by the 2026-10-12 import", () => {
  const props = campaignProperties(campaign, {
    uses: 1,
    firstUsedAt: new Date("2026-09-08T00:41:30.000Z"),
    lastUsedAt: "2026-09-08T00:41:30.000Z",
  });
  assert.deepEqual(props, {
    "HARGATETAP Uses": 1,
    "HARGATETAP Limit": 3,
    "HARGATETAP Uses Left": 2,
    "HARGATETAP First Used": "2026-09-08T00:41:30Z",
    "HARGATETAP Last Used": "2026-09-08T00:41:30Z",
  });
});

test("uses left never goes negative and is null without a limit", () => {
  assert.equal(
    campaignProperties(campaign, { uses: 5 })["HARGATETAP Uses Left"],
    0,
  );
  const unlimited = campaignProperties(
    { ...campaign, maxOrdersPerCustomer: null },
    { uses: 2 },
  );
  assert.equal(unlimited["HARGATETAP Uses Left"], null);
  assert.equal(unlimited["HARGATETAP Limit"], null);
});

test("zero uses (cancelled) clears the dates instead of leaving stale ones", () => {
  const props = campaignProperties(campaign, { uses: 0 });
  assert.equal(props["HARGATETAP Uses"], 0);
  assert.equal(props["HARGATETAP Uses Left"], 3);
  assert.equal(props["HARGATETAP First Used"], null);
  assert.equal(props["HARGATETAP Last Used"], null);
});

test("profile body is keyed by email and never carries consent", () => {
  const body = profileImportBody({
    email: "a@b.co",
    shopifyCustomerId: 42,
    campaigns: [
      {
        campaign,
        usage: {
          uses: 1,
          firstUsedAt: "2026-09-01T00:00:00Z",
          lastUsedAt: "2026-09-01T00:00:00Z",
        },
      },
    ],
  });
  assert.equal(body.data.type, "profile");
  assert.equal(body.data.attributes.email, "a@b.co");
  assert.equal(body.data.attributes.properties["Shopify Customer ID"], "42");
  assert.equal(body.data.attributes.properties["HARGATETAP Uses"], 1);
  assert.equal(JSON.stringify(body).includes("subscriptions"), false);
  assert.equal(JSON.stringify(body).includes("consent"), false);
});

test("list body lists profile ids", () => {
  assert.deepEqual(listMembershipBody(["p1", "p2"]), {
    data: [
      { type: "profile", id: "p1" },
      { type: "profile", id: "p2" },
    ],
  });
});

test("event is idempotent per order+campaign and reports uses at that order", () => {
  const order = {
    orderId: "gid://shopify/Order/123",
    orderedAt: new Date("2026-10-01T05:00:00.000Z"),
  };
  const a = redemptionEventBody({
    email: "a@b.co",
    campaign,
    order,
    usesAtOrder: 3,
  });
  const b = redemptionEventBody({
    email: "a@b.co",
    campaign,
    order,
    usesAtOrder: 3,
  });
  assert.deepEqual(a, b);
  const attrs = a.data.attributes;
  assert.equal(attrs.metric.data.attributes.name, REDEEMED_METRIC);
  assert.equal(attrs.unique_id, "gid://shopify/Order/123:ck1");
  assert.equal(attrs.time, "2026-10-01T05:00:00Z");
  assert.equal(attrs.properties.Code, "HARGATETAP");
  assert.equal(attrs.properties["Order ID"], "123");
  assert.equal(attrs.properties["Uses Left"], 0);
  assert.equal(attrs.properties["Limit Reached"], true);
});
