// Node sanity test for the eval scorer. Run: node "scoring.test.mjs"
import { readFileSync } from 'fs';
import { scoreField, scoreCase, normUrl } from './scoring.js';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error('  ✗', msg);
    fails++;
  } else {
    console.log('  ✓', msg);
  }
};

console.log('URL normalization (query/tracking + trailing slash stripped):');
ok(
  normUrl('https://www.linkedin.com/in/heather-hund/?lipi=urn%3Ali%3Apage') ===
    normUrl('https://www.linkedin.com/in/heather-hund/'),
  'tracking params + trailing slash ignored',
);
ok(normUrl('https://www.linkedin.com/in/timbates/') === 'https://www.linkedin.com/in/timbates', 'trailing slash stripped');

console.log('null/empty handling:');
ok(scoreField('title', null, null).pass, 'expected null + model null → pass');
ok(scoreField('title', null, '').pass, 'expected null + model "" → pass');
ok(!scoreField('title', null, 'Fractional CPO').pass, 'expected null + model value → fail (hallucinated title)');
ok(!scoreField('title', 'Fractional CPO', null).pass, 'expected value + model null → fail (missed title)');

console.log('fuzzy title:');
ok(scoreField('title', 'Fractional Product and CFO Expert', 'Fractional Product and CFO Expert').pass, 'verbatim title → pass');
ok(
  scoreField('title', 'Fractional CPO | Helping Companies Build from 0→1', 'Fractional CPO').pass,
  'model returns shorter substring of headline → pass (containment)',
);
ok(
  !scoreField('title', 'Fractional Product and CFO Expert', 'is a mutual connection').pass,
  'relational decoy phrase → fail',
);

console.log('event type exact:');
ok(scoreField('suggested_event_type', 'connection_request', 'connection_request').pass, 'matching stage → pass');
ok(!scoreField('suggested_event_type', 'accepted_connection', 'direct_message').pass, 'mismatched stage → fail');
ok(scoreField('suggested_event_type', null, null).pass, 'both null stage → pass');

console.log('full-dataset behavior:');
const ctx = { window: {} };
const code = readFileSync(new URL('./eval-dataset.js', import.meta.url), 'utf8');
new Function('window', code)(ctx.window);
const DATA = ctx.window.EVAL_DATASET;
ok(DATA.length === 44, `dataset has 44 cases (got ${DATA.length})`);

// A "perfect oracle" that returns exactly the expected fields must score 100%.
let perfectAll = 0;
for (const c of DATA) if (scoreCase(c.expected, c.expected).allPass) perfectAll++;
ok(perfectAll === DATA.length, `oracle (expected≡actual) scores all-pass on every case (${perfectAll}/${DATA.length})`);

// A model that always picks the FIRST decoy mutual-connection name + no fields
// should score poorly — guards against a scorer that is too lenient.
const dummy = { name: 'Laura Leach', title: 'is a mutual connection', linkedin_url: 'https://www.linkedin.com/in/lauradleach/', message_text: 'is a mutual connection', suggested_event_type: 'direct_message' };
let dummyAll = 0;
for (const c of DATA) if (scoreCase(c.expected, dummy).allPass) dummyAll++;
ok(dummyAll === 0, `decoy-only model passes 0 cases fully (got ${dummyAll})`);

console.log(fails === 0 ? '\nALL SCORING TESTS PASSED' : `\n${fails} TEST(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
