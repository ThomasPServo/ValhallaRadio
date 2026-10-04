// Imaging (voice, sweeper creator, imaging library, music beds / auto-bed) and commercials.

import { $, $$, esc, state, api, run, toast, bus, opt, input, check, collect, rowsToObjects, save, play, uploadFile, uploadFiles, stationTime, TYPE_LABEL } from './core.js';

const IMG_TYPES = ['toh_id', 'id', 'sweeper', 'liner', 'promo', 'bed'];
const FX = [['', 'Auto'], ['punch', 'Punch'], ['riser', 'Riser'], ['smooth', 'Smooth'], ['stutter', 'Stutter'], ['music', 'Over music'], ['dry', 'Dry']];
const ui = { job: null, beds: null, importing: null };
const AUDIO = /\.(mp3|wav|aiff?|flac|m4a|aac|ogg|opus|wma)$/i;

/** Import produced imaging files one by one (each is checked and typed from its name on the server). */
async function importFiles(files, type = '') {
  files = files.filter((f) => AUDIO.test(f.name) || f.type.startsWith('audio/'));
  if (!files.length) { toast('No audio files there', true); return; }
  ui.importing = { done: 0, total: files.length, failed: [] };
  const counts = {};
  for (const f of files) {
    paintImport();
    try {
      const body = f.type ? f : new Blob([f], { type: 'application/octet-stream' }); // some formats (AIFF, FLAC) arrive untyped
      const r = await api('POST', `/api/imaging/import?${new URLSearchParams({ name: f.relPath || f.name, type })}`, undefined, body);
      counts[r.item.type] = (counts[r.item.type] || 0) + 1;
    } catch (e) { ui.importing.failed.push(`${f.name}: ${e.message}`); }
    ui.importing.done++;
  }
  paintImport();
  const summary = Object.entries(counts).map(([t, n]) => `${n} ${t === 'bed' ? 'bed' : TYPE_LABEL[t] || t}${n === 1 ? '' : 's'}`).join(', ');
  toast(summary ? `Imported ${summary}` : 'Nothing imported', !summary);
  state.B = await api('GET', '/api/bootstrap');
  ui.importing = ui.importing.failed.length ? ui.importing : null;
  ui.beds = await api('GET', '/api/beds').catch(() => ui.beds);
  bus.emit('rerender');
}

function importHtml() {
  const j = ui.importing;
  if (!j) return '';
  return `<div class="progress" style="margin:8px 0"><div style="width:${(100 * j.done) / Math.max(1, j.total)}%"></div></div>
    <div class="small muted">${j.done < j.total ? `Importing ${j.done + 1} of ${j.total}…` : `Imported ${j.total - j.failed.length} of ${j.total}`}</div>
    ${j.failed.map((f) => `<div class="small" style="color:var(--red)">✗ ${esc(f)}</div>`).join('')}`;
}
function paintImport() { const el = $('#impJob'); if (el) el.innerHTML = importHtml(); }

async function upload(accept = 'audio/*') {
  const f = await uploadFile(accept);
  if (!f) return null;
  try { return await api('POST', `/api/upload?name=${encodeURIComponent(f.name)}`, undefined, f); } catch (e) { toast(e.message, true); return null; }
}

