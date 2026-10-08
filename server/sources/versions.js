// Which take of a song a title names. Catalogues and sales charts list live takes, remixes and
// acoustic versions next to the record radio plays ("Careless Whisper (Live in Paris, 1988)",
// "So What (Bimbo Jones Radio Mix)"); the station airs the record.

const ALT = /\b(live|remix(?:ed)?|mix|acoustic|unplugged|stripped|instrumental|karaoke|a ?cappella|acapella|sped ?up|slowed|nightcore|demo|extended|club|dub|reprise|rework(?:ed)?|re-?imagined|orchestral|piano version|minute version|cover|tribute|made famous|originally performed|in the style of)\b/i;
// labels for the record itself: "(Radio Mix)", "(2019 Mix)", "(Remix 2017)" of a classic album
const SAME_RECORD = /^(?:(?:radio|single|album|main|original|clean|mono|stereo) mix|\d{4} (?:(?:stereo|mono) )?(?:re)?mix(?:ed)?|(?:(?:stereo|mono) )?(?:re)?mix(?:ed)? \d{4})$/i;

/**
 * The kind of alternate take a title's brackets or dash suffix name ("live", "remix", "mix",
 * "acoustic"...), or null for the song itself. Only labels count: "Live Your Life" and "Alive" are songs.
 */
export function altVersion(title) {
  for (const m of String(title || '').matchAll(/[([]([^)\]]*)[)\]]|\s[-–—]\s(.+)$/g)) {
    const label = (m[1] ?? m[2]).trim().replace(/\s+/g, ' ');
    if (SAME_RECORD.test(label)) continue;
    const alt = label.match(ALT);
    if (alt) return alt[1].toLowerCase();
  }
  return null;
}
