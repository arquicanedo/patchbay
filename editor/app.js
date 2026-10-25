'use strict';
// pitchaxis patchbay. Blocks are typed by what they carry: an aircraft set, a value, an event, or audio. (patch.py in this
// folder has its own, different kinds; this editor borrows its idea of typed connections, not its model.)
// A cable joins two ports of the same kind; an input takes one cable (audio inputs mix), so two
// sources can never silently fight over one parameter.

const $ = (s) => document.querySelector(s);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mod = (a, n) => ((a % n) + n) % n;
const fmt = (x) => {
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1000) return Math.round(x).toLocaleString('en-US');
  if (a >= 100) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  return x.toFixed(2);
};
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (m) => NOTE_NAMES[mod(Math.round(m), 12)] + (Math.floor(Math.round(m) / 12) - 1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- the sky
let CAP = null;
async function loadCapture(key) {
  const bin = Uint8Array.from(atob(CAPTURES_B64[key]), (c) => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  const d = JSON.parse(await new Response(stream).text());
  const tracks = d.ac.map((a) => ({ cs: a[0], type: a[1], eng: a[2], wake: a[3], t: [], v: [] }));
  d.f.forEach((row, k) => {
    const t = d.t[k];
    for (let j = 0; j < row.length; j += 9) {
      const tr = tracks[row[j]];
      tr.t.push(t);
      tr.v.push([row[j + 1] * 25, row[j + 2] == null ? null : row[j + 2] * 32, row[j + 3],
        row[j + 4] == null ? null : row[j + 4] / 10, row[j + 5] / 10, row[j + 6] / 10,
        row[j + 7] == null ? null : row[j + 7] / 10, row[j + 8] == null ? null : row[j + 8] / 10]);
    }
  });
  CAP = { meta: d.meta, tracks: tracks.filter((t) => t.t.length), span: d.t[d.t.length - 1] };
  CAP.tracks.forEach((t, i) => (t.id = i));
}
const lerp = (a, b, f) => (a == null ? b : b == null ? a : a + (b - a) * f);
const clerp = (a, b, f) => (a == null ? b : b == null ? a : mod(a + ((((b - a) % 360) + 540) % 360 - 180) * f, 360));
function skyAt(T) {
  const out = [];
  if (!CAP) return out;
  for (const tr of CAP.tracks) {
    const ts = tr.t, n = ts.length;
    if (T < ts[0] - 2.5 || T > ts[n - 1] + 2.5) continue;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= T) lo = m; else hi = m - 1; }
    let a, b, f = 0;
    if (T < ts[0]) a = b = tr.v[0];
    else if (lo >= n - 1) a = b = tr.v[n - 1];
    else {
      const gap = ts[lo + 1] - ts[lo];
      if (gap > 20) {
        if (T - ts[lo] <= 2.5) a = b = tr.v[lo];
        else if (ts[lo + 1] - T <= 2.5) a = b = tr.v[lo + 1];
        else continue;
      } else { a = tr.v[lo]; b = tr.v[lo + 1]; f = (T - ts[lo]) / gap; }
    }
    out.push({ id: tr.id, cs: tr.cs, type: tr.type, eng: tr.eng,
      alt: lerp(a[0], b[0], f), vr: lerp(a[1], b[1], f), gs: lerp(a[2], b[2], f), trk: clerp(a[3], b[3], f),
      rng: lerp(a[4], b[4], f), brg: clerp(a[5], b[5], f), rssi: lerp(a[6], b[6], f), rate: lerp(a[7], b[7], f) });
  }
  return out;
}

// ---------------------------------------------------------------- values
// A value is a number per aircraft ({per: Map id->x}) or one number for everyone ({all: x}).
const Val = {
  per: (m) => ({ per: m, all: null }),
  all: (x) => ({ per: null, all: x }),
  get(v, id) {
    if (!v) return undefined;
    if (v.per) { const x = v.per.get(id); if (x !== undefined) return x; }
    return v.all == null ? undefined : v.all;
  },
  map(v, fn) {
    if (!v) return undefined;
    let per = null;
    if (v.per) { per = new Map(); for (const [k, x] of v.per) per.set(k, x == null ? null : fn(x, k)); }
    return { per, all: v.all == null ? null : fn(v.all, '*') };
  },
  list(v) {
    if (!v) return [];
    if (v.per) return [...v.per.values()].filter((x) => x != null && isFinite(x));
    return v.all == null ? [] : [v.all];
  },
  scalar(v) {
    if (!v) return undefined;
    if (v.all != null && !v.per) return v.all;
    const xs = Val.list(v);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
  },
};
const range = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);
const rangeText = (v, unit = '') => {
  const r = range(Val.list(v));
  if (!r) return 'no values';
  return (r[0] === r[1] ? fmt(r[0]) : `${fmt(r[0])} … ${fmt(r[1])}`) + unit;
};

// ---------------------------------------------------------------- transport
const TP = { playing: false, speed: 4, bpm: 96, bpb: 4, dataT: 0, w1: 0,
  dAnchor: { at: 0, d: 0 }, bAnchor: { at: 0, b: 0 } };
const dataAt = (at) => TP.dAnchor.d + (at - TP.dAnchor.at) * TP.speed;
const beatAt = (at) => TP.bAnchor.b + (at - TP.bAnchor.at) * TP.bpm / 60;
const timeOfBeat = (b) => TP.bAnchor.at + (b - TP.bAnchor.b) * 60 / TP.bpm;

// ---------------------------------------------------------------- audio
let AC = null, NOISE = null;
let LIT = [];          // {id, at} for the scope: which aircraft sounded when
let BEAMS = [];        // sweep nodes, for the scope
function ensureAudio() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  NOISE = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
  const ch = NOISE.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  for (const n of P.nodes) buildAudio(n);
  rewire();
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function playNote(bus, sound, midi, vel, pan, at, A, R) {
  const f = mtof(midi);
  const env = AC.createGain(), pn = AC.createStereoPanner();
  pn.pan.value = clamp(pan || 0, -1, 1);
  env.connect(pn); pn.connect(bus);
  let peak = clamp(vel, 0, 1) * 0.28;
  const end = at + A + R * 1.6;
  const srcs = [];
  env.gain.setValueAtTime(0, at);
  if (sound === 'bell') {
    const c = AC.createOscillator(), m = AC.createOscillator(), mg = AC.createGain();
    c.frequency.value = f; m.frequency.value = f * 3.5;
    mg.gain.setValueAtTime(f * 1.4, at); mg.gain.setTargetAtTime(f * 0.1, at, R / 3);
    m.connect(mg); mg.connect(c.frequency); c.connect(env); srcs.push(c, m);
  } else if (sound === 'pluck') {
    const o = AC.createOscillator(), lp = AC.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = f; lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(Math.min(f * 10, 16000), at); lp.frequency.setTargetAtTime(f * 1.2, at, R / 5);
    o.connect(lp); lp.connect(env); srcs.push(o); peak *= 0.9;
  } else if (sound === 'noise') {
    const s = AC.createBufferSource(), bp = AC.createBiquadFilter();
    s.buffer = NOISE; s.loop = true; bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 14;
    s.connect(bp); bp.connect(env); srcs.push(s); peak *= 3.2;
  } else {
    const o = AC.createOscillator();
    o.type = sound; o.frequency.value = f;
    if (sound === 'sawtooth' || sound === 'square') {
      const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(f * 6, 12000);
      o.connect(lp); lp.connect(env); peak *= 0.55;
    } else o.connect(env);
    srcs.push(o);
  }
  env.gain.linearRampToValueAtTime(peak, at + A);
  env.gain.setTargetAtTime(0, at + A, R / 4);
  srcs.forEach((s, i) => {
    if (s.buffer) s.start(at, Math.random() * 1.5); else s.start(at);
    s.stop(end);
    if (i === 0) s.onended = () => { env.disconnect(); pn.disconnect(); };
  });
}

function startDrone(bus, sound) {
  const env = AC.createGain(), pn = AC.createStereoPanner();
  env.gain.value = 0; env.connect(pn); pn.connect(bus);
  let src, freqParam, filt = null;
  if (sound === 'noise') {
    src = AC.createBufferSource(); src.buffer = NOISE; src.loop = true;
    filt = AC.createBiquadFilter(); filt.type = 'bandpass'; filt.Q.value = 10; src.connect(filt); filt.connect(env);
    freqParam = filt.frequency;
  } else {
    src = AC.createOscillator();
    src.type = ['sine', 'triangle', 'sawtooth', 'square'].includes(sound) ? sound : 'sine';
    if (src.type === 'sawtooth' || src.type === 'square') {
      filt = AC.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 1800; src.connect(filt); filt.connect(env);
    } else src.connect(env);
    freqParam = src.frequency;
  }
  src.start();
  return { src, env, pn, freqParam, noise: sound === 'noise', first: true };
}

function makeIR(seconds) {
  const len = Math.max(1, Math.floor(AC.sampleRate * seconds));
  const b = AC.createBuffer(2, len, AC.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return b;
}

// ---------------------------------------------------------------- the blocks
const KINDS = { T: 'traffic', V: 'value', E: 'event', A: 'audio' };
const GROUPS = {
  Sky: '--k-traffic', Rhythm: '--k-event', Shape: '--k-value', Sound: '--k-audio', Effects: '--k-audio',
};
const SCALES = {
  'major pentatonic': [0, 2, 4, 7, 9],
  'minor pentatonic': [0, 3, 5, 7, 10],
  'major': [0, 2, 4, 5, 7, 9, 11],
  'natural minor': [0, 2, 3, 5, 7, 8, 10],
  'dorian': [0, 2, 3, 5, 7, 9, 10],
  'whole tone': [0, 2, 4, 6, 8, 10],
  'chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'Newark terrain': [0, 5, 7, 8, 10],
  'Valle de México terrain': [0, 1, 2, 3, 5, 6, 8, 11],
};
// The chords of the Ground block, as semitones above the key root, with the scale their passing tones are drawn from.
// V is the major dominant (E G♯ B in A minor), so it borrows the leading tone from the harmonic minor.
const MINOR = [0, 2, 3, 5, 7, 8, 10], HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];
const CHORDS = {
  i: { root: 0, tones: [0, 3, 7], scale: MINOR },
  VII: { root: 10, tones: [10, 2, 5], scale: MINOR },
  VI: { root: 8, tones: [8, 0, 3], scale: MINOR },
  V: { root: 7, tones: [7, 11, 2], scale: HARMONIC_MINOR },
};
const GROUNDS = { lament: ['i', 'VII', 'VI', 'V'], dominant: ['i', 'V'], vamp: ['i', 'VII', 'VI', 'VII'], home: ['i', 'VII', 'i', 'VI', 'i', 'V'] };
const GROUND_MOVING_FPM = 300; // the climb rate above which a voice is in transit rather than settled, as Select's moving filter
// Voice-led chord tones for the Ground block. Nearest-tone over the lament's parallel triads walks a level voice down in step
// with the bass, in parallel fifths and octaves at 8 of 25 changes on the push capture, and a voice moving in parallel perfect
// intervals with the bass fuses into it (Huron, "Tone and Voice", 2001). So at a change the level voices that were sounding
// just before it choose together, among the chord tones within LEAD_WINDOW semitones of their altitudes, the tones that move
// least, each parallel fifth or octave (between voices or against the bass) costing PARALLEL_COST semitones of motion. Two
// rules are never traded: a higher aircraft never sounds lower, and aircraft within CO_ALT_FT sound one note.
const LEAD_WINDOW = 3.5; // nearest is always within 2.5, since the widest gap between two tones of a triad is a fourth
const PARALLEL_COST = 6;
const CO_ALT_FT = 300; // closer than this vertically, two aircraft are one voice, and co-altitude still reads as a unison
const LEAD_MAX = 8; // the search tries every combination, so with more level voices than this at a change it keeps nearest
const leadFits = (alt, a, b, ma, mb) => { const d = alt.get(a) - alt.get(b); return Math.abs(d) <= CO_ALT_FT ? ma === mb : d > 0 ? ma >= mb : ma <= mb; };
// The tones for `ids` at a change, or null when no combination keeps both rules. near: the nearest tone; place: where the
// altitude falls, in semitones; sung: the note each sounded on the tick before; bass0 and bass1: the bass before and after.
function leadAt(ids, near, place, alt, sung, isTone, lo, hi, bass0, bass1) {
  const cands = ids.map((id) => {
    if (!sung.has(id)) return [near.get(id)]; // a voice that has only just come in has no line to lead
    const t = place.get(id), c = [];
    for (let m = lo; m <= hi; m++) if (isTone(m) && Math.abs(m - t) <= LEAD_WINDOW) c.push(m);
    return c.length ? c.sort((x, y) => Math.abs(x - t) - Math.abs(y - t) || x - y) : [near.get(id)]; // nearest first, so a tie keeps it
  });
  const pick = new Array(ids.length);
  const parallels = () => {
    const parts = ids.flatMap((id, j) => (sung.has(id) ? [[sung.get(id), pick[j], id]] : [])).concat([[bass0, bass1, null]]);
    let k = 0;
    for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
      const [a0, a1, ia] = parts[a], [b0, b1, ib] = parts[b];
      if (ib != null && Math.abs(alt.get(ia) - alt.get(ib)) <= CO_ALT_FT) continue;
      const da = a1 - a0, db = b1 - b0;
      if (da && db && (da > 0) === (db > 0) && Math.abs(a1 - b1) === Math.abs(a0 - b0) && [0, 7].includes(Math.abs(a1 - b1) % 12)) k++;
    }
    return k;
  };
  let best = null, bestCost = Infinity;
  const go = (j, motion) => {
    if (j === ids.length) { const cost = motion + PARALLEL_COST * parallels(); if (cost < bestCost) { bestCost = cost; best = pick.slice(); } return; }
    for (const m of cands[j]) {
      let ok = true;
      for (let k = 0; k < j && ok; k++) ok = leadFits(alt, ids[j], ids[k], m, pick[k]);
      if (!ok) continue;
      pick[j] = m;
      go(j + 1, motion + (sung.has(ids[j]) ? Math.abs(m - sung.get(ids[j])) : 0));
    }
  };
  go(0, 0);
  return best && new Map(ids.map((id, j) => [id, best[j]]));
}
// Between changes a voice keeps its led tone while it stays level and inside the window, and gives it up as soon as keeping
// it would break a rule, against another level voice, that its nearest tone would keep.
function leadHold(led, ids, near, place, alt) {
  const held = new Map();
  for (const [id, m] of led) if (ids.includes(id) && Math.abs(m - place.get(id)) <= LEAD_WINDOW) held.set(id, m);
  const now = (id) => held.get(id) ?? near.get(id);
  for (let dropped = true; dropped;) {
    dropped = false;
    for (const [a, ma] of held) {
      if (ids.some((b) => b !== a && !leadFits(alt, a, b, ma, now(b)) && leadFits(alt, a, b, near.get(a), now(b)))) { held.delete(a); dropped = true; }
    }
  }
  return held;
}
const SOUNDS = [['bell', 'bell'], ['pluck', 'pluck'], ['sine', 'sine'], ['triangle', 'triangle'], ['sawtooth', 'saw'], ['square', 'square'], ['noise', 'noise band']];
const num = (k, label, def, o = {}) => ({ k, label, type: 'num', def, ...o });
const sel = (k, label, def, opts) => ({ k, label, type: 'sel', def, opts });
const inp = (name, kind, label) => ({ name, kind, label: label || name });
const out = inp;

// Two aircraft seen from the antenna, flown on in a straight line. Positions are in NM (x east, y north, from range and
// bearing), velocities in NM per second (from ground speed and track). Straight-line prediction fails in turns and
// level-offs; it is the same idea as the tau of collision-avoidance systems, and no more than that.
const RAD = Math.PI / 180;
const CLOSING_KT = 40; // below this relative speed two tracks are parallel or flying together, not meeting
function fix(a) {
  const th = a.brg * RAD, tk = a.trk * RAD, v = a.gs / 3600;
  return { a, x: a.rng * Math.sin(th), y: a.rng * Math.cos(th), vx: v * Math.sin(tk), vy: v * Math.cos(tk) };
}
function approach(f, g) {
  const dx = f.x - g.x, dy = f.y - g.y, dvx = f.vx - g.vx, dvy = f.vy - g.vy, vv = dvx * dvx + dvy * dvy;
  if (vv < 1e-12) return null; // the same velocity: they never close
  const tau = -(dx * dvx + dy * dvy) / vv; // seconds to the closest point; negative once it has gone by
  const t = Math.max(tau, 0) / 60;
  const vsep = Math.abs(((f.a.alt || 0) + (f.a.vr || 0) * t) - ((g.a.alt || 0) + (g.a.vr || 0) * t));
  return { dist: Math.hypot(dx, dy), rel: Math.sqrt(vv) * 3600, tau, miss: Math.hypot(dx + dvx * tau, dy + dvy * tau), vsep };
}

function hitRate(st, at) {
  st.hits = (st.hits || []).filter((t) => t > at - 8);
  return st.hits.length / 8;
}

