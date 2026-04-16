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
      { name: 'vBow',  defaultValue: 0.0,  minValue: 0,     maxValue: 2.0,  automationRate: 'k-rate' },
      { name: 'force', defaultValue: 0.3,  minValue: 0,     maxValue: 20,   automationRate: 'k-rate' },
      { name: 'gate',  defaultValue: 0,    minValue: 0,     maxValue: 1,    automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    const fs = sampleRate;
    this.fs = fs;
    this.f0 = 220; // A3 — pedagogical pitch
    // One-way delay in samples for each of the four ring buffers. Segment
    // lengths p and (N - p) come from β via pointer offsets.
    this.N = Math.max(32, Math.round(fs / this.f0 / 2));
    const N = this.N;
    this.bb = new Float32Array(N); this.bbP = 0;   // bridge -> bow (right-going)
    this.ub = new Float32Array(N); this.ubP = 0;   // bow -> bridge (left-going)
    this.bn = new Float32Array(N); this.bnP = 0;   // bow -> nut    (right-going)
    this.nb = new Float32Array(N); this.nbP = 0;   // nut -> bow    (left-going)
    this.lp = 0;
    this.dcIn = 0; this.dcOut = 0;
    this.vSm = 0; this.fSm = 0.3; this.bSm = 0.08;
  }

  process(inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;
    const N = this.N;
    const bT = params.beta[0];
    const vT = params.vBow[0];
    const fT = params.force[0];
    const g  = params.gate[0];
    const bb = this.bb, ub = this.ub, bn = this.bn, nb = this.nb;

    for (let i = 0; i < out.length; i++) {
      // Smooth parameters — slower for richer transitions; asymmetric
      // release on vBow so the string rings down naturally.
      this.bSm += (bT - this.bSm) * 0.0004;
      const vTarget = g > 0.5 ? vT : 0;
      const vCoeff = (vTarget < this.vSm) ? 0.00008 : 0.0004;
      this.vSm += (vTarget - this.vSm) * vCoeff;
      this.fSm += (fT - this.fSm) * 0.0004;

      const p  = Math.max(1, Math.min(N - 2, Math.round(this.bSm * N)));
      const Ln = N - p;

      // Read: samples arriving at each junction right now.
      const atBridge = ub[(this.ubP - p  + N) % N];
      const atNut    = bn[(this.bnP - Ln + N) % N];
      const bFromBr  = bb[(this.bbP - p  + N) % N];
      const bFromNt  = nb[(this.nbP - Ln + N) % N];

      // Bridge termination: one-pole lowpass + sign flip + small damping.
      const a = 0.55;
      const lpNew = a * atBridge + (1 - a) * this.lp;
      this.lp = lpNew;
      const bridgeOut = -lpNew * 0.996;

      // Nut termination: near-rigid, just sign flip with tiny loss.
      const nutOut = -atNut * 0.999;

      // Bow junction: scatter with friction-curve nonlinearity.
      const vStr = bFromBr + bFromNt;
      const dv   = this.vSm - vStr;
      const F    = this.fSm;
      const adv  = dv < 0 ? -dv : dv;
      const eps  = 0.14 / (F < 0.01 ? 0.01 : F);     // slip scale: large F = small eps = stickier
      const mu   = (dv < 0 ? -1 : 1) * adv / (adv + eps);
      const delta = F * mu * 0.7;                    // bow-injected wave, Z0 absorbed

      // Advance pointers and write outgoing waves into each delay line.
      this.bbP = (this.bbP + 1) % N;
      this.ubP = (this.ubP + 1) % N;
      this.bnP = (this.bnP + 1) % N;
      this.nbP = (this.nbP + 1) % N;

      bb[this.bbP] = bridgeOut;
      nb[this.nbP] = nutOut;
      bn[this.bnP] = bFromBr + delta;
      ub[this.ubP] = bFromNt + delta;

      // Output proxy: the wave currently shaking the bridge.
      let y = atBridge * 2.0;

      // DC blocker.
      const d = y - this.dcIn + 0.995 * this.dcOut;
      this.dcIn = y; this.dcOut = d;
      y = d;

      // Gentle soft-clip safety net.
      y = Math.tanh(y * 1.1) * 0.72;
      out[i] = y;
    }
    return true;
  }
}

registerProcessor('bowed-string', BowedStringProcessor);
