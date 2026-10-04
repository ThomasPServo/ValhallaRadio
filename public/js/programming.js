// Clocks & weekly grid, dayparts & DJ personas.

import { $, $$, esc, fmtDur, state, api, run, toast, bus, catColor, catOptions, opt, input, collect, rowsToObjects, save, DAYS, TYPE_LABEL } from './core.js';

const ui = { clockId: null, paint: null };
const TYPES = ['toh_id', 'music', 'sweeper', 'id', 'liner', 'promo', 'dj', 'weather', 'traffic', 'news', 'stopset'];
const estLen = (it) => ({ music: 215, stopset: (it.spots || 3) * 30 + 10, dj: it.mode === 'talk' ? 35 : 15, weather: 25, traffic: 25, news: 75, toh_id: 8, id: 5, sweeper: 5, liner: 5, promo: 30 }[it.type] || 10);
const ELEMENT_COLOR = { stopset: '#22d36b', dj: '#ffb020', weather: '#ffb020', traffic: '#ffb020', news: '#ffb020', toh_id: '#b18cff', id: '#b18cff', sweeper: '#9b7bff', liner: '#9b7bff', promo: '#9b7bff' };

function clockSvg(c) {
  const total = Math.max(3600, c.items.reduce((s, it) => s + estLen(it), 0));
  let a = -Math.PI / 2;
  const arcs = c.items.map((it) => {
    const span = (estLen(it) / total) * Math.PI * 2;
    const x1 = Math.cos(a) * 100; const y1 = Math.sin(a) * 100;
    a += span;
    const x2 = Math.cos(a) * 100; const y2 = Math.sin(a) * 100;
    const col = it.type === 'music' ? catColor(it.category) : ELEMENT_COLOR[it.type] || '#64748b';
    return `<path d="M0 0 L${x1} ${y1} A100 100 0 ${span > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z" fill="${col}" stroke="#0b0d12" stroke-width="1"><title>${TYPE_LABEL[it.type]} ${it.category || ''}</title></path>`;
  }).join('');
  const ticks = Array.from({ length: 12 }, (_, i) => { const q = (i / 12) * Math.PI * 2 - Math.PI / 2; return `<line x1="${Math.cos(q) * 104}" y1="${Math.sin(q) * 104}" x2="${Math.cos(q) * 110}" y2="${Math.sin(q) * 110}" stroke="#8a93a8" stroke-width="${i % 3 ? 1 : 2}"/>`; }).join('');
  return `${arcs}${ticks}<circle r="46" fill="#10141c"/><text text-anchor="middle" dy="-2" fill="#e8ebf2" font-size="16" font-weight="800">:00</text><text text-anchor="middle" dy="16" fill="#8a93a8" font-size="10">${c.items.filter((i) => i.type === 'music').length} songs</text>`;
}

