// The one email normalizer (ADR 0013): email_norm, ADMIN_EMAILS, TEST_EMAILS, invites, codes and the waitlist all use it.
const MAX_EMAIL_CHARS = 254;

/**
 * Trimmed, lowercased, at most 254 characters, printable ASCII only, one `@` with text on both sides and a dot in the
 * domain. A non-ASCII address is refused, so no confusable makes a second account for a same-looking address. No dot or
 * plus folding. Null when the address is not acceptable.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_CHARS) return null;
  for (let i = 0; i < email.length; i++) {
    const code = email.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return null;
  }
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return null;
  const domain = email.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && !domain.endsWith(".") ? email : null;
}

/** A comma-separated secret (ADMIN_EMAILS, TEST_EMAILS) as a set of normalized addresses. An entry that fails is skipped, so it admits nobody. */
export function emailSet(list: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const part of (list ?? "").split(",")) {
    const email = normalizeEmail(part);
    if (email) out.add(email);
  }
  return out;
}