const TYPES = {
  sky: {
    title: 'Sky', group: 'Sky', narrow: true, outputs: [out('sky', 'traffic', 'aircraft')],
    params: [num('shift', 'shifted by', 0, { unit: 's', step: 60, hint: 'the sky as it is this many seconds later in the capture (negative: earlier). A control: the same kind of traffic, not the traffic the rest of the patch is playing' })],
    doc: 'The aircraft the antenna heard that have a fresh position, replayed from the capture. One thick cable carries the whole sky, with every field attached.',
    src: 'A real receiver in central New Jersey, one frame about every 5 s (now and then 6 s). Rows whose position is older than 6 s are dropped, about a third of the rows, so this is fewer aircraft than the receiver listed.',
    tick(n, i, c) {
      const sky = n.p.shift ? skyAt(c.dataT + n.p.shift) : c.sky;
      n.readout = `${sky.length} aircraft${n.p.shift ? ` · ${n.p.shift > 0 ? '+' : ''}${n.p.shift} s` : ''}`;
      return { sky };
    },
  },
  select: {
    title: 'Select', group: 'Sky', inputs: [inp('in', 'traffic', 'aircraft')], outputs: [out('out', 'traffic', 'kept')],
    params: [num('rmin', 'range from', 0, { unit: 'NM', step: 5, min: 0 }), num('rmax', 'range to', 25, { unit: 'NM', step: 5, min: 0 }),
      num('amin', 'altitude from', 0, { unit: 'ft', step: 1000 }), num('amax', 'altitude to', 45000, { unit: 'ft', step: 1000 }),
      sel('eng', 'engines', 'any', [['any', 'any'], ['J', 'jets'], ['T', 'turboprops'], ['P', 'pistons']]),
      sel('motion', 'moving', 'any', [['any', 'any'], ['climb', 'climbing'], ['descend', 'descending'], ['level', 'level']]),
      num('nearest', 'keep nearest', 0, { step: 1, min: 0, hint: '0 keeps all' })],
    doc: 'Keeps the aircraft that match. Use several to split the sky into voices: near and far, jets and props, climbing and descending.',
    src: 'patch.py calls this a layer\'s select. Select it on the canvas to see what it keeps, highlighted on the scope.',
    tick(n, i, c) {
      const p = n.p, sky = i.in || [];
      let o = sky.filter((a) => a.rng >= p.rmin && a.rng <= p.rmax && a.alt >= p.amin && a.alt <= p.amax &&
        (p.eng === 'any' || a.eng === p.eng) &&
        (p.motion === 'any' || (p.motion === 'climb' ? a.vr > 300 : p.motion === 'descend' ? a.vr < -300 : a.vr != null && Math.abs(a.vr) <= 300)));
      if (p.nearest > 0) o = o.slice().sort((a, b) => a.rng - b.rng).slice(0, p.nearest);
      n.readout = `${o.length} of ${sky.length} kept`;
      return { out: o };
    },
  },
  read: {
    title: 'Read', group: 'Sky', inputs: [inp('in', 'traffic', 'aircraft')],
    outputs: [out('alt', 'value', 'altitude ft'), out('vr', 'value', 'climb fpm'), out('gs', 'value', 'speed kt'),
      out('trk', 'value', 'heading °'), out('rng', 'value', 'range NM'), out('brg', 'value', 'bearing °'),
      out('rssi', 'value', 'signal dBFS'), out('rate', 'value', 'messages/s'), out('count', 'value', 'count')],
    doc: 'Opens the aircraft cable into one value per field. Each output is a number per aircraft; count is one number.',
    src: 'Bearing and range are measured from the antenna, so the sky is already in a radar\'s polar coordinates. Signal and message rate are properties of the radio link, not of the aircraft.',
    tick(n, i) {
      const sky = i.in || [], o = {};
      for (const f of ['alt', 'vr', 'gs', 'trk', 'rng', 'brg', 'rssi', 'rate']) {
        const m = new Map(); for (const a of sky) m.set(a.id, a[f]); o[f] = Val.per(m);
      }
      o.count = Val.all(sky.length);
      n.readout = `${sky.length} aircraft`;
      return o;
    },
  },
  closest: {
    title: 'Closest pair', group: 'Sky', inputs: [inp('in', 'traffic', 'aircraft')],
    outputs: [out('pair', 'traffic', 'pair'), out('dist', 'value', 'distance NM'), out('miss', 'value', 'miss NM'),
      out('tau', 'value', 'time to closest s'), out('close', 'event', 'close pass'), out('passed', 'event', 'passed')],
    params: [num('miss', 'miss under', 3, { unit: 'NM', step: 0.5, min: 0.5 }), num('vert', 'vertical under', 2000, { unit: 'ft', step: 500, min: 0 }),
      num('horizon', 'look ahead', 90, { unit: 's', step: 15, min: 15 }), num('above', 'ignore below', 1000, { unit: 'ft', step: 500, min: 0 }),
      num('hold', 'hold a gap', 20, { unit: 's', step: 5, min: 0, hint: 'data time a pair is kept when one aircraft drops out' })],
    doc: 'Picks the one pair about to pass closest and gives it as a set of two aircraft. It predicts in a straight line from speed and track, so a pass is heard coming: time to closest runs down to zero as they meet, and the pair is let go once they have passed. Parallel tracks, and aircraft below the floor, are ignored.',
    src: 'Time to closest approach, the tau of collision-avoidance systems, drives a pulse better than closing speed: on a straight approach the closing speed is constant and tau is what shrinks. "Close pass" means predicted inside the miss distance and under 1,000 ft vertically (900 to start, 1,100 to stop). It is a prediction from recorded positions, not a statement about separation: visual separation and parallel approaches are legal inside these numbers.',
    init: () => ({ pair: null, chal: null, t: null, recent: new Map() }),
    tick(n, i, c) {
      const st = n.st, p = n.p, sky = i.in || [], t = c.dataT, passed = [], close = [];
      if (st.t != null && (t < st.t || t - st.t > 30)) { st.pair = null; st.chal = null; st.recent.clear(); } // a seek: start again
      const dt = st.t == null ? 0 : t - st.t; st.t = t;
      const fixes = new Map();
      for (const a of sky) if (a.alt >= p.above && a.gs != null && a.trk != null && a.rng != null && a.brg != null) fixes.set(a.id, fix(a));
      const meets = (ap) => ap && ap.tau > 0 && ap.tau <= p.horizon && ap.rel >= CLOSING_KT && ap.miss <= p.miss && ap.vsep <= p.vert;
      const key = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
      let now = null; // the incumbent's prediction this tick
      if (st.pair) {
        const [x, y] = st.pair.ids, f = fixes.get(x), g = fixes.get(y), ap = f && g ? approach(f, g) : null;
        if (!ap) { if (t - st.pair.seen > p.hold) st.pair = null; } // a pair that vanishes leaves no cadence: nothing shows who acted
        else {
          st.pair.seen = t;
          if (ap.tau > 0) {
            now = ap; st.pair.tau = ap.tau;
            st.pair.off = ap.miss > p.miss + 1 || ap.tau > p.horizon * 1.5 ? (st.pair.off || 0) + dt : 0; // a turn can spoil the prediction
            if (st.pair.off > p.hold) st.pair = null;
          } else { // the closest point has gone by
            passed.push({ id: '*', at: c.w1 }); st.recent.set(key(x, y), t); st.pair = null;
          }
        }
      }
      const list = [...fixes.values()], taken = st.pair ? new Set(st.pair.ids) : new Set();
      let best = null;
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        const ids = [list[a].a.id, list[b].a.id];
        if (taken.has(ids[0]) || taken.has(ids[1])) continue;
        const k = key(ids[0], ids[1]);
        if (st.recent.has(k) && t - st.recent.get(k) < 120) continue;
        const ap = approach(list[a], list[b]);
        if (meets(ap) && (!best || ap.tau < best.ap.tau)) best = { ids, ap, k };
      }
      if (best && !st.pair) { st.pair = { ids: best.ids, seen: t, tau: best.ap.tau, close: false, off: 0 }; st.chal = null; now = best.ap; }
      else if (best && st.pair && best.ap.tau < st.pair.tau * 0.5) { // a challenger must be much sooner, and stay so for 10 s
        if (st.chal && st.chal.k === best.k) { if (t - st.chal.since >= 10) { st.pair = { ids: best.ids, seen: t, tau: best.ap.tau, close: false, off: 0 }; st.chal = null; now = best.ap; } }
        else st.chal = { k: best.k, since: t };
      } else st.chal = null;
      const o = {};
      if (st.pair) {
        const have = st.pair.ids.map((id) => fixes.get(id)).filter(Boolean);
        o.pair = have.map((f) => f.a);
        if (now) {
          o.dist = Val.all(now.dist); o.miss = Val.all(now.miss); o.tau = Val.all(now.tau);
          if (!st.pair.close && now.miss < p.miss && now.vsep < 900) { st.pair.close = true; close.push({ id: '*', at: c.w1 }); }
          else if (st.pair.close && now.vsep > 1100) st.pair.close = false;
        }
      }
      if (c.preview) { passed.length = 0; close.length = 0; }
      o.close = close; o.passed = passed;
      n.readout = now ? `${fmt(now.dist)} NM · ${fmt(now.tau)} s` : st.pair ? 'pair out of sight' : 'no pair';
      if (!i.in) n.warn = 'nothing to watch: connect aircraft';
      return o;
    },
  },
  leveloff: {
    title: 'Level-off', group: 'Sky', inputs: [inp('in', 'traffic', 'aircraft')],
    outputs: [out('cast', 'traffic', 'cast'), out('level', 'event', 'levelled')],
    params: [num('moving', 'moving above', 500, { unit: 'ft/min', step: 100, min: 100 }),
      num('dwell', 'moving for', 15, { unit: 's', step: 5, min: 0, hint: 'data time above that rate before it counts as a climb or a descent' }),
      num('level', 'level within', 200, { unit: 'ft/min', step: 50, min: 0 }),
      num('slow', 'slows within', 4, { unit: 's', step: 1, min: 0, hint: 'longest a climb or descent may take to ease from the moving rate to the level rate; a slower ease is not a level-off. 4 s is under one 5 s frame of the capture' }),
      num('settle', 'level for', 10, { unit: 's', step: 5, min: 0, hint: 'data time within that rate before the level-off is announced' }),
      num('keep', 'keep', 3, { step: 1, min: 1, max: 8, hint: 'how many of the latest to level off stay in the cast' }),
      sel('seed', 'at the start', 'empty', [['empty', 'empty'], ['level', 'level ones']])],
    doc: 'Fires when an aircraft that was climbing or descending settles level, and keeps the last few to do so as a set. The set is the cast: plug it into a Read and a Voice to hear the aircraft that have just arrived at their altitude, instead of everyone in view. "At the start: level ones" fills the cast with the nearest aircraft already in level flight when play begins or after a seek, so it does not open empty.',
    src: 'Vertical rate comes from the capture, so a level-off is announced "level for" seconds after it happens: the block waits to be sure. An aircraft that leaves the input leaves the cast, and nothing older takes its place. 500 ft/min is a climb or descent under way, 200 ft/min is level flight.',
    init: () => ({ ac: new Map(), cast: [], t: null, hits: [], seeded: false }),
    tick(n, i, c) {
      const st = n.st, p = n.p, sky = i.in || [], t = c.dataT, level = [], here = new Set();
      if (st.t != null && (t < st.t || t - st.t > 30)) { st.ac.clear(); st.cast = []; st.seeded = false; } // a seek: start again
      st.t = t;
      if (!st.seeded) { // "level ones": the keep nearest aircraft already in level flight, the nearest the latest
        st.seeded = true;
        if (p.seed === 'level') st.cast = sky.filter((a) => a.vr != null && Math.abs(a.vr) <= p.level).sort((a, b) => b.rng - a.rng).slice(-Math.max(1, p.keep)).map((a) => a.id);
      }
      for (const a of sky) {
        here.add(a.id);
        let s = st.ac.get(a.id);
        if (!s) st.ac.set(a.id, (s = { mv: null, moving: false, lv: null, last: null }));
        const v = a.vr == null ? null : Math.abs(a.vr);
        if (v == null) { s.mv = s.lv = null; s.moving = false; }
        else if (v > p.moving) { s.lv = null; s.last = t; if (s.mv == null) s.mv = t; if (t - s.mv >= p.dwell) s.moving = true; }
        else if (v <= p.level && s.moving) {
          if (s.lv == null) s.lv = t - s.last > p.slow ? null : t;
          if (s.lv == null) { s.moving = false; s.mv = null; } // eased off too slowly: not a level-off
          else if (t - s.lv >= p.settle) { level.push({ id: a.id, at: c.w1 }); s.moving = false; s.mv = s.lv = null; }
        } else { s.lv = null; if (!s.moving) s.mv = null; } // between the two rates: a moving aircraft is still moving
      }
      for (const id of [...st.ac.keys()]) if (!here.has(id)) st.ac.delete(id);
      for (const e of level) { st.cast = st.cast.filter((x) => x !== e.id); st.cast.push(e.id); }
      st.cast = st.cast.slice(-Math.max(1, p.keep)).filter((id) => here.has(id));
      if (c.preview) level.length = 0; else st.hits = st.hits.concat(level.map((e) => e.at));
      const cast = sky.filter((a) => st.cast.includes(a.id));
      n.readout = `${cast.length} in the cast · ${hitRate(st, c.w1).toFixed(2)} level-offs/s`;
      if (!i.in) n.warn = 'nothing to watch: connect aircraft';
      return { cast, level };
    },
  },
  enterexit: {
    title: 'Enter / exit', group: 'Rhythm', inputs: [inp('in', 'traffic', 'aircraft')], outputs: [out('enter', 'event'), out('exit', 'event')],
    params: [num('hold', 'hold', 15, { unit: 's', step: 5, min: 0, hint: 'data time an aircraft must be gone before it counts as an exit' })],
    doc: 'Fires when an aircraft comes into the set and when it leaves. Put a Select in front of it to make a gate: below 4,000 ft and inside 30 NM fires as arrivals descend into the terminal area.',
    src: 'SonAir\'s controllers found exactly this cue useful: an earcon when an aircraft enters, and from which direction.',
    init: () => ({ in: new Set(), last: new Map(), primed: false }),
    tick(n, i, c) {
      const st = n.st, sky = i.in || [], enter = [], exit = [];
      const now = new Set(sky.map((a) => a.id));
      for (const id of now) {
        st.last.set(id, c.dataT);
        if (!st.in.has(id)) { st.in.add(id); if (st.primed) enter.push({ id, at: c.w1 }); }
      }
      for (const id of [...st.in]) {
        if (!now.has(id) && c.dataT - (st.last.get(id) ?? -1e9) > n.p.hold) { st.in.delete(id); if (st.primed) exit.push({ id, at: c.w1 }); }
      }
      st.primed = true;
      if (!c.preview) for (const e of enter.concat(exit)) st.hits = (st.hits || []).concat(e.at);
      n.readout = `${st.in.size} inside · ${hitRate(st, c.w1).toFixed(2)} events/s`;
      return { enter, exit };
    },
  },
  sweep: {
    title: 'Radar sweep', group: 'Rhythm', inputs: [inp('in', 'traffic', 'aircraft')], outputs: [out('hit', 'event', 'lit')],
    params: [sel('axis', 'scan by', 'bearing', [['bearing', 'bearing: a rotating beam', 'bearing'], ['range', 'range: a ring from the centre', 'range']]),
      num('bars', 'one turn', 2, { unit: 'bars', step: 0.5, min: 0.25 }),
      sel('dir', 'direction', 'cw', [['cw', 'clockwise, or outward when scanning by range', 'cw/out'], ['ccw', 'counter-clockwise, or inward when scanning by range', 'ccw/in']]),
      num('offset', 'start at', 0, { unit: '°', step: 15, hint: 'scan by bearing only' }),
      num('reach', 'reach', 60, { unit: 'NM', step: 5, min: 5, hint: 'scan by range only: where the ring ends' })],
    doc: 'A scanning front that decides when each aircraft plays. By bearing it is a rotating beam: each aircraft fires once per turn, when the beam crosses its bearing. By range it is a ring that grows from the centre, or shrinks inward: each aircraft fires when the ring reaches its range. The sweep conducts and the sky decides who plays.',
    src: 'The onset comes from the scan, not from the aircraft: bearing (or range) fixes when in the turn an aircraft sounds. sonify.py in this folder does the same arithmetic offline, and director.py lights seeded radar cells instead. At 96 bpm in 4/4 two bars is 5 s, close to the receiver\'s 5 s frame interval; at the default 4x replay one turn covers 20 s of capture. A ring spends more of its turn among the many far aircraft than the few near ones, so it speeds up as it grows.',
    init: () => ({}),
    angle(n, at) {
      const per = n.p.bars * TP.bpb;
      return mod(n.p.offset + (n.p.dir === 'ccw' ? -1 : 1) * 360 * beatAt(at) / per, 360);
    },
    radius(n, at) {
      const t = mod(beatAt(at) / (Math.max(0.25, n.p.bars) * TP.bpb), 1);
      return n.p.reach * (n.p.dir === 'ccw' ? 1 - t : t);
    },
    tick(n, i, c) {
      const sky = i.in || [], hits = [], p = n.p, byRange = p.axis === 'range';
      const per = Math.max(0.25, p.bars) * TP.bpb;
      const dir = p.dir === 'ccw' ? -1 : 1;
      if (byRange) {
        // The ring covers a fraction of its reach each tick. An inward ring is an outward one seen in (1 - range).
        const span = (c.b1 - c.b0) / per, f0 = mod(c.b0 / per, 1);
        if (!c.preview && span > 0) {
          for (const a of sky) {
            if (a.rng == null || a.rng > p.reach) continue;
            const d = mod((dir > 0 ? a.rng / p.reach : 1 - a.rng / p.reach) - f0, 1);
            if (d < span) hits.push({ id: a.id, at: c.w0 + (d / span) * (c.w1 - c.w0) });
          }
          hits.sort((x, y) => x.at - y.at);
          n.st.hits = (n.st.hits || []).concat(hits.map((h) => h.at));
        }
        n.readout = `ring ${fmt(per * 60 / TP.bpm)} s · ${sky.filter((a) => a.rng <= p.reach).length} in reach · ${hitRate(n.st, c.w1).toFixed(1)} hits/s`;
        return { hit: hits };
      }
      const span = 360 * (c.b1 - c.b0) / per;
      const a0 = mod(p.offset + dir * 360 * c.b0 / per, 360);
      if (!c.preview && span > 0) {
        for (const a of sky) {
          if (a.brg == null) continue;
          const d = dir > 0 ? mod(a.brg - a0, 360) : mod(a0 - a.brg, 360);
          if (d < span) hits.push({ id: a.id, at: c.w0 + (d / span) * (c.w1 - c.w0) });
        }
        hits.sort((x, y) => x.at - y.at);
        n.st.hits = (n.st.hits || []).concat(hits.map((h) => h.at));
      }
      n.readout = `turn ${fmt(per * 60 / TP.bpm)} s · ${sky.length} in view · ${hitRate(n.st, c.w1).toFixed(1)} hits/s`;
      return { hit: hits };
    },
  },
  every: {
    title: 'Every', group: 'Rhythm', outputs: [out('tick', 'event')],
    params: [num('beats', 'every', 4, { unit: 'beats', step: 0.25, min: 0.25 }), num('offset', 'offset', 0, { unit: 'beats', step: 0.25 })],
    doc: 'A clock. Fires on the beat grid. Into a Voice whose note is a value per aircraft, it plays all of them at once as a chord.',
    src: 'One event for everyone, not for one aircraft.',
    tick(n, i, c) {
      const ev = [], k = Math.max(0.25, n.p.beats), off = n.p.offset;
      if (!c.preview) for (let j = Math.ceil((c.b0 - off) / k - 1e-9); j * k + off < c.b1; j++) ev.push({ id: '*', at: timeOfBeat(j * k + off) });
      n.readout = `every ${fmt(k * 60 / TP.bpm)} s`;
      return { tick: ev };
    },
  },
  pulse: {
    title: 'Pulse', group: 'Rhythm', inputs: [inp('in', 'value', 'beats between')], outputs: [out('tick', 'event')],
    params: [num('fastest', 'fastest', 0.25, { unit: 'beats', step: 0.125, min: 0.0625 }), num('slowest', 'slowest', 4, { unit: 'beats', step: 0.5, min: 0.25 })],
    doc: 'Events at a pace a value sets: the value is the number of beats between one event and the next, held between fastest and slowest. Silent while there is no value. Put a Map in front to turn a distance or a time into a pace; into a Voice whose note is a value per aircraft, each event plays them all as a chord.',
    src: 'Every fires on a fixed grid; this one slows and quickens with the data. One event for everyone, not for one aircraft.',
    init: () => ({ next: null, hits: [] }),
    tick(n, i, c) {
      const st = n.st, p = n.p, x = Val.scalar(i.in), ev = [];
      if (x == null || !isFinite(x)) { st.next = null; n.readout = 'silent'; if (!i.in) n.warn = 'nothing sets the pace: connect a value'; return { tick: [] }; }
      const k = clamp(x, Math.min(p.fastest, p.slowest), Math.max(p.fastest, p.slowest));
      if (st.next == null || st.next < c.b0) st.next = c.b0; // start when a value appears, and never owe a backlog
      if (!c.preview) while (st.next < c.b1) { ev.push({ id: '*', at: timeOfBeat(st.next) }); st.next += k; }
      if (!c.preview) st.hits = (st.hits || []).concat(ev.map((e) => e.at));
      n.readout = `every ${fmt(k * 60 / TP.bpm)} s · ${hitRate(st, c.w1).toFixed(1)} events/s`;
      return { tick: ev };
    },
  },
  threshold: {
    title: 'Threshold', group: 'Rhythm', inputs: [inp('in', 'value')], outputs: [out('out', 'event', 'crossed')],
    params: [num('level', 'level', 10000, { step: 500 }), sel('dir', 'crossing', 'down', [['down', 'downward', '▼'], ['up', 'upward', '▲'], ['both', 'either way', '▼▲']])],
    doc: 'Fires when an aircraft\'s value crosses the level. Altitude through 10,000 ft, range through a ring, a climb rate going negative.',
    src: 'patch.py: Threshold, continuous to event.',
    init: () => ({ prev: new Map(), primed: false }),
    tick(n, i, c) {
      const ev = [], L = n.p.level, d = n.p.dir, st = n.st;
      if (i.in && i.in.per) for (const [id, x] of i.in.per) {
        if (x == null) continue;
        const p = st.prev.get(id);
        if (p != null && st.primed && ((d !== 'up' && p > L && x <= L) || (d !== 'down' && p < L && x >= L))) ev.push({ id, at: c.w1 });
        st.prev.set(id, x);
      }
      st.primed = true;
      if (!c.preview) st.hits = (st.hits || []).concat(ev.map((e) => e.at));
      n.readout = `${hitRate(st, c.w1).toFixed(2)} crossings/s`;
      if (!i.in) n.warn = 'nothing to watch: connect a value';
      return { out: ev };
    },
  },
  ratelimit: {
    title: 'Rate limit', group: 'Rhythm', inputs: [inp('in', 'value')], outputs: [out('out', 'event', 'changed')],
    params: [num('delta', 'change by', 1, { step: 0.5, min: 0, hint: 'in the input\'s own units' }), num('min', 'no sooner than', 1, { unit: 's', step: 0.25, min: 0 }),
      num('max', 'no later than', 12, { unit: 's', step: 1, min: 0.5 })],
    doc: 'Turns a changing value into events: fires when it has moved by at least "change by", never faster than the floor, and at least once per ceiling so nothing hangs.',
    src: 'patch.py: RateLimit. Below the floor it chatters (0.45 s re-strikes sounded like crickets); above the ceiling it drones (135.8 s held one note like a ghost).',
    init: () => ({ last: new Map(), primed: false }),
    tick(n, i, c) {
      const ev = [], p = n.p, st = n.st;
      if (i.in && i.in.per) for (const [id, x] of i.in.per) {
        if (x == null) continue;
        const s = st.last.get(id);
        if (!s) { st.last.set(id, { x, t: c.w1 - Math.random() * p.max }); if (st.primed) ev.push({ id, at: c.w1 }); continue; }
        const dt = c.w1 - s.t;
        if ((Math.abs(x - s.x) >= p.delta && dt >= p.min) || dt >= p.max) { ev.push({ id, at: c.w1 }); s.x = x; s.t = c.w1; }
      }
      st.primed = true;
      if (!c.preview) st.hits = (st.hits || []).concat(ev.map((e) => e.at));
      n.readout = `${hitRate(st, c.w1).toFixed(1)} events/s`;
      if (!i.in) n.warn = 'nothing to watch: connect a value';
      return { out: c.preview ? [] : ev };
    },
  },
  quantize: {
    title: 'Quantize', group: 'Rhythm', inputs: [inp('in', 'event')], outputs: [out('out', 'event')],
    params: [sel('grid', 'snap to', '0.25', [['1', '1/4 beats'], ['0.5', '1/8'], ['0.25', '1/16'], ['0.3333333333', '1/8 triplet'], ['4', 'bars'], ['8', '2 bars']])],
    doc: 'Moves each event forward to the next grid line, so data time lands on the beat.',
    src: 'patch.py: Quantize. Free onsets measured 16% on the beat where chance gives 20%; snapped, 61%.',
    tick(n, i) {
      const g = parseFloat(n.p.grid);
      const ev = (i.in || []).map((e) => ({ id: e.id, at: timeOfBeat(Math.ceil(beatAt(e.at) / g - 1e-6) * g) }));
      n.readout = `${(i.in || []).length} this tick`;
      return { out: ev };
    },
  },
  changed: {
    title: 'Changed', group: 'Rhythm', inputs: [inp('in', 'event'), inp('value', 'value')], outputs: [out('out', 'event', 'changed')],
    params: [num('delta', 'moved by', 1, { step: 0.5, min: 0, hint: 'in the value\'s own units; 0 lets everything through' }),
      num('every', 'or after', 4, { unit: 'bars', step: 1, min: 0, hint: 'a note that has not moved is let through again after this long; 0 never repeats it' })],
    doc: 'Lets an event through only if the value it belongs to has moved since the last one let through, or a while has passed. Between a Radar sweep and a Voice it stops a held note being struck again and again, and lets a note that changed, or a long-held one, sound.',
    src: 'One memory per aircraft (one for events that are for everyone). An event with no value is let through, since there is nothing to compare.',
    init: () => ({ last: new Map() }),
    tick(n, i, c) {
      const st = n.st, p = n.p, out = [];
      if (!c.preview) for (const e of [...(i.in || [])].sort((a, b) => a.at - b.at)) {
        const v = Val.get(i.value, e.id), b = beatAt(e.at), s = st.last.get(e.id);
        const pass = v == null || !s || Math.abs(v - s.v) >= p.delta || (p.every > 0 && b - s.b >= p.every * TP.bpb);
        if (pass) { out.push(e); if (v != null) st.last.set(e.id, { v, b }); }
      }
      n.readout = `${out.length} of ${(i.in || []).length} this tick`;
      if (!i.in) n.warn = 'nothing to gate: connect an event';
      return { out };
    },
  },
  map: {
    title: 'Map', group: 'Shape', inputs: [inp('in', 'value')], outputs: [out('out', 'value')],
    params: [num('lo', 'from', 0, { step: 1 }), num('hi', 'to', 100, { step: 1 }), num('olo', 'onto', 0, { step: 0.05 }), num('ohi', 'and', 1, { step: 0.05 })],
    doc: 'Rescales a range onto another, clamping at the ends. Reverse "onto" and "and" to invert: near becomes loud.',
    src: 'patch.py: Map, which reports its clamps instead of hiding them. The count is on the block.',
    tick(n, i) {
      const p = n.p; let cl = 0;
      const o = Val.map(i.in, (x) => {
        const f = p.hi === p.lo ? 0 : (x - p.lo) / (p.hi - p.lo);
        if (f < 0 || f > 1) cl++;
        return p.olo + clamp(f, 0, 1) * (p.ohi - p.olo);
      });
      n.readout = i.in ? `${rangeText(o)}${cl ? ` · ${cl} clamped` : ''}` : '';
      if (!i.in) n.warn = 'nothing to map: connect a value';
      return { out: o };
    },
  },
  scale: {
    title: 'Scale', group: 'Shape', inputs: [inp('in', 'value')], outputs: [out('note', 'value')],
    params: [num('lo', 'from', 0, { step: 1000 }), num('hi', 'to', 40000, { step: 1000 }),
      sel('scale', 'scale', 'Newark terrain', Object.keys(SCALES).map((s) => [s, s])),
      sel('root', 'root', '9', NOTE_NAMES.map((nm, k) => [String(k), nm])), num('oct', 'octave', 3, { step: 1, min: 0, max: 7 }),
      num('span', 'octaves', 3, { step: 1, min: 1, max: 6 })],
    doc: 'Snaps a value onto the notes of a scale: low values to low notes. Altitude to pitch is the one mapping a listener does not have to learn.',
    src: 'patch.py: Snap. The two terrain scales are pitchaxis\'s own, built from each facility\'s minimum vectoring altitudes: Newark gives A D E F G, the Valle de México eight notes with four consecutive semitones.',
    tick(n, i) {
      const p = n.p, deg = SCALES[p.scale] || SCALES['major pentatonic'];
      const base = 12 * (p.oct + 1) + parseInt(p.root, 10), steps = deg.length * p.span;
      const o = Val.map(i.in, (x) => {
        const f = clamp(p.hi === p.lo ? 0 : (x - p.lo) / (p.hi - p.lo), 0, 1);
        const k = Math.round(f * steps);
        return base + 12 * Math.floor(k / deg.length) + deg[k % deg.length];
      });
      const r = range(Val.list(o));
      n.readout = r ? `${noteName(r[0])} … ${noteName(r[1])}` : 'no notes';
      if (!i.in) n.warn = 'nothing to scale: connect a value';
      return { note: o };
    },
  },
  ground: {
    title: 'Ground', group: 'Shape', inputs: [inp('in', 'value', 'altitude ft'), inp('rate', 'value', 'climb ft/min'), inp('step', 'event', 'next chord')],
    outputs: [out('note', 'value'), out('bass', 'value', 'bass note'), out('chord', 'value', 'chord notes'), out('changed', 'event')],
    params: [sel('prog', 'chords', 'lament', [['lament', 'i VII VI V'], ['dominant', 'i V'], ['vamp', 'i VII VI VII (no G♯)'], ['home', 'i VII i VI i V (home between)']]),
      sel('root', 'key', '9', NOTE_NAMES.map((nm, k) => [String(k), nm])), num('oct', 'octave', 2, { step: 1, min: 0, max: 6 }), num('span', 'octaves', 3, { step: 1, min: 1, max: 5 }),
      num('lo', 'from', 0, { unit: 'ft', step: 1000 }), num('hi', 'to', 12000, { unit: 'ft', step: 1000 }),
      num('open', 'first chord', 4, { unit: 'bars', step: 1, min: 0, hint: 'bars the first chord is held from play, so the key is heard before it moves' }),
      num('dwell', 'between changes', 2, { unit: 'bars', step: 1, min: 0, hint: 'the fewest bars between one change and the next' }),
      sel('passing', 'passing notes', 'on', [['on', 'on'], ['off', 'off']]),
      sel('alloc', 'chord tones', 'nearest', [['nearest', 'nearest'], ['led', 'voice-led']])],
    doc: 'Turns altitudes into the notes of a chord, and moves to the next chord when an event arrives. An aircraft in level flight sounds the chord tone nearest its altitude; a climbing or descending one sounds the scale note beside it, on the side it is going. The chords are a composed cycle: the data decides when the page turns, who sings and which chord tone, not what comes next. Altitude to note is still a state-to-state mapping, held inside a fixed frame; the Duet is the example that maps relationships. Chord tones "voice-led" changes one thing: at a change, the aircraft in level flight choose together among the chord tones within 3.5 semitones of their altitudes, moving least and avoiding parallel fifths and octaves with each other and the bass, and keep that tone until the next change while they stay level. A higher aircraft still never sounds lower, and aircraft within 300 ft still share a note. With more than 8 level aircraft at a change it keeps nearest.',
    src: 'A natural minor, with the leading tone G♯ borrowed for V. The triads hold no semitone and no tritone, so aircraft in level flight never sound a minor second against each other. A change lands at the time of its event, so put a Quantize set to bars in front of "next chord" to land it on the bar line. The bass output is the chord root at the bottom of the window, for a Voice struck once a bar; chord notes is the whole chord as root, fifth and third an octave up, for a Voice with a strum.',
    init: () => ({ idx: 0, accepted: 0, last: null, pend: [], sung: new Map(), led: new Map() }),
    tick(n, i, c) {
      const st = n.st, p = n.p, cycle = GROUNDS[p.prog] || GROUNDS.lament, before = st.idx;
      if (!c.preview) {
        if (st.last == null) st.last = c.b0; // the first chord is held from the moment play starts
        for (const e of [...(i.step || [])].sort((a, b) => a.at - b.at)) {
          const b = beatAt(e.at);
          if (b - st.last >= (st.accepted ? p.dwell : p.open) * TP.bpb) { st.pend.push(e.at); st.last = b; st.accepted++; }
        }
      }
      const changed = [];
      if (!c.preview) while (st.pend.length && st.pend[0] <= c.w1) { changed.push({ id: '*', at: st.pend.shift() }); st.idx++; }
      const name = cycle[st.idx % cycle.length], ch = CHORDS[name], key = parseInt(p.root, 10);
      const base = 12 * (p.oct + 1) + key, top = base + 12 * p.span;
      const inScale = (m, scale) => scale.includes(mod(m - base, 12));
      const placeOf = (alt) => base + clamp(p.hi === p.lo ? 0 : (alt - p.lo) / (p.hi - p.lo), 0, 1) * 12 * p.span;
      const rateOf = (id) => (p.passing === 'on' ? Val.get(i.rate, id) : null);
      const note = Val.map(i.in, (alt, id) => {
        const target = placeOf(alt);
        let best = null; // the chord tone nearest the altitude, inside the window; a tie goes to the lower
        for (let m = base; m <= top; m++) if (ch.tones.includes(mod(m - base, 12)) && (best == null || Math.abs(m - target) < Math.abs(best - target))) best = m;
        const vr = rateOf(id);
        if (vr == null || Math.abs(vr) <= GROUND_MOVING_FPM) return best;
        const dir = vr > 0 ? 1 : -1;
        let m = best + dir;
        while (!inScale(m, ch.scale)) m += dir;
        return m;
      });
      const bass = Val.all(base + mod(ch.root + 6, 12) - 6); // the root nearest the bottom of the window, below it where it is nearer
      if (p.alloc === 'led' && note && note.per) {
        const ids = [], near = new Map(), place = new Map(), alt = new Map();
        for (const [id, m] of note.per) {
          const vr = rateOf(id);
          if (m == null || (vr != null && Math.abs(vr) > GROUND_MOVING_FPM)) continue; // a voice in transit keeps its passing note
          const a = Val.get(i.in, id);
          ids.push(id); near.set(id, m); place.set(id, placeOf(a)); alt.set(id, a);
        }
        let led = st.led;
        if (changed.length) {
          const bass0 = base + mod(CHORDS[cycle[before % cycle.length]].root + 6, 12) - 6;
          led = (ids.length <= LEAD_MAX && leadAt(ids, near, place, alt, st.sung, (m) => ch.tones.includes(mod(m - base, 12)), base, top, bass0, bass.all)) || new Map();
        }
        led = leadHold(led, ids, near, place, alt);
        for (const [id, m] of led) note.per.set(id, m);
        if (!c.preview) { st.led = led; st.sung = new Map([...note.per].filter(([, m]) => m != null)); }
      }
      const third = mod(ch.tones[1] - ch.tones[0], 12), fifth = mod(ch.tones[2] - ch.tones[0], 12); // open position, low to high, so a strum rises
      const chord = Val.per(new Map([['root', bass.all], ['fifth', bass.all + fifth], ['third', bass.all + 12 + third]]));
      n.readout = `${name} ${NOTE_NAMES[mod(key + ch.root, 12)]} · bass ${noteName(bass.all)}`;
      if (!i.in) n.warn = 'nothing to sound: connect an altitude';
      else if (!i.step) n.warn = 'nothing turns the page: connect an event to next chord';
      return { note, bass, chord, changed };
    },
  },
  pan: {
    title: 'Pan', group: 'Shape', inputs: [inp('in', 'value', 'bearing °')], outputs: [out('pan', 'value')],
    params: [num('width', 'width', 1, { step: 0.1, min: 0, max: 1 })],
    doc: 'Bearing to stereo position: east to the right, west to the left. The orchestra is laid out like the sky.',
    src: 'patch.py: Circular, so 359° and 1° sit next to each other.',
    tick(n, i) {
      const o = Val.map(i.in, (x) => Math.sin(x * Math.PI / 180) * n.p.width);
      n.readout = i.in ? rangeText(o) : '';
      return { pan: o };
    },
  },
  smooth: {
    title: 'Glide', group: 'Shape', inputs: [inp('in', 'value')], outputs: [out('out', 'value')],
    params: [num('tau', 'glide time', 2, { unit: 's', step: 0.5, min: 0 })],
    doc: 'Smooths each aircraft\'s value over time, so a step becomes a slide.',
    src: 'Real seconds, not data seconds.',
    init: () => ({ y: new Map() }),
    tick(n, i, c) {
      const k = n.p.tau > 0 ? 1 - Math.exp(-(c.w1 - c.w0) / n.p.tau) : 1;
      const o = Val.map(i.in, (x, id) => { const y = n.st.y.get(id); const z = y == null ? x : y + (x - y) * k; n.st.y.set(id, z); return z; });
      n.readout = i.in ? rangeText(o) : '';
      return { out: o };
    },
  },
  math: {
    title: 'Math', group: 'Shape', inputs: [inp('a', 'value'), inp('b', 'value')], outputs: [out('out', 'value')],
    params: [sel('op', 'operation', 'add', [['add', 'a + b'], ['sub', 'a − b'], ['mul', 'a × b'], ['min', 'min'], ['max', 'max']]),
      num('b', 'b if unplugged', 0, { step: 1 })],
    doc: 'Combines two values. Add an offset (−12 is an octave down), scale one value by another.',
    src: 'patch.py\'s offset and mod roles, as a block.',
    tick(n, i) {
      const op = { add: (x, y) => x + y, sub: (x, y) => x - y, mul: (x, y) => x * y, min: Math.min, max: Math.max }[n.p.op];
      const b = i.b || Val.all(n.p.b);
      if (!i.a) { n.warn = 'connect a'; return {}; }
      const o = Val.map(i.a, (x, id) => { const y = Val.get(b, id); return y == null ? x : op(x, y); });
      n.readout = rangeText(o);
      return { out: o };
    },
  },
  stats: {
    title: 'Summary', group: 'Shape', inputs: [inp('in', 'value')], outputs: [out('out', 'value', 'one number')],
    params: [sel('fn', 'take the', 'mean', [['mean', 'mean'], ['min', 'lowest'], ['max', 'highest'], ['spread', 'spread'], ['count', 'count']])],
    doc: 'Reduces a value per aircraft to one number for the whole set: the mean altitude, the nearest range, how many are climbing.',
    src: 'Use it to drive a filter or a level from the state of the sky.',
    tick(n, i) {
      const xs = Val.list(i.in), f = n.p.fn;
      const r = !xs.length ? (f === 'count' ? 0 : undefined) : f === 'mean' ? xs.reduce((s, x) => s + x, 0) / xs.length
        : f === 'min' ? Math.min(...xs) : f === 'max' ? Math.max(...xs) : f === 'spread' ? Math.max(...xs) - Math.min(...xs) : xs.length;
      n.readout = fmt(r);
      return { out: r == null ? undefined : Val.all(r) };
    },
  },
  constant: {
    title: 'Number', group: 'Shape', outputs: [out('out', 'value')], params: [num('v', 'value', 45, { step: 1 })],
    doc: 'A fixed number. As a note: 45 is A2, 57 is A3, 60 is middle C.',
    src: 'patch.py: constant, a legitimate base for something whose interest is all in its modulators.',
    tick(n) { n.readout = `${fmt(n.p.v)}${n.p.v >= 0 && n.p.v <= 127 && Number.isInteger(n.p.v) ? ` = ${noteName(n.p.v)}` : ''}`; return { out: Val.all(n.p.v) }; },
  },
  voice: {
    title: 'Voice', group: 'Sound', inputs: [inp('trig', 'event', 'play'), inp('note', 'value'), inp('vel', 'value', 'loudness'), inp('pan', 'value')],
    outputs: [out('audio', 'audio')],
    params: [sel('sound', 'sound', 'bell', SOUNDS), sel('mode', 'mode', 'notes', [['notes', 'notes'], ['drone', 'held']]),
      num('attack', 'attack', 0.01, { unit: 's', step: 0.01, min: 0 }), num('release', 'release', 1.5, { unit: 's', step: 0.1, min: 0.05 }),
      num('vol', 'volume', 0.8, { step: 0.05, min: 0, max: 2 }), num('poly', 'voices', 12, { step: 1, min: 1, max: 48 }),
      num('strum', 'strum', 0, { unit: 'ms', step: 10, min: 0, hint: 'spreads a chord from Every' })],
    doc: 'An instrument with one voice per aircraft. In notes mode it plays when "play" fires. In held mode every aircraft holds its own note and slides with it, no trigger needed.',
    src: 'Loudness is 0 to 1, pan −1 to 1, note is a MIDI number. Max voices is the polyphony ceiling; when held, the loudest are kept.',
    init: () => ({ last: new Map(), ends: [], drones: new Map(), dropped: 0 }),
    reset(n) { stopDrones(n, 0.05); },
    tick(n, i, c) {
      const p = n.p, st = n.st;
      if (i.note && i.note.per) for (const [id, x] of i.note.per) if (x != null) st.last.set(id, x);
      const xs = Val.list(i.note), bad = xs.find((x) => x < 0 || x > 127);
      if (!i.note) n.warn = 'no note: connect a Scale or a Number';
      else if (bad !== undefined) n.warn = `${fmt(bad)} is not a note (0–127): put a Scale or a Map in front`;
      else if (p.mode === 'notes' && !i.trig) n.warn = 'nothing plays it: connect an event to play';
      if (!n.reaches) n.warn = (n.warn ? n.warn + '; ' : '') + 'not connected to Output';
      if (p.mode === 'drone') { n.readout = `${st.drones.size} held`; if (!c.preview && AC && n.audio) updateDrones(n, i, c); return {}; }
      if (st.drones.size) stopDrones(n, 0.3);
      st.ends = st.ends.filter((t) => t > c.w0);
      if (!c.preview && AC && n.audio && i.trig && i.trig.length) {
        const A = Math.max(0.002, p.attack), R = Math.max(0.05, p.release);
        for (const e of i.trig) {
          let ids;
          if (e.id === '*') {
            ids = i.note && i.note.per ? [...i.note.per.keys()] : ['*'];
            if (ids.length > p.poly) ids = ids.map((id) => [id, Val.get(i.vel, id) ?? 0.8]).sort((a, b) => b[1] - a[1]).slice(0, p.poly).map((x) => x[0]);
          } else ids = [e.id];
          ids.forEach((id, k) => {
            const m = id === '*' ? Val.scalar(i.note) : (Val.get(i.note, id) ?? st.last.get(id));
            if (m == null || !isFinite(m) || m < 0 || m > 127) return;
            const live = st.ends.filter((t) => t > e.at).length;
            if (live >= p.poly) { st.dropped++; return; }
            const at = Math.max(e.at + k * p.strum / 1000, AC.currentTime + 0.005);
            playNote(n.audio.bus, p.sound, m, Val.get(i.vel, id) ?? 0.8, Val.get(i.pan, id) ?? 0, at, A, R);
            midiNote(n.id, clamp(Math.round(m), 0, 127), Val.get(i.vel, id) ?? 0.8, Val.get(i.pan, id) ?? 0, at, A + R);
            st.ends.push(at + A + R * 1.6);
            if (id !== '*') LIT.push({ id, at, kind: n.id });
          });
        }
      }
      n.readout = `${st.ends.filter((t) => t > c.w0).length} sounding${st.dropped ? ` · ${st.dropped} dropped at the ceiling` : ''}`;
      return {};
    },
  },
  filter: {
    title: 'Filter', group: 'Effects', inputs: [inp('in', 'audio'), inp('cutoff', 'value', 'cutoff Hz')], outputs: [out('out', 'audio')],
    params: [sel('type', 'type', 'lowpass', [['lowpass', 'low-pass', 'LP'], ['highpass', 'high-pass', 'HP'], ['bandpass', 'band-pass', 'BP']]),
      num('freq', 'cutoff', 1800, { unit: 'Hz', step: 100, min: 20 }), num('q', 'resonance', 1, { step: 0.5, min: 0.1 })],
    doc: 'Shapes the tone. Plug a value into cutoff to let the sky open and close it: more traffic, brighter sound.',
    src: 'A value per aircraft is averaged, since a filter has one cutoff.',
    build(n) { const f = AC.createBiquadFilter(); return { in: f, out: f, f }; },
    apply(n) { const a = n.audio; if (!a) return; a.f.type = n.p.type; a.f.Q.value = n.p.q; if (!n.cutoffDriven) a.f.frequency.value = n.p.freq; },
    tick(n, i, c) {
      const v = Val.scalar(i.cutoff);
      n.cutoffDriven = v != null;
      const hz = clamp(v ?? n.p.freq, 20, 20000);
      if (n.audio && !c.preview) n.audio.f.frequency.setTargetAtTime(hz, Math.max(c.w0, AC.currentTime), 0.15);
      n.readout = `cutoff ${fmt(hz)} Hz${v != null ? ' from the sky' : ''}`;
      if (!n.reaches) n.warn = 'not connected to Output';
      return {};
    },
  },
  delay: {
    title: 'Echo', group: 'Effects', inputs: [inp('in', 'audio')], outputs: [out('out', 'audio')],
    params: [num('beats', 'time', 0.75, { unit: 'beats', step: 0.25, min: 0.05 }), num('fb', 'feedback', 0.35, { step: 0.05, min: 0, max: 0.92 }), num('mix', 'mix', 0.3, { step: 0.05, min: 0, max: 1 })],
    doc: 'A tempo-synced echo.', src: 'Three quarters of a beat gives a dotted-eighth echo.',
    build() {
      const i = AC.createGain(), o = AC.createGain(), d = AC.createDelay(4), fb = AC.createGain(), wet = AC.createGain(), dry = AC.createGain();
      i.connect(dry); dry.connect(o); i.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(o);
      return { in: i, out: o, d, fb, wet, dry };
    },
    apply(n) { const a = n.audio; if (!a) return; a.d.delayTime.value = clamp(n.p.beats * 60 / TP.bpm, 0.01, 4); a.fb.gain.value = n.p.fb; a.wet.gain.value = n.p.mix; a.dry.gain.value = 1 - n.p.mix * 0.5; },
    tick(n) { if (!n.reaches) n.warn = 'not connected to Output'; n.readout = `${fmt(n.p.beats * 60 / TP.bpm)} s`; return {}; },
  },
  reverb: {
    title: 'Reverb', group: 'Effects', inputs: [inp('in', 'audio')], outputs: [out('out', 'audio')],
    params: [num('size', 'size', 3, { unit: 's', step: 0.5, min: 0.2, max: 10 }), num('mix', 'mix', 0.35, { step: 0.05, min: 0, max: 1 })],
    doc: 'Puts the sound in a room. Large and wet for the drone; small for detail.', src: 'A generated impulse response.',
    build(n) {
      const i = AC.createGain(), o = AC.createGain(), cv = AC.createConvolver(), wet = AC.createGain(), dry = AC.createGain();
      i.connect(dry); dry.connect(o); i.connect(cv); cv.connect(wet); wet.connect(o);
      return { in: i, out: o, cv, wet, dry, size: null };
    },
    apply(n) {
      const a = n.audio; if (!a) return;
      if (a.size !== n.p.size) { a.size = n.p.size; a.cv.buffer = makeIR(clamp(n.p.size, 0.2, 10)); }
      a.wet.gain.value = n.p.mix; a.dry.gain.value = 1 - n.p.mix * 0.6;
    },
    tick(n) { if (!n.reaches) n.warn = 'not connected to Output'; return {}; },
  },
  gain: {
    title: 'Level', group: 'Effects', inputs: [inp('in', 'audio'), inp('level', 'value')], outputs: [out('out', 'audio')],
    params: [num('g', 'gain', 1, { step: 0.05, min: 0, max: 4 })],
    doc: 'Turns the sound up or down. Plug a value into level to let the sky ride the fader.', src: 'The level input multiplies the gain.',
    build() { const g = AC.createGain(); return { in: g, out: g, g }; },
    apply(n) { if (n.audio && !n.levelDriven) n.audio.g.gain.value = n.p.g; },
    tick(n, i, c) {
      const v = Val.scalar(i.level); n.levelDriven = v != null;
      const g = clamp(n.p.g * (v ?? 1), 0, 8);
      if (n.audio && !c.preview) n.audio.g.gain.setTargetAtTime(g, Math.max(c.w0, AC.currentTime), 0.1);
      n.readout = `× ${fmt(g)}`;
      if (!n.reaches) n.warn = 'not connected to Output';
      return {};
    },
  },
  output: {
    title: 'Output', group: 'Effects', inputs: [inp('in', 'audio', 'mix')],
    params: [num('vol', 'volume', 0.8, { step: 0.05, min: 0, max: 1.5 })],
    doc: 'The speakers, and what Record captures. Everything that should be heard ends here.', src: 'A gentle limiter keeps a busy sky from clipping.',
    build() {
      const i = AC.createGain(), comp = AC.createDynamicsCompressor(), an = AC.createAnalyser(), rec = AC.createMediaStreamDestination();
      comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.25;
      an.fftSize = 1024;
      i.connect(comp); comp.connect(AC.destination); comp.connect(an); comp.connect(rec);
      return { in: i, out: null, an, rec, buf: new Float32Array(1024) };
    },
    apply(n) { if (n.audio) n.audio.in.gain.value = n.p.vol; },
    tick(n, i, c) { return {}; },
  },
};

