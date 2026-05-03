// Bow parameters — Schelleng workshop front-end.
// Schelleng (1973): F_max = k_max · v / β, F_min = k_min · v / β².
// Bow-speed changes shift both curves the same log-distance vertically —
// the pedagogical hook of the whole tool.

const BETA_MIN = 0.015, BETA_MAX = 0.25;
const F_MIN = 0.01, F_MAX = 30;
const K_MAX = 0.5, K_MIN = 0.0012;

// Worklet output is loudness-saturated via tanh, so it sits near full
// scale. Attenuate here for comfortable headphone listening; phone
// speakers stay audible because the source is already hot.
const MASTER_GAIN = 0.05;

const PLOT = { x: 66, y: 40, w: 500, h: 500 };

const PRESETS = {
  tasto:        { beta: 0.18,  f: 0.54, v: 0.90 },
  flautando:    { beta: 0.10,  f: 0.09, v: 1.65 },
  ordinario:    { beta: 0.075, f: 1.65, v: 1.14 },
  ponticello:   { beta: 0.025, f: 2.40, v: 0.75 },
  overpressure: { beta: 0.08,  f: 12.0, v: 0.75 },
  schnarr:      { beta: 0.05,  f: 19.5, v: 0.36 }
};

const REGION_COPY = {
  ordinario: {
    name: 'ordinario',
    text: 'Helmholtz corner motion — pitched, evenly voiced.'
  },
  tasto: {
    name: 'sul tasto',
    text: 'Helmholtz, broadly spaced — softer, upper partials damped.'
  },
  ponticello: {
    name: 'sul ponticello',
    text: 'Helmholtz, but crowded near the bridge — glassy, upper-partial rich.'
  },
  flautando: {
    name: 'flautando',
    text: 'Below F_min — string surface-slips, the fundamental starves.'
  },
  'ponticello-floor': {
    name: 'sul ponticello (whistling)',
    text: 'Below F_min with the bow on top of the bridge — subharmonics, whistle tones.'
  },
  overpressure: {
    name: 'overpressure',
    text: 'Above F_max — Helmholtz motion collapses, the bow crushes the string.'
  },
  schnarr: {
    name: 'Schnarrklang',
    text: 'Far above F_max — a rattle; periodic motion barely holds.'
  }
};

const PITCH_MIN_HZ = 65.41;   // C2
const PITCH_MAX_HZ = 659.26;  // E5
const PITCH_DEFAULT_HZ = 220; // A3

const state = {
  beta: 0.075,
  f: 1.65,
  v: 1.14,
  f0: PITCH_DEFAULT_HZ,
  audio: { ctx: null, node: null, on: false, pending: null, failed: false },
  anim: null
};

