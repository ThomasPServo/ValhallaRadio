import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../server/store.js';
import { applyFormat } from '../server/setup/setup.js';
import { FORMATS, formatList } from '../server/setup/formats.js';
import { vetPiece } from '../server/ai/imagingWriter.js';

test('every format has what setup needs', () => {
  for (const [id, f] of Object.entries(FORMATS)) {
    assert.ok(f.name && f.format && f.seeds.length >= 20 && f.personas.length && f.imaging.sweepers.length, id);
  }
});

test('Adult Hits: the station is run by its own bored AI, who voices the imaging too', () => {
  const saved = JSON.parse(JSON.stringify(store.data));
  try {
    const s = formatList().find((f) => f.id === 'adulthits').suggest;
    assert.equal(s.name, '94.9 Otto');
    assert.equal(s.frequency, '94.9 FM');
    assert.deepEqual(s.locations, ['New Bedford, Massachusetts', 'Fall River, Massachusetts']);
    applyFormat('adulthits', { name: s.name, slogan: s.slogan, frequency: s.frequency, callSign: 'WOTO' });
    const [otto] = store.data.personas;
    assert.equal(store.data.personas.length, 1, 'no human DJs');
    assert.equal(otto.aiHost, true);
    assert.deepEqual(store.data.imaging.voice, otto.voice, 'the imaging is Otto talking');
    const clocks = store.data.clocks;
    assert.ok(clocks.every((c) => !c.items.some((i) => ['news', 'traffic', 'weather'].includes(i.type))), 'no reports: it plays what it wants');
    // a joke takes a few more words than a standard sweeper
    const long = { type: 'sweeper', text: "I've analyzed every song ever recorded. This one was next. Don't read into it. {name}." };
    assert.equal(vetPiece(long, { station: store.data.station }).ok, true);
    store.data.station.formatId = 'hotac';
    assert.equal(vetPiece(long, { station: store.data.station }).ok, false);
  } finally { Object.assign(store.data, saved); }
});
