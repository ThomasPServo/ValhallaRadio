import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../server/store.js';
import { applyDesign } from '../server/ai/programmer.js';

const design = {
  summary: 'Classic rock for Tulsa',
  format: 'Classic Rock',
  slogan: "Tulsa's Classic Rock",
  categories: [
    { id: 'p', name: 'Power Gold', minRestHours: 6, searchSeeds: 'AC/DC, Queen' },
    { id: 'D', name: 'Deep Cuts', minRestHours: 48, searchSeeds: 'Rush' },
  ],
  clocks: [
    { key: 'std', name: 'Standard', items: [{ type: 'toh_id', category: '', mode: '', spots: 0 }, { type: 'music', category: 'P', mode: '', spots: 0 }, { type: 'stopset', category: '', mode: '', spots: 4 }, { type: 'dj', category: '', mode: 'talk', spots: 0 }] },
    { key: 'deep', name: 'Deep Cuts', items: [{ type: 'toh_id', category: '', mode: '', spots: 0 }, { type: 'music', category: 'D', mode: '', spots: 0 }] },
  ],
  dayparts: [{ name: 'All Day', startHour: 0, endHour: 23, mood: 'Rock', personaKey: 'vet' }],
  personas: [{ key: 'vet', name: 'Gravel', style: 'Veteran rocker', gender: 'male' }],
  imaging: [{ type: 'toh_id', name: 'Legal', text: '{callSign} {market}' }],
  grid: [
    { days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 23, clockKey: 'std' },
    { days: [0, 6], startHour: 18, endHour: 23, clockKey: 'deep' },
  ],
};

test('applyDesign replaces programming and keeps the library consistent', () => {
  store.data.library = [{ id: '1', title: 'x', artist: 'y', category: 'A' }];
  applyDesign(structuredClone(design));
  const d = store.data;
  assert.deepEqual(d.categories.map((c) => c.id), ['P', 'D']);
  assert.equal(d.clocks.length, 2);
  const std = d.clocks.find((c) => c.name === 'Standard');
  const deep = d.clocks.find((c) => c.name === 'Deep Cuts');
  assert.deepEqual(std.items[1], { type: 'music', category: 'P' });
  assert.deepEqual(std.items[2], { type: 'stopset', spots: 4 });
  assert.deepEqual(std.items[3], { type: 'dj', mode: 'talk' });
  assert.equal(d.grid[1][20], std.id);
  assert.equal(d.grid[6][20], deep.id, 'later grid rules override earlier ones');
  assert.equal(d.grid[6][10], std.id);
  assert.equal(d.dayparts[0].personaId, d.personas[0].id);
  assert.equal(d.personas[0].voice.openaiVoice, 'ash');
  assert.equal(d.library[0].category, 'D', 'orphaned songs move to the last category');
  assert.equal(d.station.slogan, "Tulsa's Classic Rock");
});