// ---------- pitch helpers ----------
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function hzToSemitone(hz) { return 12 * Math.log2(hz / 220); } // semitones from A3
function semitoneToHz(s)  { return 220 * Math.pow(2, s / 12); }
function hzToNoteName(hz) {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
// Mild loudness compensation so low pitches aren't swallowed by small
// speakers and high pitches aren't piercing. Unity at 220 Hz, ~+2.5 dB at
// 65 Hz, ~-2.5 dB at 660 Hz. Well under the worklet's tanh headroom.
function pitchGainFor(hz) {
  const g = Math.pow(220 / hz, 0.28);
  return Math.max(0.6, Math.min(1.35, g));
}
function clampHz(hz) { return Math.max(PITCH_MIN_HZ, Math.min(PITCH_MAX_HZ, hz)); }

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

// ---------- coordinate math ----------
function log(x) { return Math.log(x); }
function betaToX(b) {
  const t = (log(b) - log(BETA_MIN)) / (log(BETA_MAX) - log(BETA_MIN));
  return PLOT.x + t * PLOT.w;
}
function forceToY(f) {
  const t = (log(f) - log(F_MIN)) / (log(F_MAX) - log(F_MIN));
  return PLOT.y + (1 - t) * PLOT.h;
}
function xToBeta(x) {
  const t = (x - PLOT.x) / PLOT.w;
  return Math.exp(log(BETA_MIN) + t * (log(BETA_MAX) - log(BETA_MIN)));
}
function yToForce(y) {
  const t = 1 - (y - PLOT.y) / PLOT.h;
  return Math.exp(log(F_MIN) + t * (log(F_MAX) - log(F_MIN)));
}
function fMaxAt(b, v) { return K_MAX * v / b; }
function fMinAt(b, v) { return K_MIN * v / (b * b); }
function clampLog(f) { return Math.max(F_MIN * 0.999, Math.min(F_MAX * 1.001, f)); }

function classify(b, f, v) {
  const fmax = fMaxAt(b, v), fmin = fMinAt(b, v);
  if (f > fmax) return f > fmax * 2.2 ? 'schnarr' : 'overpressure';
  if (f < fmin) return b < 0.05 ? 'ponticello-floor' : 'flautando';
  if (b < 0.04) return 'ponticello';
  if (b > 0.13) return 'tasto';
  return 'ordinario';
}

// ---------- SVG build ----------
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function buildSvg() {
  const svg = $('plot');
  svg.innerHTML = '';

  // Tick labels (outside plot area).
  [0.02, 0.05, 0.1, 0.2].forEach(b => {
    const x = betaToX(b);
    const t = el('text', { x, y: PLOT.y + PLOT.h + 16, 'text-anchor': 'middle', class: 'tick-label' }, svg);
    t.textContent = b.toString();
  });
  [0.01, 0.1, 1, 10].forEach(f => {
    const y = forceToY(f);
    const t = el('text', { x: PLOT.x - 8, y: y + 3, 'text-anchor': 'end', class: 'tick-label' }, svg);
    t.textContent = f.toString();
  });

  // Axis titles.
  const xlab = el('text', {
    x: PLOT.x + PLOT.w / 2, y: PLOT.y + PLOT.h + 36,
    'text-anchor': 'middle', class: 'axis-label'
  }, svg);
  xlab.textContent = 'β — bow–bridge distance / string length (log)';
  const ylab = el('text', {
    x: 16, y: PLOT.y + PLOT.h / 2,
    transform: `rotate(-90 16 ${PLOT.y + PLOT.h / 2})`,
    'text-anchor': 'middle', class: 'axis-label'
  }, svg);
  ylab.textContent = 'F — bow force (log, arbitrary)';

  // Region fills (behind everything else in the plot).
  el('path', { id: 'region-over',  class: 'region-over'  }, svg);
  el('path', { id: 'region-helm',  class: 'region-helm'  }, svg);
  el('path', { id: 'region-floor', class: 'region-floor' }, svg);

  // Gridlines on top of region fills.
  [0.02, 0.05, 0.1, 0.2].forEach(b => {
    const x = betaToX(b);
    el('line', { x1: x, x2: x, y1: PLOT.y, y2: PLOT.y + PLOT.h, class: 'grid' }, svg);
  });
  [0.01, 0.1, 1, 10].forEach(f => {
    const y = forceToY(f);
    el('line', { x1: PLOT.x, x2: PLOT.x + PLOT.w, y1: y, y2: y, class: 'grid' }, svg);
  });

  // Plot frame on top of grid so its outline is crisp.
  el('rect', { x: PLOT.x, y: PLOT.y, width: PLOT.w, height: PLOT.h, class: 'axis' }, svg);

  // Boundary curves.
  el('path', { id: 'curve-max', class: 'boundary boundary-max' }, svg);
  el('path', { id: 'curve-min', class: 'boundary boundary-min' }, svg);

  // Boundary labels.
  const lmax = el('text', { id: 'label-max', class: 'boundary-label' }, svg);
  lmax.textContent = 'F_max ∝ v / β';
  const lmin = el('text', { id: 'label-min', class: 'boundary-label' }, svg);
  lmin.textContent = 'F_min ∝ v / β²';

  // Region labels.
  const labels = [
    ['label-tasto', 'sul tasto'],
    ['label-ord',   'ordinario'],
    ['label-pont',  'sul ponticello'],
    ['label-flaut', 'flautando / squeak'],
    ['label-crush', 'overpressure']
  ];
  labels.forEach(([id, text]) => {
    const t = el('text', { id, class: 'region-label' }, svg);
    t.textContent = text;
  });

  // v-tick on right axis.
  el('line', { id: 'v-tick', class: 'v-tick',
    x1: PLOT.x + PLOT.w + 4, x2: PLOT.x + PLOT.w + 12,
    y1: 0, y2: 0 }, svg);
  const vt = el('text', { id: 'v-tick-label', class: 'v-tick-label',
    x: PLOT.x + PLOT.w + 16, y: 0 }, svg);
  vt.textContent = 'v';

  // Puck.
  el('circle', { id: 'puck-hit', class: 'puck-hit', r: 22 }, svg);
  el('circle', { id: 'puck', class: 'puck', r: 9 }, svg);
}

// ---------- rendering ----------
function samplesAlongBeta(fn, n = 60) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const b = Math.exp(log(BETA_MIN) + (i / n) * (log(BETA_MAX) - log(BETA_MIN)));
    out.push({ b, x: betaToX(b), f: fn(b) });
  }
  return out;
}

