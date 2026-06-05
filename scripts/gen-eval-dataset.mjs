import { readFileSync, writeFileSync } from 'fs';

// The account owner doing the capturing. Threaded into the prompt (ownerName) so
// the model can tell OUR messages from the other person's in a thread.
const OWNER = 'Barton Holdridge';

const IN = 'https://www.linkedin.com/in/';
const SEARCH = 'https://www.linkedin.com/search/results/people/?keywords=fractional%20product';
const MSG = 'https://www.linkedin.com/messaging/';

// ── self-contained fragment extraction from the source capture log ───────────
// Pulls every "DROP — LLM-bound content (N chars):" fragment (the exact
// trimmedHtml the sidepanel feeds extractContact()), tagged by section header.
function extractFragments() {
  const raw = readFileSync('LinkedInRawCapturesForPromptTesting.html', 'utf8');
  const lines = raw.split('\n');
  const isHeader = (l) =>
    l.trim() &&
    !l.startsWith('<') &&
    !l.includes('DROP —') &&
    !l.includes('sidepanel.js') &&
    !l.includes('background.js') &&
    !l.includes('extractContact') &&
    !l.includes('Pipeline Tracker') &&
    !/^ot tell/.test(l);
  const out = [];
  let section = '(none)';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isHeader(l)) {
      section = l.trim().replace(/:$/, '');
      continue;
    }
    const m = l.match(/DROP — LLM-bound content \((\d+) chars\):/);
    if (m) {
      let html = l.slice(l.indexOf('chars):') + 'chars):'.length).trim();
      if (!html) html = (lines[i + 1] || '').trim();
      out.push({ section, html });
    }
  }
  return out;
}
const frags = extractFragments();

// slug helper from the fragment's first /in/<slug> occurrence
const slugOf = (html) => (html.match(/\/in\/([A-Za-z0-9\-_%]+)/) || [, ''])[1];

