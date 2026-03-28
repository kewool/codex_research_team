type AnyObject = Record<string, any>;

export function tokenValue(usage: AnyObject | null | undefined, key: string): number {
  return Number(usage?.[key] || 0);
}

export function formatTokenCount(value: unknown): string {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatTokenUsage(usage: AnyObject | null | undefined): string {
  const input = formatTokenCount(tokenValue(usage, "inputTokens"));
  const cached = formatTokenCount(tokenValue(usage, "cachedInputTokens"));
  const output = formatTokenCount(tokenValue(usage, "outputTokens"));
  return `in ${input} / cache ${cached} / out ${output}`;
}

export function formatPercent(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }
  return `${Math.round(number)}%`;
}

export function formatRemainingPercent(usedPercent: unknown): string {
  const used = Number(usedPercent);
  if (!Number.isFinite(used)) {
    return "--";
  }
  const remaining = Math.max(0, Math.min(100, 100 - used));
  return `${Math.round(remaining)}%`;
}

export function formatLimitReset(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "No reset time";
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return "No reset time";
  }
  return `Resets ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}
