function numericId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function parseIssueReference(value: string, webUrl: string): number | null {
  const reference = value.trim();
  if (!reference || reference.length > 4096) return null;
  if (/^[1-9]\d*$/.test(reference)) return numericId(reference);
  try {
    const base = new URL(webUrl);
    const target = new URL(reference);
    if (!["https:", "http:"].includes(base.protocol) || target.origin !== base.origin || target.username || target.password) return null;
    const prefix = base.pathname.replace(/\/+$/, "");
    const path = target.pathname.slice(prefix.length);
    if (!target.pathname.startsWith(prefix + "/")) return null;
    const match = /^\/issue\/([1-9]\d*)\/?$/.exec(path);
    return match ? numericId(match[1]!) : null;
  } catch { return null; }
}
