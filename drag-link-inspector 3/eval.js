// Eval runner + hybrid scorer + report renderer.
// Loaded as a module by eval.html. Reads window.EVAL_DATASET (eval-dataset.js)
// and runs each case through the on-device model via runExtraction().
//
// Scoring = HYBRID:
//   name / linkedin_url / suggested_event_type → deterministic normalized match
//   title / message_text                       → fuzzy (normalized equality,
//                                                containment, or token Jaccard)

import { runExtraction } from './extract-contact.js';
import { FIELDS, scoreCase } from './scoring.js';

// ── runner ───────────────────────────────────────────────────────────────────
const state = { results: [], running: false, abort: false };

async function runEval(filterIds) {
  if (state.running) return;
  state.running = true;
  state.abort = false;
  const dataset = window.EVAL_DATASET.filter((c) => !filterIds || filterIds.has(c.id));
  setStatus(`Running ${dataset.length} cases…`);

  for (let i = 0; i < dataset.length; i++) {
    if (state.abort) {
      setStatus(`Stopped after ${i}/${dataset.length}.`);
      break;
    }
    const c = dataset[i];
    setProgress(i, dataset.length, c.id);
    const out = await runExtraction({
      trimmedHtml: c.trimmedHtml,
      pageUrl: c.pageUrl,
      ownerName: c.ownerName ?? '',
      candidate: { name: '', title: '', linkedin_url: '', message_text: '' },
    });
    const extraction = out.ok ? out.extraction : null;
    const score = scoreCase(c.expected, extraction);
    const record = { case: c, out, extraction, score };
    upsertResult(record);
    render();
  }

  setProgress(dataset.length, dataset.length, '');
  state.running = false;
  if (!state.abort) setStatus(`Done — ${state.results.length} cases scored.`);
}

function upsertResult(record) {
  const idx = state.results.findIndex((r) => r.case.id === record.case.id);
  if (idx >= 0) state.results[idx] = record;
  else state.results.push(record);
  state.results.sort((a, b) => a.case.id.localeCompare(b.case.id));
}

// ── aggregate ────────────────────────────────────────────────────────────────
function aggregate() {
  const r = state.results;
  if (r.length === 0) return null;
  const fieldPass = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let exactCases = 0;
  let okRuns = 0;
  let totalFieldFrac = 0;
  const byCat = {};
  for (const x of r) {
    if (x.out.ok) okRuns++;
    if (x.score.allPass) exactCases++;
    totalFieldFrac += x.score.fraction;
    for (const f of FIELDS) if (x.score.perField[f].pass) fieldPass[f]++;
    const cat = x.case.category;
    byCat[cat] ??= { n: 0, exact: 0, fieldFrac: 0 };
    byCat[cat].n++;
    byCat[cat].exact += x.score.allPass ? 1 : 0;
    byCat[cat].fieldFrac += x.score.fraction;
  }
  return {
    n: r.length,
    okRuns,
    exactCases,
    avgFieldFrac: totalFieldFrac / r.length,
    fieldAcc: Object.fromEntries(FIELDS.map((f) => [f, fieldPass[f] / r.length])),
    byCat,
  };
}

// ── rendering ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtVal = (v) => (v == null ? '∅ null' : v === '' ? '∅ empty' : esc(v));

function setStatus(t) {
  $('status').textContent = t;
}
function setProgress(done, total, id) {
  const bar = $('bar');
  bar.style.width = total ? pct(done / total) : '0%';
  $('progress-label').textContent = total ? `${done}/${total} ${id}` : '';
}

