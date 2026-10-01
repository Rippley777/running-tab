export const money = (cents: number, decimals = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  }).format(cents / 100);
export const hours = (seconds: number) => `${(seconds / 3600).toFixed(1)}h`;
export const duration = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)
    .toString()
    .padStart(2, "0")}:${Math.floor((s % 3600) / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
};
export const day = (date: string, tz = "America/Chicago") =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
  }).format(new Date(date));
export const fullDay = (date: string, tz = "America/Chicago") =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
export const time = (date: string, tz = "America/Chicago") =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
export const modelLabel: Record<string, string> = {
  hourly: "Hourly",
  fixed: "Fixed price",
  prepaid: "Prepaid hours",
  support: "Recurring support",
};
export const statusLabel: Record<string, string> = {
  draft: "Draft",
  review: "Needs approval",
  approved: "Approved",
  local: "Draft",
  queued: "Queued",
  issued: "Issued",
  paid: "Paid",
  unpaid: "Awaiting payment",
  failed: "Payment failed",
  authentication_required: "Authentication needed",
  partial: "Partially paid",
  refunded: "Refunded",
  disputed: "Needs reconciliation",
  void: "Void",
  processing: "Processing",
  prepaid: "Prepaid coverage",
  nonbillable: "Non-billable",
  overage: "Overage review",
  written_off: "Written off",
};
export function invoiceStatus(i: {
  issuance_state: string;
  collection_state: string;
  approval_state: string;
  due_at: string;
}) {
  if (i.issuance_state === "void") return "void";
  if (i.collection_state !== "unpaid") return i.collection_state;
  if (i.issuance_state === "issued" && new Date(i.due_at) < new Date())
    return "overdue";
  return i.issuance_state === "local"
    ? i.approval_state
    : i.issuance_state === "queued"
      ? "queued"
      : "unpaid";
}
export function parseMoney(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new Error("Enter a dollar amount with up to two decimal places.");
  const [d, c = ""] = value.split(".");
  return Number(d) * 100 + Number(c.padEnd(2, "0"));
}
export function dateRange(
  mode = "week",
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  weekStart = 1,
) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const now = new Date(`${today}T12:00:00Z`),
    from = new Date(now),
    to = new Date(now);
  if (mode === "week")
    from.setUTCDate(now.getUTCDate() - ((now.getUTCDay() - weekStart + 7) % 7));
  else from.setUTCDate(1);
  to.setUTCDate(now.getUTCDate() + 1);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}
