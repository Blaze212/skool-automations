/**
 * stripHtmlForCarry (spec 013, D-AI-6) — the single shared helper that turns a
 * captured DOM subtree into a compact, model-safe HTML string.
 *
 * Used in three places (DRY closure of spec 012 CQ-obs-1):
 *   1. recover() — prep the model input.
 *   2. the publishable capture path — persist recovered_html (spec 012 D-rev-28).
 *   3. CSV export — re-reads from the keyed store; strip already happened.
 *
 * Strips script/svg/img/style/link/iframe (noise + weight), removes ALL element
 * attributes except href (LinkedIn's class, data-, and aria- attributes dominate
 * the byte + token count and carry no extraction value), drops comments, collapses
 * whitespace runs, and enforces a hard byte cap. Returns '' if the result
 * exceeds the cap so callers drop it with a warning rather than persisting an
 * oversized blob. The attribute strip is what keeps the model input inside
 * Gemini Nano's small context window.
 */

/** D-AI-4 — hard cap on recovered_html after the strip pass. */
export const RECOVERED_HTML_CAP_BYTES = 16 * 1024;

const BANNED_TAGS = ['script', 'svg', 'img', 'style', 'link', 'iframe'] as const;

/** The only attribute worth keeping — profile URLs live in anchor hrefs. */
const KEPT_ATTRIBUTES = new Set(['href']);

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function stripHtmlForCarry(subtreeHtml: string): string {
  if (!subtreeHtml) return '';

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(subtreeHtml, 'text/html');
  } catch {
    return '';
  }

  for (const tag of BANNED_TAGS) {
    for (const el of Array.from(doc.querySelectorAll(tag))) {
      el.remove();
    }
  }

  // Strip every attribute except href — these are the bulk of LinkedIn's
  // markup weight and provide no signal for field extraction.
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (!KEPT_ATTRIBUTES.has(attr.name)) el.removeAttribute(attr.name);
    }
  }

  // Drop comment nodes (LinkedIn ships many).
  const commentWalker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node = commentWalker.nextNode(); node; node = commentWalker.nextNode()) {
    comments.push(node);
  }
  for (const comment of comments) comment.parentNode?.removeChild(comment);

  // Collapse whitespace runs in every text node.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent) {
      node.textContent = node.textContent.replace(/\s+/g, ' ');
    }
  }

  const serialized = doc.body.innerHTML.trim();
  if (utf8ByteLength(serialized) > RECOVERED_HTML_CAP_BYTES) return '';
  return serialized;
}