function render() {
  const agg = aggregate();
  const sum = $('summary');
  if (!agg) {
    sum.innerHTML = '<p class="muted">No results yet. Click <b>Run eval</b>.</p>';
    $('cats').innerHTML = '';
    $('cases').innerHTML = '';
    return;
  }
  sum.innerHTML = `
    <div class="cards">
      <div class="card"><div class="big">${pct(agg.exactCases / agg.n)}</div><div class="lbl">cases all-5 fields correct (${agg.exactCases}/${agg.n})</div></div>
      <div class="card"><div class="big">${pct(agg.avgFieldFrac)}</div><div class="lbl">avg field accuracy / case</div></div>
      <div class="card"><div class="big">${agg.okRuns}/${agg.n}</div><div class="lbl">model returned valid JSON</div></div>
    </div>
    <table class="fieldtbl">
      <tr><th>field</th>${FIELDS.map((f) => `<th>${f}</th>`).join('')}</tr>
      <tr><td>accuracy</td>${FIELDS.map((f) => `<td class="${agg.fieldAcc[f] >= 0.8 ? 'good' : agg.fieldAcc[f] >= 0.5 ? 'warn' : 'bad'}">${pct(agg.fieldAcc[f])}</td>`).join('')}</tr>
    </table>`;

  $('cats').innerHTML = `
    <h2>By capture category</h2>
    <table class="cattbl">
      <tr><th>category</th><th>n</th><th>all-correct</th><th>avg field acc</th></tr>
      ${Object.entries(agg.byCat)
        .map(
          ([cat, c]) =>
            `<tr><td>${esc(cat)}</td><td>${c.n}</td><td>${pct(c.exact / c.n)} (${c.exact}/${c.n})</td><td>${pct(c.fieldFrac / c.n)}</td></tr>`,
        )
        .join('')}
    </table>`;

  $('cases').innerHTML =
    '<h2>Per-case detail</h2>' +
    state.results
      .map((r) => {
        const c = r.case;
        const badge = !r.out.ok
          ? `<span class="pill bad">model failed: ${esc(r.out.reason)}</span>`
          : r.score.allPass
            ? '<span class="pill good">all correct</span>'
            : `<span class="pill warn">${r.score.passed}/${r.score.total} fields</span>`;
        const rows = FIELDS.map((f) => {
          const pf = r.score.perField[f];
          const exp = c.expected[f];
          const act = r.extraction ? r.extraction[f] : null;
          const sim = f === 'title' || f === 'message_text' ? ` <span class="sim">sim ${pct(pf.sim)}</span>` : '';
          return `<tr class="${pf.pass ? 'fpass' : 'ffail'}">
            <td class="fname">${pf.pass ? '✓' : '✗'} ${f}${sim}</td>
            <td class="exp">${fmtVal(exp)}</td>
            <td class="act">${fmtVal(act)}</td></tr>`;
        }).join('');
        return `<details class="case ${r.out.ok && r.score.allPass ? '' : 'attn'}">
          <summary>${esc(c.id)} ${badge} <span class="muted">${r.out.ms}ms</span></summary>
          <table class="casetbl"><tr><th></th><th>expected</th><th>model</th></tr>${rows}</table>
          <details class="raw"><summary>prompt input HTML (${c.trimmedHtml.length} chars) + raw model output</summary>
            <div class="rawlbl">pageUrl</div><pre>${esc(c.pageUrl || '(empty)')}</pre>
            <div class="rawlbl">trimmedHtml</div><pre>${esc(c.trimmedHtml)}</pre>
            <div class="rawlbl">raw model output</div><pre>${esc(r.out.raw ?? '(none)')}</pre>
          </details>
        </details>`;
      })
      .join('');
}

function download() {
  const agg = aggregate();
  const payload = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    summary: agg,
    results: state.results.map((r) => ({
      id: r.case.id,
      category: r.case.category,
      ok: r.out.ok,
      reason: r.out.ok ? undefined : r.out.reason,
      ms: r.out.ms,
      expected: r.case.expected,
      actual: r.extraction,
      perField: Object.fromEntries(FIELDS.map((f) => [f, r.score.perField[f]])),
      raw: r.out.raw,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `eval-results-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── availability banner ──────────────────────────────────────────────────────
async function checkAvailability() {
  const el = $('availability');
  if (typeof LanguageModel === 'undefined' || !LanguageModel) {
    el.className = 'avail bad';
    el.innerHTML =
      '<b>LanguageModel global is not available.</b> Open this page as an extension page in Chrome ' +
      '(load <code>drag-link-inspector 3</code> unpacked, then open <code>eval.html</code> from the toolbar button). ' +
      'Requires Chrome with the on-device Prompt API enabled.';
    return;
  }
  let a = 'unknown';
  try {
    a = await LanguageModel.availability();
  } catch (e) {
    a = `error: ${e?.message || e}`;
  }
  if (a === 'available') {
    el.className = 'avail good';
    el.innerHTML = `On-device model <b>available</b>. Ready to run.`;
  } else if (a === 'downloadable' || a === 'downloading') {
    el.className = 'avail warn';
    el.innerHTML = `Model status: <b>${a}</b>. <button id="dl" class="btn">Download model</button> (one-time, large).`;
    $('dl').onclick = downloadModel;
  } else {
    el.className = 'avail bad';
    el.innerHTML = `Model status: <b>${a}</b> — cannot run. Enable Chrome's on-device Prompt API and retry.`;
  }
}

async function downloadModel() {
  const el = $('availability');
  el.innerHTML = 'Downloading model… <span id="dlp">0%</span>';
  try {
    const s = await LanguageModel.create({
      outputLanguage: 'en',
      monitor: (m) =>
        m.addEventListener('downloadprogress', (e) => {
          const p = $('dlp');
          if (p) p.textContent = pct(e.loaded ?? 0);
        }),
    });
    s?.destroy?.();
  } catch (e) {
    el.innerHTML = `Download failed: ${esc(e?.message || e)}`;
  }
  await checkAvailability();
}

// ── wire up ──────────────────────────────────────────────────────────────────
$('run').onclick = () => runEval(null);
$('run-failed').onclick = () => {
  const failed = new Set(state.results.filter((r) => !r.out.ok || !r.score.allPass).map((r) => r.case.id));
  if (failed.size === 0) return setStatus('No failed cases to re-run.');
  runEval(failed);
};
$('stop').onclick = () => {
  state.abort = true;
};
$('download').onclick = download;
$('recheck').onclick = checkAvailability;

setStatus(`Loaded ${window.EVAL_DATASET?.length ?? 0} cases.`);
render();
checkAvailability();