function updateCurves() {
  const v = state.v;
  const topY = PLOT.y, botY = PLOT.y + PLOT.h;
  const mxS = samplesAlongBeta(b => fMaxAt(b, v));
  const mnS = samplesAlongBeta(b => fMinAt(b, v));

  const mxPath = mxS.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${forceToY(clampLog(p.f)).toFixed(2)}`).join('');
  const mnPath = mnS.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${forceToY(clampLog(p.f)).toFixed(2)}`).join('');
  $('curve-max').setAttribute('d', mxPath);
  $('curve-min').setAttribute('d', mnPath);

  // Region: above F_max → overpressure
  const over = `M${mxS[0].x},${topY}` +
    mxS.map(p => `L${p.x.toFixed(2)},${forceToY(clampLog(p.f)).toFixed(2)}`).join('') +
    `L${mxS[mxS.length - 1].x},${topY}Z`;

  // Region: below F_min → floor
  const floor = `M${mnS[0].x},${botY}` +
    mnS.map(p => `L${p.x.toFixed(2)},${forceToY(clampLog(p.f)).toFixed(2)}`).join('') +
    `L${mnS[mnS.length - 1].x},${botY}Z`;

  // Helmholtz band between.
  const top = mxS.map(p => `L${p.x.toFixed(2)},${forceToY(clampLog(p.f)).toFixed(2)}`).join('');
  const bot = mnS.slice().reverse()
    .map(p => `L${p.x.toFixed(2)},${forceToY(clampLog(p.f)).toFixed(2)}`).join('');
  const helm = `M${mxS[0].x},${forceToY(clampLog(mxS[0].f))}` + top + bot + 'Z';

  $('region-over').setAttribute('d', over);
  $('region-helm').setAttribute('d', helm);
  $('region-floor').setAttribute('d', floor);

  // Region label positions — geometric mean of bounds at a few β anchors.
  const midY = (b) => forceToY(clampLog(Math.sqrt(fMinAt(b, v) * fMaxAt(b, v))));
  $('label-tasto').setAttribute('x', betaToX(0.18));  $('label-tasto').setAttribute('y', midY(0.18));
  $('label-ord'  ).setAttribute('x', betaToX(0.075)); $('label-ord'  ).setAttribute('y', midY(0.075));
  $('label-pont' ).setAttribute('x', betaToX(0.023)); $('label-pont' ).setAttribute('y', midY(0.023));

  $('label-flaut').setAttribute('x', betaToX(0.12));
  $('label-flaut').setAttribute('y', forceToY(clampLog(Math.max(F_MIN * 1.5, fMinAt(0.12, v) * 0.35))));

  $('label-crush').setAttribute('x', betaToX(0.10));
  $('label-crush').setAttribute('y', forceToY(clampLog(Math.min(F_MAX * 0.7, fMaxAt(0.10, v) * 2.8))));

  // Boundary curve labels: just to the right of where F_max crosses visible range
  const mxLabelB = 0.22;
  $('label-max').setAttribute('x', betaToX(mxLabelB) - 2);
  $('label-max').setAttribute('y', forceToY(clampLog(fMaxAt(mxLabelB, v))) - 6);
  $('label-max').setAttribute('text-anchor', 'end');

  const mnLabelB = 0.04;
  $('label-min').setAttribute('x', betaToX(mnLabelB) + 4);
  $('label-min').setAttribute('y', forceToY(clampLog(fMinAt(mnLabelB, v))) - 6);

  // v-tick: use it to mark where F_max meets β = 0.1 (reference point on right edge).
  const vY = forceToY(clampLog(fMaxAt(0.1, v)));
  $('v-tick').setAttribute('y1', vY);
  $('v-tick').setAttribute('y2', vY);
  $('v-tick-label').setAttribute('y', vY + 3);
}

function updatePuck() {
  const x = betaToX(state.beta), y = forceToY(state.f);
  $('puck').setAttribute('cx', x); $('puck').setAttribute('cy', y);
  $('puck-hit').setAttribute('cx', x); $('puck-hit').setAttribute('cy', y);
}

