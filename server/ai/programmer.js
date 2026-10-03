// Claude as program director: designs categories, hour clocks, the weekly grid,
// dayparts, DJ personas and imaging copy from a plain-English brief.

import { store, uid } from '../store.js';
import { claudeJson } from './claude.js';

const ITEM_TYPES = ['toh_id', 'music', 'sweeper', 'liner', 'id', 'dj', 'stopset', 'weather', 'traffic', 'news', 'promo'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'format', 'slogan', 'categories', 'clocks', 'dayparts', 'personas', 'imaging', 'grid'],
  properties: {
    summary: { type: 'string' },
    format: { type: 'string' },
    slogan: { type: 'string' },
    categories: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'name', 'minRestHours', 'searchSeeds'],
        properties: { id: { type: 'string' }, name: { type: 'string' }, minRestHours: { type: 'number' }, searchSeeds: { type: 'string' } },
      },
    },
    clocks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'name', 'items'],
        properties: {
          key: { type: 'string' },
          name: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['type', 'category', 'mode', 'spots'],
              properties: {
                type: { type: 'string', enum: ITEM_TYPES },
                category: { type: 'string' },
                mode: { type: 'string', enum: ['', 'auto', 'backsell', 'frontsell', 'talk'] },
                spots: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    dayparts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'startHour', 'endHour', 'mood', 'personaKey'],
        properties: { name: { type: 'string' }, startHour: { type: 'integer' }, endHour: { type: 'integer' }, mood: { type: 'string' }, personaKey: { type: 'string' } },
      },
    },
    personas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'name', 'style', 'gender'],
        properties: { key: { type: 'string' }, name: { type: 'string' }, style: { type: 'string' }, gender: { type: 'string', enum: ['male', 'female', 'neutral'] } },
      },
    },
    imaging: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'name', 'text'],
        properties: { type: { type: 'string', enum: ['toh_id', 'id', 'sweeper', 'liner', 'promo'] }, name: { type: 'string' }, text: { type: 'string' } },
      },
    },
    grid: {
      type: 'array',
      description: 'Rules mapping days/hours to clock keys; later rules override earlier ones.',
      items: {
        type: 'object', additionalProperties: false, required: ['days', 'startHour', 'endHour', 'clockKey'],
        properties: { days: { type: 'array', items: { type: 'integer' } }, startHour: { type: 'integer' }, endHour: { type: 'integer' }, clockKey: { type: 'string' } },
      },
    },
  },
};

const VOICES = {
  male: { elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'ash' },
  female: { elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'coral' },
  neutral: { elevenLabsVoiceId: 'SAz9YHcvj6GT2YYXdXww', openaiVoice: 'sage' },
};

export async function designStation(brief) {
  const st = store.station;
  return claudeJson({
    system:
      'You are a veteran commercial radio program director and consultant. You design formats, category structures, hour clocks and imaging ' +
      'for successful stations. Your clocks are realistic: 10-14 songs/hour on music stations, 2 stopsets per hour (placed to minimize tune-out, e.g. around :20 and :50), ' +
      'a legal ID at the top of the hour (toh_id first), sweepers between songs, DJ breaks that talk up intros, and info (news/weather/traffic) weighted to drive times. ' +
      'Category ids are 1-2 uppercase letters. For non-music clock items use category "" ; mode is only for dj items (else ""); spots is only for stopsets (else 0). ' +
      'Imaging text may use placeholders {callSign} {frequency} {name} {slogan} {market}. searchSeeds lists example artists for each category, comma separated. ' +
      'Days are 0=Sunday..6=Saturday, hours 0-23 inclusive.',
    prompt: [
      `Current station: ${st.name} (${st.callSign}, ${st.frequency}). Market: ${st.market?.name || 'unspecified'} ${(st.market?.locations || []).map((l) => l.name).join('; ')}`,
      `Current format: ${st.format}`,
      '',
      `Brief from the station owner: ${brief}`,
      '',
      'Design the complete programming: categories, 2-4 hour clocks, weekly grid rules, dayparts with mood guidance for the music director, 2-3 DJ personas (distinct, human, believable), and 8-12 imaging pieces (2 legal IDs, IDs, sweepers, liners).',
    ].join('\n'),
    maxTokens: 16000,
    effort: 'medium',
    schema: SCHEMA,
  });
}

/** Apply a design produced by designStation(). Library tracks keep their categories when ids still exist. */
export function applyDesign(d) {
  const db = store.data;
  if (d.format) db.station.format = d.format;
  if (d.slogan) db.station.slogan = d.slogan;

  const palette = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'];
  db.categories = d.categories.map((c, i) => ({ id: c.id.toUpperCase(), name: c.name, color: palette[i % palette.length], minRestHours: c.minRestHours, seeds: c.searchSeeds }));

  const personaIds = {};
  db.personas = d.personas.map((p) => {
    const id = uid('dj_');
    personaIds[p.key] = id;
    return { id, name: p.name, style: p.style, voice: { ...VOICES[p.gender] || VOICES.neutral, instructions: `Natural, warm radio host. ${p.style}` } };
  });

  const clockIds = {};
  const clockColors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b'];
  db.clocks = d.clocks.map((c, i) => {
    const id = uid('clk_');
    clockIds[c.key] = id;
    return {
      id, name: c.name, color: clockColors[i % clockColors.length],
      items: c.items.map((it) => {
        const item = { type: it.type };
        if (it.type === 'music') item.category = (it.category || db.categories[0].id).toUpperCase();
        if (it.type === 'dj') item.mode = it.mode || 'auto';
        if (it.type === 'stopset') item.spots = it.spots || 3;
        return item;
      }),
    };
  });
  const fallbackClock = db.clocks[0].id;
  db.grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => fallbackClock));
  for (const rule of d.grid) {
    const cid = clockIds[rule.clockKey];
    if (!cid) continue;
    for (const day of rule.days) {
      for (let h = rule.startHour; h <= rule.endHour && h < 24; h++) if (db.grid[day]) db.grid[day][h] = cid;
    }
  }
  db.dayparts = d.dayparts.map((p) => ({ id: uid('dp_'), name: p.name, startHour: p.startHour, endHour: p.endHour, mood: p.mood, personaId: personaIds[p.personaKey] || db.personas[0].id }));
  db.imaging.items = d.imaging.map((im) => ({ id: uid('img_'), type: im.type, name: im.name, text: im.text, file: '', enabled: true }));

  const catIds = new Set(db.categories.map((c) => c.id));
  for (const t of db.library) if (!catIds.has(t.category)) t.category = db.categories[db.categories.length - 1].id;
  store.save();
}
