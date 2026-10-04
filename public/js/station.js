// Station identity & market, streaming, AI status/programmer and settings.

import { $, esc, state, api, run, toast, bus, opt, input, check, select, collect, save, play, uploadFile, TYPE_LABEL } from './core.js';

const ui = { feed: '', feedHtml: '', design: null, brief: '', install: [], aiTest: '' };

// ------------------------------------------------------------------ station & market

function zonesHtml() {
  const z = state.B.marketZones || [];
  if (!z.length) return '<span class="muted small">Add a location to set the clock from your market.</span>';
  return z.map((x) => `<span class="badge" title="${esc(x.tz)}">${esc(x.label)} · ${esc(x.places.join(', '))}</span>`).join(' ');
}

function feedHtml(kind, r) {
  if (kind === 'weather') {
    return r.length ? r.map((w) => `<div class="feedcard"><b>${esc(w.location)}</b> <span class="muted small">${esc(w.credit || w.source || '')}</span>
      <div>${w.current.temp}${w.units.temp}, ${esc(w.current.conditions)}${w.current.feelsLike !== w.current.temp ? ` (feels ${w.current.feelsLike})` : ''}, wind ${w.current.wind ?? '—'} ${w.units.wind}</div>
      <div class="small muted">${[w.today, w.tomorrow].filter(Boolean).map((p) => `${esc(p.name)}: ${esc(p.conditions)}${p.high != null ? `, high ${p.high}` : ''}${p.low != null ? `, low ${p.low}` : ''}${p.precipChance != null ? `, ${p.precipChance}%` : ''}`).join(' · ')} · sunrise ${esc(w.sunrise || '—')} · sunset ${esc(w.sunset || '—')}</div>
      ${(w.forecast || []).slice(0, 1).map((f) => `<div class="small" style="margin-top:4px">“${esc(f.text)}”</div>`).join('')}
      ${(w.alerts || []).map((a) => `<div class="small" style="color:var(--red)">⚠ ${esc(a.event)}: ${esc(a.headline)}</div>`).join('')}</div>`).join('') : '<div class="muted small">Add a location first.</div>';
  }
  if (kind === 'news') {
    return `<h3>Local</h3>${r.local.map((n) => `<div class="small">• <span class="muted">[${esc(n.area)}]</span> ${esc(n.title)}</div>`).join('') || '<div class="muted small">No local stories.</div>'}
      <h3 style="margin-top:8px">National</h3>${r.national.map((n) => `<div class="small">• ${esc(n.title)}</div>`).join('')}`;
  }
  const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 60000))} min ago` : '');
  return `<div class="small muted" style="margin-bottom:6px">${(r.sources || []).map((s) => `<span class="badge ${s.ok ? '' : 'e'}" title="${esc(s.error || '')}">${esc(s.name)} ${s.ok ? s.count : '✗'}</span>`).join(' ')}</div>
    ${r.incidents.length ? '<h3>Incidents</h3>' : ''}${r.incidents.map((i) => `<div class="small">• <b>${esc(i.type)}</b> — ${esc(i.where)} <span class="muted">(${esc(i.area || '')}${i.lanes ? `, ${esc(i.lanes)}` : ''}, ${ago(i.at)})</span></div>`).join('')}
    ${r.closures.length ? '<h3 style="margin-top:8px">Road work &amp; closures</h3>' : ''}${r.closures.map((c) => `<div class="small">• <b>${esc(c.road)}</b> ${esc(c.direction || '')}: ${esc(c.impact)} ${esc(c.cross || '')} ${c.upcoming ? '<span class="badge">tonight</span>' : ''} <span class="muted">${esc(c.source || '')}</span></div>`).join('')}
    ${r.headlines.length ? '<h3 style="margin-top:8px">Headlines</h3>' : ''}${r.headlines.map((h) => `<div class="small">• ${esc(h.title)}</div>`).join('')}
    ${!r.incidents.length && !r.closures.length && !r.headlines.length ? '<div class="small">Nothing reported in your market right now — the DJ will say the roads look good.</div>' : ''}`;
}

export const station = {
  render() {
    const st = state.B.station;
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser */ }
    const so = st.socials || {};
    return `
    <h1>Station &amp; market</h1>
    <p class="sub">Your brand on air and everywhere listeners see it. The market drives local weather, traffic, news and the station clock.</p>
    <div class="grid cols-2">
      <div class="card stack" id="stationForm">
        <h2>Identity</h2>
        <div class="row nowrap" style="gap:14px">
          <div class="logo-drop" data-action="uploadLogo" title="Upload a logo (PNG, JPG, SVG)">${st.logo ? `<img src="/station-logo?v=${encodeURIComponent(st.logo)}" alt="">` : '<span>＋ Logo</span>'}</div>
          <div class="grid cols-2" style="flex:1">${input('name', 'Station name', st.name)}${input('slogan', 'Slogan', st.slogan)}${input('callSign', 'Call letters (for legal IDs)', st.callSign)}${input('frequency', 'Frequency / dial position', st.frequency, 'text', 'placeholder="101.9 FM"')}</div>
        </div>
        <div><label>Format (guides the music director and DJs)</label><textarea data-k="format" rows="3">${esc(st.format)}</textarea></div>
        <div class="grid cols-3">${input('website', 'Website', st.website)}${input('phone', 'Request line', st.phone)}${input('email', 'Email', st.email)}</div>
        <div class="grid cols-3">${input('socials.instagram', 'Instagram', so.instagram)}${input('socials.tiktok', 'TikTok', so.tiktok)}${input('socials.x', 'X', so.x)}${input('socials.facebook', 'Facebook', so.facebook)}${input('socials.youtube', 'YouTube', so.youtube)}
          ${select('units', 'Units', st.units, [['imperial', 'Imperial (°F, mph)'], ['metric', 'Metric (°C, km/h)']])}</div>
        ${input('language', 'Language', st.language)}
        <div class="row"><button class="primary" data-action="saveStation">Save station</button><button data-action="wizard">Run setup again…</button></div>
      </div>
      <div class="card stack">
        <h2>Market &amp; time</h2>
        <div class="grid cols-2" id="marketForm">${input('market.name', 'Market name', st.market.name, 'text', 'placeholder="e.g. West Texas, Greater Austin"')}<div></div></div>
        <div><label>Notes for the DJs (landmarks, roads, teams, local slang)</label><textarea data-k="market.description" id="mktDesc" rows="2">${esc(st.market.description || '')}</textarea></div>
        <div class="row nowrap"><input id="locName" placeholder="Add a city or a whole county, e.g. Travis County, Texas"><button data-action="addLocation">Add</button></div>
        <div>${st.market.locations.map((l, i) => `<div class="locrow"><span>${i === 0 ? '⭐' : l.kind === 'county' ? '🗺️' : '📍'} ${esc(l.name)}</span>
          <span class="small muted">${esc(l.timezone || '')}</span><span class="spacer"></span>
          ${i ? `<button class="icon" data-action="primary" data-i="${i}" title="Make primary (sets the station clock in auto mode)">⭐</button>` : '<span class="small muted">primary</span>'}
          <button class="icon danger" data-action="delLocation" data-i="${i}">✕</button></div>`).join('') || '<div class="muted small">No locations yet.</div>'}</div>
        <div class="grid cols-2" id="tzForm">
          ${select('timezoneMode', 'Station clock', st.timezoneMode || 'auto', [['auto', 'Follow the primary market location'], ['manual', 'Fixed time zone']])}
          <div><label>Time zone</label><input data-k="timezone" list="tzList" value="${esc(st.timezone)}" ${st.timezoneMode === 'manual' ? '' : 'readonly'}><datalist id="tzList">${zones.map((z) => `<option value="${z}">`).join('')}</datalist></div>
        </div>
        <div class="small">Zones in your market: ${zonesHtml()}</div>
        <div class="row"><button class="primary" data-action="saveMarket">Save market &amp; time</button></div>
        <div class="sep"></div>
        <h2>Live local data <span class="badge clean">no API keys</span></h2>
        <p class="small muted" style="margin:0">Weather: National Weather Service (US) or MET Norway. Traffic: state DOT work-zone feeds, CHP and city dispatch feeds, and local headlines. News: local RSS.</p>
        <div class="row"><button data-action="feed" data-feed="weather">🌦 Weather</button><button data-action="feed" data-feed="traffic">🚗 Traffic</button><button data-action="feed" data-feed="news">📰 News</button></div>
        <div id="feedOut">${ui.feedHtml}</div>
      </div>
    </div>`;
  },
  mount() {
    const sel = $('[data-k=timezoneMode]');
    sel.onchange = () => { $('[data-k=timezone]').readOnly = sel.value !== 'manual'; };
  },
  actions: {
    saveStation: (b) => run(b, async () => { await save('station', collect($('#stationForm')), 'Station saved'); bus.emit('bootstrap', state.B); }),
    saveMarket: (b) => run(b, async () => {
      const v = { ...collect($('#tzForm')), market: { ...collect($('#marketForm')).market, description: $('#mktDesc').value } };
      if (v.timezoneMode !== 'manual') delete v.timezone;
      await save('station', v, 'Market saved');
      bus.emit('rerender');
    }),
    uploadLogo: async () => {
      const f = await uploadFile('image/png,image/jpeg,image/webp,image/svg+xml,image/gif');
      if (!f) return;
      try { state.B = await api('POST', '/api/station/logo', undefined, f); bus.emit('bootstrap', state.B); bus.emit('rerender'); toast('Logo updated'); } catch (e) { toast(e.message, true); }
    },
    addLocation: (b) => run(b, async () => { state.B = await api('POST', '/api/market/locations', { name: $('#locName').value }); bus.emit('rerender'); }, 'Location added'),
    delLocation: async (b) => { state.B = await api('DELETE', `/api/market/locations/${b.dataset.i}`); bus.emit('rerender'); },
    primary: async (b) => { state.B = await api('POST', '/api/market/primary', { idx: Number(b.dataset.i) }); bus.emit('rerender'); toast('Primary location changed'); },
    feed: (b) => run(b, async () => {
      const r = await api('GET', `/api/feeds/${b.dataset.feed}`);
      ui.feedHtml = feedHtml(b.dataset.feed, r);
      $('#feedOut').innerHTML = ui.feedHtml;
    }),
  },
};

// ------------------------------------------------------------------ streaming

export const streaming = {
  render() {
    const B = state.B; const ic = B.stream.icecast; const S = state.S;
    const url = `${location.origin}/stream.mp3`;
    return `
    <h1>Streaming</h1>
    <p class="sub">A built-in MP3 stream with now-playing metadata, a public listener page, and an optional relay to Icecast/Shoutcast.</p>
    <div class="grid cols-2">
      <div class="card stack">
        <h2>Listen</h2>
        <div><label>Stream URL</label><input readonly value="${esc(url)}" onclick="this.select()"></div>
        <div><label>Listener page (your branding)</label><div class="row nowrap"><input readonly value="${esc(location.origin)}/listen" onclick="this.select()"><a href="/listen" target="_blank"><button>Open</button></a></div></div>
        <div><label>Now-playing JSON (websites, apps, smart speakers)</label><input readonly value="${esc(location.origin)}/api/nowplaying" onclick="this.select()"></div>
        <div><label>Embed</label><textarea readonly rows="2" onclick="this.select()">&lt;audio controls src="${esc(url)}"&gt;&lt;/audio&gt;</textarea></div>
        <div id="streamForm">${select('bitrate', 'Bitrate', B.stream.bitrate, [[64, '64 kbps'], [96, '96 kbps'], [128, '128 kbps'], [192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']])}</div>
        <p class="hint">Bitrate changes apply the next time the station goes on air.</p>
      </div>
      <div class="card stack" id="icecastForm">
        <h2>Icecast relay</h2>
        ${check('enabled', 'Push the stream to an Icecast server', ic.enabled)}
        <div class="grid cols-2">${input('host', 'Host', ic.host)}${input('port', 'Port', ic.port, 'number')}${input('mount', 'Mount', ic.mount)}${input('username', 'Source user', ic.username)}${input('password', 'Source password', ic.password, 'password')}</div>
        ${check('public', 'List in public directories', ic.public)}
        <div><button class="primary" data-action="saveStream">Save streaming</button></div>
        <div class="small"><span class="dot ${S.icecast?.startsWith('connected') ? 'ok' : ''}" style="display:inline-block"></span> Status: ${esc(S.icecast || 'off')} · ${S.listeners || 0} listening on the built-in stream</div>
      </div>
    </div>`;
  },
  actions: {
    saveStream: () => save('stream', { ...collect($('#streamForm')), icecast: collect($('#icecastForm')) }, 'Streaming saved'),
  },
};

// ------------------------------------------------------------------ AI

function aiStatusHtml() {
  const a = state.B.capabilities.ai || {};
  const cc = a.claudeCode || {}; const cx = a.codex || {}; const oa = a.openai || {}; const lm = a.lmstudio || {};
  const row = (ok, label, detail = '') => `<div class="caprow"><span class="dot ${ok === true ? 'ok' : ok === false ? 'bad' : ''}"></span><b>${label}</b><span class="muted small">${detail}</span></div>`;
  const stats = (x) => (x.calls ? ` · ${x.calls} request${x.calls === 1 ? '' : 's'}, ${x.failures || 0} failed${x.lastMs ? `, last ${(x.lastMs / 1000).toFixed(1)}s` : ''}` : '');
  const errs = [cc.lastError && `Claude Code: ${cc.lastError}`, cx.lastError && `Codex: ${cx.lastError}`, oa.lastError && `OpenAI: ${oa.lastError}`, lm.lastError && `LM Studio: ${lm.lastError}`].filter(Boolean);
  return `
    ${row(Boolean(a.provider), a.provider ? `Using ${esc(a.label)}` : 'No AI connected', a.provider ? `model ${esc(a.model || '')}${a.chain?.length > 1 ? ` · then ${a.chain.slice(1).map(esc).join(', ')}` : ''}` : '')}
    <div class="sep"></div>
    ${row(cc.found ? cc.loggedIn : null, cc.found ? `Claude Code ${esc(cc.version || '')}` : 'Claude Code not found', (cc.found ? (cc.loggedIn ? `signed in (${esc(cc.authMethod || '')})` : 'not signed in — run <code>claude</code>') : '') + stats(cc))}
    ${row(cx.found ? cx.loggedIn : null, cx.found ? `Codex ${esc(cx.version || '')} (ChatGPT)` : 'Codex not found', (cx.found ? (cx.loggedIn ? `signed in (${esc(cx.method || '')})` : 'not signed in — run <code>codex login</code>') : '') + stats(cx))}
    ${row(lm.reachable ? (lm.models?.length ? true : null) : null, lm.reachable ? `LM Studio at ${esc(lm.url)}` : 'LM Studio not running', (lm.reachable ? (lm.models?.length ? `${lm.models.length} model${lm.models.length === 1 ? '' : 's'} · using ${esc(lm.model || '')}` : 'no model loaded') : esc(lm.url || '')) + stats(lm))}
    ${row(a.apiKey ? true : null, a.apiKey ? 'Anthropic API key saved' : 'No Anthropic API key (optional)')}
    ${row(oa.apiKey ? true : null, oa.apiKey ? `OpenAI API key saved · ${esc(oa.model || '')}` : 'No OpenAI API key (optional)', stats(oa))}
    ${errs.length ? `<div class="small" style="color:var(--red)">Last error — ${errs.map(esc).join('<br>')}</div>` : ''}`;
}

function designHtml(d) {
  return `<div class="card stack">
    <div class="row"><h2 style="margin:0">Proposal</h2><span class="spacer"></span><button class="primary" data-action="applyDesign">Apply to station</button></div>
    <p>${esc(d.summary)}</p>
    <p><b>Format:</b> ${esc(d.format)}<br><b>Slogan:</b> ${esc(d.slogan)}</p>
    <div class="grid cols-2">
      <div><h3>Categories</h3>${d.categories.map((c) => `<div class="small"><b>${esc(c.id)}</b> ${esc(c.name)} — rest ${c.minRestHours}h <span class="muted">(${esc(c.searchSeeds)})</span></div>`).join('')}</div>
      <div><h3>Dayparts</h3>${d.dayparts.map((p) => `<div class="small"><b>${p.startHour}–${p.endHour}h ${esc(p.name)}</b> (${esc(p.personaKey)}): ${esc(p.mood)}</div>`).join('')}</div>
      <div><h3>Air talent</h3>${d.personas.map((p) => `<div class="small"><b>${esc(p.name)}</b>: ${esc(p.style)}</div>`).join('')}</div>
      <div><h3>Imaging</h3>${d.imaging.map((i) => `<div class="small"><b>${esc(TYPE_LABEL[i.type] || i.type)}</b>: ${esc(i.text)}</div>`).join('')}</div>
    </div>
    <h3>Clocks</h3>${d.clocks.map((c) => `<div class="small" style="margin-bottom:6px"><b>${esc(c.name)}</b>: ${c.items.map((i) => (i.type === 'music' ? i.category : TYPE_LABEL[i.type])).join(' → ')}</div>`).join('')}
    <p class="hint">Applying replaces categories, clocks, grid, dayparts, DJs and imaging. Your music library is kept.</p>
  </div>`;
}

export const ai = {
  render: () => `
    <h1>AI</h1>
    <p class="sub">The AI is the music director, writes every DJ break and imaging line, and can design your whole station. It runs on a subscription you already have — Claude Code or ChatGPT (Codex) — or fully offline on a local model in LM Studio. No API key needed.</p>
    <div class="grid cols-2">
      <div class="card stack">
        <h2>Connection</h2>
        <div id="aiStatus">${aiStatusHtml()}</div>
        <div class="row"><button data-action="aiRefresh">↻ Re-check</button><button data-action="aiTest">Test the AI</button></div>
        <div id="aiTestOut" class="small">${ui.aiTest}</div>
        <details><summary class="small">Running on a server?</summary><div class="small muted" style="margin-top:6px">Claude Code: run <code>claude setup-token</code> once and set <code>CLAUDE_CODE_OAUTH_TOKEN</code>. Codex: run <code>codex login --device-auth</code> on the server (or copy <code>~/.codex/auth.json</code>). LM Studio: start its server (<code>lms server start</code>) and point Settings → AI at it, e.g. <code>http://gpu-box:1234/v1</code>. API keys work too and act as fallbacks.</div></details>
      </div>
      <div class="card stack">
        <h2>AI programmer</h2>
        <textarea id="brief" rows="6" placeholder="e.g. A classic rock station for Tulsa aimed at 35-54. Morning show with news, weather and traffic every 20 minutes. Fewer ads at night. Weekends are 'Deep Cuts'. Two hosts: a gravel-voiced veteran and a younger sidekick.">${esc(ui.brief)}</textarea>
        <div class="row"><button class="primary" data-action="design" ${state.B.capabilities.claude ? '' : 'disabled'}>Design my station</button></div>
      </div>
    </div>
    <div id="designOut" style="margin-top:14px">${ui.design ? designHtml(ui.design) : ''}</div>`,
  actions: {
    aiRefresh: (b) => run(b, async () => { const s = await api('GET', '/api/ai/status'); state.B.capabilities.ai = s; state.B.capabilities.claude = Boolean(s.provider); $('#aiStatus').innerHTML = aiStatusHtml(); }),
    aiTest: (b) => run(b, async () => {
      const r = await api('POST', '/api/ai/test');
      state.B.capabilities.ai = r.status;
      ui.aiTest = `✅ “${esc(r.text)}” <span class="muted">(${(r.ms / 1000).toFixed(1)}s via ${esc(r.status.label || r.status.provider)})</span>`;
      $('#aiTestOut').innerHTML = ui.aiTest;
      $('#aiStatus').innerHTML = aiStatusHtml();
    }),
    design: (b) => {
      ui.brief = $('#brief').value;
      if (!ui.brief.trim()) return toast('Describe your station first', true);
      run(b, async () => { ui.design = await api('POST', '/api/ai/design', { brief: ui.brief }); $('#designOut').innerHTML = designHtml(ui.design); });
    },
    applyDesign: (b) => { if (confirm('Replace your programming with this design?')) run(b, async () => { state.B = await api('POST', '/api/ai/design/apply', { design: ui.design }); bus.emit('bootstrap', state.B); ui.design = null; location.hash = '#clocks'; }, 'Design applied'); },
  },
};

// ------------------------------------------------------------------ settings

function kokoroHtml() {
  const k = state.B.capabilities.voice?.kokoro || {};
  if (k.installed) return `<div class="caprow"><span class="dot ok"></span><b>Local voice installed</b><span class="muted small">${k.modelCached ? 'model ready' : 'model downloads on first use (~90 MB)'}</span></div>`;
  return `<div class="caprow"><span class="dot ${k.installing ? 'warn' : 'bad'}"></span><b>${k.installing ? 'Installing the local voice…' : 'Local voice not installed'}</b></div>
    <div class="small muted">A free, natural-sounding neural voice (Kokoro) that runs on this machine. One-time download, no account or key.</div>
    <div class="row"><button class="primary" data-action="installKokoro" ${k.installing ? 'disabled' : ''}>Install local voice</button></div>
    <pre class="json" id="installLog" style="max-height:90px;${ui.install.length ? '' : 'display:none'}">${esc(ui.install.slice(-6).join('\n'))}</pre>`;
}

export const settings = {
  render() {
    const s = state.B.settings; const c = state.B.capabilities;
    return `
    <h1>Settings</h1>
    <p class="sub">Everything works with no API keys: Claude Code, ChatGPT (Codex) or LM Studio for AI, the local voice for speech, and keyless public data for weather and traffic. Keys are optional upgrades, stored only on the server.</p>
    <div class="grid cols-2" id="settingsForm">
      <div class="card stack">
        <h2>🤖 AI</h2>
        ${select('claudeProvider', 'AI provider', s.claudeProvider, [['auto', 'Auto — the first one that is ready'], ['claude-code', 'Claude Code (your Claude subscription)'], ['api', 'Claude API (Anthropic key)'], ['codex', 'ChatGPT via Codex (your ChatGPT login)'], ['openai', 'OpenAI API (key)'], ['lmstudio', 'LM Studio (local model)']])}
        ${check('aiFallback', 'If it fails or hits a usage limit, use the next AI that is ready', s.aiFallback !== false)}
        <details open><summary class="small">Claude</summary><div class="stack" style="margin-top:8px">
          ${select('claudeModel', 'Claude model', s.claudeModel, [['claude-sonnet-5-5', 'Claude Sonnet 5.5 (default)'], ['claude-opus-5-5', 'Claude Opus 5.5 (strongest writing)'], ['claude-haiku-4-5', 'Claude Haiku 4.5 (lightest)'], ['claude-fable-5-1', 'Claude Fable 5.1 (most capable)']])}
          ${input('claudeCliPath', 'Claude Code path (blank = find it on PATH)', s.claudeCliPath, 'text', 'placeholder="claude"')}
          ${input('anthropicApiKey', 'Anthropic API key (optional)', s.anthropicApiKey, 'password', 'autocomplete="off"')}
        </div></details>
        <details><summary class="small">ChatGPT (Codex) &amp; OpenAI</summary><div class="stack" style="margin-top:8px">
          <div class="grid cols-2">${input('codexModel', 'Codex model (blank = Codex default)', s.codexModel, 'text', 'placeholder="default"')}${input('codexCliPath', 'Codex path (blank = PATH)', s.codexCliPath, 'text', 'placeholder="codex"')}</div>
          ${input('openaiModel', 'OpenAI API model (uses the OpenAI key under Voice)', s.openaiModel, 'text', 'placeholder="gpt-5-mini"')}
        </div></details>
        <details ${s.claudeProvider === 'lmstudio' ? 'open' : ''}><summary class="small">LM Studio (local)</summary><div class="stack" style="margin-top:8px">
          <div class="grid cols-2">${input('lmstudioUrl', 'Server URL', s.lmstudioUrl, 'text', 'placeholder="http://localhost:1234/v1"')}<div><label>Model</label><select data-k="lmstudioModel"><option value="">First loaded model</option>${(state.B.capabilities.ai?.lmstudio?.models || []).map((m) => opt(m, m, s.lmstudioModel)).join('')}${s.lmstudioModel && !(state.B.capabilities.ai?.lmstudio?.models || []).includes(s.lmstudioModel) ? opt(s.lmstudioModel, s.lmstudioModel, s.lmstudioModel) : ''}</select></div></div>
          <p class="hint" style="margin:0">Load a capable instruct model (8B+ recommended) and start the server in LM Studio's Developer tab.</p>
        </div></details>
        ${check('useClaudeForMusic', 'The AI picks the music for each hour', s.useClaudeForMusic)}
        ${check('allowDiscovery', 'Let the AI add new music when a category runs thin', s.allowDiscovery)}
      </div>
      <div class="card stack">
        <h2>🎙️ Voice</h2>
        ${select('ttsProvider', 'Voice engine', s.ttsProvider, [['auto', 'Auto (ElevenLabs if keyed, else local)'], ['kokoro', 'Local voice (free)'], ['elevenlabs', 'ElevenLabs (most expressive)'], ['openai', 'OpenAI / compatible']])}
        <div id="kokoro">${kokoroHtml()}</div>
        <details><summary class="small">ElevenLabs / OpenAI (optional)</summary><div class="stack" style="margin-top:8px">
          ${input('elevenLabsApiKey', 'ElevenLabs API key', s.elevenLabsApiKey, 'password', 'autocomplete="off"')}
          ${select('elevenLabsModel', 'ElevenLabs model', s.elevenLabsModel, [['eleven_multilingual_v2', 'Multilingual v2 (natural, stable)'], ['eleven_v3', 'v3 (most expressive, audio tags)'], ['eleven_turbo_v2_5', 'Turbo v2.5'], ['eleven_flash_v2_5', 'Flash v2.5']])}
          ${input('openaiApiKey', 'OpenAI API key', s.openaiApiKey, 'password', 'autocomplete="off"')}
          <div class="grid cols-2">${input('openaiBaseUrl', 'Base URL', s.openaiBaseUrl)}${input('openaiTtsModel', 'TTS model', s.openaiTtsModel)}</div>
        </div></details>
        <div class="row nowrap"><input id="ttsTest" value="Hey, it's twenty past seven and you're listening to ${esc(state.B.station.name)}."><button data-action="ttsTest">▶ Test</button></div>
      </div>
      <div class="card stack">
        <h2>🛡️ Broadcast standards</h2>
        ${check('cleanOnly', 'Clean versions only — swap explicit songs for radio edits, never air explicit versions', s.cleanOnly)}
        <p class="hint" style="margin:0">Turning this on checks the library for clean versions in the background. DJ and imaging copy is always kept broadcast-clean.</p>
        <h2 style="margin-top:8px">🎚️ Transitions</h2>
        <div class="grid cols-2">
          ${input('duckDb', 'Music under the DJ (dB)', s.duckDb, 'number', 'step="1" max="-3" min="-24"')}
          ${input('postGap', 'Vocals land after the talk (s)', s.postGap, 'number', 'step="0.1" min="0" max="2"')}
          ${input('talkOverOutroMax', 'Max talk over an outro (s)', s.talkOverOutroMax, 'number', 'step="0.5" min="0" max="20"')}
          ${input('musicLoudness', 'Song level before processing (LUFS)', s.musicLoudness, 'number', 'step="1" min="-24" max="-10"')}
          ${input('lookaheadItems', 'Elements prepared ahead', s.lookaheadItems, 'number', 'min="2" max="8"')}
        </div>
        ${check('beatMatch', 'Beat-match segues between songs', s.beatMatch)}
        ${check('normalize', 'Level-match voice and imaging', s.normalize)}
      </div>
      <div class="card stack">
        <h2>🎛️ Production</h2>
        ${check('production.imagingFx', 'Produce imaging with sound design (whooshes, hits, risers, echo throws)', s.production?.imagingFx !== false)}
        ${check('production.infoBeds', 'News, weather and traffic get their own sounder and bed', s.production?.infoBeds !== false)}
        <p class="hint" style="margin:0">Auto-bed under DJ talk and the sweeper creator live on the Imaging page.</p>
        <h2 style="margin-top:8px">📡 Sources &amp; data</h2>
        ${check('downloadFallback', 'Download a song only if streaming it fails', s.downloadFallback !== false)}
        <div class="grid cols-2">${input('monochromeBase', 'monochrome API', s.monochromeBase)}${input('musicCacheMaxMb', 'Download cache limit (MB)', s.musicCacheMaxMb, 'number')}</div>
        <div><label>Extra news RSS feeds (one per line)</label><textarea data-k="newsFeeds" data-list="1" rows="2">${esc((s.newsFeeds || []).join('\n'))}</textarea></div>
        <div><label>Extra traffic feeds — RSS or WZDx GeoJSON, no keys (one per line)</label><textarea data-k="trafficFeeds" data-list="1" rows="2">${esc((s.trafficFeeds || []).map((f) => (typeof f === 'string' ? f : f.url)).join('\n'))}</textarea></div>
      </div>
    </div>
    <div class="row" style="margin-top:14px"><button class="primary big" data-action="saveSettings">Save settings</button>
      <span class="small"><span class="dot ${c.ffmpeg ? 'ok' : 'bad'}" style="display:inline-block"></span> ${esc(c.ffmpeg || 'ffmpeg not found — required for audio')}</span></div>`;
  },
  mount() {
    const off = bus.on('voiceInstall', (m) => {
      if (m.line) { ui.install.push(m.line); const pre = $('#installLog'); if (pre) { pre.style.display = ''; pre.textContent = ui.install.slice(-6).join('\n'); } }
      if (m.done) {
        if (m.error) toast(`Voice install failed: ${m.error}`, true); else toast('Local voice installed');
        api('GET', '/api/bootstrap').then((b) => { state.B = b; const k = $('#kokoro'); if (k) k.innerHTML = kokoroHtml(); bus.emit('bootstrap', b); });
      }
    });
    return off;
  },
  actions: {
    saveSettings: (b) => run(b, async () => {
      const v = collect($('#settingsForm'));
      v.trafficFeeds = (v.trafficFeeds || []).map((url) => ({ url }));
      state.B = await api('PUT', '/api/settings', v);
      bus.emit('bootstrap', state.B);
    }, 'Settings saved'),
    installKokoro: (b) => run(b, async () => {
      ui.install = [];
      await api('POST', '/api/voice/kokoro/install');
      state.B.capabilities.voice.kokoro.installing = true;
      $('#kokoro').innerHTML = kokoroHtml();
    }, 'Installing the local voice…'),
    ttsTest: (b) => run(b, async () => {
      const r = await api('POST', '/api/tts/preview', { text: $('#ttsTest').value, voice: state.B.personas[0]?.voice });
      play(r.audio);
    }),
  },
};