// ---------- words for sliders ----------
function betaWords(b) {
  if (b < 0.03) return 'on the bridge';
  if (b < 0.06) return 'near the bridge';
  if (b < 0.10) return 'ordinary distance';
  if (b < 0.16) return 'toward fingerboard';
  return 'over the fingerboard';
}
function vWords(v) {
  if (v < 0.30) return 'crawling';
  if (v < 0.66) return 'slow détaché';
  if (v < 1.35) return 'moderato';
  if (v < 2.40) return 'flowing';
  return 'fast';
}
function fWords(f) {
  if (f < 0.15) return 'feather';
  if (f < 0.6)  return 'light';
  if (f < 2.4)  return 'medium';
  if (f < 7.5)  return 'firm';
  return 'pressed hard';
}

function couplingObservation(s, region) {
  const fmax = fMaxAt(s.beta, s.v), fmin = fMinAt(s.beta, s.v);
  const base = REGION_COPY[region].text;
  let hint = '';
  if (region === 'ordinario' || region === 'tasto' || region === 'ponticello') {
    const headUp = Math.log(fmax / s.f);
    const headDown = Math.log(s.f / fmin);
    if (headUp < 0.45) {
      hint = ' Halve the speed and this becomes overpressure — without moving the bow.';
    } else if (headDown < 0.45) {
      hint = ' A whisker less force, or a slower bow, and the tone slips into flautando.';
    } else if (s.beta < 0.05) {
      hint = ' Stay here and press harder: ponticello-as-timbre lives where F clears F_min.';
    } else {
      hint = ' Try lowering bow speed — the ceiling drops with it.';
    }
  } else if (region === 'flautando' || region === 'ponticello-floor') {
    hint = ' Press harder, or slow the bow — the pitched tone snaps back.';
  } else if (region === 'overpressure' || region === 'schnarr') {
    hint = ' Move toward the fingerboard, or speed up, and the ceiling lifts.';
  }
  return base + hint;
}

function updateReadout() {
  const region = classify(state.beta, state.f, state.v);
  const copy = REGION_COPY[region];
  $('regionName').textContent = copy.name;
  $('coupling').textContent = couplingObservation(state, region);
  $('betaVal').textContent = state.beta.toFixed(3);
  $('vVal').textContent    = state.v.toFixed(2);
  $('fVal').textContent    = state.f.toFixed(2);
  $('betaDesc').textContent = betaWords(state.beta);
  $('vDesc').textContent    = vWords(state.v);
  $('fDesc').textContent    = fWords(state.f);
  $('vOut').textContent     = state.v.toFixed(2);
  $('vSlider').value        = state.v;
  const pitchOut = $('pitchOut');
  if (pitchOut) {
    pitchOut.textContent = `${hzToNoteName(state.f0)} · ${Math.round(state.f0)} Hz`;
  }

  // Preset chip highlighting: require near-match on all three axes.
  document.querySelectorAll('#chips button').forEach(b => b.classList.remove('active'));
  const near = Object.entries(PRESETS).find(([_, p]) =>
    Math.abs(Math.log(p.beta / state.beta)) < 0.09 &&
    Math.abs(Math.log(p.f    / state.f))    < 0.18 &&
    Math.abs(p.v - state.v) < 0.035
  );
  if (near) document.querySelector(`#chips [data-preset="${near[0]}"]`)?.classList.add('active');
}

function updateAll() {
  updateCurves();
  updatePuck();
  updateReadout();
}

