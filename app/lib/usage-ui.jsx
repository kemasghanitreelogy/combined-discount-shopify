/** Presentation helpers shared by the usage overview and drill-down pages. */

export function legacyId(gid) {
  return String(gid || "")
    .split("/")
    .pop();
}

export function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatMoney(money) {
  if (!money) return "—";
  const amount = Number(money.amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: money.currencyCode,
    }).format(amount);
  } catch {
    return `${amount} ${money.currencyCode}`;
  }
}

const STATUS_TONE = {
  at_limit: "critical",
  near_limit: "warning",
  ok: "success",
  unlimited: "neutral",
};

/** Words, not just colour: every status reads on its own. */
export function statusText(uses, limit) {
  if (limit == null) return `${uses}× · no limit`;
  if (uses >= limit) return `${uses} / ${limit} · at limit`;
  const left = limit - uses;
  return `${uses} / ${limit} · ${left} left`;
}

export function UsageBadge({ label, uses, limit, status }) {
  return (
    <s-badge tone={STATUS_TONE[status] ?? "neutral"}>
      {label ? `${label}: ` : ""}
      {statusText(uses, limit)}
    </s-badge>
  );
}

const STATUS_LABEL = {
  at_limit: "At limit",
  near_limit: "1 left",
  ok: "Within limit",
  unlimited: "No limit",
};

export function StatusBadge({ status }) {
  return (
    <s-badge tone={STATUS_TONE[status] ?? "neutral"}>
      {STATUS_LABEL[status] ?? status}
    </s-badge>
  );
}

export function StatTile({ label, value, help }) {
  return (
    <s-box padding="base" border-radius="base" background="subdued">
      <s-stack direction="block" gap="small-100">
        <s-text tone="neutral">{label}</s-text>
        <s-heading>{value}</s-heading>
        {help ? <s-text tone="neutral">{help}</s-text> : null}
      </s-stack>
    </s-box>
  );
}
