import { timingSafeEqual } from "node:crypto";
import db from "../db.server";

/**
 * Server-to-server auth for the admin API routes.
 *
 * Those routes are called by the Treelogy Workspace backend, not by an
 * embedded admin page, so `authenticate.admin` cannot apply. A shared secret
 * in `X-Admin-Secret` (env `ADMIN_API_SECRET`) gates them instead; without it
 * anyone who found the URL could mint eligible customers.
 */
export function checkAdminSecret(request) {
  const expected = process.env.ADMIN_API_SECRET;
  if (!expected) return { ok: false, status: 503, error: "ADMIN_API_SECRET is not configured" };
  const given = request.headers.get("x-admin-secret") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

/**
 * Which shop to act on. Explicit `shop` in the body wins, then
 * `ADMIN_SHOP_DOMAIN`; otherwise the single installed shop. Ambiguity is an
 * error, not a guess — seeding the wrong shop's facts would be silent.
 */
export async function resolveAdminShop(bodyShop) {
  if (bodyShop) return String(bodyShop).trim().toLowerCase();
  if (process.env.ADMIN_SHOP_DOMAIN) return process.env.ADMIN_SHOP_DOMAIN;
  const shops = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  return shops.length === 1 ? shops[0].shop : null;
}