// ---------- drag ----------
function initDrag() {
  const svg = $('plot');
  let dragging = false;

  function toLocal(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function apply(evt, abrupt) {
    const { x, y } = toLocal(evt);
    const cx = Math.max(PLOT.x, Math.min(PLOT.x + PLOT.w, x));
    const cy = Math.max(PLOT.y, Math.min(PLOT.y + PLOT.h, y));
    state.beta = xToBeta(cx);
    state.f    = yToForce(cy);
    updatePuck();
    updateReadout();
    pushAudio(abrupt);
    if (abrupt) softRetrigger();
    $('diagramHint')?.classList.add('faded');
  }

  svg.addEventListener('pointerdown', (e) => {
    const { x, y } = toLocal(e);
    if (x < PLOT.x - 10 || x > PLOT.x + PLOT.w + 10 ||
        y < PLOT.y - 10 || y > PLOT.y + PLOT.h + 10) return;
    dragging = true;
    try { svg.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    cancelPresetAnim();
    apply(e, true);
  });
  svg.addEventListener('pointermove', (e) => { if (dragging) apply(e); });
  const stop = () => { dragging = false; };
  svg.addEventListener('pointerup', stop);
  svg.addEventListener('pointercancel', stop);
  svg.addEventListener('pointerleave', stop);
}

// ---------- presets (animated) ----------
function cancelPresetAnim() {
  if (state.anim) { cancelAnimationFrame(state.anim); state.anim = null; }
}
function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  cancelPresetAnim();
  softRetrigger();
  pushAudio(true);
  const from = { beta: state.beta, f: state.f, v: state.v };
  const start = performance.now();
  const dur = 550;
  function step(t) {
    const k = Math.min(1, (t - start) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    state.beta = Math.exp(log(from.beta) * (1 - e) + log(p.beta) * e);
    state.f    = Math.exp(log(from.f)    * (1 - e) + log(p.f)    * e);
    state.v    = from.v * (1 - e) + p.v * e;
    updateAll();
    pushAudio();
    if (k < 1) state.anim = requestAnimationFrame(step);
    else state.anim = null;
  }
  state.anim = requestAnimationFrame(step);
}

// ---------- audio ----------
async function ensureAudio() {
  if (state.audio.ctx) return true;
  if (state.audio.failed) return false;
  if (state.audio.pending) return state.audio.pending;
  state.audio.pending = (async () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || typeof AudioWorkletNode === 'undefined') throw new Error('no audio worklet');
      const ctx = new Ctx();
      // Resume immediately while still inside the user-gesture call stack;
      // iOS Safari ignores resume() once any await breaks the gesture chain.
      if (ctx.state === 'suspended') await ctx.resume();
      await ctx.audioWorklet.addModule('bowed-string-worklet.js');
      const node = new AudioWorkletNode(ctx, 'bowed-string', { outputChannelCount: [1] });
      node.parameters.get('beta').value  = state.beta;
      node.parameters.get('force').value = state.f;
      node.parameters.get('vBow').value  = state.v;
      node.parameters.get('f0').value    = state.f0;
      node.parameters.get('gate').value  = 0;
      const gain = ctx.createGain();
      gain.gain.value = MASTER_GAIN;
      const pitchGain = ctx.createGain();
      pitchGain.gain.value = pitchGainFor(state.f0);
      node.connect(gain).connect(pitchGain).connect(ctx.destination);
      state.audio.ctx = ctx;
      state.audio.node = node;
      state.audio.gain = gain;
      state.audio.pitchGain = pitchGain;
      return true;
    } catch (err) {
      state.audio.failed = true;
      const p = $('audioStatus');
      p.textContent = 'audio unavailable in this browser';
      p.classList.remove('hidden');
      $('audioToggle').disabled = true;
      return false;
    }
  })();
  return state.audio.pending;
}

let toggling = false;
async function toggleAudio() {
  if (toggling) return;
  toggling = true;
  try {
    const ok = await ensureAudio();
    if (!ok) return;
    const { ctx, node } = state.audio;
    if (ctx.state === 'suspended') await ctx.resume();
    state.audio.on = !state.audio.on;
    // When turning off, kill the gate immediately.
    // When turning on, keep gate=0; the first user interaction
    // (diagram tap, preset, slider, keyboard) will open the gate,
    // avoiding a loud surprise at max volume.
    if (!state.audio.on) node.parameters.get('gate').value = 0;
    const btn = $('audioToggle');
    btn.setAttribute('aria-pressed', state.audio.on ? 'true' : 'false');
    btn.querySelector('.icon').textContent = state.audio.on ? '🔈' : '🔇';
    btn.querySelector('.label').textContent = state.audio.on ? 'sound on' : 'sound off';
  } finally {
    toggling = false;
  }
}

// ---------- theme ----------
function applyTheme(light) {
  document.documentElement.classList.toggle('light', light);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
  const btn = $('themeToggle');
  btn.querySelector('.icon').textContent = light ? '\u{1F319}' : '\u{2600}\u{FE0F}';
  btn.querySelector('.label').textContent = light ? 'dark' : 'light';
  btn.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
}
function toggleTheme() {
  const goLight = !document.documentElement.classList.contains('light');
  applyTheme(goLight);
  try { localStorage.setItem('bow-parameters:theme', goLight ? 'light' : 'dark'); } catch {}
}

function pushAudio(microfade) {
  const n = state.audio.node;
  if (!n) return;
  // Open the gate on the first interaction after arming audio.
  if (state.audio.on && n.parameters.get('gate').value < 0.5) {
    n.parameters.get('gate').value = 1;
  }
  if (microfade && state.audio.on && state.audio.gain) {
    const g = state.audio.gain.gain;
    const t = state.audio.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.01, t + 0.004);
    g.linearRampToValueAtTime(MASTER_GAIN, t + 0.012);
  }
  n.parameters.get('beta').value  = state.beta;
  n.parameters.get('force').value = state.f;
  n.parameters.get('vBow').value  = state.v;
  n.parameters.get('f0').value    = state.f0;
  if (state.audio.pitchGain && state.audio.ctx) {
    state.audio.pitchGain.gain.setTargetAtTime(
      pitchGainFor(state.f0),
      state.audio.ctx.currentTime,
      0.03
    );
  }
}

