export function tokenValue(usage, key) {
    return Number(usage?.[key] || 0);
}
export function formatTokenCount(value) {
    return new Intl.NumberFormat("en-US").format(Number(value || 0));
}
export function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
export function formatTokenUsage(usage) {
    const input = formatTokenCount(tokenValue(usage, "inputTokens"));
    const cached = formatTokenCount(tokenValue(usage, "cachedInputTokens"));
    const output = formatTokenCount(tokenValue(usage, "outputTokens"));
    return `in ${input} / cache ${cached} / out ${output}`;
}
export function formatPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return "--";
    }
    return `${Math.round(number)}%`;
}
export function formatRemainingPercent(usedPercent) {
    const used = Number(usedPercent);
    if (!Number.isFinite(used)) {
        return "--";
    }
    const remaining = Math.max(0, Math.min(100, 100 - used));
    return `${Math.round(remaining)}%`;
}
export function formatLimitReset(value) {
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
