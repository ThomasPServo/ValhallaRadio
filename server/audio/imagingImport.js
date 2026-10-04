// Importing produced imaging (legal IDs, station IDs, sweepers, liners, promos, beds) from audio files:
// the type comes from the file and folder names imaging packages use, or the length as a last resort.

const RULES = [
  ['toh_id', /\b(toh|top ?of ?(the ?)?hour|legal ?ids?|legal|hourly ?id)\b/],
  ['bed', /\b(beds?|music ?beds?|underscore|instrumental|loop)\b/],
  ['promo', /\b(promos?|promotion|contest|event)\b/],
  ['liner', /\b(liners?|dry ?voice|dry ?liners?|voice ?only)\b/],
  ['sweeper', /\b(sweep|sweepers?|transitions?|stingers?|stagers?|drops?|whoosh|segue|ramp|intros?)\b/],
  ['id', /\b(ids?|idents?|jingles?|shotguns?|station ?ids?|logos?|signatures?)\b/],
];

/**
 * Imaging type for an imported file.
 * @param {string} name  file name, optionally with its folder path ("TOH IDs/KMXV legal 01.wav")
 * @param {number} [duration] seconds
 */
export function classifyImaging(name, duration = null) {
  const words = String(name).toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[_\-.+]+/g, ' ');
  const parts = words.split(/[\\/]/).reverse(); // the file name wins over its folders
  for (const part of parts) for (const [type, re] of RULES) if (re.test(part)) return type;
  if (duration != null) {
    if (duration >= 45) return 'bed';
    if (duration >= 20) return 'promo';
    if (duration <= 4) return 'id';
  }
  return 'sweeper';
}

/** A readable name from the file name ("KMXV_Sweeper-03_final.wav" → "KMXV Sweeper 03 final"). */
export function imagingName(name) {
  const base = String(name).split(/[\\/]/).pop().replace(/\.[a-z0-9]{2,4}$/i, '');
  return base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Imported imaging';
}
