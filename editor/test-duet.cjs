// Tests for the Closest pair, Pulse, Level-off and Ground blocks and the duet and ground examples, run against the built
// page in headless Chromium.
//   node editor/test-duet.cjs [page.html]
// Playwright comes from this repository's node_modules (npm install). The synthetic cases use made-up aircraft whose geometry is known
// exactly (positions in NM, speeds in knots, climb rates in ft/min, time in seconds of data time); the Ground properties
// run over seeded altitudes in every chord; the example cases run over the first capture. Exit status 1 if any case fails.
const path = require('path');
const { chromium } = require('playwright');

const PAGE = path.resolve(process.argv[2] || path.join(__dirname, 'pitchaxis-patchbay.html'));
let failed = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`); if (!cond) failed++; };

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on('pageerror', (e) => { console.log('PAGEERR', e.message); failed++; });
  await p.goto('file://' + PAGE);
  await p.waitForSelector('#loading', { state: 'hidden', timeout: 30000 });

  const R = await p.evaluate(() => {
    const out = {};
    const ac = (id, x, y, gs, trk, alt, vr = 0) => ({ id, alt, vr, gs, trk, rng: Math.hypot(x, y), brg: (Math.atan2(x, y) * 180 / Math.PI + 360) % 360 });
    const mk = () => ({ p: Object.fromEntries(TYPES.closest.params.map((q) => [q.k, q.def])), st: TYPES.closest.init() });
    const mv = (id, x, y, gs, trk, alt, vr = 0) => ({ id, x, y, gs, trk, alt, vr });
    // Step movers through data time and record what the block says each second.
    const run = (movers, { from = 0, to = 400, hide = () => false, n = mk(), preview = false } = {}) => {
      const rec = [];
      for (let t = from; t <= to; t++) {
        const sky = movers.filter((m) => !hide(m, t)).map((m) => {
          const s = t / 3600, k = Math.PI / 180;
          return ac(m.id, m.x + m.gs * Math.sin(m.trk * k) * s, m.y + m.gs * Math.cos(m.trk * k) * s, m.gs, m.trk, m.alt, m.vr);
        });
        const o = TYPES.closest.tick(n, { in: sky }, { dataT: t, w0: t, w1: t + 1, b0: 0, b1: 0, preview });
        rec.push({ t, pair: (o.pair || []).map((a) => a.id).sort().join(''), tau: o.tau ? o.tau.all : null, miss: o.miss ? o.miss.all : null,
          close: (o.close || []).length, passed: (o.passed || []).length });
      }
      return rec;
    };
    const sum = (rec, k) => rec.reduce((s, r) => s + r[k], 0);
    // Two aircraft on the x axis flying at each other at 250 kt each (closing 0.139 NM/s), passing 0.5 NM apart.
    const headOn = (half, altB) => [mv('A', -half, 0, 250, 90, 10000), mv('B', half, 0.5, 250, 270, altB)];

    // 1. a legal head-on pass, 1,000 ft apart, 40 NM at the start: closest point at 288 s
    let rec = run(headOn(20, 11000));
    const eng = rec.filter((x) => x.pair === 'AB');
    out.engaged = eng.length;
    out.beforeEngaged = rec.filter((x) => x.t < (eng[0]?.t ?? 1e9) && x.pair).length; out.firstTau = eng[0]?.tau ?? null;
    out.tauMonotone = eng.every((x, i) => i === 0 || x.tau < eng[i - 1].tau);
    out.miss = eng[0]?.miss ?? null; out.passedCount = sum(rec, 'passed'); out.passedAt = rec.find((x) => x.passed)?.t ?? -1;
    out.closeLegal = sum(rec, 'close'); out.afterPass = rec.filter((x) => x.t > out.passedAt && x.pair).length;
    // 2. the same pass 800 ft apart: one close pass, announced before the pass
    rec = run(headOn(20, 10800));
    out.closeTight = sum(rec, 'close'); out.closeFirst = (rec.find((x) => x.close)?.t ?? 1e9) < (rec.find((x) => x.passed)?.t ?? -1);
    // 3. tracks that do not meet: parallel at 10 kt relative never; a 90 degree crossing does
    out.parallel = run([mv('A', -20, 0, 250, 90, 10000), mv('B', -20.2, 0.1, 260, 90, 10000)]).filter((x) => x.pair).length;
    out.crossing = run([mv('A', -10, 0, 250, 90, 10000), mv('B', 0.3, -10, 250, 0, 11000)], { to: 200 }).filter((x) => x.pair === 'AB').length;
    // 4. the floor
    out.low = run([mv('A', -20, 0, 250, 90, 500), mv('B', 20, 0.5, 250, 270, 600)]).filter((x) => x.pair).length;
    out.high = run([mv('A', -20, 0, 250, 90, 1500), mv('B', 20, 0.5, 250, 270, 1600)]).filter((x) => x.pair === 'AB').length;
    // 5. a gap in the data: 10 s is held through; a gap that lasts through the pass is let go with no "passed"
    rec = run(headOn(20, 11000), { hide: (m, t) => m.id === 'B' && t >= 230 && t < 240 });
    out.gap10Passed = sum(rec, 'passed'); out.gap10Resumed = rec.find((x) => x.t === 245).pair === 'AB';
    out.gapDuring = rec.find((x) => x.t === 235).pair; // A alone is still reported: the pair is held, not dropped and found again
    rec = run(headOn(20, 11000), { hide: (m, t) => m.id === 'B' && t >= 230 && t < 300, to: 340 });
    out.gapLongPassed = sum(rec, 'passed'); out.gapLongReleased = rec.find((x) => x.t === 280).pair === '';
    // 6. a seek backwards starts again; the pass is announced once, in the second run only
    const n6 = mk();
    run(headOn(20, 11000), { from: 0, to: 250, n: n6 });
    rec = run(headOn(20, 11000), { from: 100, to: 400, n: n6 });
    out.seekFirst = rec[0].pair; out.seekPassed = sum(rec, 'passed'); out.seekReengaged = rec.some((x) => x.pair === 'AB');
    // 7. challengers. The incumbent A-B (closest point at t=115 s) is engaged from t=25. C and D enter at t=40.
    const ab = [mv('A', -8, 0, 250, 90, 10000), mv('B', 8, 0.5, 250, 270, 11000)];
    const cd = (meet) => { const d = 0.0694444 * meet; return [mv('C', 0, -d, 250, 0, 20000), mv('D', 0.5, d, 250, 180, 21000)]; }; // C-D meet at t=meet
    const late = (ids) => (m, t) => ids.includes(m.id) && t < 40;
    //  a challenger 40 s from its closest point against 75 s for the incumbent, so under half: takes over, but only after 10 s
    rec = run(ab.concat(cd(70)), { to: 120, hide: late('CD') });
    out.abFirst = rec.find((x) => x.pair).t; out.cdTakes = rec.find((x) => x.pair === 'CD')?.t ?? null;
    out.noCdBefore = rec.filter((x) => x.t < 49 && x.pair === 'CD').length;
    //  one that is under half only for the last 5 s before it passes: the 10 s dwell is never served
    rec = run(ab.concat(cd(110)), { to: 130, hide: late('CD') });
    out.mildCd = rec.filter((x) => x.pair === 'CD').length; out.mildAbPassed = sum(rec, 'passed'); out.mildAbAt = rec.find((x) => x.passed)?.t ?? -1;
    //  a challenger that shares an aircraft with the incumbent: A-E would be at 30 s against 75 s, but A is taken
    const e = mv('E', -3.1388, 4.861, 250, 180, 10500); // meets A at t=70
    rec = run(ab.concat([e]), { to: 120, hide: late('E') });
    out.sharedE = rec.filter((x) => x.pair.includes('E')).length; out.sharedAB = rec.filter((x) => x.t >= 30 && x.t < 110 && x.pair === 'AB').length;
    // 8. preview mode: the pair is reported, no events
    rec = run(headOn(20, 10800), { preview: true });
    out.previewEvents = sum(rec, 'close') + sum(rec, 'passed'); out.previewPair = rec.some((x) => x.pair === 'AB');

    // ---- Pulse
    const pn = () => ({ p: Object.fromEntries(TYPES.pulse.params.map((q) => [q.k, q.def])), st: TYPES.pulse.init() });
    const pulses = (value, from, to, n = pn(), prev = false) => {
      const ev = [];
      for (let b = from; b < to - 1e-9; b += 0.1) {
        const o = TYPES.pulse.tick(n, { in: value == null ? undefined : { per: null, all: value } }, { b0: b, b1: b + 0.1, w0: b, w1: b + 0.1, preview: prev });
        for (const x of o.tick) ev.push(x.at);
      }
      return ev;
    };
    const beat = (at) => (at - TP.bAnchor.at) * TP.bpm / 60 + TP.bAnchor.b;
    let ev = pulses(2, 0, 20).map(beat);
    out.pulse2 = ev.length >= 9 && ev.slice(1).every((x, i) => Math.abs(x - ev[i] - 2) < 1e-6);
    ev = pulses(0.01, 0, 5).map(beat);
    out.pulseFloor = ev.length > 10 && ev.slice(1).every((x, i) => Math.abs(x - ev[i] - 0.25) < 1e-6);
    out.pulseSilent = pulses(null, 0, 5).length; out.pulsePreview = pulses(2, 0, 5, pn(), true).length;
    const n9 = pn(); pulses(1, 0, 3, n9); const lateEv = pulses(1, 100, 101, n9).map(beat);
    out.pulseNoBacklog = lateEv.length >= 1 && lateEv.length <= 2 && lateEv[0] >= 100 - 1e-9;
    return out;
  });
  ok('legal head-on pass: not engaged until 90 s out', R.engaged > 60 && R.beforeEngaged === 0 && R.firstTau <= 90 && R.firstTau > 85, JSON.stringify([R.engaged, R.beforeEngaged, R.firstTau]));
  ok('legal head-on pass: time to closest shrinks every second', R.tauMonotone);
  ok('legal head-on pass: predicted miss is the 0.5 NM flown', Math.abs(R.miss - 0.5) < 0.02, String(R.miss));
  ok('legal head-on pass: one "passed", within 3 s of the closest point', R.passedCount === 1 && Math.abs(R.passedAt - 288) <= 3, `${R.passedCount} at ${R.passedAt}`);
  ok('legal head-on pass: 1,000 ft apart is not a close pass', R.closeLegal === 0, String(R.closeLegal));
  ok('legal head-on pass: nothing reselected once they have passed', R.afterPass === 0, String(R.afterPass));
  ok('800 ft apart: exactly one close pass, announced before the pass', R.closeTight === 1 && R.closeFirst, String(R.closeTight));
  ok('a pair 0.22 NM apart on parallel tracks, 10 kt relative, is never chosen', R.parallel === 0, String(R.parallel));
  ok('a 90 degree crossing is a pair', R.crossing > 60, String(R.crossing));
  ok('aircraft below the 1,000 ft floor are ignored', R.low === 0, String(R.low));
  ok('aircraft above the floor are paired', R.high > 60, String(R.high));
  ok('a 10 s gap is held through: the pair is still reported, and the pass is announced once', R.gap10Passed === 1 && R.gap10Resumed && R.gapDuring === 'A', JSON.stringify([R.gap10Passed, R.gap10Resumed, R.gapDuring]));
  ok('a gap through the pass lets the pair go with no "passed"', R.gapLongPassed === 0 && R.gapLongReleased, JSON.stringify([R.gapLongPassed, R.gapLongReleased]));
  ok('a seek backwards starts again and the pass is announced once', R.seekFirst === '' && R.seekPassed === 1 && R.seekReengaged, JSON.stringify([R.seekFirst, R.seekPassed, R.seekReengaged]));
  ok('a challenger under half the incumbent time takes over only after a 10 s dwell', R.abFirst >= 24 && R.abFirst <= 27 && R.noCdBefore === 0 && R.cdTakes >= 49 && R.cdTakes <= 53, JSON.stringify([R.abFirst, R.noCdBefore, R.cdTakes]));
  ok('a challenger that is under half for only 5 s never takes over', R.mildCd === 0 && R.mildAbPassed === 1 && Math.abs(R.mildAbAt - 115) <= 3, JSON.stringify([R.mildCd, R.mildAbPassed, R.mildAbAt]));
  ok('a challenger sharing an aircraft with the incumbent is ignored', R.sharedE === 0 && R.sharedAB > 70, JSON.stringify([R.sharedE, R.sharedAB]));
  ok('preview mode reports the pair and emits no events', R.previewEvents === 0 && R.previewPair, JSON.stringify([R.previewEvents, R.previewPair]));
  ok('Pulse: a value of 2 gives events exactly 2 beats apart', R.pulse2);
  ok('Pulse: a tiny value is held at the fastest pace', R.pulseFloor);
  ok('Pulse: no value is silent, and preview mode makes no events', R.pulseSilent === 0 && R.pulsePreview === 0, JSON.stringify([R.pulseSilent, R.pulsePreview]));
  ok('Pulse: a long gap leaves no backlog of events', R.pulseNoBacklog);

  // ---- Level-off: synthetic climb-rate profiles, one sample per second of data time
  const L = await p.evaluate(() => {
    const out = {};
    const mk = (over = {}) => ({ p: { ...Object.fromEntries(TYPES.leveloff.params.map((q) => [q.k, q.def])), ...over }, st: TYPES.leveloff.init() });
    // profiles: id -> (t) => climb rate in ft/min, or null for no reading. absent(id, t) takes an aircraft out of the input.
    const run = (profiles, { n = mk(), from = 0, to = 200, preview = false, absent = () => false } = {}) => {
      const ev = [], cast = [];
      for (let t = from; t <= to; t++) {
        const sky = Object.entries(profiles).filter(([id]) => !absent(id, t)).map(([id, f]) => ({ id, vr: f(t), alt: 5000, rng: 10 }));
        const o = TYPES.leveloff.tick(n, { in: sky }, { dataT: t, w0: t, w1: t + 1, b0: 0, b1: 0, preview });
        for (const e of o.level) ev.push({ t, id: e.id });
        cast.push({ t, ids: o.cast.map((a) => a.id).sort().join('') });
      }
      return { ev, cast, n };
    };
    const castAt = (r, t) => r.cast.find((x) => x.t === t).ids;
    // 60 s of descent at 1,000 ft/min, then level
    const descentThenLevel = (t0) => (t) => (t < t0 ? -1000 : 0);
    let r = run({ A: descentThenLevel(60) });
    out.single = r.ev.length === 1 && r.ev[0].id === 'A'; out.singleAt = r.ev[0] ? r.ev[0].t : null;
    // cruising with a climb rate that jitters by 250 ft/min is never a level-off
    r = run({ A: (t) => (t % 2 ? 250 : -250) }); out.jitter = r.ev.length;
    // a climb that lasts 10 s, under the 15 s dwell, then level: not a level-off; 20 s is
    out.shortClimb = run({ A: (t) => (t < 10 ? 1500 : 0) }).ev.length; out.longClimb = run({ A: (t) => (t < 20 ? 1500 : 0) }).ev.length;
    // the thresholds are exclusive above and inclusive below: exactly 500 ft/min is not moving, exactly 200 ft/min is level
    out.at500 = run({ A: (t) => (t < 60 ? -500 : 0) }).ev.length; out.at501 = run({ A: (t) => (t < 60 ? -501 : 0) }).ev.length;
    out.at200 = run({ A: (t) => (t < 60 ? -1000 : 200) }).ev.length; out.at201 = run({ A: (t) => (t < 60 ? -1000 : 201) }).ev.length;
    // a climb rate of 0 is a reading (level); null is no reading and cancels a descent in progress
    out.nullBreaks = run({ A: (t) => (t < 30 ? -1000 : t < 40 ? null : 0) }).ev.length;
    // easing off over 20 s is not a level-off at the default 4 s, and is when the limit is 30 s
    const ease = (t) => (t < 40 ? -800 : t < 60 ? -800 + (t - 40) * 40 : 0);
    out.easeDefault = run({ A: ease }).ev.length; out.easeLoose = run({ A: ease }, { n: mk({ slow: 30 }) }).ev.length;
    // the level-off waits: nothing before 10 s of level flight, and a climb that resumes before then cancels it
    out.resumes = run({ A: (t) => (t < 30 ? -1000 : t < 36 ? 0 : -1000) }, { to: 120 }).ev.length;
    // one aircraft levelling does not fire another, and each keeps its own timers
    r = run({ A: descentThenLevel(60), B: descentThenLevel(100) });
    out.two = JSON.stringify(r.ev.map((e) => [e.id, e.t]));
    // the cast: the last `keep` to level off. Four aircraft level at 60, 100, 140, 180: with keep 3 the first is displaced.
    r = run({ A: descentThenLevel(60), B: descentThenLevel(100), C: descentThenLevel(140), D: descentThenLevel(180) }, { to: 260 });
    out.cast3 = [castAt(r, 75), castAt(r, 115), castAt(r, 155), castAt(r, 195)];
    out.cast1 = castAt(run({ A: descentThenLevel(60), B: descentThenLevel(100) }, { n: mk({ keep: 1 }), to: 130 }), 125);
    // an aircraft that leaves the input leaves the cast, and nobody older takes its place
    r = run({ A: descentThenLevel(60), B: descentThenLevel(100), C: descentThenLevel(140), D: descentThenLevel(180), E: descentThenLevel(220) }, { to: 260, absent: (id, t) => id === 'C' && t >= 200 });
    out.castGone = [castAt(r, 195), castAt(r, 205), castAt(r, 235)];
    // an id that returns after leaving starts with fresh timers: a descent that was under way when it left does not count
    out.reused = run({ A: (t) => (t < 25 ? -1000 : 0) }, { to: 120, absent: (id, t) => t >= 25 && t < 28 }).ev.length;
    // preview reports the cast and emits nothing
    r = run({ A: descentThenLevel(60) }, { preview: true }); out.previewEv = r.ev.length; out.previewCast = castAt(r, 100);
    // a seek backwards starts again: the cast empties, and the same level-off is announced again
    const n7 = mk(); run({ A: descentThenLevel(60) }, { n: n7, to: 120 });
    r = run({ A: descentThenLevel(60) }, { n: n7, from: 40, to: 120 });
    out.seekFirst = r.cast[0].ids; out.seekEv = r.ev.length;
    return out;
  });
  ok('Level-off: a descent that ends level is announced once, 10 s after it levelled', L.single && L.singleAt === 70, JSON.stringify([L.single, L.singleAt]));
  ok('Level-off: a climb rate jittering by 250 ft/min in cruise is never announced', L.jitter === 0, String(L.jitter));
  ok('Level-off: a climb shorter than 15 s does not count, one of 20 s does', L.shortClimb === 0 && L.longClimb === 1, JSON.stringify([L.shortClimb, L.longClimb]));
  ok('Level-off: exactly 500 ft/min is not moving and exactly 200 ft/min is level', L.at500 === 0 && L.at501 === 1 && L.at200 === 1 && L.at201 === 0, JSON.stringify([L.at500, L.at501, L.at200, L.at201]));
  ok('Level-off: a missing reading cancels a descent in progress', L.nullBreaks === 0, String(L.nullBreaks));
  ok('Level-off: easing off over 20 s is not a level-off at 4 s, and is at 30 s', L.easeDefault === 0 && L.easeLoose === 1, JSON.stringify([L.easeDefault, L.easeLoose]));
  ok('Level-off: a descent that resumes inside the 10 s wait is not announced', L.resumes === 0, String(L.resumes));
  ok('Level-off: two aircraft keep separate timers', L.two === '[["A",70],["B",110]]', L.two);
  ok('Level-off: the cast is the last three to level off, and the fourth displaces the first', JSON.stringify(L.cast3) === '["A","AB","ABC","BCD"]', JSON.stringify(L.cast3));
  ok('Level-off: keep 1 holds only the latest', L.cast1 === 'B', L.cast1);
  ok('Level-off: an aircraft that leaves the input leaves the cast and frees its place; the one displaced earlier does not return', L.castGone[0] === 'BCD' && L.castGone[1] === 'BD' && L.castGone[2] === 'BDE', JSON.stringify(L.castGone));
  ok('Level-off: an id that returns after leaving starts with fresh timers', L.reused === 0, String(L.reused));
  ok('Level-off: preview mode reports the cast and emits no events', L.previewEv === 0 && L.previewCast === 'A', JSON.stringify([L.previewEv, L.previewCast]));
  ok('Level-off: a seek backwards empties the cast and announces the level-off again', L.seekFirst === '' && L.seekEv === 1, JSON.stringify([L.seekFirst, L.seekEv]));

  // ---- Quantize's 2-bar grid, Sky's shift, Level-off's seeded start, Changed
  const NB = await p.evaluate(() => {
    const out = {};
    const q = (grid, beats) => { const n = { p: { grid } }; return TYPES.quantize.tick(n, { in: beats.map((b) => ({ id: '*', at: timeOfBeat(b) })) }).out.map((e) => +beatAt(e.at).toFixed(4)); };
    out.q2 = JSON.stringify(q('8', [0.2, 5, 8, 8.0000005, 8.001, 15.9])); out.q1 = JSON.stringify(q('4', [0.2, 4, 4.001]));
    out.q2opt = TYPES.quantize.params.find((x) => x.k === 'grid').opts.some((o) => o[0] === '8' && o[1] === '2 bars');
    // Sky: no shift is the sky of the moment itself; a shift is the sky of another moment of the capture
    const sk = (shift, T) => TYPES.sky.tick({ p: { shift }, readout: '' }, {}, { sky: skyAt(T), dataT: T }).sky;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    out.skyNow = same(sk(0, 600), skyAt(600)); out.skyLater = same(sk(300, 600), skyAt(900)); out.skyEarlier = same(sk(-120, 600), skyAt(480));
    out.skyDiffers = !same(sk(300, 600), sk(0, 600)); out.skyPastEnd = sk(100000, 600).length === 0; out.skyBeforeStart = sk(-100000, 600).length === 0;
    // Level-off "level ones": the nearest `keep` aircraft in level flight fill the cast at the start, once
    const mk = (over = {}) => ({ p: { ...Object.fromEntries(TYPES.leveloff.params.map((q) => [q.k, q.def])), seed: 'level', ...over }, st: TYPES.leveloff.init() });
    const ac = (id, vr, rng) => ({ id, vr, alt: 5000, rng });
    const field = [ac('D', 0, 20), ac('A', 0, 5), ac('M', -1000, 1), ac('C', 100, 15), ac('B', -200, 10), ac('N', null, 2)];
    const tk = (n, sky, t, preview = false) => TYPES.leveloff.tick(n, { in: sky }, { dataT: t, w0: t, w1: t + 1, b0: 0, b1: 0, preview });
    const ids = (o) => o.cast.map((a) => a.id).sort().join('');
    let n = mk(); let o = tk(n, field, 0);
    out.seedNearest = ids(o); out.seedNoEvents = o.level.length;
    out.seedKeep1 = ids(tk(mk({ keep: 1 }), field, 0)); out.seedEmpty = ids(tk(mk({ seed: 'empty' }), field, 0));
    out.seedOnce = ids(tk(n, field.concat([ac('Z', 0, 2)]), 1));            // a later arrival does not re-seed
    out.seedPreview = ids(tk(mk(), field, 0, true));                         // the stopped preview shows it too
    n = mk(); tk(n, field, 0); tk(n, field, 1); out.seedReseeded = ids(tk(n, field.concat([ac('Z', 0, 2)]), 0)); // a seek backwards: seeded again, with Z nearest
    out.seedFresh = ids(tk(Object.assign(mk(), { st: TYPES.leveloff.init() }), field, 0));
    out.seedOnlyPresent = ids(tk(mk(), [], 0));
    // Changed: an event passes if its value moved since the last one let through, or after a while
    const ch = (over = {}) => ({ p: { ...Object.fromEntries(TYPES.changed.params.map((q) => [q.k, q.def])), ...over }, st: TYPES.changed.init() });
    const gate = (n, items, preview = false) => { // items: [beat, id, value]; one tick holds them all
      const evs = items.map(([b, id]) => ({ id, at: timeOfBeat(b) })), per = new Map(items.filter((x) => x[2] != null && x[1] !== '*').map(([, id, v]) => [id, v]));
      const star = items.find((x) => x[1] === '*' && x[2] != null);
      const value = items.every((x) => x[2] == null) ? undefined : { per, all: star ? star[2] : null };
      return TYPES.changed.tick(n, { in: evs, value }, { w0: 0, w1: 0.1, b0: 0, b1: 0.16, preview }).out.map((e) => +beatAt(e.at).toFixed(3));
    };
    const seq = (n, items) => items.map((it) => gate(n, [it]).length); // one event per tick: 1 passed, 0 held back
    out.firstPasses = JSON.stringify(seq(ch(), [[0, 'a', 60], [4, 'a', 60], [8, 'a', 60], [12, 'a', 61], [16, 'a', 61]]));  // 1 0 0 1 0
    out.edgeDelta = JSON.stringify(seq(ch({ delta: 2 }), [[0, 'a', 60], [4, 'a', 61.9], [8, 'a', 62]]));                       // 1 0 1: moved by exactly delta passes
    out.sinceLastPassed = JSON.stringify(seq(ch({ delta: 2 }), [[0, 'a', 60], [4, 'a', 61], [8, 'a', 62]]));                  // 1 0 1: compared with the last let through, not the last seen
    out.everyRepeats = JSON.stringify(seq(ch({ every: 4 }), [[0, 'a', 60], [8, 'a', 60], [15.9, 'a', 60], [16, 'a', 60], [31.9, 'a', 60], [32, 'a', 60]])); // 1 0 0 1 0 1
    out.everyZero = JSON.stringify(seq(ch({ every: 0 }), [[0, 'a', 60], [400, 'a', 60]]));
    out.deltaZero = JSON.stringify(seq(ch({ delta: 0 }), [[0, 'a', 60], [4, 'a', 60], [8, 'a', 60]]));
    out.noValue = JSON.stringify([seq(ch(), [[0, 'a', null]]), seq(ch(), [[0, 'a', null], [1, 'a', null]]), seq(ch(), [[0, 'a', 60], [1, 'a', null]])]);
    out.perAircraft = JSON.stringify(seq(ch(), [[0, 'a', 60], [1, 'b', 60], [2, 'a', 60], [3, 'b', 61]]));                       // 1 1 0 1
    out.everyone = JSON.stringify(seq(ch(), [[0, '*', 60], [4, '*', 60], [8, '*', 62]]));                                         // 1 0 1
    const inOrder = ch(); out.inOrder = JSON.stringify(gate(inOrder, [[8, 'a', 60], [0, 'a', 60]]));                              // sorted: 0 passes, 8 held
    out.previewQuiet = gate(ch(), [[0, 'a', 60]], true).length; const pv = ch(); gate(pv, [[0, 'a', 60]], true); out.previewNoMemory = gate(pv, [[0, 'a', 60]]).length;
    const c1 = ch(), c2 = ch(); gate(c1, [[0, 'a', 60]]); out.isolated = gate(c2, [[0, 'a', 60]]).length === 1;
    const c3 = ch(); gate(c3, [[0, 'a', 60]]); c3.st = TYPES.changed.init(); out.forgets = gate(c3, [[0, 'a', 60]]).length === 1;
    return out;
  });
  ok('Quantize: a 2-bar grid is offered, moves an event to the next even bar, and leaves one on it (to a millionth of a beat) where it is', NB.q2opt && NB.q2 === '[8,8,8,8,16,16]' && NB.q1 === '[4,4,8]', JSON.stringify([NB.q2opt, NB.q2, NB.q1]));
  ok('Sky: a shift of 0 is the sky of the moment, a shift is the sky of another moment, and past either end of the capture it is empty', NB.skyNow && NB.skyLater && NB.skyEarlier && NB.skyDiffers && NB.skyPastEnd && NB.skyBeforeStart, JSON.stringify([NB.skyNow, NB.skyLater, NB.skyEarlier, NB.skyDiffers, NB.skyPastEnd, NB.skyBeforeStart]));
  ok('Level-off: "level ones" seeds the cast with the nearest aircraft in level flight, not the moving, not those with no reading', NB.seedNearest === 'ABC' && NB.seedNoEvents === 0, JSON.stringify([NB.seedNearest, NB.seedNoEvents]));
  ok('Level-off: the seed respects keep, is empty when not asked for, and shows in preview', NB.seedKeep1 === 'A' && NB.seedEmpty === '' && NB.seedPreview === 'ABC', JSON.stringify([NB.seedKeep1, NB.seedEmpty, NB.seedPreview]));
  ok('Level-off: the seed happens once, again after a seek or reset, and holds nothing that is not there', NB.seedOnce === 'ABC' && NB.seedReseeded === 'ABZ' && NB.seedFresh === 'ABC' && NB.seedOnlyPresent === '', JSON.stringify([NB.seedOnce, NB.seedReseeded, NB.seedFresh, NB.seedOnlyPresent]));
  ok('Changed: the first event passes, a repeat of the same value does not, a changed value does', NB.firstPasses === '[1,0,0,1,0]', NB.firstPasses);
  ok('Changed: a value that has moved by exactly delta passes, measured from the last one let through', NB.edgeDelta === '[1,0,1]' && NB.sinceLastPassed === '[1,0,1]', JSON.stringify([NB.edgeDelta, NB.sinceLastPassed]));
  ok('Changed: an unmoved value passes again after the set time, and never with 0', NB.everyRepeats === '[1,0,0,1,0,1]' && NB.everyZero === '[1,0]', JSON.stringify([NB.everyRepeats, NB.everyZero]));
  ok('Changed: a delta of 0 lets everything through, and an event with no value is not held back', NB.deltaZero === '[1,1,1]' && NB.noValue === '[[1],[1,1],[1,1]]', JSON.stringify([NB.deltaZero, NB.noValue]));
  ok('Changed: each aircraft has its own memory, and events for everyone have one', NB.perAircraft === '[1,1,0,1]' && NB.everyone === '[1,0,1]', JSON.stringify([NB.perAircraft, NB.everyone]));
  ok('Changed: events in one tick are taken in time order', NB.inOrder === '[0]', NB.inOrder);
  ok('Changed: preview lets nothing through and remembers nothing; two blocks and a reset keep no shared memory', NB.previewQuiet === 0 && NB.previewNoMemory === 1 && NB.isolated && NB.forgets, JSON.stringify([NB.previewQuiet, NB.previewNoMemory, NB.isolated, NB.forgets]));

  // ---- Ground: properties of the note rule over every chord, and the clock that turns the page
  const GR = await p.evaluate(() => {
    const out = {};
    const mk = (over = {}) => ({ p: { ...Object.fromEntries(TYPES.ground.params.map((q) => [q.k, q.def])), ...over }, st: TYPES.ground.init() });
    let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); // fixed seed: the same altitudes every run
    const notes = (n, alts, rates) => { // one tick with the given altitudes (and climb rates) for aircraft 0..k; the note each is given
      const per = new Map(alts.map((a, k) => [k, a])), rate = rates ? { per: new Map(rates.map((r, k) => [k, r])), all: null } : undefined;
      const o = TYPES.ground.tick(n, { in: { per, all: null }, rate }, { w0: 0, w1: 0.1, b0: 0, b1: 0.16, preview: true });
      return alts.map((_, k) => Val.get(o.note, k));
    };
    const atChord = (prog, k, over = {}) => { const n = mk({ prog, ...over }); n.st.idx = k; return n; };
    const pcs = (m, key = 9) => ((m - key) % 12 + 12) % 12;
    const progs = { lament: 4, dominant: 2, vamp: 4, home: 6 };
    const chordOf = (prog, k) => GROUNDS[prog][k % GROUNDS[prog].length];
    const sample = () => Array.from({ length: 400 }, () => -2000 + rnd() * 17000);
    // 1-3. level aircraft: chord tones only, no semitone or tritone between any two, and higher altitude never gives a lower note
    out.inChord = true; out.noClash = true; out.monotone = true; let clashes = 0, notChord = 0;
    for (const prog of Object.keys(progs)) for (let k = 0; k < progs[prog]; k++) {
      const ch = CHORDS[chordOf(prog, k)], n = atChord(prog, k);
      const alts = sample(), got = notes(n, alts);
      for (const m of got) if (!ch.tones.includes(pcs(m))) { out.inChord = false; notChord++; }
      for (let a = 0; a < got.length; a++) for (let b = a + 1; b < got.length; b++) { const d = Math.abs(got[a] - got[b]) % 12, ic = Math.min(d, 12 - d); if (ic === 1 || ic === 6) { out.noClash = false; clashes++; } }
      const order = alts.map((a, i) => i).sort((x, y) => alts[x] - alts[y]);
      for (let j = 1; j < order.length; j++) if (got[order[j]] < got[order[j - 1]]) out.monotone = false;
    }
    // 4. voice leading: from any altitude, the note moves by at most a fourth at every change, wrap included
    let worst = 0;
    for (const prog of Object.keys(progs)) for (let k = 0; k < progs[prog]; k++) {
      const alts = sample(), a = notes(atChord(prog, k), alts), b = notes(atChord(prog, k + 1), alts);
      for (let j = 0; j < alts.length; j++) worst = Math.max(worst, Math.abs(a[j] - b[j]));
    }
    out.worstMove = worst;
    // 5. a voice in transit sounds the scale note beside its chord tone, on the side it is going; the thresholds are exact
    out.passing = true; out.passingBad = [];
    for (const prog of ['lament', 'dominant']) for (let k = 0; k < progs[prog]; k++) {
      const ch = CHORDS[chordOf(prog, k)], alts = sample(), n = atChord(prog, k);
      const tone = notes(n, alts), up = notes(n, alts, alts.map(() => 301)), dn = notes(n, alts, alts.map(() => -301));
      const edge = notes(n, alts, alts.map(() => 300)), edgeDn = notes(n, alts, alts.map(() => -300)), zero = notes(n, alts, alts.map(() => 0));
      const off = notes(atChord(prog, k, { passing: 'off' }), alts, alts.map(() => 1500));
      alts.forEach((_, j) => {
        const okUp = up[j] > tone[j] && up[j] - tone[j] <= 3 && ch.scale.includes(pcs(up[j])) && !ch.tones.includes(pcs(up[j]));
        const okDn = dn[j] < tone[j] && tone[j] - dn[j] <= 3 && ch.scale.includes(pcs(dn[j])) && !ch.tones.includes(pcs(dn[j]));
        if (!okUp || !okDn || edge[j] !== tone[j] || edgeDn[j] !== tone[j] || zero[j] !== tone[j] || off[j] !== tone[j]) { out.passing = false; if (out.passingBad.length < 3) out.passingBad.push([prog, k, alts[j], tone[j], up[j], dn[j], edge[j], zero[j], off[j]]); }
      });
    }
    // 6. the bass is the chord root, nearest the bottom of the window; it moves with the key; two Grounds do not share a bass
    const bassOf = (prog, k, over) => TYPES.ground.tick(atChord(prog, k, over), { in: { per: new Map([[0, 5000]]), all: null } }, { w0: 0, w1: 0.1, b0: 0, b1: 0.16, preview: true }).bass.all;
    out.bassA = [0, 1, 2, 3].map((k) => bassOf('lament', k)); out.bassC = [0, 1, 2, 3].map((k) => bassOf('lament', k, { root: '0' }));
    // 7. a missing altitude gives no note, and an altitude of 0 is an altitude; the window edges clamp
    const gaps = notes(mk(), [null, 0, 12000, -5000, 40000]);
    out.nullNote = gaps[0] == null; out.zeroNote = gaps[1] != null && gaps[1] === gaps[3]; out.hiClamp = gaps[2] === gaps[4];
    const flat = notes(mk({ lo: 5000, hi: 5000 }), [0, 5000, 9000]); out.flatWindow = flat.every((m) => Number.isFinite(m));
    // 8. the clock. Drive ticks of 0.05 s; each step event is delivered `lead` seconds before its time, as a Quantize delivers one.
    const drive = (n, stepsAtBeat, { lead = 0, to = 80, preview = false, reorder = false, together = false } = {}) => {
      const log = []; const evs = stepsAtBeat.map((b) => ({ id: '*', at: timeOfBeat(b) }));
      for (let a = 0.0137; a < to * 60 / TP.bpm; a += 0.05) {
        const w0 = a, w1 = a + 0.05, due = together ? (a < 0.06 ? evs : []) : evs.filter((e) => e.at - lead >= w0 && e.at - lead < w1);
        const o = TYPES.ground.tick(n, { in: { per: new Map([[0, 5000]]), all: null }, step: reorder ? due.reverse() : due }, { w0, w1, b0: beatAt(w0), b1: beatAt(w1), preview });
        for (const e of o.changed) log.push({ beat: +beatAt(e.at).toFixed(3), seen: w1, name: n.readout.split(' ')[0] });
      }
      return log;
    };
    const beats = (log) => log.map((x) => x.beat);
    out.openHold = JSON.stringify(beats(drive(mk(), [2, 12, 20, 24, 28, 36])));       // 16 beats before the first, 8 between
    out.openAtEdge = JSON.stringify(beats(drive(mk(), [16.5, 24.5])));                // the first change may come exactly when the first chord has been held
    out.zeroHold = JSON.stringify(beats(drive(mk({ open: 0, dwell: 0 }), [0.5, 0.5, 3])));  // 0 is a value: no hold at all
    out.lateSeen = drive(mk(), [20], { lead: 2 }).map((x) => +(x.seen - timeOfBeat(x.beat)).toFixed(2)); // delivered 2 s early, applied no earlier than its time
    out.outOfOrder = JSON.stringify(beats(drive(mk(), [28, 20], { together: true })));
    out.previewSteps = drive(mk(), [20, 30, 40], { preview: true }).length;
    const names4 = drive(mk(), [20, 30, 40, 50, 60, 70], { to: 120 }).map((x) => x.name); out.cycle = JSON.stringify(names4);
    const a1 = mk(), a2 = mk(); drive(a1, [20, 30], { to: 60 }); out.isolated = a1.st.idx === 2 && a2.st.idx === 0;
    const n3 = mk(); drive(n3, [20, 30], { to: 60 }); n3.st = TYPES.ground.init(); out.reset = JSON.stringify(beats(drive(n3, [20, 30], { to: 60 })));
    // the table itself, in A: Am G F and E major, the last with the leading tone G sharp that A natural minor lacks
    out.table = JSON.stringify(['i', 'VII', 'VI', 'V'].map((k) => CHORDS[k].tones.map((t) => (9 + t) % 12).sort((x, y) => x - y)));
    out.leadingTone = CHORDS.V.scale.includes(11) && ['i', 'VII', 'VI'].every((k) => !CHORDS[k].scale.includes(11) && CHORDS[k].scale.includes(10));
    // the chord as three notes, low to high: root, fifth, third an octave up; it follows the key and the chord
    const chordOf2 = (k, over) => { const o = TYPES.ground.tick(atChord('lament', k, over), { in: { per: new Map([[0, 5000]]), all: null } }, { w0: 0, w1: 0.1, b0: 0, b1: 0.16, preview: true }); return [...o.chord.per.entries()]; };
    out.chordA = JSON.stringify([0, 1, 2, 3].map((k) => chordOf2(k))); out.chordC = JSON.stringify(chordOf2(0, { root: '0' }));
    // 9. determinism
    const once = () => { seed = 777; return JSON.stringify(notes(mk(), sample())); };
    out.same = once() === once();
    return out;
  });
  ok('Ground: a level aircraft always sounds a tone of the chord, in every progression', GR.inChord);
  ok('Ground: no two level aircraft ever sound a semitone or a tritone together', GR.noClash);
  ok('Ground: higher altitude never gives a lower note', GR.monotone);
  ok('Ground: a note moves by at most a fourth when the chord changes, wrap included', GR.worstMove <= 5, String(GR.worstMove));
  ok('Ground: climbing sounds the scale note above the chord tone, descending the one below, only past 300 ft/min', GR.passing, JSON.stringify(GR.passingBad));
  ok('Ground: the chords are A minor, G, F and E major, and only V takes the leading tone G sharp', GR.table === '[[0,4,9],[2,7,11],[0,5,9],[4,8,11]]' && GR.leadingTone, JSON.stringify([GR.table, GR.leadingTone]));
  ok('Ground: the bass is the chord root, A2 G2 F2 E2 in A and following the key', JSON.stringify(GR.bassA) === '[45,43,41,40]' && JSON.stringify(GR.bassC) === '[36,34,32,31]', JSON.stringify([GR.bassA, GR.bassC]));
  ok('Ground: the chord output is root, fifth and third an octave up, with string keys that no aircraft id can equal', GR.chordA === '[[["root",45],["fifth",52],["third",60]],[["root",43],["fifth",50],["third",59]],[["root",41],["fifth",48],["third",57]],[["root",40],["fifth",47],["third",56]]]' && GR.chordC === '[["root",36],["fifth",43],["third",51]]', JSON.stringify([GR.chordA, GR.chordC]));
  ok('Ground: no altitude gives no note, 0 ft is an altitude, and the window clamps at both ends', GR.nullNote && GR.zeroNote && GR.hiClamp && GR.flatWindow, JSON.stringify([GR.nullNote, GR.zeroNote, GR.hiClamp, GR.flatWindow]));
  ok('Ground: the first chord is held 4 bars from play, then 2 bars between changes', GR.openHold === '[20,28,36]', GR.openHold);
  ok('Ground: a step exactly at the end of the hold turns the page', GR.openAtEdge === '[16.5,24.5]', GR.openAtEdge);
  ok('Ground: a hold of 0 bars holds nothing', GR.zeroHold === '[0.5,0.5,3]', GR.zeroHold);
  ok('Ground: a step delivered 2 s early waits for its time', GR.lateSeen.length === 1 && GR.lateSeen[0] >= 0 && GR.lateSeen[0] < 0.06, JSON.stringify(GR.lateSeen));
  ok('Ground: steps arriving together, the later one first, are taken in time order', GR.outOfOrder === '[20,28]', GR.outOfOrder);
  ok('Ground: preview mode never turns the page', GR.previewSteps === 0, String(GR.previewSteps));
  ok('Ground: the chords cycle i VII VI V and come home after four changes', GR.cycle === '["VII","VI","V","i","VII","VI"]', GR.cycle);
  ok('Ground: two blocks keep their own place in the cycle', GR.isolated);
  ok('Ground: after a reset the block is back on the first chord and holds it again', GR.reset === '[20,30]', GR.reset);
  ok('Ground: the same altitudes always give the same notes', GR.same);

  // ---- Ground, voice-led chord tones: chosen together at a change, held between changes, never at the cost of the two rules
  const VL = await p.evaluate(() => {
    const out = {};
    const mk = (over = {}) => ({ p: { ...Object.fromEntries(TYPES.ground.params.map((q) => [q.k, q.def])), ...over }, st: TYPES.ground.init() });
    const STEPS = [17, 25, 33, 41, 49, 57, 65, 73]; // the first just past the 4-bar opening hold, then every 2 bars
    // Drive blocks side by side in ticks of 0.05 s. sky(beat) -> [[id, alt ft, climb ft/min], ...]; every block sees the same sky.
    const drive = (blocks, sky, { to = 80, steps = STEPS } = {}) => {
      const logs = blocks.map(() => []), evs = steps.map((b) => ({ id: '*', at: timeOfBeat(b) }));
      for (let a = 0.0137; a < to * 60 / TP.bpm; a += 0.05) {
        const w0 = a, w1 = a + 0.05, b = beatAt(w0), ac = sky(b);
        const inp = { in: { per: new Map(ac.map(([id, alt]) => [id, alt])), all: null }, rate: { per: new Map(ac.map(([id, , vr]) => [id, vr])), all: null }, step: evs.filter((e) => e.at >= w0 && e.at < w1) };
        blocks.forEach((n, k) => { const o = TYPES.ground.tick(n, inp, { w0, w1, b0: b, b1: beatAt(w1), preview: false }); logs[k].push({ b, ch: o.changed.length, bass: o.bass.all, idx: n.st.idx, ac, notes: new Map(ac.map(([id]) => [id, Val.get(o.note, id)])) }); });
      }
      return logs;
    };
    const level = (vr) => vr == null || Math.abs(vr) <= 300;
    const place = (alt) => 45 + Math.min(Math.max(alt / 12000, 0), 1) * 36; // A2 plus three octaves over 0 to 12,000 ft, the default window
    const isPar = (a0, a1, b0, b1) => { const da = a1 - a0, db = b1 - b0; return da && db && (da > 0) === (db > 0) && Math.abs(a1 - b1) === Math.abs(a0 - b0) && [0, 7].includes(Math.abs(a1 - b1) % 12); };
    const fits = (da, ma, mb) => (Math.abs(da) <= 300 ? ma === mb : da > 0 ? ma >= mb : ma <= mb); // da: altitude of a minus b
    // parallel fifths and octaves at changes, among level voices sounding on both sides of the change, and against the bass
    const parallelsAt = (log) => { let k = 0; for (let j = 1; j < log.length; j++) if (log[j].ch) {
      const parts = log[j].ac.filter(([id, , vr]) => level(vr) && log[j - 1].notes.get(id) != null).map(([id, alt]) => [log[j - 1].notes.get(id), log[j].notes.get(id), alt]).concat([[log[j - 1].bass, log[j].bass, null]]);
      for (let x = 0; x < parts.length; x++) for (let y = x + 1; y < parts.length; y++) {
        if (parts[y][2] != null && Math.abs(parts[x][2] - parts[y][2]) <= 300) continue;
        if (isPar(parts[x][0], parts[x][1], parts[y][0], parts[y][1])) k++;
      } } return k; };
    const atChanges = (log) => log.filter((x) => x.ch).map((x) => [...x.notes.values()][0]);

    // 1. one level aircraft at 5,750 ft through two cycles of the lament. Nearest sits a twelfth above the bass on E, D, C as it
    // falls A G F, parallel fifths at i-VII and VII-VI. Voice-led takes B instead of D (5 semitones of motion against 2 plus a
    // parallel), C from B by step, and E over the dominant because B there would be a fifth parallel to C over F.
    const one = () => [['A', 5750, 0]];
    const [nr, ld] = drive([mk(), mk({ alloc: 'led' })], one);
    out.nearestSeq = JSON.stringify(atChanges(nr)); out.ledSeq = JSON.stringify(atChanges(ld));
    out.nearestPar = parallelsAt(nr); out.ledPar = parallelsAt(ld);
    // 2. between changes the led tone is held on every tick, not only struck at the change
    const firstTurn = ld.findIndex((x) => x.ch), secondTurn = ld.findIndex((x, j) => j > firstTurn && x.ch);
    out.held = ld.slice(firstTurn, secondTurn).every((x) => x.notes.get('A') === 59) && secondTurn - firstTurn > 50;
    // 3. the lead is given up, and not taken back before the next change, when the aircraft starts to move, leaves the window,
    // or leaves the sky; in each case it sounds what nearest would
    const after = (sky) => { const [l] = drive([mk({ alloc: 'led' })], sky, { to: 30 }); return l.filter((x) => x.b > 17.5 && x.b < 24.9).map((x) => x.notes.get('A')); };
    const tail = (xs) => [...new Set(xs.slice(-20))];
    const moving = after((b) => [['A', 5750, b > 19 && b < 21 ? -1000 : 0]]);
    out.moving = JSON.stringify([moving[0], [...new Set(moving.filter((_, j, xs) => j > xs.length * 0.35 && j < xs.length * 0.45))], tail(moving)]);
    const jumped = after((b) => [['A', b > 19 && b < 21 ? 7000 : 5750, 0]]);
    out.jumped = JSON.stringify([jumped[0], tail(jumped)]);
    const gone = after((b) => (b > 19 && b < 21 ? [] : [['A', 5750, 0]]));
    out.gone = JSON.stringify([gone[0], tail(gone)]);
    // 4. a held tone gives way when a newcomer would otherwise break a rule: one 450 ft below sounding higher (D over B), one 150
    // ft above sounding another note. The rule wins and both sound D, as nearest would have them.
    const pair = (alt2) => { const [l] = drive([mk({ alloc: 'led' })], (b) => [['A', 5750, 0]].concat(b > 20 ? [['B', alt2, 0]] : []), { to: 30 }); const x = l.filter((r) => r.b > 22 && r.b < 24.9); return [...new Set(x.map((r) => `${r.notes.get('A')}/${r.notes.get('B')}`))]; };
    out.below = JSON.stringify(pair(5300)); out.coAlt = JSON.stringify(pair(5900));
    // 5. preview reads the held tones and changes nothing: a preview at 7,000 ft shows the nearest G but does not drop the lead
    const pv = mk({ alloc: 'led' }); drive([pv], one, { to: 20 });
    const before = JSON.stringify([[...pv.st.led], [...pv.st.sung], pv.st.idx]);
    const tickA = (alt, preview) => Val.get(TYPES.ground.tick(pv, { in: { per: new Map([['A', alt]]), all: null }, rate: { per: new Map([['A', 0]]), all: null } }, { w0: 30, w1: 30.05, b0: 48, b1: 48.08, preview }).note, 'A');
    const seen = [tickA(5750, true), tickA(7000, true)], unchanged = JSON.stringify([[...pv.st.led], [...pv.st.sung], pv.st.idx]) === before;
    out.preview = JSON.stringify(seen) === '[59,67]' && unchanged && tickA(5750, false) === 59;
    // 5b. a voice that enters on the very tick of a change has no line to lead, so it sounds its nearest tone and the others make
    // room: B enters 450 ft below A on D, so A cannot take B below it and sounds D too
    const [nc] = drive([mk({ alloc: 'led' })], (b) => [['A', 5750, 0]].concat(b > 16.92 ? [['B', 5300, 0]] : []), { to: 22 });
    const ci = nc.findIndex((x) => x.ch);
    out.newcomer = JSON.stringify([nc[ci - 1].notes.get('B') ?? null, nc[ci].notes.get('A'), nc[ci].notes.get('B')]);
    // 5c. on a tie the nearest tone is kept. Vamp, VI to VII: from A3, G3 and B3 both cost 2; nearest is G3 at 3,500 ft, B3 at 4,025
    const tie = (alt) => { const n = mk({ prog: 'vamp', alloc: 'led' }); n.st.idx = 2; const [l] = drive([n], () => [['A', alt, 0]], { to: 20, steps: [17] }); return [l.find((x) => x.ch).notes.get('A'), l[0].notes.get('A')]; };
    out.tie = JSON.stringify([tie(3500), tie(4025)]);
    // 6. a reset forgets the leads; two blocks keep their own
    const rs = mk({ alloc: 'led' }); drive([rs], one, { to: 20 }); rs.st = TYPES.ground.init(); rs.st.idx = 1;
    out.reset = Val.get(TYPES.ground.tick(rs, { in: { per: new Map([['A', 5750]]), all: null } }, { w0: 0, w1: 0.05, b0: 0, b1: 0.08, preview: false }).note, 'A') === 62;
    const iso1 = mk({ alloc: 'led' }), iso2 = mk({ alloc: 'led' }); drive([iso1], one, { to: 20 }); drive([iso2], () => [['A', 9850, 0]], { to: 20 });
    out.isolated = iso1.st.led.get('A') === 59 && iso2.st.led.get('A') === 74;
    // 7. nearest ignores whatever the lead state holds, even a tone the hold would keep (C, 2.25 semitones from 5,750 ft)
    const nm = mk(); nm.st.led = new Map([['A', 60]]); out.defAlloc = TYPES.ground.params.find((q) => q.k === 'alloc').def;
    out.nearestIgnores = Val.get(TYPES.ground.tick(nm, { in: { per: new Map([['A', 5750]]), all: null } }, { w0: 0, w1: 0.05, b0: 0, b1: 0.08, preview: true }).note, 'A') === 64;
    // 8. more level aircraft than the search will take, at a change: nearest for all, at once
    const crowd = (b) => Array.from({ length: 9 }, (_, k) => [`c${k}`, 1000 + k * 1150, 0]);
    const t8 = performance.now(), [cn, cl] = drive([mk(), mk({ alloc: 'led' })], crowd, { to: 20 });
    out.crowd = cl.every((x, j) => [...x.notes].every(([id, m]) => cn[j].notes.get(id) === m)) && performance.now() - t8 < 3000;

    // 9. properties over seeded skies, each tick of the voice-led block checked against a nearest twin fed the same sky
    const sky = (seed, K) => {
      let s = seed; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const st = Array.from({ length: K }, () => ({ alt: Math.round(r() * 140) * 100 - 500, vr: 0, on: r() < 0.8 })), rows = [];
      for (let q = 0; q <= 330; q++) { // a quarter beat apart, to beat 82
        st.forEach((a, k) => {
          if (r() < 0.01) a.on = !a.on;
          if (r() < 0.05) a.vr = a.vr && r() < 0.7 ? 0 : (r() < 0.5 ? -1 : 1) * (400 + r() * 2000);
          else if (!a.vr && r() < 0.05) a.vr = [-300, 300, -150, 200][Math.floor(r() * 4)]; // level, up to the threshold exactly
          if (r() < 0.03) { const o = st[Math.floor(r() * K)]; a.alt = o.alt + Math.round((r() - 0.5) * 800); } // pressure on the two rules
          a.alt = Math.max(-500, Math.min(14000, a.alt + a.vr * 0.01));
        });
        rows.push(st.map((a, k) => (a.on ? [`a${k}`, a.alt, a.vr] : null)).filter(Boolean));
      }
      return (b) => rows[Math.min(rows.length - 1, Math.max(0, Math.floor(b * 4)))];
    };
    const bad = { transit: 0, chord: 0, window: 0, rule: 0, cost: 0 }, ex = []; let parNear = 0, parLed = 0, changes = 0, diffs = 0;
    const note = (msg) => { if (ex.length < 4) ex.push(msg); };
    for (const prog of Object.keys(GROUNDS)) for (let seed = 1; seed <= 12; seed++) {
      const K = 2 + (seed % 5), [nl, vl] = drive([mk({ prog }), mk({ prog, alloc: 'led' })], sky(seed * 7919 + prog.length, K), { to: 82 });
      parNear += parallelsAt(nl); parLed += parallelsAt(vl);
      vl.forEach((x, j) => {
        const ch = CHORDS[GROUNDS[prog][x.idx % GROUNDS[prog].length]], lv = x.ac.filter(([, , vr]) => level(vr));
        for (const [id, alt, vr] of x.ac) {
          const m = x.notes.get(id), mn = nl[j].notes.get(id);
          if (m !== mn) diffs++;
          if (!level(vr)) { if (m !== mn) { bad.transit++; note(['transit', prog, seed, j, id, m, mn]); } continue; }
          if (!ch.tones.includes(((m - 9) % 12 + 12) % 12)) { bad.chord++; note(['chord', prog, seed, j, id, m]); }
          if (Math.abs(m - place(alt)) > 3.5) { bad.window++; note(['window', prog, seed, j, id, m, alt]); }
        }
        for (let a = 0; a < lv.length; a++) for (let c = a + 1; c < lv.length; c++) {
          const [ia, ha] = lv[a], [ic, hc] = lv[c];
          if (fits(ha - hc, nl[j].notes.get(ia), nl[j].notes.get(ic)) && !fits(ha - hc, x.notes.get(ia), x.notes.get(ic))) { bad.rule++; note(['rule', prog, seed, j, ia, ha, x.notes.get(ia), ic, hc, x.notes.get(ic)]); }
        }
        // at a change, if nearest keeps both rules, the voice-led choice costs no more than nearest by its own measure
        if (x.ch && j > 0) {
          changes++;
          const prev = vl[j - 1].notes, keepsRules = lv.every(([ia, ha], a) => lv.every(([ic, hc], c) => c <= a || fits(ha - hc, nl[j].notes.get(ia), nl[j].notes.get(ic))));
          const cost = (now) => {
            const parts = lv.filter(([id]) => prev.get(id) != null).map(([id, alt]) => [prev.get(id), now.get(id), alt]);
            let c = parts.reduce((s, q) => s + Math.abs(q[1] - q[0]), 0); parts.push([vl[j - 1].bass, x.bass, null]);
            for (let u = 0; u < parts.length; u++) for (let v = u + 1; v < parts.length; v++) if (!(parts[v][2] != null && Math.abs(parts[u][2] - parts[v][2]) <= 300) && isPar(parts[u][0], parts[u][1], parts[v][0], parts[v][1])) c += 6;
            return c;
          };
          if (keepsRules && cost(x.notes) > cost(nl[j].notes)) { bad.cost++; note(['cost', prog, seed, j, cost(x.notes), cost(nl[j].notes)]); }
        }
      });
    }
    Object.assign(out, { bad, ex, parNear, parLed, changes, diffs });
    return out;
  });
  ok('Ground, voice-led: by default the chord tones are nearest, and nearest ignores the lead state', VL.defAlloc === 'nearest' && VL.nearestIgnores, JSON.stringify([VL.defAlloc, VL.nearestIgnores]));
  ok('Ground, voice-led: at 5,750 ft nearest walks E D C down a twelfth over the bass; voice-led sounds E B C E', VL.nearestSeq === '[62,60,64,64,62,60,64,64]' && VL.ledSeq === '[59,60,64,64,59,60,64,64]', JSON.stringify([VL.nearestSeq, VL.ledSeq]));
  ok('Ground, voice-led: that aircraft makes 4 parallel fifths with the bass under nearest and none voice-led', VL.nearestPar === 4 && VL.ledPar === 0, JSON.stringify([VL.nearestPar, VL.ledPar]));
  ok('Ground, voice-led: the led tone is held on every tick until the next change', VL.held);
  ok('Ground, voice-led: moving gives up the lead: the passing note, then the nearest tone once level again', VL.moving === '[59,[60],[62]]', VL.moving);
  ok('Ground, voice-led: leaving the window gives up the lead for good: back at 5,750 ft it sounds the nearest D', VL.jumped === '[59,[62]]', VL.jumped);
  ok('Ground, voice-led: an aircraft that leaves and comes back under the same id sounds the nearest tone', VL.gone === '[59,[62]]', VL.gone);
  ok('Ground, voice-led: a held tone gives way to a newcomer 450 ft below rather than sound under it', VL.below === '["62/62"]', VL.below);
  ok('Ground, voice-led: a held tone gives way to a newcomer 150 ft above, so co-altitude stays a unison', VL.coAlt === '["62/62"]', VL.coAlt);
  ok('Ground, voice-led: preview shows the held tone and changes no state', VL.preview);
  ok('Ground, voice-led: a voice entering on the tick of a change sounds its nearest tone, and the others make room', VL.newcomer === '[null,62,62]', VL.newcomer);
  ok('Ground, voice-led: on a tie the nearest tone is kept, whether it is the lower or the upper', VL.tie === '[[55,57],[59,57]]', VL.tie);
  ok('Ground, voice-led: a reset forgets the leads, and two blocks keep their own', VL.reset && VL.isolated, JSON.stringify([VL.reset, VL.isolated]));
  ok('Ground, voice-led: with more than 8 level aircraft at a change it keeps nearest, promptly', VL.crowd);
  ok('Ground, voice-led (seeded skies): a voice in transit sounds exactly its passing note', VL.bad.transit === 0, JSON.stringify(VL.ex));
  ok('Ground, voice-led (seeded skies): a level voice sounds a chord tone within 3.5 semitones of its altitude', VL.bad.chord === 0 && VL.bad.window === 0, JSON.stringify([VL.bad, VL.ex]));
  ok('Ground, voice-led (seeded skies): neither rule (order, co-altitude unison) is ever broken where nearest keeps it', VL.bad.rule === 0, JSON.stringify([VL.bad, VL.ex]));
  ok('Ground, voice-led (seeded skies): at every change the choice costs no more than nearest, motion plus 6 a parallel', VL.bad.cost === 0 && VL.changes > 300, JSON.stringify([VL.bad.cost, VL.changes, VL.ex]));
  ok('Ground, voice-led (seeded skies): fewer parallel fifths and octaves at changes than nearest, and the notes do differ', VL.parLed < VL.parNear && VL.diffs > 1000, JSON.stringify([VL.parNear, VL.parLed, VL.diffs]));

  // ---- the ground examples over the first capture, at the speed and tempo they open with
  const GE = await p.evaluate(async () => {
    const run = async (name, secs) => {
      preset(name); await new Promise((r) => setTimeout(r, 300));
      if ($('#capture').value !== 'push') { $('#capture').value = 'push'; await useCapture('push'); }
      resetStates();
      const g = P.nodes.find((n) => n.type === 'ground'), voices = P.nodes.filter((n) => n.type === 'voice');
      const role = new Map(voices.map((v) => [v.id, v.p.sound === 'bell' ? 'bell' : v.p.sound === 'triangle' ? 'drone' : v.p.release === 1.6 ? 'bass' : v.p.release === 1.5 ? 'restate' : 'cast']));
      const orig = TYPES.voice.tick, strikes = [], warns = new Set(), chords = [];
      TYPES.voice.tick = function (n, i, c) {
        const r = orig.call(this, n, i, c);
        if (!c.preview && i.trig) for (const e of i.trig) {
          const ids = e.id === '*' ? (i.note && i.note.per ? [...i.note.per.keys()] : ['*']) : [e.id];
          for (const id of ids) { const m = id === '*' ? Val.scalar(i.note) : (Val.get(i.note, id) ?? n.st.last.get(id)); if (m != null) strikes.push({ v: role.get(n.id), beat: +beatAt(e.at).toFixed(4), m: Math.round(m), id }); }
        }
        return r;
      };
      let a = 0.0137; const frames = [], feed = g && P.wires.find((w) => w.b[0] === g.id && w.b[1] === 'in'), rdn = feed && byId(feed.a[0]);
      for (let T = GROUND.at; T <= GROUND.at + secs * 4; T += 0.4) {
        evaluate({ w0: a, w1: a + 0.1, b0: a * 1.6, b1: (a + 0.1) * 1.6, dataT: T, preview: false });
        if (g) for (const e of g.out.changed || []) chords.push(+beatAt(e.at).toFixed(4));
        if (g) frames.push({ ch: (g.out.changed || []).length, bass: g.out.bass.all, v: [...g.out.note.per].map(([id, m]) => [id, m, Val.get(rdn.out.alt, id), Val.get(rdn.out.vr, id)]) });
        for (const n of P.nodes) if (n.warn) warns.add(`${n.type}: ${n.warn}`);
        a += 0.1;
      }
      TYPES.voice.tick = orig;
      const by = (r) => strikes.filter((s) => s.v === r);
      return { name, warns: [...warns], chords, strikes, frames, bass: by('bass'), cast: by('cast'), bell: by('bell'), restate: by('restate'), drone: by('drone'), bars: Math.floor(secs * 1.6 / 4), types: P.nodes.map((n) => n.type),
        voices: voices.map((v) => ({ role: role.get(v.id), strum: v.p.strum, poly: v.p.poly, ring: v.p.attack + 1.6 * v.p.release })), firstCast: Math.min(...by('cast').map((s) => s.beat)) };
    };
    const A = await run('ground', 400), A2 = await run('ground', 400), B = await run('groundclock', 200), S = await run('groundshift', 400), M = await run('groundstrum', 400), T = await run('groundthin', 400), C = await run('groundcast', 400), L = await run('groundled', 400);
    const gaps = (r) => r.chords.slice(1).map((b, i) => b - r.chords[i]);
    const all = A.cast.concat(A.bell, A.restate), onBar = (r) => r.chords.every((b) => Math.abs(b % 4) < 1e-3);
    // thin: a note struck again for the same aircraft is either a new note or at least `every` bars after the last strike
    const repeats = (r) => { const last = new Map(); let n = 0, soon = 0; for (const s of r.cast) { const l = last.get(s.id); if (l && l.m === s.m) { n++; if (s.beat - l.beat < 15.99) soon++; } last.set(s.id, s); } return { n, soon }; };
    // strum: each bar's bass event strikes three notes, low to high, the first the root
    const strumBars = M.bass.length === 3 * M.bars && M.bass.every((s, k, arr) => k % 3 === 0 || s.m > arr[k - 1].m) && M.bass.every((s, k) => k % 3 !== 0 || [45, 43, 41, 40].includes(s.m));
    // a note rings for attack + 1.6 x release, and a Voice drops a note struck while it already holds `voices` of them
    const room = (r) => r.voices.filter((v) => v.role !== 'drone').map((v) => { // the Radar director's own drone is left out: 2 voices for 11 s notes, as in the director
      const t = r.strikes.filter((x) => x.v === v.role).map((x) => x.beat * 60 / 96).sort((a, b) => a - b);
      let most = 0; t.forEach((at, i) => { let n = 0; for (let j = 0; j <= i; j++) if (t[j] + v.ring > at) n++; most = Math.max(most, n); });
      return most <= v.poly ? null : `${r.name} ${v.role}: ${most} at once, ceiling ${v.poly}`;
    }).filter(Boolean);
    const terrainPcs = [9, 2, 4, 5, 7];
    // among level voices: parallel fifths and octaves at changes (co-altitude pairs are one voice), and the two rules on every tick
    const lead = (r) => {
      let pp = 0, rule = 0; const lvl = (x) => x[1] != null && (x[3] == null || Math.abs(x[3]) <= 300);
      const isPar = (a0, a1, b0, b1) => { const da = a1 - a0, db = b1 - b0; return da && db && (da > 0) === (db > 0) && Math.abs(a1 - b1) === Math.abs(a0 - b0) && [0, 7].includes(Math.abs(a1 - b1) % 12); };
      r.frames.forEach((f, k) => {
        const L = f.v.filter(lvl);
        for (let x = 0; x < L.length; x++) for (let y = x + 1; y < L.length; y++) { const d = L[x][2] - L[y][2]; if (Math.abs(d) <= 300 ? L[x][1] !== L[y][1] : (d > 0 ? L[x][1] < L[y][1] : L[x][1] > L[y][1])) rule++; }
        if (!k || !f.ch) return;
        const prev = new Map(r.frames[k - 1].v.map((x) => [x[0], x[1]]));
        const parts = L.filter((x) => prev.get(x[0]) != null).map((x) => [prev.get(x[0]), x[1], x[2]]).concat([[r.frames[k - 1].bass, f.bass, null]]);
        for (let x = 0; x < parts.length; x++) for (let y = x + 1; y < parts.length; y++) if (!(parts[y][2] != null && Math.abs(parts[x][2] - parts[y][2]) <= 300) && isPar(parts[x][0], parts[x][1], parts[y][0], parts[y][1])) pp++;
      });
      return { pp, rule };
    };
    return { ledChords: JSON.stringify(L.chords) === JSON.stringify(A.chords), leadA: lead(A), leadL: lead(L), ledType: L.types.includes('ground') && P.nodes.find((n) => n.type === 'ground').p.alloc === 'led',
      ledRange: L.cast.concat(L.bell, L.restate).every((s) => s.m >= 43 && s.m <= 84), ledRestate: L.chords.every((cb) => L.restate.some((s) => Math.abs(s.beat - cb) < 1e-3)),
      warns: [A, B, S, M, T, L, C].flatMap((r) => r.warns.map((w) => `${r.name} ${w}`)), firstChange: A.chords[0], nChanges: A.chords.length, onBar: onBar(A), minGap: Math.min(...gaps(A)),
      bassPerBar: A.bass.length === A.bars, bassNotes: [...new Set(A.bass.map((s) => s.m))].sort((x, y) => x - y),
      bassOnBar: A.bass.every((s) => Math.abs(s.beat % 4) < 1e-3 || Math.abs((s.beat % 4) - 4) < 1e-3), bellOnBeat: A.bell.every((s) => Math.abs(s.beat - Math.round(s.beat)) < 1e-3),
      restateAtChange: A.chords.every((cb) => A.restate.some((s) => Math.abs(s.beat - cb) < 1e-3)), restateOnlyAtChange: A.restate.every((s) => A.chords.some((cb) => Math.abs(s.beat - cb) < 1e-3)),
      noteRange: [Math.min(...all.map((s) => s.m)), Math.max(...all.map((s) => s.m))], voices: A.cast.length > 50 && A.bell.length > 5, firstCast: A.firstCast,
      clockGaps: [...new Set(gaps(B).map((g) => +g.toFixed(3)))], clockFirst: B.chords[0], clockOnBar: onBar(B),
      shiftDiffers: JSON.stringify(S.chords) !== JSON.stringify(A.chords), shiftOk: S.chords.length >= 8 && onBar(S) && S.chords[0] >= 16 && Math.min(...gaps(S)) >= 8, shiftCount: [A.chords.length, S.chords.length],
      strumBars, strumVoice: M.voices.some((v) => v.role === 'bass' && v.strum === 60 && v.poly >= 3), strumChanges: JSON.stringify(M.chords) === JSON.stringify(A.chords),
      thinFewer: T.cast.length < A.cast.length, thinRepeats: repeats(T), baseRepeats: repeats(A), thinSameChords: JSON.stringify(T.chords) === JSON.stringify(A.chords),
      castOnlyTypes: !C.types.includes('ground') && C.types.includes('scale') && C.types.includes('leveloff'), castOnlyNotes: C.cast.concat(C.bell).every((s) => terrainPcs.includes(((s.m % 12) + 12) % 12) && s.m >= 45 && s.m <= 81),
      castOnlyDrone: C.drone.length > 10 && C.drone.every((s) => s.m === 33), castOnlySings: C.cast.length > 50 && C.bell.length > 5,
      noRoom: [A, B, S, M, T, L, C].flatMap(room),
      same: JSON.stringify(A.strikes) === JSON.stringify(A2.strikes) && JSON.stringify(A.chords) === JSON.stringify(A2.chords) };
  });
  ok('ground examples: every block is connected and none warns, in all seven', GE.warns.length === 0, JSON.stringify(GE.warns));
  ok('ground example: the first chord is held for 4 bars, and the page turns at least every 2 bars after', GE.firstChange >= 16 && GE.minGap >= 8 && GE.nChanges >= 10, JSON.stringify([GE.firstChange, GE.minGap, GE.nChanges]));
  ok('ground example: every change lands on a bar line', GE.onBar);
  ok('ground example: one bass note on every bar, from A2 G2 F2 E2', GE.bassPerBar && GE.bassOnBar && JSON.stringify(GE.bassNotes) === '[40,41,43,45]', JSON.stringify([GE.bassPerBar, GE.bassOnBar, GE.bassNotes]));
  ok('ground example: level-off bells fall on the beat', GE.bellOnBeat && GE.voices, String(GE.voices));
  ok('ground example: the cast restates the chord at every change and at no other time', GE.restateAtChange && GE.restateOnlyAtChange, JSON.stringify([GE.restateAtChange, GE.restateOnlyAtChange]));
  ok('ground example: the voices stay between G2 and C6', GE.noteRange[0] >= 43 && GE.noteRange[1] <= 84, JSON.stringify(GE.noteRange));
  ok('ground example: the cast is singing within the first turn of the sweep, not after a silent opening', GE.firstCast < 8, String(GE.firstCast));
  ok('ground on a clock: the page turns every 24 beats, on the bar line', GE.clockGaps.length === 1 && GE.clockGaps[0] === 24 && GE.clockFirst >= 16 && GE.clockOnBar, JSON.stringify([GE.clockGaps, GE.clockFirst, GE.clockOnBar]));
  ok('ground, shifted sky: the page turns at other times than with the real sky, under the same rules', GE.shiftDiffers && GE.shiftOk, JSON.stringify([GE.shiftDiffers, GE.shiftOk, GE.shiftCount]));
  ok('ground, strummed: each bar strikes the chord low to high, from the root, with the strum on', GE.strumBars && GE.strumVoice && GE.strumChanges, JSON.stringify([GE.strumBars, GE.strumVoice, GE.strumChanges]));
  ok('ground, thinned: fewer cast strikes, no held note struck again inside 4 bars, the chords unchanged', GE.thinFewer && GE.thinRepeats.soon === 0 && GE.baseRepeats.soon > 0 && GE.thinSameChords, JSON.stringify([GE.thinFewer, GE.thinRepeats, GE.baseRepeats, GE.thinSameChords]));
  ok('ground, voice-led: a Ground block set to voice-led, turning the page exactly when Ground does', GE.ledType && GE.ledChords, JSON.stringify([GE.ledType, GE.ledChords]));
  ok('ground, voice-led: at most a third of Ground\'s parallel fifths and octaves at changes, with both rules unbroken on every tick', GE.leadA.pp >= 10 && GE.leadL.pp * 3 <= GE.leadA.pp && GE.leadA.rule === 0 && GE.leadL.rule === 0, JSON.stringify([GE.leadA, GE.leadL]));
  ok('ground, voice-led: the cast restates the chord at every change, and the voices stay between G2 and C6', GE.ledRestate && GE.ledRange, JSON.stringify([GE.ledRestate, GE.ledRange]));
  ok('cast only: the same cast and bells on the terrain scale, no Ground, the director\'s drone', GE.castOnlyTypes && GE.castOnlyNotes && GE.castOnlyDrone && GE.castOnlySings, JSON.stringify([GE.castOnlyTypes, GE.castOnlyNotes, GE.castOnlyDrone, GE.castOnlySings]));
  ok('ground examples: no voice is asked for more notes at once than its ceiling', GE.noRoom.length === 0, JSON.stringify(GE.noRoom));
  ok('ground example: two runs from the same start give the same notes', GE.same);

  // ---- the duet example over the first capture, at the speed and tempo it opens with
  const D = await p.evaluate(() => {
    preset('duet');
    const nodes = (t) => P.nodes.filter((n) => n.type === t);
    const cl = nodes('closest')[0], pu = nodes('pulse')[0];
    const segs = []; let cur = null, a = 0; const pulses = [], close = [], passed = [];
    for (let T = DUET.at - 20; T <= 1000; T += 0.4) { // 0.4 s of data is 0.1 s of audio at the default 4x
      evaluate({ w0: a, w1: a + 0.1, b0: a * 1.6, b1: (a + 0.1) * 1.6, dataT: T, preview: false });
      const o = cl.out || {}, ids = (o.pair || []).map((x) => x.id).sort().join('|');
      if (ids.includes('|')) {
        if (!cur || cur.ids !== ids) { cur = { ids, types: o.pair.map((x) => x.type).sort().join('/'), from: T, to: T, tau0: o.tau.all }; segs.push(cur); }
        cur.to = T;
      } else cur = null;
      for (const e of (pu.out && pu.out.tick) || []) pulses.push({ at: e.at, T });
      for (const e of o.close || []) close.push(T);
      for (const e of o.passed || []) passed.push(T);
      a += 0.1;
    }
    const first = segs[0];
    const inFirst = pulses.filter((x) => x.T >= first.from && x.T <= first.to + 0.5).map((x) => x.at);
    // Each pulse strikes both aircraft's notes, and a note rings for attack + 1.6 x release; a Voice drops notes beyond its ceiling.
    const trig = P.wires.find((w) => w.a[0] === pu.id && w.a[1] === 'tick'), voice = byId(trig.b[0]);
    const gapsNow = inFirst.slice(1).map((x, i) => x - inFirst[i]);
    const ringing = 2 * (voice.p.attack + 1.6 * voice.p.release) / Math.min(...gapsNow);
    return { ringing, poly: voice.p.poly, segs: segs.map((s) => `${s.types} ${Math.round(s.from)}-${Math.round(s.to)}`), firstTypes: first.types, firstTau: first.tau0,
      gaps: inFirst.slice(1).map((x, i) => x - inFirst[i]), close, passed, start: DUET.at };
  });
  console.log('      segments:', D.segs.join(' | '), '| close at', D.close.map(Math.round).join(','), '| passed at', D.passed.map(Math.round).join(','));
  ok('duet example: opens on the Boeing 737 MAX and the Cessna T206', D.firstTypes === 'B39M/T206', D.firstTypes);
  ok('duet example: engaged with at most 90 s to go', D.firstTau <= 90, String(D.firstTau));
  ok('duet example: the pulse speeds up through the encounter', D.gaps.length >= 8 && D.gaps[0] > 3 * D.gaps[D.gaps.length - 1], JSON.stringify([D.gaps.length, D.gaps[0], D.gaps[D.gaps.length - 1]]));
  ok('duet example: no gap is more than 25% longer than the one before it', D.gaps.every((g, i) => i === 0 || g <= D.gaps[i - 1] * 1.25), JSON.stringify(D.gaps.map((g) => +g.toFixed(2))));
  ok('duet example: the voice has room for the notes still ringing at the fastest pulse', D.ringing <= D.poly, `${D.ringing.toFixed(1)} notes ringing against a ceiling of ${D.poly}`);
  ok('duet example: one close pass and one "passed" for that pair', D.close.filter((t) => t < 900).length === 1 && D.passed.filter((t) => t < 900).length === 1, JSON.stringify([D.close, D.passed]));

  await b.close();
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