function softRetrigger(damp) {
  const n = state.audio.node;
  if (!n || !state.audio.on) return;
  n.port.postMessage({ type: 'soft-retrigger', damp: damp ?? 0.25 });
}

// ---------- tour ----------
const TOUR = [
  {
    title: "A location isn't a sound.",
    text: "Students are taught to play sul tasto, sul ponticello. But those are places on the string — not sounds. Move the bow here: all you've chosen is where it sits.",
    visual: 'string-position'
  },
  {
    title: "Add weight.",
    text: "Now the force changes too. Heavy near the fingerboard chokes. Light near the bridge whistles. Same places, different results.",
    visual: 'string-force'
  },
  {
    title: "Add speed.",
    text: "One more knob: bow speed. The same force at the same place sounds different at different speeds — the whole window for pitched tone moves with v.",
    visual: 'mini-speed'
  },
  {
    title: "There's a shape to this.",
    text: "Schelleng (1973) showed the pitched-tone window is bounded by two curves: a crush ceiling F_max ∝ v/β and a squeak floor F_min ∝ v/β². Halving v shifts both down together.",
    visual: 'mini-curves'
  },
  {
    title: "Named effects are coordinates.",
    text: "Each tradition-named effect — tasto, pont, flautando, overpressure, Schnarrklang — is just a point in this space. Tap a chip and watch the puck jump.",
    visual: 'mini-presets'
  },
  {
    title: "Play.",
    text: "Flip the sound on. Drag the puck across the regions and listen to the coupling. What you call 'a sound' is a relation between three numbers, not a third of them on its own.",
    visual: 'final'
  }
];

let tourIndex = 0;

function openTour() {
  tourIndex = 0;
  $('tour').classList.remove('hidden');
  $('tour').setAttribute('aria-hidden', 'false');
  renderTour();
}
function closeTour() {
  $('tour').classList.add('hidden');
  $('tour').setAttribute('aria-hidden', 'true');
}
function renderTour() {
  const c = TOUR[tourIndex];
  const body = $('tourBody');
  body.innerHTML = '';
  const chap = document.createElement('div');
  chap.className = 'tour-chapter';
  chap.textContent = `chapter ${tourIndex + 1} / ${TOUR.length}`;
  body.appendChild(chap);
  const title = document.createElement('div');
  title.className = 'tour-title';
  title.id = 'tourTitle';
  title.textContent = c.title;
  body.appendChild(title);
  const text = document.createElement('div');
  text.className = 'tour-text';
  text.textContent = c.text;
  body.appendChild(text);
  const vis = document.createElement('div');
  vis.className = 'tour-visual';
  vis.innerHTML = renderTourVisual(c.visual);
  body.appendChild(vis);

  const dots = $('tourDots');
  dots.innerHTML = '';
  TOUR.forEach((_, i) => {
    const s = document.createElement('span');
    if (i === tourIndex) s.classList.add('active');
    dots.appendChild(s);
  });
  $('tourNext').textContent = tourIndex === TOUR.length - 1 ? 'done' : 'next';
  $('tourPrev').disabled = tourIndex === 0;
}