function buildAudio(n) {
  if (!AC || n.audio) return;
  const T = TYPES[n.type];
  if (T.build) n.audio = T.build(n);
  else if (n.type === 'voice') { const bus = AC.createGain(); n.audio = { in: null, out: bus, bus }; }
  applyParams(n);
}
function applyParams(n) {
  const T = TYPES[n.type];
  if (n.type === 'voice' && n.audio) n.audio.bus.gain.value = n.p.vol;
  if (T.apply) T.apply(n);
}
function stopDrones(n, t) {
  if (!n.st || !n.st.drones) return;
  for (const [id, d] of n.st.drones) {
    midiOff(n.id, id, AC.currentTime);
    try { d.env.gain.cancelScheduledValues(AC.currentTime); d.env.gain.setTargetAtTime(0, AC.currentTime, t / 3); d.src.stop(AC.currentTime + t * 2 + 0.05); } catch (e) { /* already stopped */ }
  }
  n.st.drones.clear();
}
function updateDrones(n, i, c) {
  const p = n.p, st = n.st;
  let ids = i.note && i.note.per ? [...i.note.per.keys()].filter((id) => i.note.per.get(id) != null) : i.note && i.note.all != null ? ['*'] : [];
  if (ids.length > p.poly) ids = ids.map((id) => [id, Val.get(i.vel, id) ?? 0.8]).sort((a, b) => b[1] - a[1]).slice(0, p.poly).map((x) => x[0]);
  const keep = new Set(ids), t0 = Math.max(c.w0, AC.currentTime);
  const level = 0.22 / Math.sqrt(Math.max(1, ids.length));
  for (const id of ids) {
    const m = id === '*' ? Val.scalar(i.note) : Val.get(i.note, id);
    if (m == null || m < 0 || m > 127) continue;
    let d = st.drones.get(id);
    if (!d) { d = startDrone(n.audio.bus, p.sound); st.drones.set(id, d); }
    const mn = clamp(Math.round(m), 0, 127);
    d.mv = clamp(Val.get(i.vel, id) ?? 0.8, 0, 1); d.mp = clamp(Val.get(i.pan, id) ?? 0, -1, 1);
    if (d.mn !== mn) { if (d.mn != null) midiOff(n.id, id, t0); midiOn(n.id, id, mn, d.mv, d.mp, t0); d.mn = mn; }
    const f = mtof(m);
    if (d.first) { d.freqParam.setValueAtTime(f, t0); d.first = false; } else d.freqParam.setTargetAtTime(f, t0, Math.max(0.05, p.attack / 2));
    d.env.gain.setTargetAtTime(clamp(Val.get(i.vel, id) ?? 0.8, 0, 1) * level * (d.noise ? 3 : 1), t0, Math.max(0.05, p.attack / 2));
    d.pn.pan.setTargetAtTime(clamp(Val.get(i.pan, id) ?? 0, -1, 1), t0, 0.3);
    if (id !== '*' && Math.random() < 0.02) LIT.push({ id, at: t0, kind: n.id });
  }
  for (const [id, d] of st.drones) {
    if (keep.has(id)) continue;
    midiOff(n.id, id, t0);
    d.env.gain.cancelScheduledValues(t0); d.env.gain.setTargetAtTime(0, t0, p.release / 3); d.src.stop(t0 + p.release * 1.5 + 0.1);
    st.drones.delete(id);
  }
}

