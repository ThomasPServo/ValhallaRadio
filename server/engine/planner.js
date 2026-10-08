// Transition planner: decides exactly when the next element starts and how every playing source's
// level moves, the way a good board op would ride it. Pure and deterministic (unit tested).
//
// Golden rule: the DJ (or imaging voice) never talks over vocals. Vocal timing comes from synced
// lyrics or studio markers; when it is unknown we assume vocals could be anywhere and keep voice
// and music apart (fade-and-talk, post at the end of the talk) instead of guessing.
//
// All times are seconds on the engine's master timeline. Song markers are relative to the song's
// trimmed start; `start` is when that source began on the master timeline.

const dbToLin = (db) => Math.pow(10, db / 20);

export const DEFAULTS = {
  postGap: 0.5, // vocals hit this long after the talk ends
  minVocalGap: 0.25, // never closer than this
  duckDb: -12, // music under the DJ
  imagingDuckDb: -7, // music under a sweeper voice
  talkOverOutroMax: 6, // start talking at most this long before a song's natural end
  spotGap: 0.2,
  beatMatch: true,
  beatConfidence: 0.85,
};

/** Normalise a song/element description into absolute times. */
function describe(src) {
  const s = { ...src };
  s.end = s.start + s.len;
  if (s.kind === 'music') {
    const fallbackMix = s.endType === 'fade' ? s.len - 6 : s.len - 0.1;
    s.mixOutAbs = s.start + Math.min(s.len, s.mixOut ?? fallbackMix);
    s.vocalEndAbs = s.vocalEnd == null ? null : s.start + s.vocalEnd;
  } else {
    s.voiceStartAbs = s.start + (s.voiceStart ?? 0);
    s.voiceEndAbs = s.start + (s.voiceEnd ?? s.len);
    s.postAbs = s.start + (s.post ?? s.voiceEnd ?? s.len);
    s.tailAbs = s.start + (s.tailStart ?? s.len);
  }
  return s;
}

const similarTempo = (a, b) => {
  if (!a || !b) return false;
  for (const ratio of [1, 2, 0.5]) if (Math.abs((a * ratio) / b - 1) < 0.03) return true;
  return false;
};

/**
 * @param {object} p
 * @param {number} p.now           current master time
 * @param {object} p.prev          anchor source (the last element that started), see describe()
 * @param {object} p.next          element to plan: { kind, len, ...markers }
 * @param {object[]} [p.others]    other music still sounding (e.g. the song under a DJ break)
 * @param {object} [p.opts]
 * @returns {{ start:number, ramps:object[], type:string, notes:string[] }}
 */
