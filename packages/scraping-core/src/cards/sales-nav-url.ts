/**
 * URL normalizers shared by the Sales Navigator cards.
 *
 * Sales Navigator never exposes the public `/in/{vanity}` profile URL in most
 * surfaces — its person links point at `/sales/lead/{leadId},{searchContext},
 * {trackingId}`. The lead id (the segment before the first comma) is the stable
 * identity; the trailing comma-separated fields are per-search noise that
 * changes every time the same person surfaces in a different query, so we strip
 * them to keep the captured URL deduplicatable.
 *
 * The regular-LinkedIn cards each carry their own copy of `normalizeLinkedInUrl`
 * (see the TODO in pipeline-tracker/src/content.ts about consolidating them).
 * The three Sales Nav cards share this module instead of triplicating the logic
 * — it contains no `serve()`/side effects, so importing it is safe under the
 * Deno.serve module-isolation rule.
 */

/** Collapse any LinkedIn URL to its canonical `https://www.linkedin.com/in/{vanity}` form. */
export function normalizeLinkedInUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const m = u.pathname.match(/^(\/in\/[^/?#]+)/);
    if (!m) return url;
    return `https://www.linkedin.com${m[1]}`;
  } catch {
    return url;
  }
}

/**
 * Collapse a Sales Navigator lead URL to `https://www.linkedin.com/sales/lead/{leadId}`,
 * dropping the `,{searchContext},{trackingId}` suffix and any query/hash.
 * Accepts both absolute hrefs and the relative `/sales/lead/...` form Sales Nav
 * emits in its menus. Returns '' when the path isn't a lead URL.
 */
export function normalizeSalesLeadUrl(url: string): string {
  if (!url) return '';
  try {
    const base = url.startsWith('http')
      ? url
      : `https://www.linkedin.com${url.startsWith('/') ? '' : '/'}${url}`;
    const u = new URL(base);
    const m = u.pathname.match(/^(\/sales\/lead\/[^,/?#]+)/);
    if (!m) return '';
    return `https://www.linkedin.com${m[1]}`;
  } catch {
    return '';
  }
}

/**
 * Resolve the best available profile URL inside a scope element, preferring the
 * canonical public profile over the Sales Nav lead URL.
 *
 * Order: a public `/in/{vanity}` link (the "View LinkedIn profile" menu item
 * exposes one) wins because it's the same identity the regular-LinkedIn flows
 * capture — keeping both surfaces deduplicatable against each other. Falls back
 * to the normalized `/sales/lead/{leadId}` URL, then ''.
 */
export function resolveProfileUrl(scope: ParentNode): string {
  const inLink = scope.querySelector('a[href*="linkedin.com/in/"]') as HTMLAnchorElement | null;
  if (inLink) {
    const normalized = normalizeLinkedInUrl(inLink.href);
    if (normalized) return normalized;
  }
  const leadLink = scope.querySelector('a[href*="/sales/lead/"]') as HTMLAnchorElement | null;
  if (leadLink) {
    return normalizeSalesLeadUrl(leadLink.getAttribute('href') ?? leadLink.href);
  }
  return '';
}