// ---------------------------------------------------------------- the patch
let P = { nodes: [], wires: [] };
let VIEW = { x: 40, y: 30, z: 0.85 };
let SEL = null;      // {node: id} or {wire: index}
let ORDER = [];
let nextId = 1;
const byId = (id) => P.nodes.find((n) => n.id === id);
const portSpec = (n, io, name) => (TYPES[n.type][io === 'in' ? 'inputs' : 'outputs'] || []).find((p) => p.name === name);

function defaults(type) {
  const o = {};
  for (const q of TYPES[type].params || []) o[q.k] = q.def;
  return o;
}
function addNode(type, x, y, p = {}, id = null) {
  const n = { id: id || 'n' + nextId++, type, x, y, p: { ...defaults(type), ...p }, out: {}, readout: '', warn: '' };
  n.st = TYPES[type].init ? TYPES[type].init() : {};
  P.nodes.push(n);
  buildAudio(n);
  renderNode(n);
  return n;
}
function removeNode(id) {
  const n = byId(id); if (!n) return;
  if (TYPES[n.type].reset) TYPES[n.type].reset(n);
  if (n.audio) { try { n.audio.out && n.audio.out.disconnect(); } catch (e) { /* not connected */ } }
  P.wires = P.wires.filter((w) => w.a[0] !== id && w.b[0] !== id);
  P.nodes = P.nodes.filter((x) => x !== n);
  n.el.remove();
  if (SEL && SEL.node === id) select(null);
  changed();
}
function reaches(fromId, toId) {
  const seen = new Set([fromId]), q = [fromId];
  while (q.length) {
    const id = q.shift();
    if (id === toId) return true;
    for (const w of P.wires) if (w.a[0] === id && !seen.has(w.b[0])) { seen.add(w.b[0]); q.push(w.b[0]); }
  }
  return false;
}

// What to put between two ports of different kinds. The idea of suggesting an adapter follows patch.py; the blocks and kinds differ.
const BRIDGES = {
  'traffic>value': { type: 'read', why: 'An aircraft cable carries whole aircraft; a value is one number each.', label: 'Insert Read' },
  'traffic>event': { type: 'sweep', why: 'Aircraft are not moments. Something has to decide when each one plays.', label: 'Insert Radar sweep' },
  'value>event': { type: 'threshold', why: 'A value is continuous and an event is a moment.', label: 'Insert Threshold' },
  'event>value': { why: 'An event is a moment and carries no number. Take the number from Read, and use the event to play.' },
  'value>traffic': { why: 'A number cannot become aircraft. Feed this input from Sky or a Select.' },
  'event>traffic': { why: 'An event cannot become aircraft. Feed this input from Sky or a Select.' },
  'value>audio': { why: 'A value is not a sound yet. Route it into a Voice: its note, loudness or pan.' },
  'event>audio': { why: 'An event is not a sound yet. Use it to play a Voice.' },
  'traffic>audio': { why: 'Aircraft are not a sound yet. Read a field, scale it to a note, and play it with a Voice.' },
  'audio>value': { why: 'Audio only goes into effects and Output.' },
  'audio>event': { why: 'Audio only goes into effects and Output.' },
  'audio>traffic': { why: 'Audio only goes into effects and Output.' },
};

function connect(a, b, quiet) {
  // a = [nodeId, outPort], b = [nodeId, inPort]
  const na = byId(a[0]), nb = byId(b[0]);
  if (!na || !nb || na === nb) return false;
  const ka = portSpec(na, 'out', a[1]).kind, kb = portSpec(nb, 'in', b[1]).kind;
  if (ka !== kb) {
    const br = BRIDGES[`${ka}>${kb}`];
    if (!quiet) toast(`${cap(ka)} cannot plug into ${kb}. ${br.why}`, br.type ? br.label : null, br.type ? () => insertBridge(a, b, br.type) : null);
    return false;
  }
  if (reaches(b[0], a[0])) { if (!quiet) toast('That would loop back on itself, and feedback is not supported.'); return false; }
  if (P.wires.some((w) => w.a[0] === a[0] && w.a[1] === a[1] && w.b[0] === b[0] && w.b[1] === b[1])) return false;
  let replaced = false;
  if (kb !== 'audio') {
    const before = P.wires.length;
    P.wires = P.wires.filter((w) => !(w.b[0] === b[0] && w.b[1] === b[1]));
    replaced = P.wires.length < before;
  }
  P.wires.push({ a: [...a], b: [...b] });
  if (replaced && !quiet) toast(`Replaced the old cable. ${portSpec(nb, 'in', b[1]).label} takes one source, so two can never fight over it.`);
  if (!quiet) changed();
  return true;
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
function insertBridge(a, b, type) {
  const na = byId(a[0]), nb = byId(b[0]);
  const n = addNode(type, 0, 0);
  placeFree(n, [(na.x + nb.x) / 2 + 104, (na.y + nb.y) / 2 + 120]);
  const T = TYPES[type];
  const ka = portSpec(na, 'out', a[1]).kind, kb = portSpec(nb, 'in', b[1]).kind;
  const ip = T.inputs.find((p) => p.kind === ka), op = T.outputs.find((p) => p.kind === kb);
  connect(a, [n.id, ip.name], true); connect([n.id, op.name], b, true);
  hideToast(); changed(); select({ node: n.id });
}

function changed() {
  // topological order over all cables; audio cables carry no per-tick data but still order nothing wrong
  const indeg = new Map(P.nodes.map((n) => [n.id, 0]));
  for (const w of P.wires) indeg.set(w.b[0], indeg.get(w.b[0]) + 1);
  const q = P.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id), o = [];
  while (q.length) {
    const id = q.shift(); o.push(byId(id));
    for (const w of P.wires) if (w.a[0] === id) { indeg.set(w.b[0], indeg.get(w.b[0]) - 1); if (indeg.get(w.b[0]) === 0) q.push(w.b[0]); }
  }
  ORDER = o;
  // which blocks feed Output
  const outIds = P.nodes.filter((n) => n.type === 'output').map((n) => n.id);
  const live = new Set(outIds), stack = [...outIds];
  while (stack.length) { const id = stack.pop(); for (const w of P.wires) if (w.b[0] === id && !live.has(w.a[0])) { live.add(w.a[0]); stack.push(w.a[0]); } }
  for (const n of P.nodes) n.reaches = live.has(n.id);
  BEAMS = P.nodes.filter((n) => n.type === 'sweep');
  rewire();
  drawWires();
  markPorts();
  save();
}
function rewire() {
  if (!AC) return;
  for (const n of P.nodes) if (n.audio && n.audio.out) { try { n.audio.out.disconnect(); } catch (e) { /* none */ } }
  for (const w of P.wires) {
    const na = byId(w.a[0]), nb = byId(w.b[0]);
    if (portSpec(na, 'out', w.a[1]).kind !== 'audio' || !na.audio || !nb.audio || !nb.audio.in) continue;
    na.audio.out.connect(nb.audio.in);
  }
}

