// Pure hybrid scoring logic for the eval — no DOM, no model. Imported by eval.js
// and unit-tested by scoring.test.mjs in Node.
//
//   name / linkedin_url / suggested_event_type → deterministic normalized match
//   title / message_text                       → fuzzy (normalized equality,
//                                                substring containment, or token Jaccard)

export const FIELDS = ['name', 'title', 'linkedin_url', 'message_text', 'suggested_event_type'];
export const FUZZY_THRESHOLD = { title: 0.7, message_text: 0.55 };

export const normText = (s) =>
  s == null ? '' : String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

export const isEmpty = (v) => v == null || normText(v) === '';

export function normUrl(u) {
  if (u == null) return '';
  let s = String(u).trim();
  try {
    const url = new URL(s);
    s = url.origin.toLowerCase() + url.pathname.toLowerCase();
  } catch {
    s = s.toLowerCase().split(/[?#]/)[0];
  }
  return s.replace(/\/+$/, '');
}

export function tokens(s) {
  return new Set(
    normText(s)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

export function jaccard(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function scoreField(field, expected, actual) {
  const expEmpty = isEmpty(expected);
  const actEmpty = isEmpty(actual);

  if (field === 'suggested_event_type') {
    const e = expected == null ? null : String(expected);
    const a = actual == null ? null : String(actual);
    return { pass: e === a, sim: e === a ? 1 : 0 };
  }

  if (field === 'name') {
    if (expEmpty || actEmpty) return { pass: expEmpty && actEmpty, sim: expEmpty && actEmpty ? 1 : 0 };
    const pass = normText(expected) === normText(actual);
    return { pass, sim: pass ? 1 : jaccard(expected, actual) };
  }

  if (field === 'linkedin_url') {
    if (expEmpty || actEmpty) return { pass: expEmpty && actEmpty, sim: expEmpty && actEmpty ? 1 : 0 };
    const pass = normUrl(expected) === normUrl(actual);
    return { pass, sim: pass ? 1 : 0 };
  }

  // fuzzy fields: title, message_text
  if (expEmpty || actEmpty) return { pass: expEmpty && actEmpty, sim: expEmpty && actEmpty ? 1 : 0 };
  const e = normText(expected);
  const a = normText(actual);
  const sim = jaccard(expected, actual);
  const pass = e === a || a.includes(e) || e.includes(a) || sim >= (FUZZY_THRESHOLD[field] ?? 0.7);
  return { pass, sim };
}

export function scoreCase(expected, actual) {
  const perField = {};
  let passed = 0;
  for (const f of FIELDS) {
    perField[f] = scoreField(f, expected[f], actual ? actual[f] : null);
    if (perField[f].pass) passed++;
  }
  return {
    perField,
    passed,
    total: FIELDS.length,
    fraction: passed / FIELDS.length,
    allPass: passed === FIELDS.length,
  };
}