function renderTourVisual(kind) {
  if (kind === 'string-position') {
    return `
      <svg viewBox="0 0 460 150">
        <line class="mini-string" x1="30" y1="85" x2="430" y2="85"/>
        <circle class="mini-anchor" cx="30" cy="85" r="5"/>
        <circle class="mini-anchor" cx="430" cy="85" r="5"/>
        <text class="mini-label" x="30" y="120" text-anchor="middle">bridge</text>
        <text class="mini-label" x="430" y="120" text-anchor="middle">nut</text>
        <line class="mini-bow" x1="90" y1="55" x2="90" y2="115"/>
        <text class="mini-label-mono" x="90" y="45" text-anchor="middle">sul pont.</text>
        <line class="mini-bow" x1="200" y1="55" x2="200" y2="115"/>
        <text class="mini-label-mono" x="200" y="45" text-anchor="middle">ordinario</text>
        <line class="mini-bow" x1="340" y1="55" x2="340" y2="115"/>
        <text class="mini-label-mono" x="340" y="45" text-anchor="middle">sul tasto</text>
      </svg>`;
  }
  if (kind === 'string-force') {
    return `
      <svg viewBox="0 0 460 150">
        <line class="mini-string" x1="30" y1="85" x2="430" y2="85"/>
        <circle class="mini-anchor" cx="30" cy="85" r="5"/>
        <circle class="mini-anchor" cx="430" cy="85" r="5"/>
        <line class="mini-bow mini-bow-fat" x1="100" y1="55" x2="100" y2="115"/>
        <text class="mini-label" x="100" y="140" text-anchor="middle">heavy &middot; near bridge: whistle</text>
        <line class="mini-bow" x1="360" y1="55" x2="360" y2="115" stroke-dasharray="2 3"/>
        <text class="mini-label" x="360" y="140" text-anchor="middle">light &middot; near f.board: ghost</text>
      </svg>`;
  }
  if (kind === 'mini-speed') {
    return miniDiagramSvg({ speed: true, curves: false, presets: false });
  }
  if (kind === 'mini-curves') {
    return miniDiagramSvg({ speed: false, curves: true, presets: false });
  }
  if (kind === 'mini-presets') {
    return miniDiagramSvg({ speed: false, curves: true, presets: true });
  }
  if (kind === 'final') {
    return `
      <svg viewBox="0 0 460 120">
        <text class="mini-label" x="230" y="40" text-anchor="middle" style="font-size:13px;">
          β &middot; v &middot; F
        </text>
        <text class="mini-label" x="230" y="74" text-anchor="middle" style="font-size:11px; font-style:italic;">
          a sound is a relation, not a coordinate
        </text>
        <text class="mini-label" x="230" y="100" text-anchor="middle" style="font-size:11px; fill:var(--accent);">
          close this — play
        </text>
      </svg>`;
  }
  return '';
}

function miniDiagramSvg({ speed, curves, presets }) {
  // Mini log-log panel with boundaries, optional speed-shift preview,
  // optional preset dots. Uses the same k's as the main diagram.
  const W = 460, H = 220;
  const px = 40, py = 18, pw = W - 60, ph = H - 54;
  const b2x = (b) => px + (log(b) - log(BETA_MIN)) / (log(BETA_MAX) - log(BETA_MIN)) * pw;
  const f2y = (f) => py + (1 - (log(f) - log(F_MIN)) / (log(F_MAX) - log(F_MIN))) * ph;
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  s += `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" class="axis" style="stroke:var(--line);fill:none"/>`;
  s += `<text class="mini-label" x="${px + pw/2}" y="${H - 18}" text-anchor="middle">β →</text>`;
  s += `<text class="mini-label" x="14" y="${py + ph/2}" text-anchor="middle" transform="rotate(-90 14 ${py + ph/2})">F →</text>`;

  if (curves) {
    // Two speeds: v=0.4 and v=0.18 to show the shift
    const vs = speed ? [0.4, 0.18] : [0.4];
    vs.forEach((v, i) => {
      const op = i === 0 ? 1 : 0.45;
      let mx = '', mn = '';
      for (let j = 0; j <= 40; j++) {
        const b = Math.exp(log(BETA_MIN) + (j / 40) * (log(BETA_MAX) - log(BETA_MIN)));
        const fm = clampLog(fMaxAt(b, v));
        const fn = clampLog(fMinAt(b, v));
        mx += `${j ? 'L' : 'M'}${b2x(b).toFixed(1)},${f2y(fm).toFixed(1)}`;
        mn += `${j ? 'L' : 'M'}${b2x(b).toFixed(1)},${f2y(fn).toFixed(1)}`;
      }
      s += `<path d="${mx}" class="mini-fmax" style="opacity:${op}"/>`;
      s += `<path d="${mn}" class="mini-fmin" style="opacity:${op}"/>`;
    });
    s += `<text class="mini-label-mono" x="${px + pw - 4}" y="${py + 12}" text-anchor="end">F_max</text>`;
    s += `<text class="mini-label-mono" x="${px + 6}" y="${py + ph - 6}">F_min</text>`;
  }

  if (speed && !curves) {
    // Show two positions of F_max only — emphasize the shift alone.
    [0.4, 0.18].forEach((v, i) => {
      let mx = '';
      for (let j = 0; j <= 40; j++) {
        const b = Math.exp(log(BETA_MIN) + (j / 40) * (log(BETA_MAX) - log(BETA_MIN)));
        const fm = clampLog(fMaxAt(b, v));
        mx += `${j ? 'L' : 'M'}${b2x(b).toFixed(1)},${f2y(fm).toFixed(1)}`;
      }
      s += `<path d="${mx}" class="mini-fmax" style="opacity:${i ? 0.5 : 1}"/>`;
      s += `<text class="mini-label-mono" x="${px + pw - 4}" y="${f2y(fMaxAt(0.15, v)) - 4}" text-anchor="end" style="opacity:${i ? 0.6 : 1}">v=${v}</text>`;
    });
  }

  if (presets) {
    const items = [
      ['tasto', 'tasto'],
      ['flautando', 'flaut.'],
      ['ordinario', 'ord.'],
      ['ponticello', 'pont.'],
      ['overpressure', 'over']
    ];
    items.forEach(([k, label]) => {
      const p = PRESETS[k];
      const x = b2x(p.beta), y = f2y(clampLog(p.f));
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" class="mini-puck"/>`;
      s += `<text class="mini-label-mono" x="${x.toFixed(1)}" y="${(y - 9).toFixed(1)}" text-anchor="middle">${label}</text>`;
    });
  }

  s += `</svg>`;
  return s;
}