// ---------------------------------------------------------------- evaluation
let SKY = [];
function evaluate(c) {
  c.sky = SKY = skyAt(c.dataT);
  for (const n of ORDER) {
    const T = TYPES[n.type], ins = {};
    for (const w of P.wires) if (w.b[0] === n.id) { const src = byId(w.a[0]); if (src.out) ins[w.b[1]] = src.out[w.a[1]]; }
    n.warn = '';
    try { n.out = T.tick(n, ins, c) || {}; } catch (e) { n.out = {}; n.warn = 'error: ' + e.message; console.error(e); }
    for (const p of T.outputs || []) if (p.kind === 'event' && n.out[p.name] && n.out[p.name].length) (n.evLast = n.evLast || {})[p.name] = performance.now();
  }
}
function resetStates() {
  for (const n of P.nodes) {
    const T = TYPES[n.type];
    if (T.reset) T.reset(n);
    n.st = T.init ? T.init() : {};
    n.evLast = {};
  }
  LIT = [];
}
let schedTimer = null, previewTimer = null;
const LOOKAHEAD = 0.12;
function schedule() {
  const until = AC.currentTime + LOOKAHEAD;
  if (TP.w1 >= until) return;
  const w0 = TP.w1, w1 = until;
  let dataT = dataAt(w1);
  if (dataT > CAP.span) { // loop the capture
    TP.dAnchor = { at: w1, d: 0 }; dataT = 0; resetStates();
  }
  TP.dataT = dataT;
  evaluate({ w0, w1, b0: beatAt(w0), b1: beatAt(w1), dataT, preview: false });
  TP.w1 = w1;
}
function play() {
  ensureAudio();
  AC.resume();
  resetStates();
  const t = AC.currentTime + 0.06;
  TP.w1 = t; TP.dAnchor = { at: t, d: TP.dataT }; TP.bAnchor = { at: t, b: 0 };
  TP.playing = true;
  clearInterval(previewTimer);
  schedTimer = setInterval(schedule, 25);
  $('#play').textContent = '■'; $('#play').setAttribute('aria-pressed', 'true'); $('#play').setAttribute('aria-label', 'Stop');
}
function stop() {
  TP.playing = false;
  clearInterval(schedTimer);
  TP.dataT = clamp(dataAt(AC.currentTime), 0, CAP.span);
  for (const n of P.nodes) if (n.type === 'voice') stopDrones(n, 0.4);
  if (RECORDER) toggleRecord();
  $('#play').textContent = '▶'; $('#play').setAttribute('aria-pressed', 'false'); $('#play').setAttribute('aria-label', 'Play');
  startPreview();
}
function startPreview() {
  clearInterval(previewTimer);
  const run = () => { const t = AC ? AC.currentTime : performance.now() / 1000; evaluate({ w0: t, w1: t + 0.4, b0: 0, b1: 0, dataT: TP.dataT, preview: true }); };
  run();
  previewTimer = setInterval(run, 400);
}
function seek(d) {
  if (TP.playing) { TP.dAnchor = { at: TP.w1, d }; resetStates(); } else { TP.dataT = d; }
}

// ---------------------------------------------------------------- recording
let RECORDER = null, TAKES = 0;
const DL = { save: async ({ filename, data }) => { const a = document.createElement('a'); a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data])); a.download = filename; a.click(); } };
function toggleRecord() {
  const outN = P.nodes.find((n) => n.type === 'output');
  if (!RECORDER) {
    if (!TP.playing) { toast('Press Play first. Record captures what is coming out of Output.'); return; }
    if (!outN || !outN.audio) { toast('Add an Output block first.'); return; }
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mime = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mime) { toast('This browser cannot record audio.'); return; }
    const chunks = [], t0 = performance.now();
    const rec = new MediaRecorder(outN.audio.rec.stream, { mimeType: mime });
    RECORDER = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => addTake(new Blob(chunks, { type: mime }), mime, (performance.now() - t0) / 1000, rec.midi);
    rec.start(500);
    startMidi();
    $('#rec').setAttribute('aria-pressed', 'true');
  } else {
    RECORDER.midi = finishMidi();
    RECORDER.stop(); RECORDER = null;
    $('#rec').setAttribute('aria-pressed', 'false');
  }
}
function addTake(blob, mime, secs, midi) {
  TAKES++; $('#takecount').textContent = TAKES;
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const box = $('#takes'); const empty = box.querySelector('.empty'); if (empty) empty.remove();
  const div = document.createElement('div'); div.className = 'take';
  const name = `sky-take-${TAKES}.${ext}`;
  div.innerHTML = `<span>Take ${TAKES} · ${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}</span>`;
  const saver = (label, filename, data) => {
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; b.hidden = !DL;
    b.onclick = async () => { try { await DL.save({ filename, data }); toast(`Saved ${filename}.`); } catch (e) { if (e && e.code !== 'declined') toast('Saving is not available here.'); } };
    return b;
  };
  const acts = document.createElement('span'); acts.className = 'acts';
  acts.append(saver('Audio', name, blob));
  if (midi) acts.append(saver('MIDI', `sky-take-${TAKES}.mid`, new Blob([midi], { type: 'audio/midi' })));
  const au = document.createElement('audio'); au.controls = true; au.src = URL.createObjectURL(blob);
  // Chrome writes no length into MediaRecorder files, so the player shows 0:00 and cannot seek until it is made to find the end
  au.addEventListener('loadedmetadata', () => {
    if (au.duration !== Infinity) return;
    au.currentTime = 1e101;
    au.addEventListener('timeupdate', () => { au.currentTime = 0; }, { once: true });
  });
  div.append(acts, au); box.prepend(div);
  const drawer = box.closest('details'); if (drawer) { drawer.open = true; div.scrollIntoView({ block: 'nearest' }); }
}

// ---------------------------------------------------------------- a MIDI take
// While recording, every note a Voice plays is also kept as a note event, so the take comes with a Standard MIDI File:
// one track per Voice on its own channel, a General MIDI program picked from its sound, pan as CC 10, tempo from the clock.
let MIDIREC = null;
const GM_PROGRAM = { bell: 14, pluck: 24, sine: 88, triangle: 73, sawtooth: 81, square: 80, noise: 122 };
const GM_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]; // channel 10 (index 9) is General MIDI percussion
const midiVel = (v) => clamp(Math.round(1 + clamp(v, 0, 1) * 126), 1, 127);
function midiNode(nodeId) {
  if (!MIDIREC.prog.has(nodeId)) MIDIREC.prog.set(nodeId, GM_PROGRAM[byId(nodeId)?.p.sound] ?? 0);
}
function midiOn(nodeId, key, note, vel, pan, at) {
  if (!MIDIREC) return;
  midiNode(nodeId);
  MIDIREC.ev.push({ at, on: true, node: nodeId, note, vel: midiVel(vel), pan });
  MIDIREC.open.set(`${nodeId}|${key}`, note);
}
function midiOff(nodeId, key, at) {
  if (!MIDIREC) return;
  const k = `${nodeId}|${key}`, note = MIDIREC.open.get(k);
  if (note === undefined) return;
  MIDIREC.open.delete(k);
  MIDIREC.ev.push({ at, on: false, node: nodeId, note });
}
function midiNote(nodeId, note, vel, pan, at, dur) {
  if (!MIDIREC) return;
  midiNode(nodeId);
  MIDIREC.ev.push({ at, on: true, node: nodeId, note, vel: midiVel(vel), pan }, { at: at + dur, on: false, node: nodeId, note });
}
function startMidi() {
  MIDIREC = { t0: AC.currentTime, bpm: TP.bpm, bpb: TP.bpb, ev: [], open: new Map(), prog: new Map() };
  for (const n of P.nodes) {
    if (n.type !== 'voice' || !n.st || !n.st.drones) continue;
    for (const [id, d] of n.st.drones) if (d.mn != null) midiOn(n.id, id, d.mn, d.mv ?? 0.8, d.mp ?? 0, MIDIREC.t0);
  }
}
function finishMidi() {
  const r = MIDIREC; MIDIREC = null;
  if (!r || !AC) return null;
  return buildMidi(r, AC.currentTime);
}
function buildMidi(r, end) {
  const PPQ = 480, tick = (sec) => Math.round((clamp(sec, r.t0, end) - r.t0) * r.bpm / 60 * PPQ);
  const vlq = (v) => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); return b; };
  const be = (v, k) => Array.from({ length: k }, (_, i) => (v >> (8 * (k - 1 - i))) & 0xff);
  const meta = (type, bytes) => [0xff, type, ...vlq(bytes.length), ...bytes];
  const ascii = (str) => [...str].map((c) => c.charCodeAt(0) & 0x7f);
  const chunk = (events) => {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const body = []; let last = 0;
    for (const e of events) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(0, 0xff, 0x2f, 0);
    return [0x4d, 0x54, 0x72, 0x6b, ...be(body.length, 4), ...body];
  };
  // pair each note-off with the oldest open note-on of the same pitch on the same Voice; whatever is still open ends with the take
  const perNode = new Map();
  for (const e of r.ev.slice().sort((a, b) => a.at - b.at || Number(a.on) - Number(b.on))) {
    const t = perNode.get(e.node) || perNode.set(e.node, { notes: [], open: new Map() }).get(e.node);
    if (e.on) { const o = { start: e.at, end: null, note: e.note, vel: e.vel, pan: e.pan }; t.notes.push(o); (t.open.get(e.note) || t.open.set(e.note, []).get(e.note)).push(o); }
    else { const q = t.open.get(e.note); if (q && q.length) q.shift().end = e.at; }
  }
  const conductor = [
    { tick: 0, order: 0, bytes: meta(0x03, ascii('pitchaxis sky take')) },
    { tick: 0, order: 1, bytes: meta(0x51, be(Math.round(60e6 / r.bpm), 3)) },
    { tick: 0, order: 2, bytes: meta(0x58, [r.bpb, 2, 24, 8]) },
  ];
  const tracks = [chunk(conductor)];
  let k = 0, count = 0;
  for (const [nodeId, t] of perNode) {
    const ch = GM_CHANNELS[k++ % GM_CHANNELS.length], ev = [];
    ev.push({ tick: 0, order: 0, bytes: meta(0x03, ascii(`Voice ${nodeId}`)) }, { tick: 0, order: 1, bytes: [0xc0 | ch, r.prog.get(nodeId) ?? 0] });
    let pan = null;
    for (const n of t.notes) {
      const s0 = tick(n.start), s1 = tick(n.end ?? end);
      if (n.start >= end || s1 <= s0) continue;
      const cc = Math.round((clamp(n.pan || 0, -1, 1) + 1) / 2 * 127);
      if (cc !== pan) { ev.push({ tick: s0, order: 1, bytes: [0xb0 | ch, 10, cc] }); pan = cc; }
      ev.push({ tick: s0, order: 2, bytes: [0x90 | ch, n.note, n.vel] }, { tick: s1, order: 0, bytes: [0x80 | ch, n.note, 0] });
      count++;
    }
    tracks.push(chunk(ev));
  }
  if (!count) return null;
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...be(6, 4), ...be(1, 2), ...be(tracks.length, 2), ...be(PPQ, 2), ...tracks.flat()]);
}

