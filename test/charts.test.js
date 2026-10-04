import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { store } from '../server/store.js';
import { sameSong, primaryArtist, chartPosition, chartCategory, chartLine, stationCharts, FORMAT_CHARTS } from '../server/sources/charts.js';
import { songStory } from '../server/sources/songInfo.js';
import { factLine } from '../server/sources/songFacts.js';
import { classifyImaging, imagingName } from '../server/audio/imagingImport.js';
import { pickImaging } from '../server/scheduler/logs.js';

test('chart matching: featured artists, punctuation and remix tags don\'t hide a song', () => {
  assert.equal(primaryArtist('Post Malone Featuring Morgan Wallen'), 'postmalone');
  assert.equal(primaryArtist('Lauren Alaina f/Chase Matthew').startsWith('laurenalaina'), true);
  assert.equal(primaryArtist('The Killers'), 'killers');
  assert.ok(sameSong({ artist: 'Post Malone, Morgan Wallen', title: 'I Had Some Help' }, { artist: 'Post Malone Featuring Morgan Wallen', title: 'I Had Some Help' }));
  assert.ok(sameSong({ artist: 'Whitney Houston', title: 'I Wanna Dance with Somebody' }, { artist: 'Whitney Houston', title: 'I Wanna Dance With Somebody (Who Loves Me)' }));
  assert.ok(sameSong({ artist: 'Tame Impala', title: 'Dracula' }, { artist: 'Tame Impala', title: 'Dracula - JENNIE Remix' }));
  assert.ok(!sameSong({ artist: 'Fleetwood Mac', title: 'Dreams' }, { artist: 'The Cranberries', title: 'Dreams' }), 'same title, different artist');
});

test('chart position: best rank across the station\'s charts, with its chart run', () => {
  const charts = [
    { short: 'iTunes Country', entries: [{ rank: 3, artist: 'Ella Langley', title: "Choosin' Texas" }] },
    { short: 'Hot 100', entries: [{ rank: 1, artist: 'Ella Langley', title: "Choosin' Texas", lastWeek: 2, peak: 1, weeks: 49 }] },
  ];
  const pos = chartPosition({ artist: 'Ella Langley', title: "Choosin' Texas" }, charts);
  assert.deepEqual(pos, { chart: 'Hot 100', rank: 1, lastWeek: 2, peak: 1, weeks: 49 });
  assert.equal(chartPosition({ artist: 'Nobody', title: 'Nothing' }, charts), null);
  assert.equal(chartLine({ chart: pos }), '#1 Hot 100, up from #2, 49 wks');
  assert.equal(chartLine({ chartPeak: { peak: 3, chart: 'Hot 100' } }), 'peaked #3 Hot 100');
  assert.ok(factLine({ year: 2025, chart: pos }).includes('#1 Hot 100'), 'the music director sees chart positions');
});

test('chart rotation: power for the top 15, current for the rest, recurrent when a hit falls off', () => {
  assert.equal(chartCategory({ category: 'B' }, { rank: 4 }, true), 'A');
  assert.equal(chartCategory({ category: 'A' }, { rank: 30 }, true), 'B');
  assert.equal(chartCategory({ category: 'A' }, { rank: 2 }, true), null, 'already right');
  assert.equal(chartCategory({ category: 'A' }, null, true), 'C', 'fell off the chart');
  assert.equal(chartCategory({ category: 'A' }, null, false), null, 'never charted: left alone');
  assert.equal(chartCategory({ category: 'G' }, { rank: 1 }, true), null, 'gold is never touched');
});

test('each format follows its own charts unless the station picks', () => {
  store.data.station.formatId = 'country';
  store.data.settings.charts = [];
  assert.deepEqual(stationCharts(), FORMAT_CHARTS.country.charts);
  store.data.settings.charts = ['hot100', 'nope'];
  assert.deepEqual(stationCharts(), ['hot100']);
  store.data.settings.charts = [];
});

test('song story: the right Wikipedia article, never a same-named song by someone else', async () => {
  const real = globalThis.fetch;
  const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('list=search')) return json({ query: { search: [
      { title: 'Dreams (The Cranberries song)', snippet: '"Dreams" is a song by Irish band the Cranberries' },
      { title: 'Dreams (Fleetwood Mac song)', snippet: '"Dreams" is a song by British-American rock band <span>Fleetwood Mac</span>' },
    ] } });
    if (url.includes('Dreams_(Fleetwood_Mac_song)')) return json({ type: 'standard', title: 'Dreams (Fleetwood Mac song)', description: '1977 single by Fleetwood Mac', extract: '"Dreams" is a song by Fleetwood Mac, from Rumours (1977). Their only US number one.' });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const s = await songStory({ artist: 'Fleetwood Mac', title: 'Dreams' });
    assert.equal(s.title, 'Dreams (Fleetwood Mac song)');
    assert.match(s.extract, /Rumours/);
    assert.equal(await songStory({ artist: 'Some New Act', title: 'Dreams' }), null);
  } finally { globalThis.fetch = real; }
});

test('imported imaging is typed from file and folder names', () => {
  assert.equal(classifyImaging('KMXV_TOH_Legal_ID_01.wav'), 'toh_id');
  assert.equal(classifyImaging('Top of Hour 3.mp3'), 'toh_id');
  assert.equal(classifyImaging('Sweeper-03 final.mp3'), 'sweeper');
  assert.equal(classifyImaging('Liners/weekend.wav'), 'liner');
  assert.equal(classifyImaging('Station IDs/short 1.wav'), 'id');
  assert.equal(classifyImaging('Jingles/Shotgun 2.aiff'), 'id');
  assert.equal(classifyImaging('promos/summer concert.mp3'), 'promo');
  assert.equal(classifyImaging('Beds/news bed loop.wav'), 'bed');
  assert.equal(classifyImaging('TOH IDs/2024/sweeper-ish name.wav'), 'sweeper', 'the file name wins over its folder');
  assert.equal(classifyImaging('untitled 7.wav', 30), 'promo');
  assert.equal(classifyImaging('untitled 8.wav', 3), 'id');
  assert.equal(classifyImaging('untitled 9.wav', 9), 'sweeper');
  assert.equal(imagingName('KMXV_Sweeper-03_final.wav'), 'KMXV Sweeper 03 final');
});

test('imported imaging replaces voiced copy of the same type on air (or mixes with it)', () => {
  store.data.imaging = { voice: {}, items: [
    { id: 'v1', type: 'sweeper', text: 'Voiced sweeper', enabled: true },
    { id: 'v2', type: 'sweeper', text: 'Another voiced sweeper', enabled: true },
    { id: 'f1', type: 'sweeper', file: 'sweep1.wav', text: '', enabled: true, imported: true },
    { id: 'v3', type: 'liner', text: 'Voiced liner', enabled: true },
  ] };
  store.data.settings.importedImaging = 'prefer';
  for (let i = 0; i < 4; i++) assert.equal(pickImaging('sweeper').id, 'f1');
  assert.equal(pickImaging('liner').id, 'v3', 'types without imported audio still use voiced copy');
  store.data.settings.importedImaging = 'mix';
  const seen = new Set(Array.from({ length: 6 }, () => pickImaging('sweeper').id));
  assert.deepEqual([...seen].sort(), ['f1', 'v1', 'v2']);
});