// ---------- init ----------
function initControls() {
  $('vSlider').addEventListener('input', (e) => {
    cancelPresetAnim();
    state.v = parseFloat(e.target.value);
    $('vOut').textContent = state.v.toFixed(2);
    updateCurves();
    updateReadout();
    pushAudio();
  });

  $('pitchSlider').addEventListener('input', (e) => {
    state.f0 = clampHz(semitoneToHz(parseFloat(e.target.value)));
    updateReadout();
    pushAudio();
    try { localStorage.setItem('bow-parameters:pitch', String(state.f0)); } catch {}
  });

  $('chips').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-preset]');
    if (!btn) return;
    applyPreset(btn.dataset.preset);
  });

  $('audioToggle').addEventListener('click', toggleAudio);
  $('themeToggle').addEventListener('click', toggleTheme);

  $('tourBtn').addEventListener('click', openTour);
  $('tourClose').addEventListener('click', closeTour);
  $('tourNext').addEventListener('click', () => {
    if (tourIndex === TOUR.length - 1) { closeTour(); return; }
    tourIndex = Math.min(TOUR.length - 1, tourIndex + 1);
    renderTour();
  });
  $('tourPrev').addEventListener('click', () => {
    tourIndex = Math.max(0, tourIndex - 1);
    renderTour();
  });

  document.addEventListener('keydown', (e) => {
    const tour = $('tour');
    if (!tour.classList.contains('hidden')) {
      if (e.key === 'Escape') closeTour();
      if (e.key === 'ArrowRight') $('tourNext').click();
      if (e.key === 'ArrowLeft')  $('tourPrev').click();
      return;
    }
    // Keyboard nudge for puck.
    const step = e.shiftKey ? 0.03 : 0.008;
    let acted = false;
    if (e.key === 'ArrowLeft')  { state.beta = Math.max(BETA_MIN, state.beta * (1 - step * 3)); acted = true; }
    if (e.key === 'ArrowRight') { state.beta = Math.min(BETA_MAX, state.beta * (1 + step * 3)); acted = true; }
    if (e.key === 'ArrowUp')    { state.f = Math.min(F_MAX, state.f * (1 + step * 6)); acted = true; }
    if (e.key === 'ArrowDown')  { state.f = Math.max(F_MIN, state.f * (1 - step * 6)); acted = true; }
    if (acted) {
      cancelPresetAnim();
      e.preventDefault();
      updatePuck(); updateReadout(); pushAudio();
      softRetrigger();
    }
  });

  // Auto-open the tour on first mobile visit.
  try {
    const isNarrow = window.matchMedia('(max-width: 640px)').matches;
    const seen = localStorage.getItem('bow-parameters:tour-seen');
    if (isNarrow && !seen) {
      setTimeout(() => {
        openTour();
        localStorage.setItem('bow-parameters:tour-seen', '1');
      }, 400);
    }
  } catch {}
}

function init() {
  try {
    const saved = localStorage.getItem('bow-parameters:theme');
    if (saved === 'light') applyTheme(true);
    else if (!saved && window.matchMedia('(prefers-color-scheme: light)').matches) applyTheme(true);
  } catch {}
  try {
    const savedPitch = parseFloat(localStorage.getItem('bow-parameters:pitch'));
    if (Number.isFinite(savedPitch)) state.f0 = clampHz(savedPitch);
  } catch {}
  buildSvg();
  initDrag();
  initControls();
  const pitchSlider = $('pitchSlider');
  if (pitchSlider) pitchSlider.value = hzToSemitone(state.f0).toFixed(1);
  updateAll();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