// ---------------------------------------------------------------- the editor
const world = $('#world'), svg = $('#wires'), canvas = $('#canvas');
const SVG_PAD = 5000; // the cable layer is a large box so hit-testing works anywhere on the canvas
// How a parameter is touched is decided by its shape, never per block:
//   enum of <=4 short options -> segmented, else pick; bounded number with <=7 steps -> stepper,
//   bounded with more -> knob; unbounded -> scrub. Every one keeps a real <input>/<select data-k> as the source of truth.
const segChars = (q) => q.opts.reduce((s, o) => s + (o[2] || o[1]).length, 0);
function ctlKind(q) {
  if (q.type === 'sel') return q.opts.length <= 4 && segChars(q) <= 20 ? 'seg' : 'pick';
  if (q.min != null && q.max != null) return (q.max - q.min) / (q.step || 1) <= 7 ? 'step' : 'knob';
  return 'scrub';
}
const decimals = (s) => { const t = String(+(+s).toFixed(4)), i = t.indexOf('.'); return i < 0 ? 0 : t.length - i - 1; };
const fmtCtl = (v, dec) => { const d = Math.max(dec, decimals(v)); return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
const KNOB_A0 = 135, KNOB_SWEEP = 270; // 7:30 to 4:30, the way a hardware pot sweeps
const knobXY = (r, a) => [14 + r * Math.cos(a * Math.PI / 180), 14 + r * Math.sin(a * Math.PI / 180)];
function knobArc(a0, a1) {
  const [x0, y0] = knobXY(11, a0), [x1, y1] = knobXY(11, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A11 11 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const isLog = (q) => q.min > 0 && q.max / q.min >= 20; // a log taper only where the range spans decades
const knobT = (q, v) => clamp(isLog(q) ? Math.log(Math.max(v, q.min) / q.min) / Math.log(q.max / q.min) : (v - q.min) / (q.max - q.min), 0, 1);
const knobV = (q, t) => (isLog(q) ? q.min * Math.pow(q.max / q.min, t) : q.min + t * (q.max - q.min));
function paramHtml(n, q, wide) {
  const id = `p-${n.id}-${q.k}`, v = n.p[q.k], kind = ctlKind(q);
  const title = q.hint ? ` title="${esc(q.hint)}"` : '';
  if (q.type === 'sel') {
    const sl = `<select class="ed" id="${id}" data-k="${q.k}" aria-label="${esc(q.label)}"${kind === 'seg' ? ' hidden' : ''}>${q.opts.map(([val, lab]) => `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
    if (kind === 'seg') return `<div class="seg"${title}><label>${esc(q.label)}</label><div class="cells" role="group" aria-label="${esc(q.label)}">${q.opts.map(([val, lab, sh]) => `<button data-v="${esc(val)}" title="${esc(lab)}">${esc(sh || lab)}</button>`).join('')}</div>${sl}</div>`;
    return `<div class="pick"${title}><label for="${id}">${esc(q.label)}</label><div class="well"><button data-d="-1" aria-label="Previous ${esc(q.label)}">◂</button><span class="v"></span><button data-d="1" aria-label="Next ${esc(q.label)}">▸</button>${sl}</div></div>`;
  }
  const step = q.step || 1, d = [`data-kind="${kind}"`, `data-step="${step}"`, `data-def="${q.def}"`];
  if (q.min != null) d.push(`data-min="${q.min}"`);
  if (q.max != null) d.push(`data-max="${q.max}"`);
  const unit = q.unit ? `<em>${esc(q.unit)}</em>` : '';
  const knob = kind === 'knob' ? `<svg class="knob" viewBox="0 0 28 28" aria-hidden="true"><path class="kt" d="${knobArc(KNOB_A0, KNOB_A0 + KNOB_SWEEP)}"/>${(() => { const a = KNOB_A0 + KNOB_SWEEP * knobT(q, q.def), [x0, y0] = knobXY(12.5, a), [x1, y1] = knobXY(15, a); return `<line class="kd" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`; })()}<path class="ka" d=""/><line class="kp" x1="14" y1="14" x2="14" y2="14"/></svg>` : '';
  const arrows = kind === 'step' ? ['<button data-d="-1" tabindex="-1" aria-label="Decrease">◂</button>', '<button data-d="1" tabindex="-1" aria-label="Increase">▸</button>'] : ['', ''];
  return `<div class="ctl ${kind}${wide ? ' wide' : ''}" ${d.join(' ')} tabindex="0" role="spinbutton" aria-label="${esc(q.label)}"${title}>${arrows[0]}${knob}<div class="tx"><label for="${id}">${esc(q.label)}</label><span class="v"><b></b>${unit}</span></div>${arrows[1]}<input class="ed" id="${id}" data-k="${q.k}" type="number" value="${v}" step="${step}"${q.min != null ? ` min="${q.min}"` : ''}${q.max != null ? ` max="${q.max}"` : ''} tabindex="-1"></div>`;
}
function paramTiles(n, params) {
  const kinds = params.map(ctlKind), wide = params.map(() => false);
  let open = -1; // index of a tile waiting for a partner on its row
  kinds.forEach((k, i) => {
    if (k === 'seg' || k === 'pick') { if (open >= 0) wide[open] = true; open = -1; } else if (open >= 0) open = -1; else open = i;
  });
  if (open >= 0) wide[open] = true;
  return params.map((q, i) => paramHtml(n, q, wide[i])).join('');
}
function renderNode(n) {
  const T = TYPES[n.type];
  const el = document.createElement('div');
  el.className = 'node' + (T.narrow ? ' narrow' : ''); el.dataset.id = n.id;
  el.style.setProperty('--c', `var(${GROUPS[T.group]})`);
  const port = (io, p) => `<div class="pr"><span class="port" data-io="${io}" data-port="${p.name}" data-kind="${p.kind}" title="${esc(p.label)} · ${p.kind}"></span><span>${esc(p.label)}</span></div>`;
  el.innerHTML = `<div class="nh"><span class="nt">${esc(T.title)}</span><button class="nx" aria-label="Delete ${esc(T.title)}" title="Delete">×</button></div>
    <div class="np"><div class="ins">${(T.inputs || []).map((p) => port('in', p)).join('')}</div><div class="outs">${(T.outputs || []).map((p) => port('out', p)).join('')}</div></div>
    <div class="nb">${paramTiles(n, T.params || [])}</div>
    ${n.type === 'output' ? '<div class="mtr"><span class="fill"></span><span class="pk"></span></div>' : ''}
    <div class="nf"><i class="led"></i><span class="ro"></span></div>`;
  n.el = el;
  el.querySelectorAll('.ctl, .seg, .pick').forEach(syncCtl);
  place(n);
  world.appendChild(el);
}
// Put a block in the clear space nearest the middle of the view (or of `near`), so a new block never lands on another.
function placeFree(n, near) {
  // A block's footer can grow by a line or two of warning once it has run, so reserve that slack under every block.
  const slack = 32, w = n.el.offsetWidth, h = n.el.offsetHeight + slack, m = 16, step = 24;
  const others = P.nodes.filter((x) => x !== n).map((x) => ({ x: x.x - m, y: x.y - m, w: x.el.offsetWidth + 2 * m, h: x.el.offsetHeight + slack + 2 * m }));
  const c = canvas.getBoundingClientRect();
  const view = { x0: -VIEW.x / VIEW.z, y0: -VIEW.y / VIEW.z, x1: (c.width - VIEW.x) / VIEW.z, y1: (c.height - VIEW.y) / VIEW.z };
  const [ox, oy] = near || [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2];
  const clear = (x, y) => others.every((r) => x + w <= r.x || x >= r.x + r.w || y + h <= r.y || y >= r.y + r.h);
  const inView = (x, y) => x >= view.x0 && y >= view.y0 && x + w <= view.x1 && y + h <= view.y1;
  const search = (visibleOnly) => {
    for (let k = 0; k <= 60; k++) {
      let best = null;
      for (let i = -k; i <= k; i++) {
        for (let j = -k; j <= k; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== k) continue;
          const x = Math.round(ox - w / 2 + i * step), y = Math.round(oy - h / 2 + j * step);
          if ((!visibleOnly || inView(x, y)) && clear(x, y)) { const d = i * i + j * j; if (!best || d < best.d) best = { x, y, d }; }
        }
      }
      if (best) return best;
    }
    return null;
  };
  const seen = search(true), spot = seen || search(false) || { x: Math.round(ox - w / 2), y: Math.round(oy - h / 2) };
  n.x = spot.x; n.y = spot.y; place(n);
  return !!seen;
}
function reveal(n) {
  const c = canvas.getBoundingClientRect();
  VIEW.x = c.width / 2 - (n.x + n.el.offsetWidth / 2) * VIEW.z; VIEW.y = c.height / 2 - (n.y + n.el.offsetHeight / 2) * VIEW.z;
  applyView(); drawWires();
}
function place(n) { n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; }
function applyView() {
  world.style.transform = `translate(${VIEW.x}px, ${VIEW.y}px) scale(${VIEW.z})`;
  canvas.style.backgroundPosition = `${VIEW.x}px ${VIEW.y}px, ${VIEW.x}px ${VIEW.y}px`;
  canvas.style.backgroundSize = `${120 * VIEW.z}px ${120 * VIEW.z}px, ${24 * VIEW.z}px ${24 * VIEW.z}px`;
}
function portEl(id, io, name) { const n = byId(id); return n && n.el.querySelector(`.port[data-io="${io}"][data-port="${name}"]`); }
function portXY(el) {
  const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
  return [(r.left + r.width / 2 - c.left - VIEW.x) / VIEW.z, (r.top + r.height / 2 - c.top - VIEW.y) / VIEW.z];
}
const curve = (x1, y1, x2, y2) => { const dx = Math.max(56, Math.abs(x2 - x1) * 0.5); return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; };
const CABLE_W = { traffic: 7, value: 2, event: 3.5, audio: 4 };
function drawWires(temp) {
  let h = '';
  P.wires.forEach((w, k) => {
    const ea = portEl(w.a[0], 'out', w.a[1]), eb = portEl(w.b[0], 'in', w.b[1]);
    if (!ea || !eb) return;
    const [x1, y1] = portXY(ea), [x2, y2] = portXY(eb), d = curve(x1, y1, x2, y2);
    const kind = ea.dataset.kind, cw = CABLE_W[kind];
    // each cable is told apart by weight and pattern as well as hue: hollow multicore, thin line, dots, bright-cored audio
    h += SEL && SEL.wire === k ? `<path class="su" stroke-width="${cw + 4}" d="${d}"/>` : `<path class="halo" stroke-width="${cw + 3}" d="${d}"/>`;
    h += `<path class="cab k-${kind}" data-w="${k}" stroke-width="${cw}"${kind === 'event' ? ' stroke-dasharray=".1 8"' : ''} d="${d}"/>`;
    if (kind === 'traffic') h += `<path class="cab core-t" data-w="${k}" stroke-width="3" d="${d}"/>`;
    if (kind === 'audio') h += `<path class="cab core-a" data-w="${k}" stroke-width="1" d="${d}"/>`;
    h += `<path class="hit" data-w="${k}" d="${d}"/>`;
  });
  if (temp) h += `<path class="temp" d="${curve(...temp)}"/>`;
  svg.innerHTML = `<g transform="translate(${SVG_PAD} ${SVG_PAD})">${h}</g>`;
}
function markPorts() {
  document.querySelectorAll('.port.on').forEach((p) => p.classList.remove('on'));
  for (const w of P.wires) { const a = portEl(w.a[0], 'out', w.a[1]), b = portEl(w.b[0], 'in', w.b[1]); a && a.classList.add('on'); b && b.classList.add('on'); }
}
function select(s) {
  SEL = s;
  document.querySelectorAll('.node.sel').forEach((e) => e.classList.remove('sel'));
  document.querySelectorAll('.port.psel').forEach((e) => e.classList.remove('psel'));
  if (s && s.node) byId(s.node)?.el.classList.add('sel');
  if (s && s.port) portEl(s.node, s.port.io, s.port.name)?.classList.add('psel');
  drawWires();
  renderInspector();
  markPalette();
}
// Library cue. A selected jack narrows it to that port: an output marks the blocks that can take it (swatch on the
// right of the chip), an input marks the blocks that can feed it (swatch on the left). With only a block selected it
// marks the blocks that can take any of its outputs. A fit means a direct cable, no adapter.
function markPalette() {
  const pal = $('#palette'), S = SEL && SEL.node ? byId(SEL.node) : null;
  let up = false, kinds = [];
  if (S && SEL.port) { const sp = portSpec(S, SEL.port.io, SEL.port.name); kinds = sp ? [sp.kind] : []; up = SEL.port.io === 'in'; }
  else if (S) kinds = [...new Set((TYPES[S.type].outputs || []).map((p) => p.kind))];
  pal.classList.toggle('cueing', !!S);
  pal.querySelectorAll('.pal').forEach((b) => {
    const T = TYPES[b.dataset.type];
    const fits = kinds.filter((k) => ((up ? T.outputs : T.inputs) || []).some((p) => p.kind === k));
    b.querySelector('.cue').innerHTML = fits.map((k) => `<i style="--c:var(--k-${k})"></i>`).join('');
    b.classList.toggle('fit', fits.length > 0);
    b.classList.toggle('up', fits.length > 0 && up);
    const why = up ? `feeds the selected ${fits.join(' / ')} input` : `takes the selected block's ${fits.join(' / ')}`;
    b.title = fits.length ? `${T.doc} — ${why}` : T.doc;
  });
}
function renderInspector() {
  const box = $('#insp');
  const n = SEL && SEL.node ? byId(SEL.node) : null;
  if (!n) {
    box.innerHTML = `<h2>Inspector</h2><div class="body"><span class="hint">DRAG JACK TO JACK · CLICK A CABLE, DEL</span><span class="hint">DRAG A TILE · TAP TO TYPE · DOUBLE-CLICK RESETS</span><span class="hint">CLICK A BLOCK TO READ IT</span></div>`;
    return;
  }
  const T = TYPES[n.type];
  box.innerHTML = `<h2>Inspector <span>${esc(T.group)}</span></h2><div class="body"><h3>${esc(T.title)}</h3><p>${esc(T.doc)}</p>${T.src ? `<details><summary>Source</summary><p>${esc(T.src)}</p></details>` : ''}</div>`;
}

// palette
(function buildPalette() {
  const pal = $('#palette'), groups = {};
  for (const [type, T] of Object.entries(TYPES)) (groups[T.group] = groups[T.group] || []).push([type, T]);
  for (const [g, items] of Object.entries(groups)) {
    const d = document.createElement('div');
    d.innerHTML = `<h3>${g}</h3><div class="items">${items.map(([type, T]) => `<button class="pal" data-type="${type}" title="${esc(T.doc)}" style="--c:var(${GROUPS[g]})"><span class="pt">${esc(T.title)}</span><span class="cue"></span></button>`).join('')}</div>`;
    pal.appendChild(d);
  }
  pal.addEventListener('click', (e) => {
    const b = e.target.closest('.pal'); if (!b) return;
    const n = addNode(b.dataset.type, 0, 0);
    if (!placeFree(n)) reveal(n); // no clear space in view: bring the new block to the middle
    changed(); select({ node: n.id });
  });
})();

// pointer handling: drag blocks, drag cables, pan the canvas
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.zoom, .toast')) return; // a pan would capture the pointer and swallow the button's click
  const portE = e.target.closest('.port'), head = e.target.closest('.nh'), nodeE = e.target.closest('.node'), hit = e.target.closest('path.hit');
  if (e.target.closest('.nx')) { removeNode(nodeE.dataset.id); return; }
  if (portE) {
    e.preventDefault();
    const id = portE.closest('.node').dataset.id;
    const tap = { id, io: portE.dataset.io, name: portE.dataset.port, x: e.clientX, y: e.clientY }; // a click, not a drag, selects the port
    let from;
    if (portE.dataset.io === 'out') from = [id, portE.dataset.port];
    else {
      // pick up the cable plugged into this input and carry it away
      const k = P.wires.findIndex((w) => w.b[0] === id && w.b[1] === portE.dataset.port);
      if (k < 0) { drag = { kind: 'tap', tap }; canvas.setPointerCapture(e.pointerId); return; }
      from = P.wires[k].a; P.wires.splice(k, 1); changed();
    }
    drag = { kind: 'wire', from, tap, start: portXY(portEl(from[0], 'out', from[1])) };
    document.body.dataset.wk = portEl(from[0], 'out', from[1]).dataset.kind;
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (hit) { select({ wire: +hit.dataset.w }); return; }
  if (head) {
    const n = byId(nodeE.dataset.id);
    select({ node: n.id });
    drag = { kind: 'node', n, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y };
    n.el.classList.add('lift');
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (nodeE) { if (!e.target.closest('input,select,button')) select({ node: nodeE.dataset.id }); return; }
  select(null);
  drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: VIEW.x, oy: VIEW.y };
  canvas.classList.add('panning');
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'node') {
    drag.n.x = Math.round(drag.ox + (e.clientX - drag.sx) / VIEW.z); drag.n.y = Math.round(drag.oy + (e.clientY - drag.sy) / VIEW.z);
    place(drag.n); drawWires();
  } else if (drag.kind === 'pan') {
    VIEW.x = drag.ox + e.clientX - drag.sx; VIEW.y = drag.oy + e.clientY - drag.sy; applyView();
  } else if (drag.kind === 'wire') {
    const c = canvas.getBoundingClientRect();
    const x = (e.clientX - c.left - VIEW.x) / VIEW.z, y = (e.clientY - c.top - VIEW.y) / VIEW.z;
    document.querySelectorAll('.port.hot').forEach((p) => p.classList.remove('hot'));
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const tp = over && over.closest && over.closest('.port[data-io="in"]'); if (tp) tp.classList.add('hot');
    drawWires([...drag.start, x, y]);
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (drag.kind === 'wire') {
    delete document.body.dataset.wk;
    document.querySelectorAll('.port.hot').forEach((p) => p.classList.remove('hot'));
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const tp = over && over.closest && over.closest('.port[data-io="in"]');
    if (tp) connect(drag.from, [tp.closest('.node').dataset.id, tp.dataset.port]);
    drawWires();
  }
  if (drag.kind === 'node') drag.n.el.classList.remove('lift');
  if (drag.kind === 'node' || drag.kind === 'pan') save();
  canvas.classList.remove('panning');
  const tap = drag.tap;
  drag = null;
  if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 4) select({ node: tap.id, port: { io: tap.io, name: tap.name } });
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
  else { VIEW.x -= e.deltaX; VIEW.y -= e.deltaY; applyView(); }
}, { passive: false });
function zoomAt(cx, cy, f) {
  const c = canvas.getBoundingClientRect(), z = clamp(VIEW.z * f, 0.3, 2);
  const px = cx - c.left, py = cy - c.top;
  VIEW.x = px - (px - VIEW.x) * z / VIEW.z; VIEW.y = py - (py - VIEW.y) * z / VIEW.z; VIEW.z = z;
  applyView(); drawWires();
}
function fit() {
  if (!P.nodes.length) return;
  const c = canvas.getBoundingClientRect();
  const xs = P.nodes.map((n) => n.x), ys = P.nodes.map((n) => n.y), xe = P.nodes.map((n) => n.x + n.el.offsetWidth), ye = P.nodes.map((n) => n.y + n.el.offsetHeight);
  const x0 = Math.min(...xs) - 30, y0 = Math.min(...ys) - 30, x1 = Math.max(...xe) + 30, y1 = Math.max(...ye) + 30;
  const z = clamp(Math.min(c.width / (x1 - x0), c.height / (y1 - y0)), 0.7, 1);
  VIEW = { z, x: (c.width - (x1 - x0) * z) / 2 - x0 * z, y: (c.height - (y1 - y0) * z) / 2 - y0 * z };
  applyView(); drawWires();
}
$('#zin').onclick = () => { const c = canvas.getBoundingClientRect(); zoomAt(c.left + c.width / 2, c.top + c.height / 2, 1.2); };
$('#zout').onclick = () => { const c = canvas.getBoundingClientRect(); zoomAt(c.left + c.width / 2, c.top + c.height / 2, 1 / 1.2); };
$('#zfit').onclick = fit;
world.addEventListener('input', onParam);
world.addEventListener('change', onParam);
function onParam(e) {
  const t = e.target; if (!t.dataset.k) return;
  const n = byId(t.closest('.node').dataset.id); if (!n) return;
  const q = TYPES[n.type].params.find((x) => x.k === t.dataset.k);
  if (q.type === 'num') { const v = parseFloat(t.value); if (!isFinite(v)) return; n.p[q.k] = v; } else n.p[q.k] = t.value;
  if (n.type === 'voice' && q.k === 'sound' && n.st.drones) stopDrones(n, 0.2);
  applyParams(n);
  save();
}
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && /^[zy]$/i.test(e.key) && !e.target.closest('input,select,textarea')) {
    e.preventDefault();
    if (e.key.toLowerCase() === 'y' || e.shiftKey) redo(); else undo();
    return;
  }
  if (e.target.closest('input,select,textarea,button,.ctl')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && SEL) {
    e.preventDefault();
    if (SEL.node) { if (!SEL.port) removeNode(SEL.node); }
    else if (SEL.wire != null) { P.wires.splice(SEL.wire, 1); select(null); changed(); }
  }
  if (e.key === ' ' && CAP) { e.preventDefault(); TP.playing ? stop() : play(); }
});

// ---------------------------------------------------------------- touching a parameter
// One gesture for every tile: drag vertically (shift = fine), tap to type, double-click or long-press to reset.
const specOf = (el) => {
  const d = el.dataset;
  return { kind: d.kind, step: +d.step || 1, def: +d.def, min: d.min != null ? +d.min : -Infinity, max: d.max != null ? +d.max : Infinity, dec: decimals(d.step || 1) };
};
function syncCtl(el) {
  const ed = el.querySelector('.ed');
  if (el.classList.contains('ctl')) {
    const s = specOf(el), v = parseFloat(ed.value), ok = isFinite(v);
    el.querySelector('.v b').textContent = ok ? fmtCtl(v, s.dec) : '–';
    if (ok) el.setAttribute('aria-valuenow', v);
    const ka = el.querySelector('.ka');
    if (ka && ok) {
      const a = KNOB_A0 + KNOB_SWEEP * knobT(s, v), [x0, y0] = knobXY(3, a), [x1, y1] = knobXY(8, a), kp = el.querySelector('.kp');
      ka.setAttribute('d', a > KNOB_A0 + 0.5 ? knobArc(KNOB_A0, a) : '');
      kp.setAttribute('x1', x0.toFixed(2)); kp.setAttribute('y1', y0.toFixed(2)); kp.setAttribute('x2', x1.toFixed(2)); kp.setAttribute('y2', y1.toFixed(2));
    }
  } else if (el.classList.contains('seg')) {
    el.querySelectorAll('.cells button[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === ed.value));
  } else if (el.classList.contains('pick') && !el.classList.contains('menu')) {
    el.querySelector('.v').textContent = ed.selectedIndex >= 0 ? ed.options[ed.selectedIndex].text : '';
  }
}
const fire = (ed) => { ed.dispatchEvent(new Event('input', { bubbles: true })); ed.dispatchEvent(new Event('change', { bubbles: true })); };
function setCtl(el, v, warn) {
  const s = specOf(el), ed = el.querySelector('.ed'), c = clamp(v, s.min, s.max);
  if (warn && c !== v) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 300); }
  const q = +c.toFixed(4);
  if (q !== parseFloat(ed.value)) { ed.value = q; fire(ed); }
  syncCtl(el);
}
function resetCtl(el) {
  setCtl(el, specOf(el).def);
  el.classList.add('reset'); setTimeout(() => el.classList.remove('reset'), 250);
}
function openEditor(el) {
  const ed = el.querySelector('.ed');
  el.classList.add('editing'); el._v0 = ed.value;
  ed.focus(); ed.select();
}
function closeEditor(el, commit) {
  if (!el.classList.contains('editing')) return;
  const ed = el.querySelector('.ed'), v = parseFloat(ed.value);
  el.classList.remove('editing');
  if (!commit || !isFinite(v)) { ed.value = el._v0; fire(ed); syncCtl(el); } else setCtl(el, v, true);
}
let cd = null;
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.ctl');
  if (!el || e.button !== 0 || e.target.closest('button') || el.classList.contains('editing')) return;
  cd = { el, s: specOf(el), id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), v0: parseFloat(el.querySelector('.ed').value) || 0, moved: false, reset: false };
  cd.timer = setTimeout(() => { if (cd && !cd.moved) { cd.reset = true; resetCtl(cd.el); } }, 600);
  el.setPointerCapture(e.pointerId);
  el.classList.add('drag');
  el.focus({ preventScroll: true });
  e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
  if (!cd || e.pointerId !== cd.id) return;
  const dy = cd.y0 - e.clientY;
  if (!cd.moved) { if (Math.hypot(e.clientX - cd.x0, dy) < 4) return; cd.moved = true; clearTimeout(cd.timer); }
  const { s, v0 } = cd;
  let v;
  if (s.kind === 'knob') {
    v = knobV(s, clamp(knobT(s, v0) + dy / 140 * (e.shiftKey ? 0.1 : 1), 0, 1)); // 140 px is the whole travel
    v = Math.round(v / s.step) * s.step;
  } else if (e.shiftKey) v = v0 + Math.round(dy / 6) * s.step / 10;
  else { const d = Math.abs(dy); v = v0 + Math.sign(dy) * Math.round(d / 6 * (1 + d / 240)) * s.step; } // 6 px a step, accelerating
  setCtl(cd.el, v);
});
function endCtl(e) {
  if (!cd || e.pointerId !== cd.id) return;
  clearTimeout(cd.timer);
  const { el, moved, reset, t0 } = cd; cd = null;
  el.classList.remove('drag');
  if (e.type === 'pointerup' && !moved && !reset && performance.now() - t0 < 250) openEditor(el);
}
document.addEventListener('pointerup', endCtl);
document.addEventListener('pointercancel', endCtl);
document.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('.ctl')) e.preventDefault(); });
document.addEventListener('dblclick', (e) => {
  const el = e.target.closest && e.target.closest('.ctl');
  if (!el || e.target.closest('button')) return;
  closeEditor(el, false); resetCtl(el);
});
document.addEventListener('focusout', (e) => {
  const el = e.target.closest && e.target.closest('.ctl.editing');
  if (el && e.target.classList.contains('ed')) closeEditor(el, true);
});
document.addEventListener('keydown', (e) => {
  const el = e.target.closest && e.target.closest('.ctl');
  if (!el) return;
  if (el.classList.contains('editing')) {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } else if (e.key === 'Escape') { e.preventDefault(); closeEditor(el, false); el.focus(); }
    return;
  }
  if (e.target !== el) return;
  const s = specOf(el), v = parseFloat(el.querySelector('.ed').value) || 0, f = e.shiftKey ? 0.1 : 1;
  let nv = null;
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nv = v + s.step * f;
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nv = v - s.step * f;
  else if (e.key === 'PageUp') nv = v + s.step * 10;
  else if (e.key === 'PageDown') nv = v - s.step * 10;
  else if (e.key === 'Home' && isFinite(s.min)) nv = s.min;
  else if (e.key === 'End' && isFinite(s.max)) nv = s.max;
  else if (e.key === 'Enter') { e.preventDefault(); openEditor(el); return; }
  if (nv != null) { e.preventDefault(); setCtl(el, nv); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const seg = b.closest('.seg'), pk = b.closest('.pick'), st = b.closest('.ctl.step');
  if (seg && b.dataset.v != null) { const sl = seg.querySelector('select.ed'); sl.value = b.dataset.v; fire(sl); syncCtl(seg); }
  else if (st && b.dataset.d) setCtl(st, (parseFloat(st.querySelector('.ed').value) || 0) + +b.dataset.d * specOf(st).step);
  else if (pk && b.dataset.d) { const sl = pk.querySelector('select.ed'), n = sl.options.length; sl.selectedIndex = (sl.selectedIndex + +b.dataset.d + n) % n; fire(sl); syncCtl(pk); }
});
document.addEventListener('change', (e) => {
  const w = e.target.closest && e.target.closest('.ctl, .seg, .pick');
  if (w && e.target.classList.contains('ed')) syncCtl(w);
});

