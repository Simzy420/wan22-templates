export const RUNPOD_BILLING_URL = "https://console.runpod.io/user/billing";

/**
 * Rows for #runpod-balance. Old responses with only `balance` still render one line.
 * A balance under $1 is `low` so the phone can show it in red.
 */
export function balanceRows(data) {
  const source =
    Array.isArray(data?.accounts) && data.accounts.length
      ? data.accounts
      : data && typeof data.balance === "number"
        ? [{ label: "Runpod 1", balance: data.balance, spendPerHour: data.spendPerHour }]
        : [];
  return source.map((account) => {
    const label = typeof account?.label === "string" && account.label.trim() ? account.label.trim() : "Runpod";
    const known = typeof account?.balance === "number" && Number.isFinite(account.balance);
    const spend =
      known && typeof account.spendPerHour === "number" && Number.isFinite(account.spendPerHour)
        ? ` · $${account.spendPerHour.toFixed(3)}/hr`
        : "";
    return {
      label,
      text: known ? `${label} $${account.balance.toFixed(2)}${spend}` : `${label} unavailable`,
      low: known && account.balance < 1,
      href: RUNPOD_BILLING_URL,
    };
  });
}