export function planTransition({ now, prev, next, others = [], opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const ramps = [];
  const notes = [];
  const duck = dbToLin(o.duckDb);
  const fade = (target, at, dur, curve = 'db') => ramps.push({ target, lane: 'fade', at, dur: Math.max(0.02, dur), to: 0, curve });
  const duckRamp = (target, at, dur, to) => ramps.push({ target, lane: 'duck', at, dur: Math.max(0.02, dur), to, curve: 'lin' });

  // operator skip / emergency: fast, smooth pot-down and go
  if (o.immediate || !prev) {
    const start = now + (prev ? 0.25 : 0.02);
    if (prev) fade('prev', now, 1.2, 'cos');
    for (const x of others) fade(x.id, now, 1.2, 'cos');
    return { start, ramps, type: 'cut', notes: [prev ? 'Operator take: quick pot-down' : 'Start'] };
  }

  const A = describe(prev);
  const B = { ...next };
  let start;
  let type;

  if (A.kind === 'music' && B.kind === 'music') {
    // ---------------------------------------------------------------- song → song segue
    const lead = B.rampIn > 1 ? Math.min(2, B.rampIn * 0.5) : 0;
    if (A.endType === 'cold') { start = A.mixOutAbs - 0.02; type = 'cold'; notes.push('Cold ending: tight segue'); }
    else { start = A.mixOutAbs - lead; type = 'segue'; notes.push(lead ? `Fade segue, soft intro leads ${lead.toFixed(1)}s` : 'Fade segue'); }
    if (o.beatMatch && A.beat && B.firstBeat != null && B.beat && A.beat.confidence >= o.beatConfidence && B.beat.confidence >= o.beatConfidence && similarTempo(A.beat.period, B.beat.period)) {
      const want = start + B.firstBeat;
      const k = Math.round((want - (A.start + A.beat.phase)) / A.beat.period);
      const shift = A.start + A.beat.phase + k * A.beat.period - want;
      if (Math.abs(shift) <= A.beat.period / 2) { start += shift; notes.push('Beat-matched'); }
    }
    if (A.vocalEndAbs != null && B.vocalStart != null) start = Math.max(start, A.vocalEndAbs + 0.3 - B.vocalStart);
    start = Math.max(Math.min(start, A.end + 0.02), now + 0.05);
    const vocalsStillGoing = A.vocalEndAbs == null ? A.endType !== 'cold' : A.vocalEndAbs > start;
    if (A.endType === 'cold') {
      if (A.end - start > 0.3) fade('prev', start + 0.2, Math.min(1.5, A.end - start - 0.2));
    } else {
      const at = vocalsStillGoing ? start : start + Math.min(1, lead + 0.5);
      fade('prev', at, vocalsStillGoing ? 1 : Math.min(3.5, Math.max(1, A.end - at)));
    }
  } else if (A.kind === 'music') {
    // ---------------------------------------------------------------- song → voice / imaging / spot
    const vs = B.voiceStart ?? 0;
    if (B.kind === 'voice' && B.bedded) {
      // a report with its own sounder and bed starts clean: on the song's last hit, or as the song fades
      // (its bed under the song's outro would be two pieces of music at once)
      if (A.endType === 'cold') { start = A.end + 0.05; notes.push('Song ends, then the report'); }
      else { fade('prev', A.mixOutAbs, 0.9); start = A.mixOutAbs + 0.45; notes.push('Song fades, then the report'); }
      if (A.vocalEndAbs != null) start = Math.max(start, A.vocalEndAbs + 0.3);
      type = 'post';
    } else if (B.kind === 'voice') {
      const talkEnd = A.endType === 'fade' ? Math.min(A.end, A.mixOutAbs + 1.5) : A.end;
      if (A.vocalEndAbs != null && A.vocalEndAbs < talkEnd) {
        const earliest = A.vocalEndAbs + 0.35 - vs;
        const preferred = talkEnd - Math.min(o.talkOverOutroMax, Math.max(1, (B.len - vs) * 0.6)) - vs;
        start = Math.max(earliest, Math.min(preferred, talkEnd + 0.1)); // never before the last vocal
        type = 'talkover';
        notes.push('DJ talks over the instrumental outro');
        duckRamp('prev', start + vs - 0.15, 0.15, duck);
      } else if (A.vocalEndAbs != null || A.endType === 'cold') {
        start = Math.max(A.end + 0.12, (A.vocalEndAbs ?? 0) + 0.35) - vs; type = 'post'; notes.push('Song ends, then the DJ');
      } else {
        // vocal timing unknown: fade the song out, then talk (never over possible vocals)
        fade('prev', A.mixOutAbs, 0.7);
        start = A.mixOutAbs + 0.75 - vs; type = 'fade-talk'; notes.push('Vocals unknown: fade then talk');
      }
    } else if (B.kind === 'imaging') {
      type = 'sweep';
      if (A.vocalEndAbs != null) {
        start = A.endType === 'cold' ? A.end - Math.min(vs, 0.6) : A.mixOutAbs - Math.min(vs, 1) * 0.5;
        start = Math.max(start, A.vocalEndAbs + 0.2 - vs);
        notes.push('Imaging over the instrumental ending');
        duckRamp('prev', start + vs - 0.1, 0.1, dbToLin(o.imagingDuckDb));
        fade('prev', Math.max(start + vs, A.mixOutAbs), 1.2);
      } else if (A.endType === 'cold') {
        start = A.end - Math.min(vs, 0.6); // FX rides the final hit; the voice lands after the song ends
        notes.push('Imaging on the cold ending');
      } else {
        fade('prev', A.mixOutAbs, 0.7); // vocals unknown: song out before the imaging voice
        start = A.mixOutAbs + 0.75 - vs;
        notes.push('Vocals unknown: song potted before the imaging voice');
      }
    } else {
      if (A.endType === 'cold') start = A.end + 0.1;
      else { fade('prev', A.mixOutAbs, 0.8); start = A.mixOutAbs + 0.6; }
      type = 'butt';
      notes.push('Into the stopset');
    }
    start = Math.max(start, now + 0.05);
  } else if (B.kind === 'music') {
    // ---------------------------------------------------------------- voice / imaging / spot → song
    if (A.kind === 'voice' && A.bedded) {
      // the report's bed can't be pulled from under its voice, so no talk-up: the song starts as the
      // voice ends and the bed's tail fades away under it
      start = A.voiceEndAbs + 0.08;
      if (B.vocalStart != null) start = Math.max(start, A.voiceEndAbs + o.minVocalGap - B.vocalStart);
      fade('prev', start, 0.7);
      type = 'post';
      notes.push('Report ends, then the song');
    } else if (A.kind === 'voice') {
      if (B.vocalStart != null) {
        const ideal = A.voiceEndAbs + o.postGap - B.vocalStart;
        start = Math.min(Math.max(ideal, A.voiceStartAbs + 0.4), A.voiceEndAbs);
        start = Math.max(start, A.voiceEndAbs + o.minVocalGap - B.vocalStart);
        type = 'talkup';
        const intoIntro = Math.max(0, A.voiceEndAbs - start);
        notes.push(intoIntro > 0.2 ? `Talk-up: ${intoIntro.toFixed(1)}s over the intro, vocals ${(start + B.vocalStart - A.voiceEndAbs).toFixed(1)}s after the talk` : 'Song starts as the talk ends');
      } else {
        start = A.voiceEndAbs + 0.05; type = 'post'; notes.push('Intro unknown: song starts as the talk ends');
      }
      if (start < A.voiceEndAbs) {
        duckRamp('next', start - 0.01, 0.01, duck);
        duckRamp('next', A.voiceEndAbs, 0.6, 1);
      }
    } else if (A.kind === 'imaging') {
      start = Math.max(A.start + 0.1, A.postAbs - (B.firstBeat ?? 0));
      if (B.vocalStart != null) start = Math.max(start, A.voiceEndAbs + o.minVocalGap - B.vocalStart);
      else start = Math.max(start, A.voiceEndAbs - 0.02);
      type = 'sweep-in';
      notes.push(B.firstBeat != null ? 'First downbeat on the imaging post' : 'Song on the imaging post');
      if (start < A.voiceEndAbs) {
        duckRamp('next', start - 0.01, 0.01, dbToLin(o.imagingDuckDb));
        duckRamp('next', A.voiceEndAbs, 0.3, 1);
      }
    } else {
      start = A.end + 0.15; type = 'butt'; notes.push('Out of the stopset');
    }
    start = Math.max(start, now + 0.05);
    for (const x of others) if (x.kind === 'music') fade(x.id, Math.max(now, start - 0.15), 1.2);
  } else {
    // ---------------------------------------------------------------- element → element (no music involved)
    const vs = B.voiceStart ?? 0;
    if (B.kind === 'spot') start = (A.kind === 'imaging' ? A.tailAbs : A.end) + o.spotGap;
    else if (B.kind === 'imaging') start = (A.kind === 'spot' ? A.end + 0.1 : A.voiceEndAbs + 0.2) - Math.min(vs, 0.4);
    else start = (A.kind === 'imaging' ? A.tailAbs : A.end) + (A.kind === 'voice' ? 0.35 : 0.15) - vs;
    start = Math.max(start, A.kind === 'spot' ? A.end : A.voiceEndAbs + 0.15 - vs, now + 0.05);
    type = 'butt';
    if (B.kind === 'spot') for (const x of others) if (x.kind === 'music') fade(x.id, Math.max(now, start - 0.4), 0.6);
  }

  return { start, ramps, type, notes };
}