// toast
let toastTimer = null;
function toast(msg, label, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (label) { const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; b.onclick = fn; t.appendChild(b); }
  t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, label ? 9000 : 5000);
}
function hideToast() { $('#toast').hidden = true; }

// live readouts, a few times a second
// Is there signal on this output right now? Drives the footer LED and dims cables that carry nothing.
function audioLive(n) {
  if (!AC) return false;
  if (n.type === 'voice') return !!(n.st && ((n.st.ends && n.st.ends.some((t) => t > AC.currentTime)) || (n.st.drones && n.st.drones.size)));
  return P.wires.some((w) => w.b[0] === n.id && portSpec(byId(w.a[0]), 'out', w.a[1]).kind === 'audio' && audioLive(byId(w.a[0])));
}
function portLive(n, port) {
  const kind = portSpec(n, 'out', port).kind, o = n.out && n.out[port];
  if (kind === 'audio') return audioLive(n);
  if (kind === 'event') return !!(n.evLast && performance.now() - (n.evLast[port] || -1e9) < 1500);
  if (kind === 'traffic') return Array.isArray(o) && o.length > 0;
  return Val.list(o).length > 0;
}
const nodeLive = (n) => (n.type === 'output' ? audioLive(n) : (TYPES[n.type].outputs || []).some((p) => portLive(n, p.name)));
// -48 dBFS to 0 across the meter
const meterPct = (db) => clamp((db + 48) / 48, 0, 1) * 100;

setInterval(() => {
  for (const n of P.nodes) {
    const nf = n.el.querySelector('.nf');
    let h = esc(n.readout || '');
    if (n.warn) h += `<div class="wn">▲ ${esc(n.warn)}</div>`;
    if (n.type === 'output') {
      let lvl = 0;
      if (n.audio) { n.audio.an.getFloatTimeDomainData(n.audio.buf); let s = 0; for (const x of n.audio.buf) s += x * x; lvl = Math.sqrt(s / n.audio.buf.length); }
      const db = 20 * Math.log10(lvl + 1e-6), pct = TP.playing ? meterPct(db) : 0, pk = n.el.querySelector('.mtr .pk');
      n.peak = Math.max(pct, (n.peak || 0) - 8);
      n.el.querySelector('.mtr .fill').style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
      pk.style.display = n.peak > 1 ? 'block' : 'none'; pk.style.left = `calc(${n.peak}% - 2px)`;
      h += TP.playing ? `${fmt(db)} dBFS` : 'stopped';
    }
    const ro = nf.querySelector('.ro');
    if (ro.innerHTML !== h) ro.innerHTML = h;
    nf.classList.toggle('wrap', !!n.warn);
    nf.querySelector('.led').classList.toggle('on', nodeLive(n));
    n.el.classList.toggle('warn', !!n.warn);
  }
  // cables that carry nothing while playing fall back to a dim tone; paused, every cable shows full colour
  svg.querySelectorAll('path.cab').forEach((p) => {
    const w = P.wires[+p.dataset.w];
    p.classList.toggle('idle', !!(TP.playing && w && !portLive(byId(w.a[0]), w.a[1])));
  });
  if (CAP) {
    const t = TP.playing ? clamp(dataAt(AC.currentTime), 0, CAP.span) : TP.dataT;
    const d = new Date((CAP.meta.t0 + t) * 1000);
    const loc = new Date((CAP.meta.t0 + t + CAP.meta.utc_offset_sec) * 1000);
    $('#clock').textContent = `${loc.toISOString().slice(11, 19)} ${CAP.meta.tz} · ${d.toISOString().slice(11, 16)}Z`;
    $('#clock').title = `${CAP.meta.site || 'receiver'} · ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}Z`;
    if (document.activeElement !== $('#scrub')) $('#scrub').value = Math.round(t);
  }
}, 200);

