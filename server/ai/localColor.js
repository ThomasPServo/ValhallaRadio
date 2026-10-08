// Local color: what people in a market actually know and joke about (roads, bridges, food, landmarks,
// habits), so the AI's asides and imaging sound like they're from here. Curated and factual; for a market
// that isn't listed, the AI draws on what it reliably knows about the place.
import { store } from '../store.js';

const REGIONS = [
  {
    name: 'the SouthCoast (New Bedford, Fall River and the towns around them)',
    match: /\b(new bedford|fall river|dartmouth|fairhaven|acushnet|westport|somerset|swansea|freetown|mattapoisett|marion|rochester|wareham|seekonk|tiverton)\b/i,
    notes: [
      'People call the area the SouthCoast. New Bedford is the Whaling City; Fall River is the Spindle City, for its old granite textile mills.',
      'New Bedford is the highest-earning commercial fishing port in the country, mostly on sea scallops. Moby-Dick opens in New Bedford: the Seamen\'s Bethel and the Whaling Museum are downtown.',
      'Deep Portuguese, Azorean, Madeiran and Cape Verdean roots: malasadas, chouriço, linguiça, sweet bread, kale soup. New Bedford\'s Feast of the Blessed Sacrament every summer is the big Madeiran feast.',
      'Fall River: Lizzie Borden (1892; the house is a bed and breakfast and museum now), Battleship Cove and the USS Massachusetts, the Braga Bridge carrying 195 over the Taunton River, and the chow mein sandwich.',
      'The swing bridge between New Bedford and Fairhaven opens for boats and stops traffic on Route 6.',
      'Roads people complain about: 195 through both cities and over the Braga, Route 24 to Boston, Route 140, Route 18 into downtown New Bedford, and summer Cape traffic heading through Wareham to the bridges.',
      'Beaches: Horseneck in Westport, Fort Taber in New Bedford\'s South End.',
      'New England habits: Dunkin\' on every corner, "wicked", Boston sports, nor\'easters, buying bread and milk before every storm.',
    ],
  },
];

/** Local color for the station's market, or null when there's none on file. */
export function localColor(st = store.station) {
  const where = [st.market?.name, ...(st.market?.locations || []).map((l) => l.name)].filter(Boolean).join('; ');
  const r = REGIONS.find((x) => x.match.test(where));
  return r ? { region: r.name, notes: r.notes } : null;
}

/** The same, as prompt lines. */
export function localColorText(st = store.station) {
  const c = localColor(st);
  return c ? `LOCAL COLOR for ${c.region} (facts; use them in your own words):\n${c.notes.map((n) => `- ${n}`).join('\n')}` : '';
}