function clockEditor(c) {
  return `
    <div class="row"><div style="flex:1">${input('name', 'Clock name', c.name)}</div><div style="width:90px"><label>Color</label><input data-k="color" type="color" value="${esc(c.color)}" style="padding:2px;height:36px"></div></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>#</th><th>Element</th><th>Options</th><th>~Len</th><th></th></tr></thead><tbody id="clockRows">
    ${c.items.map((it, i) => `<tr data-i="${i}"><td class="muted">${i + 1}</td>
      <td><select data-f="type" data-change="clockType">${TYPES.map((t) => opt(t, TYPE_LABEL[t], it.type)).join('')}</select></td>
      <td>${it.type === 'music' ? `<select data-f="category">${catOptions(it.category)}</select>`
        : it.type === 'dj' ? `<select data-f="mode">${[['auto', 'Auto (back/forward-sell)'], ['backsell', 'Back-sell'], ['frontsell', 'Forward-sell'], ['talk', 'Personality talk']].map(([v, l]) => opt(v, l, it.mode)).join('')}</select>`
        : it.type === 'stopset' ? `<input data-f="spots" type="number" min="1" max="10" value="${it.spots || 3}" style="width:80px"> <span class="small muted">spots</span>` : ''}</td>
      <td class="num small muted">${fmtDur(estLen(it))}</td>
      <td class="row nowrap"><button class="icon" data-action="clockMove" data-i="${i}" data-dir="-1">↑</button><button class="icon" data-action="clockMove" data-i="${i}" data-dir="1">↓</button><button class="icon danger" data-action="clockDel" data-i="${i}">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:10px">
      <select id="addType" style="max-width:200px">${TYPES.map((t) => opt(t, TYPE_LABEL[t], 'music')).join('')}</select><button data-action="clockAdd">+ Add element</button>
      <span class="spacer"></span><button class="danger" data-action="delClock">Delete clock</button><button class="primary" data-action="saveClock">Save clock</button>
    </div>
    <p class="hint">Estimated length ${fmtDur(c.items.reduce((s, it) => s + estLen(it), 0))} of 60:00. Over-filled hours are trimmed at the top of the hour; under-filled ones get extra music.</p>`;
}

function syncClock() {
  const c = state.B.clocks.find((x) => x.id === ui.clockId);
  if (!c) return;
  Object.assign(c, collect($('#clockEditor')));
  c.items = $$('#clockRows tr').map((tr) => {
    const it = { type: $('[data-f=type]', tr).value };
    if (it.type === 'music') it.category = $('[data-f=category]', tr)?.value || state.B.categories[0]?.id;
    if (it.type === 'dj') it.mode = $('[data-f=mode]', tr)?.value || 'auto';
    if (it.type === 'stopset') it.spots = Number($('[data-f=spots]', tr)?.value || 3);
    return it;
  });
}

export const clocks = {
  render() {
    const B = state.B;
    const clock = B.clocks.find((c) => c.id === ui.clockId) || B.clocks[0];
    ui.clockId = clock?.id;
    ui.paint ||= clock?.id;
    return `
    <h1>Clocks &amp; grid</h1>
    <p class="sub">Hour templates and the weekly schedule. Every hour's log is built from its clock; the music director fills the music slots.</p>
    <div class="grid" style="grid-template-columns:280px minmax(0,1fr)">
      <div class="card">
        <h2>Clocks</h2>
        ${B.clocks.map((c) => `<button class="listbtn ${c.id === clock?.id ? 'on' : ''}" data-action="pickClock" data-id="${c.id}"><span class="cat" style="background:${c.color}">&nbsp;</span> ${esc(c.name)} <span class="muted small">(${c.items.length})</span></button>`).join('')}
        <div class="row" style="margin-top:10px"><button data-action="newClock">+ New clock</button>${clock ? '<button data-action="dupClock">Duplicate</button>' : ''}</div>
        ${clock ? `<svg class="clockviz" viewBox="-112 -112 224 224" style="margin-top:14px">${clockSvg(clock)}</svg>` : ''}
      </div>
      <div class="card" id="clockEditor">${clock ? clockEditor(clock) : ''}</div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row"><h2 style="margin:0">Weekly grid</h2><span class="spacer"></span><label style="margin:0">Paint with</label>
        <select id="paintClock" style="max-width:240px">${B.clocks.map((c) => opt(c.id, c.name, ui.paint)).join('')}</select>
        <button class="primary" data-action="saveGrid">Save grid</button></div>
      <p class="hint">Click or drag across hours to assign the selected clock.</p>
      <div class="table-wrap"><table class="gridtable" id="gridTable"><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${B.grid.map((row, d) => `<tr><th>${DAYS[d]}</th>${row.map((cid, h) => { const c = B.clocks.find((x) => x.id === cid); return `<td data-d="${d}" data-h="${h}" title="${esc(c?.name || '')}" style="background:${c?.color || '#333'}"></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
    </div>`;
  },
  mount() {
    $('#paintClock').onchange = (e) => { ui.paint = e.target.value; };
    let painting = false;
    const paint = (td) => {
      if (!td?.dataset.d) return;
      state.B.grid[td.dataset.d][td.dataset.h] = ui.paint;
      const c = state.B.clocks.find((x) => x.id === ui.paint);
      td.style.background = c?.color; td.title = c?.name;
    };
    const t = $('#gridTable');
    t.onmousedown = (e) => { painting = true; paint(e.target.closest('td')); e.preventDefault(); };
    t.onmouseover = (e) => { if (painting) paint(e.target.closest('td')); };
    const up = () => { painting = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  },
  changes: { clockType: () => { syncClock(); bus.emit('rerender'); } },
  actions: {
    pickClock: (b) => { ui.clockId = b.dataset.id; bus.emit('rerender'); },
    newClock: () => { const c = { id: `clk_${Math.random().toString(36).slice(2, 9)}`, name: 'New Clock', color: '#14b8a6', items: [{ type: 'toh_id' }, { type: 'music', category: state.B.categories[0]?.id }] }; state.B.clocks.push(c); ui.clockId = c.id; bus.emit('rerender'); },
    dupClock: () => { syncClock(); const src = state.B.clocks.find((c) => c.id === ui.clockId); const c = { ...structuredClone(src), id: `clk_${Math.random().toString(36).slice(2, 9)}`, name: `${src.name} (copy)` }; state.B.clocks.push(c); ui.clockId = c.id; bus.emit('rerender'); },
    clockAdd: () => { syncClock(); const t = $('#addType').value; const c = state.B.clocks.find((x) => x.id === ui.clockId); c.items.push(t === 'music' ? { type: t, category: state.B.categories[0]?.id } : t === 'stopset' ? { type: t, spots: 3 } : t === 'dj' ? { type: t, mode: 'auto' } : { type: t }); bus.emit('rerender'); },
    clockMove: (b) => { syncClock(); const c = state.B.clocks.find((x) => x.id === ui.clockId); const i = Number(b.dataset.i); const j = i + Number(b.dataset.dir); if (j < 0 || j >= c.items.length) return; [c.items[i], c.items[j]] = [c.items[j], c.items[i]]; bus.emit('rerender'); },
    clockDel: (b) => { syncClock(); const c = state.B.clocks.find((x) => x.id === ui.clockId); c.items.splice(Number(b.dataset.i), 1); bus.emit('rerender'); },
    saveClock: async () => { syncClock(); await save('clocks', state.B.clocks, 'Clock saved'); bus.emit('rerender'); },
    delClock: async () => {
      const B = state.B;
      if (B.clocks.length < 2) return toast('You need at least one clock', true);
      if (!confirm('Delete this clock? Grid hours using it switch to the first clock.')) return;
      const keep = B.clocks.filter((c) => c.id !== ui.clockId);
      const grid = B.grid.map((r) => r.map((cid) => (keep.some((c) => c.id === cid) ? cid : keep[0].id)));
      await save('clocks', keep);
      await save('grid', grid, 'Clock deleted');
      ui.clockId = null; ui.paint = null; bus.emit('rerender');
    },
    saveGrid: () => save('grid', state.B.grid, 'Grid saved'),
  },
};

// ------------------------------------------------------------------ DJs

function personaCard(p) {
  const B = state.B;
  const voices = B.kokoroVoices || {};
  return `<div class="card stack" data-id="${p.id}">
    <div class="row"><div class="avatar">${esc((p.name || '?')[0])}</div><div style="flex:1">${input('name', 'On-air name', p.name)}</div><button class="icon danger" data-action="delPersona" data-id="${p.id}" title="Remove">✕</button></div>
    <div><label>Personality &amp; style (Claude writes in this voice)</label><textarea data-k="style" rows="3">${esc(p.style)}</textarea></div>
    <div class="grid cols-2">
      <div><label>Local voice (free)</label><select data-k="voice.kokoroVoice">${Object.entries(voices).map(([k, l]) => opt(k, l, p.voice?.kokoroVoice || 'af_heart')).join('')}</select></div>
      ${input('voice.speed', 'Speaking speed', p.voice?.speed ?? 1, 'number', 'step="0.05" min="0.8" max="1.25"')}
      ${input('voice.elevenLabsVoiceId', 'ElevenLabs voice ID (if keyed)', p.voice?.elevenLabsVoiceId)}
      ${input('voice.openaiVoice', 'OpenAI voice (if keyed)', p.voice?.openaiVoice)}
    </div>
    <div class="row"><select data-role="kind" style="max-width:180px">${[['auto', 'Quick break'], ['backsell', 'Back-sell'], ['frontsell', 'Forward-sell'], ['talk', 'Personality talk'], ['weather', 'Weather'], ['traffic', 'Traffic'], ['news', 'Newscast']].map(([k, l]) => opt(k, l, 'auto')).join('')}</select>
      <button data-action="previewBreak" data-id="${p.id}">🎙️ Write &amp; voice a sample</button></div>
    <div data-role="out"></div>
  </div>`;
}

const readPersonas = () => $$('#personaCards > .card').map((card) => {
  const v = collect(card);
  if (v.voice?.speed) v.voice.speed = Number(v.voice.speed) || 1;
  const prev = state.B.personas.find((p) => p.id === card.dataset.id);
  return { id: card.dataset.id, ...v, voice: { ...(prev?.voice || {}), ...(v.voice || {}) } };
});

export const djs = {
  render() {
    const B = state.B;
    return `
    <h1>Dayparts &amp; DJs</h1>
    <p class="sub">Dayparts tell the music director and the DJs what each part of the day should feel like. Personas are your air talent: Claude writes as them, the voice engine performs them.</p>
    <div class="card">
      <h2>Dayparts</h2>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>From</th><th>To</th><th>Mood &amp; programming direction</th><th>Host</th><th></th></tr></thead><tbody id="dpRows">
      ${B.dayparts.map((d) => `<tr data-id="${d.id}"><td><input data-f="name" value="${esc(d.name)}"></td><td><input data-f="startHour" type="number" min="0" max="23" value="${d.startHour}" style="width:64px"></td><td><input data-f="endHour" type="number" min="0" max="23" value="${d.endHour}" style="width:64px"></td><td><textarea data-f="mood" rows="2" style="min-height:40px">${esc(d.mood)}</textarea></td><td><select data-f="personaId">${B.personas.map((p) => opt(p.id, p.name, d.personaId)).join('')}</select></td><td><button class="icon danger" data-action="delRow">✕</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:10px"><button data-action="addDaypart">+ Daypart</button><span class="spacer"></span><button class="primary" data-action="saveDayparts">Save dayparts</button></div>
    </div>
    <div class="row" style="margin:20px 0 10px"><h2 style="margin:0">Air talent</h2><span class="spacer"></span><button data-action="addPersona">+ DJ</button><button class="primary" data-action="savePersonas">Save DJs</button></div>
    <div class="grid cols-2" id="personaCards">${B.personas.map(personaCard).join('')}</div>`;
  },
  actions: {
    addDaypart: () => $('#dpRows').insertAdjacentHTML('beforeend', `<tr><td><input data-f="name" value="New daypart"></td><td><input data-f="startHour" type="number" value="0" style="width:64px"></td><td><input data-f="endHour" type="number" value="23" style="width:64px"></td><td><textarea data-f="mood" rows="2" style="min-height:40px"></textarea></td><td><select data-f="personaId">${state.B.personas.map((p) => opt(p.id, p.name)).join('')}</select></td><td><button class="icon danger" data-action="delRow">✕</button></td></tr>`),
    saveDayparts: () => save('dayparts', rowsToObjects('#dpRows').map((d) => ({ ...d, startHour: Number(d.startHour), endHour: Number(d.endHour) }))),
    addPersona: async () => { await save('personas', [...readPersonas(), { name: 'New DJ', style: 'Friendly, natural, conversational host.', voice: { kokoroVoice: 'af_heart', speed: 1 } }], 'DJ added'); bus.emit('rerender'); },
    savePersonas: () => save('personas', readPersonas(), 'DJs saved'),
    delPersona: async (b) => { if (state.B.personas.length < 2) return toast('Keep at least one DJ', true); await save('personas', readPersonas().filter((p) => p.id !== b.dataset.id)); bus.emit('rerender'); },
    previewBreak: (b) => {
      const card = b.closest('.card');
      run(b, async () => {
        await save('personas', readPersonas(), 'DJ saved');
        const r = await api('POST', '/api/dj/preview', { kind: $('[data-role=kind]', card).value });
        $('[data-role=out]', card).innerHTML = `<div class="script">“${esc(r.text)}”</div><div class="small muted">Voiced as ${esc(r.persona)} (by daypart). ${r.audio ? '' : 'No voice engine yet — script only.'}</div>${r.audio ? `<audio controls autoplay src="${r.audio}" style="width:100%;margin-top:6px"></audio>` : ''}`;
      });
    },
  },
};