// ---------------------------------------------------------------- the scope
const scope = $('#scope'), sctx = scope.getContext('2d');
let SCOPE_NM = 60, COLORS = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['--scope', '--line', '--muted', '--ink', '--hair-2', '--ink-3', '--k-traffic', '--k-event', '--k-value', '--accent']) COLORS[k] = cs.getPropertyValue(k).trim();
}
readColors(); setInterval(readColors, 1500);
function setRange(nm) { SCOPE_NM = nm; document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', +b.dataset.nm === nm)); }
scope.addEventListener('click', () => setRange(SCOPE_NM === 60 ? 30 : SCOPE_NM === 30 ? 120 : 60));
$('#range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setRange(+b.dataset.nm); });
setRange(SCOPE_NM);
function drawScope() {
  const W = scope.width, R = W / 2 - 14, cx = W / 2, cy = W / 2;
  sctx.fillStyle = COLORS['--scope']; sctx.fillRect(0, 0, W, W);
  sctx.strokeStyle = COLORS['--hair-2']; sctx.lineWidth = 1.5; sctx.fillStyle = COLORS['--ink-3']; sctx.font = '18px "Chivo Mono", ui-monospace, monospace';
  const ring = SCOPE_NM / 3;
  sctx.setLineDash([2, 7]);
  for (let k = 1; k <= 3; k++) { sctx.beginPath(); sctx.arc(cx, cy, R * k / 3, 0, 7); sctx.stroke(); sctx.fillText(`${Math.round(ring * k)}`, cx + R * k / 3 - (k === 3 ? 44 : 34), cy - 6); }
  sctx.setLineDash([]);
  for (let a = 0; a < 360; a += 30) { const r = a * Math.PI / 180; sctx.beginPath(); sctx.moveTo(cx + Math.sin(r) * R * 0.97, cy - Math.cos(r) * R * 0.97); sctx.lineTo(cx + Math.sin(r) * R, cy - Math.cos(r) * R); sctx.stroke(); }
  sctx.fillText('N', cx - 6, 20);
  const at = AC ? AC.currentTime : 0;
  const T = TP.playing ? clamp(dataAt(at), 0, CAP ? CAP.span : 0) : TP.dataT;
  const sky = CAP ? skyAt(T) : [];
  // beams
  if (TP.playing) for (const b of BEAMS) {
    if (b.p.axis === 'range') {
      const pr = R * TYPES.sweep.radius(b, at) / SCOPE_NM; // a ring past the scope's edge is simply off the glass
      if (pr > R) continue;
      const tw = R * 0.18, lo = b.p.dir === 'ccw' ? pr : Math.max(0, pr - tw), hi = b.p.dir === 'ccw' ? Math.min(R, pr + tw) : pr;
      sctx.save();
      sctx.globalAlpha = 0.12; sctx.fillStyle = COLORS['--k-event'];
      sctx.beginPath(); sctx.arc(cx, cy, hi, 0, 7); sctx.arc(cx, cy, lo, 0, 7, true); sctx.fill();
      sctx.globalAlpha = 0.85; sctx.strokeStyle = COLORS['--k-event']; sctx.lineWidth = 3;
      sctx.beginPath(); sctx.arc(cx, cy, pr, 0, 7); sctx.stroke();
      sctx.restore();
      continue;
    }
    const ang = TYPES.sweep.angle(b, at) * Math.PI / 180;
    sctx.save();
    sctx.strokeStyle = COLORS['--k-event']; sctx.globalAlpha = 0.85; sctx.lineWidth = 3;
    sctx.beginPath(); sctx.moveTo(cx, cy); sctx.lineTo(cx + Math.sin(ang) * R, cy - Math.cos(ang) * R); sctx.stroke();
    sctx.globalAlpha = 0.12; sctx.fillStyle = COLORS['--k-event']; sctx.beginPath(); sctx.moveTo(cx, cy);
    const tail = b.p.dir === 'ccw' ? 0.6 : -0.6;
    sctx.arc(cx, cy, R, ang - Math.PI / 2, ang - Math.PI / 2 + tail, tail < 0); sctx.closePath(); sctx.fill();
    sctx.restore();
  }
  // highlight what the selected block keeps
  let keep = null;
  const sn = SEL && SEL.node ? byId(SEL.node) : null;
  if (sn) {
    const T = TYPES[sn.type], op = (T.outputs || []).find((p) => p.kind === 'traffic');
    let o = op ? sn.out && sn.out[op.name] : null;
    if (!o) { const ip = (T.inputs || []).find((p) => p.kind === 'traffic'); const w = ip && P.wires.find((x) => x.b[0] === sn.id && x.b[1] === ip.name); if (w) o = byId(w.a[0]).out[w.a[1]]; }
    if (Array.isArray(o)) keep = new Set(o.map((a) => a.id));
  }
  LIT = LIT.filter((l) => l.at > at - 2);
  const glow = new Map();
  for (const l of LIT) if (l.at <= at) glow.set(l.id, Math.max(glow.get(l.id) || 0, Math.exp(-(at - l.at) / 0.45)));
  for (const a of sky) {
    if (a.rng > SCOPE_NM) continue;
    const r = a.brg * Math.PI / 180, d = R * a.rng / SCOPE_NM, x = cx + Math.sin(r) * d, y = cy - Math.cos(r) * d;
    const gl = glow.get(a.id) || 0, kept = keep ? keep.has(a.id) : true;
    sctx.globalAlpha = 1;
    if (a.trk != null) { const tr = a.trk * Math.PI / 180, len = 6 + (a.gs || 0) / 40; sctx.strokeStyle = kept ? COLORS['--ink-3'] : COLORS['--hair-2']; sctx.lineWidth = 1.5; sctx.beginPath(); sctx.moveTo(x, y); sctx.lineTo(x + Math.sin(tr) * len, y - Math.cos(tr) * len); sctx.stroke(); }
    if (gl > 0.02) { sctx.fillStyle = COLORS['--k-event']; sctx.globalAlpha = gl * 0.5; sctx.beginPath(); sctx.arc(x, y, 6 + 16 * gl, 0, 7); sctx.fill(); sctx.globalAlpha = 1; }
    sctx.fillStyle = keep ? (kept ? COLORS['--k-traffic'] : COLORS['--hair-2']) : COLORS['--ink'];
    sctx.beginPath(); sctx.arc(x, y, keep && kept ? 5 : 3.5, 0, 7); sctx.fill();
  }
  sctx.globalAlpha = 1;
  const inRange = sky.filter((a) => a.rng <= SCOPE_NM).length, info = $('#scopeinfo');
  if (info.dataset.k !== `${inRange}/${sky.length}/${SCOPE_NM}`) {
    info.dataset.k = `${inRange}/${sky.length}/${SCOPE_NM}`;
    info.textContent = `${inRange} of ${sky.length}`;
    info.title = `${inRange} aircraft within ${SCOPE_NM} NM of the antenna, ${sky.length} in the capture now`;
  }
  requestAnimationFrame(drawScope);
}

// ---------------------------------------------------------------- presets
// Where the duet example opens: a Boeing 737 MAX and a Cessna T206 meet at about 6,000 ft, 14 NM from the antenna, 880 s
// into the first capture; the altitude window keeps the rest of the sky out of their way. A second pair follows at 950 s.
const DUET = { at: 790, select: { rmax: 80, amin: 5000, amax: 7500 } };
// Where the ground example opens: 280 s into the first capture, about nine seconds before the first arrival descends through 4,000 ft.
const GROUND = { at: 280 };
const GROUND_ARMS = ['ground', 'groundclock', 'groundshift', 'groundstrum', 'groundthin', 'groundled', 'groundcast'];
function preset(name) {
  for (const n of [...P.nodes]) removeNode(n.id);
  P = { nodes: [], wires: [] }; nextId = 1;
  const N = (type, x, y, p) => addNode(type, x, y, p).id;
  const W = (a, ap, b, bp) => connect([a, ap], [b, bp], true);
  if (name === 'director') {
    const sky = N('sky', -160, 0), sel = N('select', 0, 0, { rmax: 25 });
    const sw = N('sweep', 236, 0, { bars: 2 }), rd = N('read', 236, 265);
    const q = N('quantize', 472, 0, { grid: '0.25' }), sc = N('scale', 472, 125, { lo: 0, hi: 40000, scale: 'Newark terrain', root: '9', oct: 3, span: 3 });
    const mp = N('map', 472, 365, { lo: 0, hi: 25, olo: 1, ohi: 0.2 }), pn = N('pan', 472, 555);
    const v = N('voice', 708, 0, { sound: 'bell', release: 1.5, vol: 0.8, poly: 24 });
    const ev = N('every', 708, 330, { beats: 8 }), k = N('constant', 708, 475, { v: 33 });
    const rv = N('reverb', 944, 0, { size: 3.5, mix: 0.4 }), o = N('output', 944, 150);
    const v2 = N('voice', 944, 300, { sound: 'triangle', release: 7, attack: 1.5, vol: 0.55, poly: 2 });
    W(sky, 'sky', sel, 'in'); W(sel, 'out', sw, 'in'); W(sel, 'out', rd, 'in'); W(sw, 'hit', q, 'in'); W(q, 'out', v, 'trig');
    W(rd, 'alt', sc, 'in'); W(sc, 'note', v, 'note'); W(rd, 'rng', mp, 'in'); W(mp, 'out', v, 'vel'); W(rd, 'brg', pn, 'in'); W(pn, 'pan', v, 'pan');
    W(v, 'audio', rv, 'in'); W(rv, 'out', o, 'in'); W(ev, 'tick', v2, 'trig'); W(k, 'out', v2, 'note'); W(v2, 'audio', o, 'in');
  } else if (name === 'ping') {
    // The same sky as the director, scanned by range: a ring grows from the antenna and each aircraft pings as it reaches
    // it, nearest and loudest first. Traffic thickens with range (about 50 aircraft sit inside 30 NM of this antenna), so
    // the pings start sparse and speed up until the ring resets. Selection and ring end at the same range, 30 NM.
    const sky = N('sky', -160, 0), sel = N('select', 0, 0, { rmax: 30 });
    const sw = N('sweep', 236, 0, { axis: 'range', bars: 2, reach: 30 }), rd = N('read', 236, 265);
    const q = N('quantize', 472, 0, { grid: '0.25' }), sc = N('scale', 472, 125, { lo: 0, hi: 40000, scale: 'Newark terrain', root: '9', oct: 3, span: 3 });
    const mp = N('map', 472, 365, { lo: 0, hi: 30, olo: 1, ohi: 0.3 }), pn = N('pan', 472, 555);
    const v = N('voice', 708, 0, { sound: 'pluck', release: 0.8, vol: 0.8, poly: 24 });
    const rv = N('reverb', 944, 0, { size: 3, mix: 0.35 }), o = N('output', 944, 150);
    W(sky, 'sky', sel, 'in'); W(sel, 'out', sw, 'in'); W(sel, 'out', rd, 'in'); W(sw, 'hit', q, 'in'); W(q, 'out', v, 'trig');
    W(rd, 'alt', sc, 'in'); W(sc, 'note', v, 'note'); W(rd, 'rng', mp, 'in'); W(mp, 'out', v, 'vel'); W(rd, 'brg', pn, 'in'); W(pn, 'pan', v, 'pan');
    W(v, 'audio', rv, 'in'); W(rv, 'out', o, 'in');
  } else if (name === 'chimes') {
    const sky = N('sky', -160, 0), sel = N('select', 0, 0, { rmax: 30, amax: 4000 }), rd2 = N('read', 0, 290);
    const ee = N('enterexit', 236, 0, { hold: 20 }), rd = N('read', 236, 150), th = N('threshold', 236, 425, { level: 10000, dir: 'down' });
    const q = N('quantize', 472, 0, { grid: '0.5' }), sc = N('scale', 472, 125, { lo: 0, hi: 360, scale: 'major pentatonic', root: '2', oct: 4, span: 2 });
    const pn = N('pan', 472, 365), m = N('math', 472, 490, { op: 'add', b: -24 }), k = N('constant', 472, 660, { v: 86 });
    const v = N('voice', 708, 0, { sound: 'pluck', release: 2.2, vol: 0.9, poly: 8 }), v2 = N('voice', 708, 330, { sound: 'sine', release: 2.5, attack: 0.08, vol: 0.6, poly: 6 });
    const dl = N('delay', 944, 0, { beats: 0.75, fb: 0.35, mix: 0.3 }), rv = N('reverb', 944, 165, { size: 3, mix: 0.35 }), o = N('output', 944, 315);
    const v3 = N('voice', 944, 455, { sound: 'bell', release: 3, vol: 0.45, poly: 4 });
    W(sky, 'sky', sel, 'in'); W(sel, 'out', ee, 'in'); W(sel, 'out', rd, 'in'); W(ee, 'enter', q, 'in'); W(q, 'out', v, 'trig');
    W(rd, 'brg', sc, 'in'); W(sc, 'note', v, 'note'); W(rd, 'brg', pn, 'in'); W(pn, 'pan', v, 'pan');
    W(ee, 'exit', v2, 'trig'); W(sc, 'note', m, 'a'); W(m, 'out', v2, 'note'); W(pn, 'pan', v2, 'pan');
    W(sky, 'sky', rd2, 'in'); W(rd2, 'alt', th, 'in'); W(th, 'out', v3, 'trig'); W(k, 'out', v3, 'note');
    W(v, 'audio', dl, 'in'); W(v2, 'audio', dl, 'in'); W(v3, 'audio', dl, 'in'); W(dl, 'out', rv, 'in'); W(rv, 'out', o, 'in');
  } else if (name === 'drone') {
    const sky = N('sky', -160, 0), sel = N('select', 0, 0, { rmax: 20, nearest: 6 }), rd2 = N('read', 0, 290);
    const rd = N('read', 236, 0), mp2 = N('map', 236, 290, { lo: 60, hi: 140, olo: 300, ohi: 2600 });
    const sc = N('scale', 472, 0, { lo: 0, hi: 20000, scale: 'minor pentatonic', root: '9', oct: 2, span: 2 }), gl = N('smooth', 472, 250, { tau: 4 });
    const mp = N('map', 472, 380, { lo: 0, hi: 20, olo: 1, ohi: 0.25 }), pn = N('pan', 472, 570);
    const v = N('voice', 708, 0, { sound: 'triangle', mode: 'drone', attack: 3, release: 6, vol: 0.9, poly: 6 });
    const fl = N('filter', 944, 0, { type: 'lowpass', freq: 900, q: 2 }), rv = N('reverb', 944, 205, { size: 7, mix: 0.6 }), o = N('output', 944, 355);
    W(sky, 'sky', sel, 'in'); W(sel, 'out', rd, 'in'); W(rd, 'alt', sc, 'in'); W(sc, 'note', gl, 'in'); W(gl, 'out', v, 'note');
    W(rd, 'rng', mp, 'in'); W(mp, 'out', v, 'vel'); W(rd, 'brg', pn, 'in'); W(pn, 'pan', v, 'pan');
    W(sky, 'sky', rd2, 'in'); W(rd2, 'count', mp2, 'in'); W(mp2, 'out', fl, 'cutoff');
    W(v, 'audio', fl, 'in'); W(fl, 'out', rv, 'in'); W(rv, 'out', o, 'in');
  } else if (name === 'levels') {
    // Cruising traffic sits on flight levels, 1,000 ft apart. At 1,000 ft per semitone the odd levels (eastbound) and the
    // even levels (westbound) are the two whole-tone scales, and FL290 to FL410 is exactly one octave.
    const sky = N('sky', -160, 0), sel = N('select', 0, 0, { rmax: 120, amin: 18000, amax: 45000, motion: 'level', nearest: 10 });
    const rd = N('read', 236, 0);
    const sc = N('scale', 472, 0, { lo: 18000, hi: 54000, scale: 'chromatic', root: '0', oct: 3, span: 3 });
    const mp = N('map', 472, 250, { lo: 0, hi: 120, olo: 1, ohi: 0.3 }), pn = N('pan', 472, 440);
    const v = N('voice', 708, 0, { sound: 'triangle', mode: 'drone', attack: 3, release: 6, vol: 0.8, poly: 12 });
    const rv = N('reverb', 944, 0, { size: 5, mix: 0.45 }), o = N('output', 944, 150);
    W(sky, 'sky', sel, 'in'); W(sel, 'out', rd, 'in'); W(rd, 'alt', sc, 'in'); W(sc, 'note', v, 'note');
    W(rd, 'rng', mp, 'in'); W(mp, 'out', v, 'vel'); W(rd, 'brg', pn, 'in'); W(pn, 'pan', v, 'pan');
    W(v, 'audio', rv, 'in'); W(rv, 'out', o, 'in');
  } else if (name === 'duet') {
    // Two aircraft closing on each other become two voices. Their altitudes make the interval (a minor pentatonic scale at
    // 1,000 ft a step, so the legal vertical minimum is one step), the time left to their closest point sets how fast the
    // voices restrike, and a predicted close pass, inside 3 NM and under 1,000 ft, sounds a tritone, which that scale
    // cannot make. The window below the select keeps the pair this example opens on apart from the rest of the sky.
    const sky = N('sky', -160, 0), sel = N('select', 0, 0, DUET.select), cl = N('closest', 236, 0);
    const rd = N('read', 472, 0), mv = N('map', 472, 330, { lo: 0.3, hi: 5, olo: 1, ohi: 0.35 });
    const sc = N('scale', 708, 0, { lo: 0, hi: 30000, scale: 'minor pentatonic', root: '9', oct: 2, span: 6 }), pn = N('pan', 708, 300);
    const mt = N('map', 236, 400, { lo: 5, hi: 90, olo: 0.375, ohi: 4 }), pu = N('pulse', 236, 590, { fastest: 0.25, slowest: 4 });
    const v = N('voice', 944, 0, { sound: 'bell', release: 0.7, vol: 0.8, poly: 24 }); // fast restrikes need a short note and room for the ones still ringing
    const k1 = N('constant', 708, 450, { v: 60 }), k2 = N('constant', 708, 580, { v: 66 });
    const s1 = N('voice', 944, 450, { sound: 'triangle', attack: 0.03, release: 2.5, vol: 0.45, poly: 2 });
    const s2 = N('voice', 1180, 450, { sound: 'triangle', attack: 0.03, release: 2.5, vol: 0.45, poly: 2 });
    const rv = N('reverb', 1180, 0, { size: 3, mix: 0.35 }), o = N('output', 1180, 150);
    W(sky, 'sky', sel, 'in'); W(sel, 'out', cl, 'in'); W(cl, 'pair', rd, 'in');
    W(rd, 'alt', sc, 'in'); W(sc, 'note', v, 'note'); W(rd, 'brg', pn, 'in'); W(pn, 'pan', v, 'pan');
    W(cl, 'dist', mv, 'in'); W(mv, 'out', v, 'vel'); W(cl, 'tau', mt, 'in'); W(mt, 'out', pu, 'in'); W(pu, 'tick', v, 'trig');
    W(cl, 'close', s1, 'trig'); W(cl, 'close', s2, 'trig'); W(k1, 'out', s1, 'note'); W(k2, 'out', s2, 'note');
    W(v, 'audio', rv, 'in'); W(s1, 'audio', rv, 'in'); W(s2, 'audio', rv, 'in'); W(rv, 'out', o, 'in');
  } else if (GROUND_ARMS.includes(name)) {
    // Few voices over a composed ground. The aircraft that have just levelled off are the cast and sing the notes of the
    // chord; an arrival descending through 4,000 ft inside 30 NM turns the page, on the next bar line, and the cast states
    // the new chord together as it turns; a bass is struck on every bar; a level-off is a bell, on the beat. The gate is read
    // from a Select of its own that keeps every altitude, so an arrival turns the page whether or not it is one of the voices.
    // The other examples are arms to listen against, each changing one thing:
    //   clock  the page turns every 6 bars instead of when an arrival descends (about the rate the arrivals set)
    //   shift  the page turns on the arrivals of the same sky 300 s later: the same kind of timing, not these aircraft's
    //   strum  the bass bar is the whole chord, rolled, instead of the root alone
    //   thin   a held note is not struck again each turn; it sounds when it changes, or every other turn
    //   led    chord tones voice-led: at a change the cast moves least and avoids parallel fifths and octaves with the bass
    //   cast   no Ground: the same cast and bells on the terrain scale of the Radar director, and its drone
    const arm = name.slice('ground'.length);
    const sky = N('sky', -160, 0), sel = N('select', 0, 0, { rmax: 30, amax: 12000 }), lo = N('leveloff', 236, 0, { seed: 'level' });
    const rd = N('read', 472, 0), sw = N('sweep', 472, 300, { bars: 2 }), q = N('quantize', 708, 300, { grid: '0.25' });
    const gr = arm === 'cast' ? N('scale', 708, 0, { lo: 0, hi: 12000, scale: 'Newark terrain', root: '9', oct: 2, span: 3 }) : N('ground', 708, 0, arm === 'led' ? { alloc: 'led' } : undefined);
    const mp = N('map', 944, 520, { lo: 0, hi: 30, olo: 1, ohi: 0.3 }), pn = N('pan', 944, 700);
    const v = N('voice', 1180, 0, { sound: 'pluck', release: 1.2, vol: 0.8, poly: 12 });
    const qL = N('quantize', 708, 700, { grid: '1' }), k = N('constant', 944, 880, { v: 0.9 }), vb = N('voice', 1180, 300, { sound: 'bell', release: 2.5, vol: 0.7, poly: 6 });
    const rv = N('reverb', 1416, 0, { size: 3, mix: 0.3 }), o = N('output', 1416, 150);
    W(sky, 'sky', sel, 'in'); W(sel, 'out', lo, 'in'); W(lo, 'cast', rd, 'in'); W(lo, 'cast', sw, 'in'); W(rd, 'alt', gr, 'in');
    if (arm === 'thin') { const ch = N('changed', 708, 150, { delta: 1, every: 4 }); W(sw, 'hit', ch, 'in'); W(gr, 'note', ch, 'value'); W(ch, 'out', q, 'in'); } else W(sw, 'hit', q, 'in');
    W(q, 'out', v, 'trig'); W(gr, 'note', v, 'note'); W(rd, 'rng', mp, 'in'); W(mp, 'out', v, 'vel'); W(rd, 'brg', pn, 'in'); W(pn, 'pan', v, 'pan');
    W(lo, 'level', qL, 'in'); W(qL, 'out', vb, 'trig'); W(gr, 'note', vb, 'note'); W(k, 'out', vb, 'vel'); W(pn, 'pan', vb, 'pan');
    W(v, 'audio', rv, 'in'); W(vb, 'audio', rv, 'in'); W(rv, 'out', o, 'in');
    if (arm === 'cast') { // the Radar director's drone: a held-feeling A1 every 8 beats
      const ev = N('every', 944, 1040, { beats: 8 }), kk = N('constant', 944, 1180, { v: 33 }), vd = N('voice', 1180, 600, { sound: 'triangle', release: 7, attack: 1.5, vol: 0.55, poly: 2 });
      W(ev, 'tick', vd, 'trig'); W(kk, 'out', vd, 'note'); W(vd, 'audio', o, 'in');
    } else {
      W(rd, 'vr', gr, 'rate');
      if (arm === 'clock') { const cl = N('every', 472, 520, { beats: 24 }); W(cl, 'tick', gr, 'step'); } else {
        const sky2 = arm === 'shift' ? N('sky', -160, 420, { shift: 300 }) : sky;
        const sel2 = N('select', 0, 420, { rmax: 30 }), rd2 = N('read', 236, 420), th = N('threshold', 472, 520, { level: 4000, dir: 'down' }), qb = N('quantize', 708, 520, { grid: '4' });
        W(sky2, 'sky', sel2, 'in'); W(sel2, 'out', rd2, 'in'); W(rd2, 'alt', th, 'in'); W(th, 'out', qb, 'in'); W(qb, 'out', gr, 'step');
      }
      const ev = N('every', 944, 1040, { beats: 4 }), vc = N('voice', 1180, 600, { sound: 'pluck', release: 1.6, vol: 0.8, poly: arm === 'strum' ? 6 : 4, strum: arm === 'strum' ? 60 : 0 });
      const vd = N('voice', 1180, 900, { sound: 'pluck', release: 1.5, vol: 0.7, poly: 8, strum: 40 });
      W(ev, 'tick', vc, 'trig'); W(gr, arm === 'strum' ? 'chord' : 'bass', vc, 'note');
      W(gr, 'changed', vd, 'trig'); W(gr, 'note', vd, 'note'); W(mp, 'out', vd, 'vel'); W(pn, 'pan', vd, 'pan');
      W(vc, 'audio', rv, 'in'); W(vd, 'audio', rv, 'in');
    }
  } else {
    N('sky', 40, 200); N('output', 700, 200);
  }
  changed(); select(null);
  requestAnimationFrame(fit);
  // The duet opens on its own encounter: the first capture, a little before the aircraft meet.
  if (name === 'duet') (async () => { if ($('#capture').value !== 'push') { $('#capture').value = 'push'; await useCapture('push'); } seek(DUET.at); })();
  // The ground opens on the busy half hour, at the start of an arrival push.
  if (GROUND_ARMS.includes(name)) (async () => { if ($('#capture').value !== 'push') { $('#capture').value = 'push'; await useCapture('push'); } seek(GROUND.at); })();
}

// ---------------------------------------------------------------- save, export, import
function serial() {
  return { pitchaxis_patch: 1, nodes: P.nodes.map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, p: n.p })), wires: P.wires, tempo: TP.bpm };
}
let saveTimer = null;
// Undo steps are whole-patch snapshots, taken once an edit has settled (the same 300 ms that debounces the save), so a
// drag or a typed value is one step and so is loading an example or importing a patch.
const HIST = { past: [], future: [], cur: null, restoring: false };
function updateHistButtons() { $('#undo').disabled = !HIST.past.length; $('#redo').disabled = !HIST.future.length; }
function commitHistory() {
  const snap = JSON.stringify(serial());
  if (snap === HIST.cur) return;
  if (!HIST.restoring && HIST.cur !== null) { HIST.past.push(HIST.cur); if (HIST.past.length > 100) HIST.past.shift(); HIST.future = []; }
  HIST.cur = snap;
  updateHistButtons();
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem('pitchaxis-patch', JSON.stringify(serial())); } catch (e) { /* storage unavailable */ } commitHistory(); }, 300); }
function stepHistory(from, to) {
  clearTimeout(saveTimer); commitHistory(); // an edit still waiting to settle becomes a step first
  if (!from.length) return;
  to.push(HIST.cur);
  HIST.cur = from.pop();
  HIST.restoring = true;
  try { load(JSON.parse(HIST.cur), true); } finally { HIST.restoring = false; }
  try { localStorage.setItem('pitchaxis-patch', HIST.cur); } catch (e) { /* storage unavailable */ }
  updateHistButtons();
}
const undo = () => stepHistory(HIST.past, HIST.future);
const redo = () => stepHistory(HIST.future, HIST.past);
function load(obj, keepView) {
  if (!obj || !Array.isArray(obj.nodes)) throw new Error('not a patch');
  for (const n of [...P.nodes]) removeNode(n.id);
  P = { nodes: [], wires: [] };
  let max = 0;
  for (const n of obj.nodes) { if (!TYPES[n.type]) continue; addNode(n.type, n.x, n.y, n.p, n.id); max = Math.max(max, parseInt(String(n.id).slice(1), 10) || 0); }
  nextId = max + 1;
  for (const w of obj.wires || []) if (byId(w.a[0]) && byId(w.b[0]) && portSpec(byId(w.a[0]), 'out', w.a[1]) && portSpec(byId(w.b[0]), 'in', w.b[1])) connect(w.a, w.b, true);
  if (obj.tempo) { TP.bpm = obj.tempo; $('#bpm').value = obj.tempo; }
  changed(); select(null); if (!keepView) requestAnimationFrame(fit);
}
const modal = $('#modal');
function openModal(mode) {
  modal.hidden = false;
  $('#mtitle').textContent = mode === 'export' ? 'Export patch' : 'Import patch';
  $('#mtext').value = mode === 'export' ? JSON.stringify(serial(), null, 1) : '';
  $('#mtext').readOnly = mode === 'export';
  $('#mload').hidden = mode === 'export'; $('#mfilebtn').hidden = mode === 'export';
  $('#mcopy').hidden = mode !== 'export'; $('#msave').hidden = mode !== 'export' || !DL;
  $('#mnote').textContent = mode === 'export' ? 'The wiring as JSON. Send it to someone, or load it back with Import.' : 'Paste a patch, or open a .json file.';
  $('#mtext').focus();
}
$('#export').onclick = () => openModal('export');
$('#import').onclick = () => openModal('import');
$('#mclose').onclick = () => (modal.hidden = true);
modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
$('#mcopy').onclick = async () => { try { await navigator.clipboard.writeText($('#mtext').value); $('#mnote').textContent = 'Copied.'; } catch (e) { $('#mtext').select(); $('#mnote').textContent = 'Selected. Press Ctrl-C or ⌘-C to copy.'; } };
$('#msave').onclick = async () => { try { await DL.save({ filename: 'sky-patch.json', data: $('#mtext').value }); $('#mnote').textContent = 'Saved.'; } catch (e) { if (e && e.code !== 'declined') $('#mnote').textContent = 'Saving is not available here; use Copy.'; } };
$('#mfilebtn').onclick = () => $('#mfile').click();
$('#mfile').onchange = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => ($('#mtext').value = r.result); r.readAsText(f); };
$('#mload').onclick = () => { try { load(JSON.parse($('#mtext').value)); modal.hidden = true; toast('Patch loaded.'); } catch (e) { $('#mnote').textContent = 'That is not a patch this editor can read: ' + e.message; } };

// ---------------------------------------------------------------- transport controls
$('#play').onclick = () => { if (!CAP) return; TP.playing ? stop() : play(); };
$('#rec').onclick = toggleRecord;
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#speed').onchange = (e) => { const s = parseFloat(e.target.value); if (TP.playing) { const t = AC.currentTime; TP.dAnchor = { at: t, d: dataAt(t) }; } TP.speed = s; };
$('#bpm').onchange = (e) => {
  const b = clamp(parseFloat(e.target.value) || 96, 30, 240); e.target.value = b;
  if (TP.playing) { const t = AC.currentTime; TP.bAnchor = { at: t, b: beatAt(t) }; }
  TP.bpm = b; for (const n of P.nodes) applyParams(n); save();
};
$('#scrub').oninput = (e) => seek(parseFloat(e.target.value));
async function useCapture(key) {
  const was = TP.playing; if (was) stop();
  await loadCapture(key); $('#scrub').max = Math.floor(CAP.span); TP.dataT = 0; resetStates();
  if (was) play();
}
$('#capture').onchange = (e) => useCapture(e.target.value);
$('#preset').onchange = (e) => { if (e.target.value) preset(e.target.value); e.target.value = ''; };

// ---------------------------------------------------------------- boot
(async function boot() {
  applyView();
  document.querySelectorAll('.bar .ctl, .bar .seg, .bar .pick').forEach(syncCtl);
  try { await loadCapture('push'); } catch (e) { $('#loading').textContent = 'Could not unpack the capture: ' + e.message; return; }
  $('#loading').remove();
  $('#scrub').max = Math.floor(CAP.span);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('pitchaxis-patch') || 'null'); } catch (e) { /* storage unavailable */ }
  try { if (saved && saved.nodes && saved.nodes.length) load(saved); else preset('director'); } catch (e) { preset('director'); }
  renderInspector();
  startPreview();
  requestAnimationFrame(drawScope);
  window.addEventListener('resize', () => drawWires());
})();
