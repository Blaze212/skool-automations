const zone = document.getElementById('zone');
const out = document.getElementById('out');

// The whole panel accepts drops so the target is easy to hit.
['dragenter', 'dragover'].forEach((evt) =>
  document.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add('over'); })
);
['dragleave', 'dragend'].forEach((evt) =>
  document.addEventListener(evt, (e) => {
    if (e.relatedTarget === null) zone.classList.remove('over');
  })
);

document.addEventListener('drop', (e) => {
  e.preventDefault();
  zone.classList.remove('over');
  const dt = e.dataTransfer;
  out.innerHTML = '';

  // 1) Pull the anchor text + href out of the text/html flavor (where the name lives).
  const html = dt.getData('text/html');
  let extracted = null;
  if (html) {
    const a = new DOMParser().parseFromString(html, 'text/html').querySelector('a');
    if (a) {
      extracted = { text: a.textContent.trim(), href: a.getAttribute('href') || '' };
    }
  }

  if (extracted) {
    const wrap = flavor('Extracted link', 'text: ' + extracted.text + '\nhref: ' + extracted.href, true);
    const btns = document.createElement('div');
    btns.className = 'btns';
    btns.append(
      copyBtn('Copy name', extracted.text),
      copyBtn('Copy URL', extracted.href),
      copyBtn('Copy JSON', JSON.stringify(extracted))
    );
    wrap.appendChild(btns);
  } else {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'No <a> anchor found in the drag payload — raw flavors below.';
    out.appendChild(note);
  }

  // 2) Dump every flavor the drag actually carried.
  for (const type of dt.types) {
    flavor(type, dt.getData(type) || '(empty)', false);
  }
});

function flavor(label, value, pick) {
  const wrap = document.createElement('div');
  wrap.className = 'flavor';
  const h = document.createElement('h3');
  h.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = value;
  if (pick) pre.classList.add('pick');
  wrap.append(h, pre);
  out.appendChild(wrap);
  return wrap;
}

function copyBtn(label, value) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      const old = b.textContent;
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = old; }, 1000);
    } catch (err) {
      console.warn('Clipboard failed', err);
    }
  });
  return b;
}