function imgRow(i) {
  const bed = i.type === 'bed';
  return `<tr data-id="${i.id}" class="${i.enabled ? '' : 'off'}">
    <td data-label="Type"><select data-f="type">${IMG_TYPES.map((t) => opt(t, t === 'bed' ? 'Music bed' : TYPE_LABEL[t], i.type)).join('')}</select></td>
    <td data-label="Name"><input data-f="name" value="${esc(i.name)}">
      <div class="small">${i.imported ? `<span class="badge clean" title="Imported ${i.importedAt ? new Date(i.importedAt).toLocaleDateString() : ''}">imported${i.duration ? ` · ${i.duration}s` : ''}</span>` : ''}${i.auto ? `<span class="badge auto" title="Written by the sweeper creator ${i.createdAt ? new Date(i.createdAt).toLocaleDateString() : ''}">auto</span>` : ''}${i.theme ? ` <span class="muted">${esc(i.theme)}</span>` : ''}${i.expires ? ` <span class="muted">· until ${esc(i.expires)}</span>` : ''}</div></td>
    <td data-label="Copy" class="wide">${bed ? '<span class="small muted">Plays under talk (see Music beds)</span><input data-f="text" type="hidden" value="">' : `<input data-f="text" value="${esc(i.text || '')}" placeholder="Copy with {name} {frequency} {callSign} {market} {slogan}">`}</td>
    <td data-label="FX">${bed ? '<input data-f="fx" type="hidden" value="">' : `<select data-f="fx">${FX.map(([v, l]) => opt(v, l, i.fx || '')).join('')}</select>`}</td>
    <td data-label="Audio"><div class="row nowrap"><input data-f="file" type="hidden" value="${esc(i.file || '')}"><span class="small muted fname" data-role="fname" title="${esc(i.file || '')}">${i.file ? 'uploaded' : bed ? '—' : 'voiced'}</span>
      <button class="icon" data-action="upload" title="Upload produced audio">⤒</button>${i.file ? '<button class="icon" data-action="clearFile" title="Use the voiced copy instead">✕</button>' : ''}</div></td>
    <td data-label="Pinned" title="Pinned pieces are never retired by the weekly refresh"><input data-f="pinned" type="checkbox" ${i.pinned ? 'checked' : ''} ${i.auto ? '' : 'disabled'}></td>
    <td data-label="On"><input data-f="enabled" type="checkbox" ${i.enabled ? 'checked' : ''}></td>
    <td class="acts"><div class="row nowrap"><button class="icon" data-action="previewImaging" title="Produce &amp; preview">▶</button><button class="icon" data-action="fireCart" data-id="${i.id}" title="Fire on air now">🔥</button><button class="icon danger" data-action="delRow">✕</button></div></td>
  </tr>`;
}

/** Keep fields the table doesn't edit (createdAt, theme, expires, markers…) when saving. */
function readItems() {
  const prev = new Map(state.B.imaging.items.map((i) => [i.id, i]));
  return rowsToObjects('#imgRows').map((r) => {
    const base = prev.get(r.id) || {};
    const out = { ...base, ...r };
    if (!out.fx) delete out.fx;
    if (!out.auto) delete out.pinned;
    return out;
  });
}

function jobHtml(j) {
  if (!j || (!j.running && !j.created?.length && !j.errors?.length)) return '';
  const pct = j.running ? (j.phase === 'writing' ? 15 : 15 + (85 * (j.produced || 0)) / Math.max(1, j.created.length)) : 100;
  return `<div class="progress" style="margin:10px 0"><div style="width:${pct}%"></div></div>
    <div class="small muted">${j.running ? (j.phase === 'writing' ? 'Writing copy…' : `Producing ${j.produced}/${j.created.length}…`) : `Done — ${j.created?.length || 0} new piece${j.created?.length === 1 ? '' : 's'}${j.source === 'templates' ? ' (template writer: connect Claude for custom copy)' : ''}`}</div>
    ${(j.created || []).map((c) => `<div class="small">✨ <b>${esc(TYPE_LABEL[c.type] || c.type)}</b> ${esc(c.text)} <span class="muted">${esc(c.fx || '')}</span></div>`).join('')}
    ${(j.rejected || []).length ? `<details style="margin-top:6px"><summary class="small">${j.rejected.length} line${j.rejected.length === 1 ? '' : 's'} rejected by the broadcast check</summary>${j.rejected.map((r) => `<div class="small muted">✗ ${esc(r.text || '')} — ${esc(r.why)}</div>`).join('')}</details>` : ''}
    ${(j.errors || []).map((e) => `<div class="small" style="color:var(--red)">${esc(e)}</div>`).join('')}`;
}

function bedsHtml() {
  const s = state.B.settings.autoBed || {};
  const r = ui.beds;
  if (!r) return '<div class="muted small"><span class="spin"></span> Loading beds…</div>';
  return `
    <div class="row">${check('enabled', 'Auto-bed: put a music bed under DJ talk when there\'s no song to talk over', s.enabled !== false)}</div>
    <div class="grid cols-3">
      <div><label>Bed</label><select data-k="bed"><option value="auto" ${(s.bed || 'auto') === 'auto' ? 'selected' : ''}>Auto (your uploaded bed, else the format's style)</option>${r.beds.map((b) => opt(b.id, `${b.name}${b.synth ? ` — ${b.bpm} BPM` : ' (uploaded)'}`, s.bed)).join('')}</select></div>
      <div class="ctl"><label>Level under the voice <span class="num" id="bedLvl">${s.levelDb ?? -12} dB</span></label><input type="range" data-k="levelDb" min="-24" max="-6" step="1" value="${s.levelDb ?? -12}"></div>
      <div class="row" style="align-items:flex-end"><button class="primary" data-action="saveBed">Save</button></div>
    </div>
    <div class="beds">${r.beds.map((b) => `<div class="bed ${r.chosen === b.id ? 'on' : ''}"><button class="icon" data-action="previewBed" data-id="${b.id}" title="Preview">▶</button><div><b>${esc(b.name)}</b> ${r.chosen === b.id ? '<span class="badge clean">in use</span>' : ''}<div class="small muted">${esc(b.description || '')}</div></div></div>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button data-action="uploadBed">⤒ Upload your own bed</button><span class="small muted">Any instrumental: it's crossfaded into a seamless loop automatically.</span></div>`;
}