// Per-index truth labels (name/title/message/stage). url + pageUrl derived below.
// stage ∈ connection_request | accepted_connection | direct_message | null
const L = [
  // 0-4  Name links from search page (name-only <a>, no headline/action)
  { n: 'Heather Hund', t: null, m: null, s: null },
  { n: 'Sean Boyce', t: null, m: null, s: null },
  { n: 'Tania H.', t: null, m: null, s: null },
  { n: 'Timothy Bates', t: null, m: null, s: null },
  { n: 'Kevin Smith', t: null, m: null, s: null },
  // 5-12 TITLE links from search page (card: headline + location + action + mutual-connection decoy)
  {
    n: 'Heather Hund',
    t: 'Fractional Product Marketing, Consumer Insights & Strategy | ex-BCG, Goldman | Stanford GSB | VC-Backed Startups | Artist',
    m: null,
    s: 'connection_request',
  }, // Pending
  { n: 'Sean Boyce', t: 'Fractional Product and CFO Expert', m: null, s: null }, // Follow
  {
    n: 'Tania H.',
    t: 'Product Strategy and Go-to-Market Leader I Fractional Product Marketer I Using a customer-centric approach to help you win with product-led GTM',
    m: null,
    s: 'connection_request',
  }, // Pending
  {
    n: 'Timothy Bates',
    t: 'Strategic Advisor | Fractional Product Management | 2X Founder | AI/ML | Growth/Scale | Enterprise Digital Transformation',
    m: null,
    s: null,
  }, // Connect
  {
    n: 'Kevin Smith',
    t: 'Fractional & Interim CPO (Chief Product Officer) | Product Advisor | ex-Google | ex-Trilogy',
    m: null,
    s: 'connection_request',
  }, // Pending
  {
    n: 'Dave Reinhold',
    t: 'Fractional CPO | Helping Companies Build from 0→1 and Achieve Product-Market Fit',
    m: null,
    s: 'connection_request',
  }, // Pending
  {
    n: 'Minati Shah',
    t: 'Fractional Product Consultant | Product Leader | Passionate About CX, Innovation & Scalable Impact | Ex-Apple, Microsoft, E*TRADE',
    m: null,
    s: null,
  }, // Connect
  {
    n: 'Shikha Nalla',
    t: 'Building something new | Fractional Product Leader | Ex-Tempo, Pivot, Fitbit',
    m: null,
    s: null,
  }, // Connect
  // 13-19 Profile Name (h2 only)
  { n: 'Shikha Nalla', t: null, m: null, s: null },
  { n: 'Minati Shah', t: null, m: null, s: null },
  { n: 'Brian Root', t: null, m: null, s: null },
  { n: 'Mark Koslow', t: null, m: null, s: null },
  { n: 'Timothy Bates', t: null, m: null, s: null },
  { n: 'Tania H.', t: null, m: null, s: null },
  { n: 'Sean Boyce', t: null, m: null, s: null },
  // 20-26 Profile Manually highlight header (full header; Follow/Connect/Message present = no interaction taken)
  { n: 'Sean Boyce', t: 'Fractional Product and CFO Expert', m: null, s: null },
  {
    n: 'Tania H.',
    t: 'Product Strategy and Go-to-Market Leader I Fractional Product Marketer I Using a customer-centric approach to help you win with product-led GTM',
    m: null,
    s: null,
  },
  {
    n: 'Timothy Bates',
    t: 'Strategic Advisor | Fractional Product Management | 2X Founder | AI/ML | Growth/Scale | Enterprise Digital Transformation',
    m: null,
    s: null,
  },
  { n: 'Mark Koslow', t: 'Fractional Product Manager | Ex-Reforge', m: null, s: null },
  {
    n: 'Brian Root',
    t: 'Fractional CPO | Most product problems live upstream of the product',
    m: null,
    s: null,
  },
  {
    n: 'Minati Shah',
    t: 'Fractional Product Consultant | Product Leader | Passionate About CX, Innovation & Scalable Impact | Ex-Apple, Microsoft, E*TRADE',
    m: null,
    s: null,
  },
  {
    n: 'Shikha Nalla',
    t: 'Building something new | Fractional Product Leader | Ex-Tempo, Pivot, Fitbit',
    m: null,
    s: null,
  },
  // 27-31 Profile side panel connects NAME drag (name-only)
  { n: 'Phoebe Fan', t: null, m: null, s: null },
  { n: 'Sanjeet Singh', t: null, m: null, s: null },
  { n: 'Nicole Roze', t: null, m: null, s: null },
  { n: 'Jess Thevenoz', t: null, m: null, s: null },
  { n: 'Ashley Kera', t: null, m: null, s: null },
  // 32-34 Profile side panel connects MESSAGE drag (name + headline)
  {
    n: 'Phoebe Fan',
    t: 'Operating Partner @ Foothill Ventures | Ecosystem Builder to Empower Frontier Builders in AI & Deep Tech',
    m: null,
    s: null,
  },
  {
    n: 'Jess Thevenoz',
    t: 'Founder of Theodora | Find wine you love without becoming a sommelier',
    m: null,
    s: null,
  },
  {
    n: 'Ashley Kera',
    t: 'People Ops Consultant & Coach | Scaled multimillion-dollar talent programs | I help orgs scale smarter and women move through change with clarity and self-trust',
    m: null,
    s: null,
  },
  // 35-38 Messenger pop-ups (contact = the OTHER party, not Barton)
  {
    n: 'Jesse Leonard',
    t: 'Founder & CEO at Leonard Workforce Solutions | Helping companies hire better, lead stronger, and grow faster',
    m: "Hey Jesse, appreciate the connection.\n\nI've been building submittal and workflow automations with a few boutique agencies and noticed Leonard Workforce Solutions is doing a lot of recruiting and staffing work.\n\nI put together a tiny tool that takes a candidate's resume + target role and auto-builds a client-ready submittal in your branding (snapshot, 'why this candidate,' key qualifications) and logs time saved per run.\n\nWould you be open to a 60-second Loom showing how it works on a sample candidate, just to see if it's relevant for your stack?",
    s: 'direct_message',
  },
  {
    n: 'John Ricciardi',
    t: 'Regulatory Affairs Search Partner | Helping Life Sciences Leaders Build High-Impact Teams',
    m: 'Looking forward to connecting with you here, John!',
    s: 'accepted_connection',
  },
  {
    n: 'David Hampton, Jr.',
    t: 'Founder, Hampton Strategies | Executive Search for Tax Directors, VPs of Tax, and Heads of Tax at Fortune 500, Public, and Complex Growth Companies',
    m: 'Looking forward to connecting with you here, David!',
    s: 'accepted_connection',
  },
  {
    n: 'Kevin Clifford',
    t: 'Sports AI & Data Recruitment | Hiring AI/ML Engineers, Data Scientists & Analytics Leaders in Sport & SportsTech | 17 years in data hiring | Founder of Animo Group',
    m: "Hey Kevin, appreciate the connection.\n\nI've been building submittal and workflow automations with a few boutique agencies and noticed your team is doing a lot of work in Sports and SportTech recruiting.\n\nI put together a tiny tool that takes a candidate's resume + target role and auto-builds a client-ready submittal in your branding (snapshot, 'why this candidate,' key qualifications) and logs time saved per run.\n\nWould you be open to a 60-second Loom showing how it works on a sample candidate, just to see if it's relevant for your stack?\n\nAs a fellow \"Soccer\" 😅 fan the niche you are in is really cool!",
    s: 'direct_message',
  },
  // 39-43 Messenger page chat (greeting threads = accepted_connection)
  {
    n: 'Amy Ospital',
    t: 'Founder & CEO @ The Network 101 | Executive Search - Accounting & Finance, Legal, & others | 12+ years closing Enterprise Deals',
    m: 'Looking forward to connecting with you here, Amy!',
    s: 'accepted_connection',
  },
  {
    n: 'Nick Starbuck',
    t: 'Specialist Recruiter | Platform Law Firms & Financial Services | Placing entrepreneurial professionals into consultant models | Smart Match Network',
    m: 'Looking forward to connecting with you here, Nick!',
    s: 'accepted_connection',
  },
  {
    n: 'Somer Hackley',
    t: 'Executive Recruiter | Technology, Data, Product, Security | C-level, SVP, VP | Author: Search in Plain Sight',
    m: 'Looking forward to connecting with you here, Somer!',
    s: 'accepted_connection',
  },
  {
    n: 'Douglas Wetzel',
    t: 'Founder & CEO at Ashton North | Executive Search Partner for Manufacturing, Industrial & PE Backed Companies | Building Leadership Teams That Drive Growth',
    m: 'Looking forward to connecting with you here, Douglas!',
    s: 'accepted_connection',
  },
  {
    n: 'Vince Toves',
    t: 'Program & Operations Leader: The 0-to-1 Catalyst | Directed 340x Listing Growth at Zillow | Reduced wasted spend by ~$40M/yr & contributed to ~15% revenue uplift (~$100M/yr) for P&G | AI Builder & Leader | UW MBA',
    // message rule = "most recent message WE (the owner) sent". Vince sent the
    // greeting TO Barton; Barton's own later messages have NO body in this
    // captured fragment → no owner-authored text to extract → null.
    m: null,
    s: 'accepted_connection',
  },
];

