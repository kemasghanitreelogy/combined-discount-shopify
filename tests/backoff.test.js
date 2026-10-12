import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTEMPTS,
  nextDelayMs,
  shouldGiveUp,
} from "../app/lib/sync/backoff.js";

const mid = () => 0.5; // no jitter

test("exponential from 30 s", () => {
  assert.equal(nextDelayMs(1, null, mid), 30_000);
  assert.equal(nextDelayMs(2, null, mid), 60_000);
  assert.equal(nextDelayMs(5, null, mid), 480_000);
});

test("capped at one hour", () => {
  assert.equal(nextDelayMs(30, null, mid), 3_600_000);
});

test("jitter stays within ±20 %", () => {
  assert.equal(
    nextDelayMs(1, null, () => 0),
    24_000,
  );
  assert.equal(
    nextDelayMs(1, null, () => 0.999999),
    36_000,
  );
});

test("Retry-After wins, but is capped", () => {
  assert.equal(nextDelayMs(1, 5_000, mid), 5_000);
  assert.equal(nextDelayMs(1, 10 * 3_600_000, mid), 3_600_000);
});

test("gives up on permanent errors at once, on retryable ones after the cap", () => {
  assert.equal(shouldGiveUp({ attempts: 1, retryable: false }), true);
  assert.equal(
    shouldGiveUp({ attempts: MAX_ATTEMPTS - 1, retryable: true }),
    false,
  );
  assert.equal(shouldGiveUp({ attempts: MAX_ATTEMPTS, retryable: true }), true);
});

test("summarizeError keeps the cause of a Prisma error on one line", async () => {
  const { summarizeError } = await import("../app/lib/sync/backoff.js");
  const prisma = new Error(
    "\nInvalid `prisma.discountRedemption.groupBy()` invocation:\n\n\nCan't reach database server at `host:5432`\n\nPlease make sure your database server is running.",
  );
  assert.equal(
    summarizeError(prisma),
    "Can't reach database server at `host:5432` Please make sure your database server is running.",
  );
  assert.equal(summarizeError({ message: "" }), "unknown error");
  assert.equal(summarizeError("x".repeat(900)).length, 500);
});