export const imaging = {
  render() {
    const B = state.B;
    const v = B.imaging.voice || {};
    const ai = B.settings.autoImaging || {};
    return `
    <h1>Imaging &amp; beds</h1>
    <p class="sub">Legal IDs, station IDs, sweepers and liners: produced automatically from copy in the imaging voice with sound design, or upload finished audio. Placeholders: {name} {callSign} {frequency} {slogan} {market}.</p>
    <div class="grid cols-2">
      <div class="card stack" id="creator">
        <h2>✨ Sweeper creator</h2>
        <p class="small muted" style="margin:0">Claude writes fresh imaging for your format, market, season and the artists in rotation; every line passes a broadcast check (no ratings claims, contests or promises you can't keep), then it's produced and ready to air.</p>
        <div class="grid cols-3"><div><label>How many</label><input id="crCount" type="number" min="1" max="20" value="${ai.perRun || 6}"></div><div class="span-2"><label>Direction (optional)</label><input id="crGuide" placeholder="e.g. lean into the holidays, mention the weekend, more energy"></div></div>
        <div class="row"><button class="primary" data-action="createImaging">Write &amp; produce</button><span class="spacer"></span>
          <span class="small muted">${ai.lastRun ? `Last batch ${new Date(ai.lastRun).toLocaleDateString()}` : 'No batches yet'}</span></div>
        <div id="crJob">${jobHtml(ui.job)}</div>
        <div class="sep"></div>
        <div id="autoImg" class="stack">
          ${check('enabled', 'Refresh imaging automatically', ai.enabled)}
          <div class="grid cols-3">${input('everyDays', 'Every (days)', ai.everyDays ?? 7, 'number', 'min="1" max="60"')}${input('perRun', 'Pieces per batch', ai.perRun ?? 6, 'number', 'min="1" max="20"')}${input('keep', 'Keep newest', ai.keep ?? 18, 'number', 'min="4" max="100"')}</div>
          <div><button data-action="saveAutoImaging">Save schedule</button> <span class="small muted">Older auto pieces retire as new ones arrive; pinned and hand-made pieces stay.</span></div>
        </div>
      </div>
      <div class="card stack" id="imgVoice">
        <h2>🎤 Imaging voice</h2>
        <div class="grid cols-2">
          <div><label>Local voice (free)</label><select data-k="kokoroVoice">${Object.entries(B.kokoroVoices || {}).map(([k, l]) => opt(k, l, v.kokoroVoice || 'am_michael')).join('')}</select></div>
          ${input('speed', 'Speed', v.speed ?? 1, 'number', 'step="0.05" min="0.8" max="1.25"')}
          ${input('elevenLabsVoiceId', 'ElevenLabs voice ID', v.elevenLabsVoiceId)}${input('openaiVoice', 'OpenAI voice', v.openaiVoice)}
        </div>
        ${input('instructions', 'Voice direction (OpenAI gpt-4o-mini-tts)', v.instructions)}
        <div class="sep"></div>
        <h2>🎵 Music beds</h2>
        <div id="beds">${bedsHtml()}</div>
      </div>
    </div>
    <div class="card" style="margin-top:14px" id="imgLib">
      <div class="row wrap" style="margin-bottom:8px"><h2 style="margin:0">Imaging library</h2><span class="spacer"></span><span class="small muted">${B.imaging.items.length} pieces${B.imaging.items.some((i) => i.imported) ? ` · ${B.imaging.items.filter((i) => i.imported).length} imported` : ''}</span></div>
      <div class="dropzone" id="impDrop">
        <div><b>Import your produced imaging</b> <span class="small muted">TOH/legal IDs, station IDs, sweepers, liners, promos and beds (MP3, WAV, AIFF, FLAC, M4A). Drop files or a whole folder here. The type is read from file and folder names like “TOH”, “Legal ID”, “Sweeper” or “Liner”, and you can change it below.</span></div>
        <div class="row wrap">
          <select id="impType" style="max-width:190px"><option value="">Type: detect from name</option>${IMG_TYPES.map((t) => opt(t, t === 'bed' ? 'Music bed' : TYPE_LABEL[t], '')).join('')}</select>
          <button class="primary" data-action="importFiles">⤒ Import files</button><button data-action="importFolder">📁 Import a folder</button>
          <span class="spacer"></span>
          <label style="margin:0">On air</label><select id="impPref" style="max-width:260px">${opt('prefer', 'Imported pieces replace voiced copy of the same type', B.settings.importedImaging || 'prefer')}${opt('mix', 'Mix imported and voiced pieces', B.settings.importedImaging || 'prefer')}</select>
        </div>
        <div id="impJob">${importHtml()}</div>
      </div>
      <div class="table-wrap"><table class="stacktable"><thead><tr><th>Type</th><th>Name</th><th>Copy</th><th>FX</th><th>Audio</th><th title="Pinned">📌</th><th>On</th><th></th></tr></thead><tbody id="imgRows">
      ${B.imaging.items.map(imgRow).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:10px"><button data-action="addImaging">+ Imaging</button><span class="spacer"></span><button class="primary" data-action="saveImaging">Save imaging</button></div>
    </div>`;
  },
  mount() {
    api('GET', '/api/beds').then((r) => { ui.beds = r; const el = $('#beds'); if (el) el.innerHTML = bedsHtml(); }).catch((e) => toast(e.message, true));
    api('GET', '/api/imaging/create').then((j) => { if (j.running || j.created?.length) { ui.job = j; const el = $('#crJob'); if (el) el.innerHTML = jobHtml(j); } }).catch(() => {});
    const drop = $('#impDrop');
    if (drop) {
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = async (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        importFiles(await droppedFiles(e.dataTransfer), $('#impType').value);
      };
    }
    $('#impPref')?.addEventListener('change', async (e) => {
      try { state.B = await api('PUT', '/api/settings', { importedImaging: e.target.value }); toast('Saved'); } catch (err) { toast(err.message, true); }
    });
    const onInput = (e) => { if (e.target.dataset.k === 'levelDb') $('#bedLvl').textContent = `${e.target.value} dB`; };
    document.addEventListener('input', onInput);
    const offs = [
      bus.on('imagingJob', (j) => { ui.job = j; const el = $('#crJob'); if (el) el.innerHTML = jobHtml(j); }),
      bus.on('bootstrap', () => { if (ui.job && !ui.job.running) bus.emit('rerender'); }),
    ];
    return () => { document.removeEventListener('input', onInput); offs.forEach((f) => f()); };
  },
  actions: {
    createImaging: (b) => run(b, async () => {
      ui.job = await api('POST', '/api/imaging/create', { count: Number($('#crCount').value) || 6, guidance: $('#crGuide').value });
      $('#crJob').innerHTML = jobHtml(ui.job);
    }),
    saveAutoImaging: (b) => run(b, async () => {
      const v = collect($('#autoImg'));
      state.B = await api('PUT', '/api/settings', { autoImaging: v });
    }, 'Schedule saved'),
    addImaging: () => $('#imgRows').insertAdjacentHTML('afterbegin', imgRow({ id: '', type: 'sweeper', name: 'New sweeper', text: 'All the hits. {name}.', enabled: true })),
    saveImaging: async () => {
      const voice = collect($('#imgVoice'));
      voice.speed = Number(voice.speed) || 1;
      delete voice.enabled; delete voice.bed; delete voice.levelDb;
      await save('imaging', { ...state.B.imaging, voice: { ...state.B.imaging.voice, ...voice }, items: readItems() }, 'Imaging saved');
      bus.emit('rerender');
    },
    importFiles: async () => importFiles(await uploadFiles('audio/*'), $('#impType').value),
    importFolder: async () => importFiles(await uploadFiles('', { directory: true }), $('#impType').value),
    upload: async (b) => {
      const r = await upload();
      if (!r) return;
      const tr = b.closest('tr');
      $('[data-f=file]', tr).value = r.file;
      $('[data-role=fname]', tr).textContent = 'uploaded';
      const dur = $('[data-f=durationSec]', tr);
      if (dur) dur.value = Math.round(r.duration);
      toast(`Uploaded (${r.duration}s) — remember to save`);
    },
    clearFile: (b) => { const tr = b.closest('tr'); $('[data-f=file]', tr).value = ''; $('[data-role=fname]', tr).textContent = 'voiced'; },
    previewImaging: (b) => {
      const tr = b.closest('tr');
      const file = $('[data-f=file]', tr).value;
      if (file) return play(`/uploads/${file}`);
      const id = tr.dataset.id;
      const saved = state.B.imaging.items.find((i) => i.id === id);
      const same = saved && saved.text === $('[data-f=text]', tr).value && (saved.fx || '') === ($('[data-f=fx]', tr)?.value || '');
      run(b, async () => {
        const r = same ? await api('POST', '/api/tts/preview', { imagingId: id }) : await api('POST', '/api/tts/preview', { text: $('[data-f=text]', tr).value, imaging: true });
        play(r.audio);
      });
    },
    fireCart: (b) => run(null, () => api('POST', `/api/carts/${b.dataset.id}/fire`), 'Fired'),
    saveBed: (b) => run(b, async () => {
      const v = collect($('#beds'));
      state.B = await api('PUT', '/api/settings', { autoBed: { enabled: v.enabled, bed: v.bed, levelDb: Number(v.levelDb) } });
      ui.beds = await api('GET', '/api/beds');
      $('#beds').innerHTML = bedsHtml();
    }, 'Auto-bed saved'),
    previewBed: (b) => run(b, async () => { const r = await api('POST', '/api/beds/preview', { id: b.dataset.id }); play(r.audio); }),
    uploadBed: async () => {
      const r = await upload();
      if (!r) return;
      const name = prompt('Name this bed', 'Station bed') || 'Station bed';
      await save('imaging', { ...state.B.imaging, items: [...state.B.imaging.items, { type: 'bed', name, text: '', file: r.file, enabled: true }] }, 'Bed added');
      ui.beds = await api('GET', '/api/beds');
      bus.emit('rerender');
    },
  },
};

