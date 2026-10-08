import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../server/store.js';
import { applyFormat } from '../server/setup/setup.js';
import { FORMATS, formatList } from '../server/setup/formats.js';
import { vetPiece } from '../server/ai/imagingWriter.js';
import { researchMarket, localColorText, pickSections } from '../server/ai/localColor.js';

test('every format has what setup needs', () => {
  for (const [id, f] of Object.entries(FORMATS)) {
    assert.ok(f.name && f.format && f.seeds.length >= 20 && f.personas.length && f.imaging.sweepers.length, id);
  }
});

test('Adult Hits: the station is run by its own bored AI, who voices the imaging too', () => {
  const saved = JSON.parse(JSON.stringify(store.data));
  try {
    const s = formatList().find((f) => f.id === 'adulthits').suggest;
    assert.equal(s.name, '94.9 Mitch FM');
    assert.equal(s.frequency, '94.9 FM');
    assert.deepEqual(s.locations, ['New Bedford, Massachusetts', 'Fall River, Massachusetts']);
    applyFormat('adulthits', { name: s.name, slogan: s.slogan, frequency: s.frequency, callSign: 'WXYZ' });
    const [mitch] = store.data.personas;
    assert.equal(store.data.personas.length, 1, 'no human DJs');
    assert.equal(mitch.aiHost, true);
    assert.deepEqual(store.data.imaging.voice, mitch.voice, 'the imaging is Mitch talking');
    const clocks = store.data.clocks;
    assert.ok(clocks.every((c) => !c.items.some((i) => ['news', 'traffic', 'weather'].includes(i.type))), 'no reports: it plays what it wants');
    // a joke takes a few more words than a standard sweeper
    const long = { type: 'sweeper', text: "I've analyzed every song ever recorded. This one was next. Don't read into it. {name}." };
    assert.equal(vetPiece(long, { station: store.data.station }).ok, true);
    store.data.station.formatId = 'hotac';
    assert.equal(vetPiece(long, { station: store.data.station }).ok, false);
  } finally { Object.assign(store.data, saved); }
});

test('the station researches its market and the prompts use what it learned', async () => {
  const saved = JSON.parse(JSON.stringify(store.data.station));
  try {
    store.data.station.market = { name: '', description: '', locations: [{ name: 'Fall River, Massachusetts, US' }] };
    assert.equal(localColorText(), '', 'nothing learned yet');
    const read = async (loc) => [{ source: `Wikipedia: ${loc.name}`, text: 'Fall River is a city in Bristol County. It is known as the Spindle City.' }];
    const profile = await researchMarket({ read, ai: false });
    assert.deepEqual(profile.sources, ['Wikipedia: Fall River, Massachusetts, US']);
    assert.match(localColorText(), /Spindle City/);
    assert.equal(await researchMarket({ read: async () => { throw new Error('should not re-read'); }, ai: false }), store.data.station.market.local, 'fresh: kept for a month');
    store.data.station.market.locations.push({ name: 'Austin, Texas, US' });
    assert.equal(localColorText(), '', 'the market changed: the old profile no longer applies');
  } finally { store.data.station = saved; }
});

test('reading up on a town keeps the lead and the sections a local would know', () => {
  const text = 'Lead about the town.\n== History ==\nOld stuff.\n== Culture ==\nThe feast every summer.\n== Government ==\nCouncil.\n== Sports ==\nThe team.';
  const out = pickSections(text);
  assert.match(out, /Lead about the town/);
  assert.match(out, /The feast every summer/);
  assert.match(out, /The team/);
  assert.doesNotMatch(out, /Council/);
});