if (L.length !== frags.length) {
  throw new Error(`label/frag mismatch ${L.length} vs ${frags.length}`);
}

const catSlug = (section) =>
  section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const pageUrlFor = (section, slug) => {
  const s = section.toLowerCase();
  if (s.includes('search')) return SEARCH;
  if (s.includes('messager') || s.includes('messanger')) return MSG;
  if (s.includes('profile name') || s.includes('highlight header'))
    return slug ? IN + slug + '/' : '';
  return ''; // side-panel drags: tab URL is indeterminate
};

const records = frags.map((f, i) => {
  const slug = slugOf(f.html);
  const url = slug ? (slug.startsWith('ACoA') ? IN + slug : IN + slug + '/') : '';
  return {
    id: `${String(i).padStart(2, '0')}-${catSlug(f.section)}`,
    category: f.section,
    pageUrl: pageUrlFor(f.section, slug),
    ownerName: OWNER,
    trimmedHtml: f.html,
    expected: {
      name: L[i].n,
      title: L[i].t,
      linkedin_url: url,
      message_text: L[i].m,
      suggested_event_type: L[i].s,
    },
  };
});

const banner = `// AUTO-GENERATED truth dataset for the on-device extraction eval.
// Source: LinkedInRawCapturesForPromptTesting.html (the "DROP — LLM-bound content"
// fragments — i.e. the exact \`trimmedHtml\` the sidepanel feeds extractContact()).
// Inputs are byte-exact; \`expected\` labels were hand-authored. Each record also
// carries \`ownerName\` (the capturing user) which is threaded into the prompt so
// the model can identify OUR messages in a thread. message_text labels follow the
// "most recent message the owner sent" rule. Regenerate / edit labels in
// scripts/gen-eval-dataset.mjs, not here.
//
// ${records.length} cases across ${[...new Set(records.map((r) => r.category))].length} capture categories.

window.EVAL_DATASET = ${JSON.stringify(records, null, 2)};
`;

const outPath = 'drag-link-inspector 3/eval-dataset.js';
writeFileSync(outPath, banner);
console.log('Wrote', outPath, '—', records.length, 'records');
// sanity: list any record missing a url where a slug existed
records.forEach((r, i) => {
  if (!r.expected.linkedin_url) console.log('  no url:', r.id);
});