/** Files from a drop, walking into dropped folders (keeping their paths, which name the imaging type). */
async function droppedFiles(dt) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((r) => entry.file(r, () => r(null)));
      if (f) out.push(Object.assign(f, { relPath: `${prefix}${f.name}` }));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((r) => reader.readEntries(r, () => r([])));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) { for (const e of entries) await walk(e, ''); } else out.push(...[...dt.files].map((f) => Object.assign(f, { relPath: f.name })));
  return out;
}

// ------------------------------------------------------------------ commercials

function spotRow(s) {
  const B = state.B;
  return `<tr data-id="${s.id}">
    <td data-label="Advertiser"><select data-f="advertiserId">${B.advertisers.map((a) => opt(a.id, a.name, s.advertiserId)).join('')}</select></td>
    <td data-label="Title"><input data-f="title" value="${esc(s.title)}"></td>
    <td data-label="Script" class="wide"><textarea data-f="text" rows="2" style="min-height:40px;min-width:220px" placeholder="Script (voiced if there's no audio file)">${esc(s.text || '')}</textarea></td>
    <td data-label="Audio"><div class="row nowrap"><input data-f="file" type="hidden" value="${esc(s.file || '')}"><span class="small muted" data-role="fname">${s.file ? 'uploaded' : 'voiced'}</span><button class="icon" data-action="upload" title="Upload produced spot">⤒</button></div></td>
    <td data-label="Length (s)"><input data-f="durationSec" type="number" value="${s.durationSec || 30}" style="width:64px"></td>
    <td data-label="Starts"><input data-f="startDate" type="date" value="${esc(s.startDate || '')}"></td>
    <td data-label="Ends"><input data-f="endDate" type="date" value="${esc(s.endDate || '')}"></td>
    <td data-label="Max/day"><input data-f="maxPerDay" type="number" value="${s.maxPerDay || 0}" style="width:64px" title="0 = unlimited"></td>
    <td data-label="Dayparts" class="wide"><select data-f="dayparts" multiple size="2" style="min-width:120px">${B.dayparts.map((d) => `<option value="${d.id}" ${(s.dayparts || []).includes(d.id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></td>
    <td data-label="On"><input data-f="enabled" type="checkbox" ${s.enabled !== false ? 'checked' : ''}></td>
    <td class="acts"><div class="row nowrap"><button class="icon" data-action="previewSpot" title="Preview">▶</button><button class="icon danger" data-action="delRow">✕</button></div></td>
  </tr>`;
}

export const spots = {
  render() {
    const B = state.B;
    return `
    <h1>Commercials</h1>
    <p class="sub">Advertisers, spots and flights. Stopsets are filled automatically, honouring flight dates, dayparts, daily caps and advertiser separation.</p>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr)">
      <div class="card">
        <h2>Advertisers</h2>
        <table><tbody id="advRows">${B.advertisers.map((a) => `<tr data-id="${a.id}"><td><input data-f="name" value="${esc(a.name)}"></td><td><input data-f="category" placeholder="Category (auto, dining…)" value="${esc(a.category || '')}"></td><td><button class="icon danger" data-action="delRow">✕</button></td></tr>`).join('')}</tbody></table>
        <div class="row" style="margin-top:10px"><button data-action="addAdvertiser">+ Advertiser</button><span class="spacer"></span><button class="primary" data-action="saveAdvertisers">Save</button></div>
      </div>
      <div class="card">
        <div class="row"><h2 style="margin:0">Affidavit (proof of play)</h2><span class="spacer"></span><input type="date" id="affDate" style="max-width:170px"><button data-action="loadAffidavit">Load</button></div>
        <div id="affOut" class="small muted" style="margin-top:8px">Pick a day to see every spot that aired.</div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Spots</h2>
      <div class="table-wrap"><table class="stacktable"><thead><tr><th>Advertiser</th><th>Title</th><th>Script</th><th>Audio</th><th>Len (s)</th><th>Start</th><th>End</th><th>Max/day</th><th>Dayparts</th><th>On</th><th></th></tr></thead><tbody id="spotRows">
      ${B.spots.map(spotRow).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:10px"><button data-action="addSpot" ${B.advertisers.length ? '' : 'disabled'}>+ Spot</button>${B.advertisers.length ? '' : '<span class="small muted">Add an advertiser first.</span>'}<span class="spacer"></span><button class="primary" data-action="saveSpots">Save spots</button></div>
    </div>`;
  },
  actions: {
    addAdvertiser: () => $('#advRows').insertAdjacentHTML('beforeend', '<tr><td><input data-f="name" placeholder="Advertiser name"></td><td><input data-f="category" placeholder="Category"></td><td><button class="icon danger" data-action="delRow">✕</button></td></tr>'),
    saveAdvertisers: async () => { await save('advertisers', rowsToObjects('#advRows').filter((a) => a.name)); bus.emit('rerender'); },
    addSpot: () => $('#spotRows').insertAdjacentHTML('beforeend', spotRow({ id: '', advertiserId: state.B.advertisers[0]?.id, title: 'New spot', durationSec: 30, maxPerDay: 6, enabled: true })),
    saveSpots: async () => { await save('spots', rowsToObjects('#spotRows').map((s) => ({ ...s, maxPerDay: Number(s.maxPerDay) || 0, durationSec: Number(s.durationSec) || 30 }))); bus.emit('rerender'); },
    upload: imaging.actions.upload,
    previewSpot: (b) => {
      const tr = b.closest('tr');
      const file = $('[data-f=file]', tr).value;
      if (file) return play(`/uploads/${file}`);
      run(b, async () => { const r = await api('POST', '/api/tts/preview', { text: $('[data-f=text]', tr).value }); play(r.audio); });
    },
    loadAffidavit: (b) => run(b, async () => {
      const r = await api('GET', `/api/reports/affidavit?date=${$('#affDate').value || ''}`);
      const name = (id) => state.B.spots.find((s) => s.id === id)?.title || id;
      $('#affOut').innerHTML = `<b>${esc(r.date)}</b> — ${r.plays.length} spot plays<table style="margin-top:6px"><thead><tr><th>Time</th><th>Spot</th><th>Advertiser</th></tr></thead><tbody>${r.plays.map((p) => `<tr><td class="num">${stationTime(p.at)}</td><td>${esc(p.title)}</td><td>${esc(p.artist)}</td></tr>`).join('')}</tbody></table>
        <div style="margin-top:8px">${Object.entries(r.totals).map(([id, n]) => `<span class="badge">${esc(name(id))}: ${n}</span>`).join(' ')}</div>`;
    }),
  },
};
