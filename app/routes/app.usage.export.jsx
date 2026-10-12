import { authenticate } from "../shopify.server";
import {
  buildUsageReport,
  parseFilters,
  withCustomerDetails,
} from "../lib/usage-report.server";

function csvCell(value) {
  if (value == null) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  // Quote everything that could break a row, and defuse spreadsheet formulas.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV of the overview as currently filtered — every page, not just the visible one. */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const filters = parseFilters(new URL(request.url));
  const report = await buildUsageReport({
    admin,
    shop: session.shop,
    ...filters,
  });
  const rows = await withCustomerDetails(admin, report.rows);

  const lines = [
    [
      "Customer ID",
      "Name",
      "Email",
      "Status",
      "Total uses",
      "Discount",
      "Discount uses",
      "Limit",
      "First used",
      "Last used",
    ],
  ];
  for (const r of rows) {
    for (const c of r.campaigns) {
      lines.push([
        r.customerId.split("/").pop(),
        r.name,
        r.email,
        c.status,
        r.totalUses,
        c.code || c.title,
        c.uses,
        c.limit ?? "",
        r.firstUsedAt,
        r.lastUsedAt,
      ]);
    }
  }

  const body = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="discount-usage.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
