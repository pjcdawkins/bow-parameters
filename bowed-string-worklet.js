// Digital-waveguide bowed string for the Schelleng workshop.
// Pedagogical, not a faithful violin model. Four uni-directional delay
// segments around the string loop meet at the bow scattering junction;
// bridge + nut terminate with sign flip, bridge adds a one-pole lowpass
// to mimic frequency-dependent losses. Stick-slip is approximated with
// a saturating friction curve whose "slip threshold" scales as 1 / F.

class BowedStringProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'beta',  defaultValue: 0.08, minValue: 0.005, maxValue: 0.5,  automationRate: 'k-rate' },
      { name: 'vBow',  defaultValue: 0.0,  minValue: 0,     maxValue: 4.0,  automationRate: 'k-rate' },
      { name: 'force', defaultValue: 0.3,  minValue: 0,     maxValue: 30,   automationRate: 'k-rate' },
      { name: 'f0',    defaultValue: 220,  minValue: 55,    maxValue: 700,  automationRate: 'k-rate' },
      { name: 'gate',  defaultValue: 0,    minValue: 0,     maxValue: 1,    automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    const fs = sampleRate;
    this.fs = fs;
    // Buffers are sized once for the lowest supported fundamental; the live
    // wrap length `N` below shrinks for higher pitches. 50 Hz gives headroom
    // under the 55 Hz parameter floor.
    this.F0_MIN = 50;
    this.Nmax = Math.ceil(fs / (2 * this.F0_MIN)) + 4;
    this.f0Sm = 220;
    this.N = Math.max(32, Math.round(fs / this.f0Sm / 2));
    this.bb = new Float32Array(this.Nmax); this.bbP = 0;   // bridge -> bow (right-going)
    this.ub = new Float32Array(this.Nmax); this.ubP = 0;   // bow -> bridge (left-going)
    this.bn = new Float32Array(this.Nmax); this.bnP = 0;   // bow -> nut    (right-going)
    this.nb = new Float32Array(this.Nmax); this.nbP = 0;   // nut -> bow    (left-going)
    this.lp = 0;
    this.dcIn = 0; this.dcOut = 0;
    this.vSm = 0; this.fSm = 0.3; this.bSm = 0.08;
    this.gSm = 0;   // smoothed gate envelope to avoid clicks
    // Phase-continuous resonance dump on discrete technique switches.
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'soft-retrigger') {
        const k = (typeof e.data.damp === 'number') ? e.data.damp : 0.25;
        const bb = this.bb, ub = this.ub, bn = this.bn, nb = this.nb;
        for (let i = 0; i < this.N; i++) { bb[i] *= k; ub[i] *= k; bn[i] *= k; nb[i] *= k; }
      }
    };
  }

  process(inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;
    const bT = params.beta[0];
    const vT = params.vBow[0];
    const fT = params.force[0];
    const pT = params.f0[0];
    const g  = params.gate[0];
    const bb = this.bb, ub = this.ub, bn = this.bn, nb = this.nb;

    for (let i = 0; i < out.length; i++) {
      // Smooth gate envelope (~5 ms ramp) to avoid clicks on start/stop.
      const gTarget = g >= 0.5 ? 1 : 0;
      this.gSm += (gTarget - this.gSm) * 0.02;
      if (this.gSm < 0.0001) {
        // Fully faded out — clear state for a clean restart.
        this.vSm = 0; this.fSm = 0;
        bb.fill(0); ub.fill(0); bn.fill(0); nb.fill(0);
        this.lp = 0; this.dcIn = 0; this.dcOut = 0;
        this.gSm = 0;
        out[i] = 0;
        continue;
      }
      this.bSm += (bT - this.bSm) * 0.008;
      this.vSm += (vT - this.vSm) * 0.008;
      this.fSm += (fT - this.fSm) * 0.008;
      this.f0Sm += (pT - this.f0Sm) * 0.008;

      // Live wrap length from smoothed pitch; integer snaps are inaudible
      // thanks to the one-pole smoother. Buffers are at least Nmax long.
      const N = Math.max(16, Math.min(this.Nmax, Math.round(this.fs / (2 * this.f0Sm))));
      this.N = N;
      // Keep pointers inside the live range so reads stay valid when N shrinks.
      if (this.bbP >= N) this.bbP %= N;
      if (this.ubP >= N) this.ubP %= N;
      if (this.bnP >= N) this.bnP %= N;
      if (this.nbP >= N) this.nbP %= N;

      const p  = Math.max(1, Math.min(N - 2, Math.round(this.bSm * N)));
      const Ln = N - p;

      // Read: samples arriving at each junction right now.
      const atBridge = ub[(this.ubP - p  + N) % N];
      const atNut    = bn[(this.bnP - Ln + N) % N];
      const bFromBr  = bb[(this.bbP - p  + N) % N];
      const bFromNt  = nb[(this.nbP - Ln + N) % N];

      // Bridge termination: one-pole lowpass + sign flip + damping.
      // Brighter near bridge (ponticello harmonics), darker at tasto.
      const a = 0.3 + (1 - Math.min(1, this.bSm * 5)) * 0.5;
      const lpNew = a * atBridge + (1 - a) * this.lp;
      this.lp = lpNew;
      const bridgeOut = -lpNew * 0.999;

      // Nut termination: near-rigid, just sign flip with tiny loss.
      const nutOut = -atNut * 0.9995;

      // Bow junction: scatter with friction-curve nonlinearity.
      const vStr = bFromBr + bFromNt;
      const F    = this.fSm;
      const beta = this.bSm;
      // High force → noisy bow velocity for aperiodic schnarr character.
      const schnarr = F > 7.5 ? (Math.random() * 2 - 1) * (F - 7.5) * 0.3 : 0;
      const dv   = this.vSm + schnarr - vStr;
      const adv  = dv < 0 ? -dv : dv;
      // Slip scale varies with β: looser near bridge (clean ponticello),
      // stickier far from bridge (tasto sustains).
      const epsBase = 0.05 + Math.max(0, 0.12 - beta) * 1.2;
      const eps  = epsBase / (F < 0.01 ? 0.01 : F);
      const mu   = (dv < 0 ? -1 : 1) * adv / (adv + eps);
      const delta = F * mu * 5.0;                    // bow-injected wave, Z0 absorbed

      // Advance pointers and write outgoing waves into each delay line.
      this.bbP = (this.bbP + 1) % N;
      this.ubP = (this.ubP + 1) % N;
      this.bnP = (this.bnP + 1) % N;
      this.nbP = (this.nbP + 1) % N;

      bb[this.bbP] = bridgeOut;
      nb[this.nbP] = nutOut;
      bn[this.bnP] = bFromBr + delta;
      ub[this.ubP] = bFromNt + delta;

      // Velocity scales volume (faster bow = louder); beta gain lifts tasto.
      const vGain = 0.3 + this.vSm * 1.5;
      const betaGain = 1 + this.bSm * 12;
      let y = atBridge * 10 * betaGain * vGain;

      // DC blocker.
      const d = y - this.dcIn + 0.995 * this.dcOut;
      this.dcIn = y; this.dcOut = d;
      y = d;

      // Gentle soft-clip safety net.
      y = Math.tanh(y * 1.1) * 0.99;
      out[i] = y * this.gSm;
    }
    return true;
  }
}

registerProcessor('bowed-string', BowedStringProcessor);
