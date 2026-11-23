// Self-contained AudioWorkletProcessor source for high-polyphony handpan synthesis.
// Loaded via a Blob URL so it works identically under Vite dev, production builds, and sub-path deployments.

export const PAN_WORKLET_NAME = "cyberpan-synth";

export const PAN_WORKLET_CODE = `
const TABLE_SIZE = 4096;
const SIN_TABLE = new Float32Array(TABLE_SIZE + 1);
for (let i = 0; i <= TABLE_SIZE; i++) {
  SIN_TABLE[i] = Math.sin((i / TABLE_SIZE) * Math.PI * 2);
}

const MAX_VOICES = 64;
const SOFT_VOICES = 48;
const PI_HALF = Math.PI * 0.5;
const TWO_PI = Math.PI * 2;

class PanSynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.active = new Uint8Array(MAX_VOICES); // 0 = free, 1 = sounding, 2 = damping/releasing
    this.activeCount = 0;
    this.pitchKey = new Int32Array(MAX_VOICES);
    this.startDelay = new Int32Array(MAX_VOICES);
    this.triggerFrame = new Float64Array(MAX_VOICES);

    this.gainL = new Float32Array(MAX_VOICES);
    this.gainR = new Float32Array(MAX_VOICES);

    this.ph1 = new Float64Array(MAX_VOICES);
    this.ph2 = new Float64Array(MAX_VOICES);
    this.ph3 = new Float64Array(MAX_VOICES);
    this.ph4 = new Float64Array(MAX_VOICES);

    this.inc1 = new Float64Array(MAX_VOICES);
    this.inc2 = new Float64Array(MAX_VOICES);
    this.inc3 = new Float64Array(MAX_VOICES);
    this.inc4 = new Float64Array(MAX_VOICES);

    // Envelopes: fundamental (e1), 2nd harmonic (e2), 3rd harmonic (e3), mallet noise (en)
    this.e1 = new Float32Array(MAX_VOICES);
    this.e1Step = new Float32Array(MAX_VOICES);
    this.e1Dec = new Float32Array(MAX_VOICES);
    this.e1Atk = new Int32Array(MAX_VOICES);

    this.e2 = new Float32Array(MAX_VOICES);
    this.e2Step = new Float32Array(MAX_VOICES);
    this.e2Dec = new Float32Array(MAX_VOICES);
    this.e2Atk = new Int32Array(MAX_VOICES);

    this.e3 = new Float32Array(MAX_VOICES);
    this.e3Step = new Float32Array(MAX_VOICES);
    this.e3Dec = new Float32Array(MAX_VOICES);
    this.e3Atk = new Int32Array(MAX_VOICES);

    this.en = new Float32Array(MAX_VOICES);
    this.enStep = new Float32Array(MAX_VOICES);
    this.enDec = new Float32Array(MAX_VOICES);
    this.enAtk = new Int32Array(MAX_VOICES);

    // Per-voice bandpass biquad for decorrelated mallet attack noise
    this.nb0 = new Float32Array(MAX_VOICES);
    this.nb2 = new Float32Array(MAX_VOICES);
    this.na1 = new Float32Array(MAX_VOICES);
    this.na2 = new Float32Array(MAX_VOICES);
    this.nx1 = new Float32Array(MAX_VOICES);
    this.nx2 = new Float32Array(MAX_VOICES);
    this.ny1 = new Float32Array(MAX_VOICES);
    this.ny2 = new Float32Array(MAX_VOICES);

    this.damp = new Float32Array(MAX_VOICES);
    this.dampMul = new Float32Array(MAX_VOICES);

    // Min-heap of scheduled note events ordered by target sample frame
    this.heap = [];

    // Fast decorrelated PRNG state (xorshift32)
    this.rng = 0x9e3779b9;

    // Smoothed polyphony auto-leveling gain
    this.busGain = 1.0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "pan") {
        this.pushEvent(msg);
      } else if (msg.type === "clear") {
        this.heap.length = 0;
        const fastDamp = Math.exp(-1 / (0.015 * sampleRate));
        for (let v = 0; v < MAX_VOICES; v++) {
          if (this.active[v]) {
            this.active[v] = 2;
            this.dampMul[v] = Math.min(this.dampMul[v], fastDamp);
          }
        }
      }
    };
  }

  pushEvent(ev) {
    const frame = Math.max(currentFrame, Math.round(ev.t * sampleRate));
    const item = {
      frame,
      key: ev.key | 0,
      freq: ev.freq,
      vel: ev.vel,
      tau: ev.tau,
      bright: ev.bright,
      pan: ev.pan,
    };
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].frame <= h[i].frame) break;
      const tmp = h[p];
      h[p] = h[i];
      h[i] = tmp;
      i = p;
    }
  }

  popEvent() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      const n = h.length;
      while (true) {
        let smallest = i;
        const l = (i << 1) + 1;
        const r = l + 1;
        if (l < n && h[l].frame < h[smallest].frame) smallest = l;
        if (r < n && h[r].frame < h[smallest].frame) smallest = r;
        if (smallest === i) break;
        const tmp = h[i];
        h[i] = h[smallest];
        h[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }

  voiceAmplitude(v) {
    return (this.e1[v] * 2 + this.e2[v] + this.e3[v] + this.en[v]) * this.damp[v];
  }

  allocateSlot() {
    // 1. Prefer an inactive slot
    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.active[v] === 0) return v;
    }
    // 2. Otherwise steal the quietest already-damping slot
    let bestDamp = -1;
    let bestDampAmp = Infinity;
    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.active[v] === 2) {
        const amp = this.voiceAmplitude(v);
        if (amp < bestDampAmp) {
          bestDampAmp = amp;
          bestDamp = v;
        }
      }
    }
    if (bestDamp >= 0) return bestDamp;

    // 3. Fallback: steal quietest active slot
    let best = 0;
    let bestAmp = Infinity;
    for (let v = 0; v < MAX_VOICES; v++) {
      const amp = this.voiceAmplitude(v);
      if (amp < bestAmp) {
        bestAmp = amp;
        best = v;
      }
    }
    return best;
  }

  triggerVoice(ev, delaySamples) {
    const sr = sampleRate;
    const dedupeWindow = Math.round(sr * 0.005); // 5ms same-pitch deduplication
    const samePitchDamp = Math.exp(-1 / (0.022 * sr)); // 22ms natural handpan dimple re-strike damping
    const stealDamp = Math.exp(-1 / (0.01 * sr)); // 10ms smooth voice-steal fade-out

    let soundingCount = 0;
    let quietestSounding = -1;
    let quietestAmp = Infinity;

    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.active[v] !== 1) continue;
      if (this.pitchKey[v] === ev.key) {
        if (ev.frame - this.triggerFrame[v] < dedupeWindow) {
          return;
        }
        this.active[v] = 2;
        this.dampMul[v] = Math.min(this.dampMul[v], samePitchDamp);
        continue;
      }
      soundingCount++;
      const amp = this.voiceAmplitude(v);
      if (amp < quietestAmp) {
        quietestAmp = amp;
        quietestSounding = v;
      }
    }

    if (soundingCount >= SOFT_VOICES && quietestSounding >= 0) {
      this.active[quietestSounding] = 2;
      this.dampMul[quietestSounding] = Math.min(this.dampMul[quietestSounding], stealDamp);
    }

    const v = this.allocateSlot();
    if (this.active[v] === 0) this.activeCount++;

    const nyquistLimit = sr * 0.44;
    const freq = Math.max(20, Math.min(nyquistLimit / 3.1, ev.freq));
    const vel = Math.max(0.05, Math.min(1, ev.vel));
    const tau = Math.max(0.15, Math.min(4.0, ev.tau));
    const bright = Math.max(0, Math.min(1, ev.bright));

    this.active[v] = 1;
    this.pitchKey[v] = ev.key;
    this.startDelay[v] = delaySamples;
    this.triggerFrame[v] = ev.frame;

    const pan = Math.max(-1, Math.min(1, ev.pan));
    const x = (pan + 1) * 0.5;
    this.gainL[v] = Math.cos(x * PI_HALF);
    this.gainR[v] = Math.sin(x * PI_HALF);

    this.ph1[v] = 0;
    this.ph2[v] = 0;
    this.ph3[v] = 0;
    this.ph4[v] = 0;

    this.inc1[v] = freq / sr;
    this.inc2[v] = (freq + 0.7) / sr;
    this.inc3[v] = Math.min(nyquistLimit, freq * 2.001) / sr;
    this.inc4[v] = Math.min(nyquistLimit, freq * 2.998) / sr;

    const initEnv = (atkSec, peak, decSec, eArr, stepArr, decArr, atkArr) => {
      const p = Math.max(0.0002, peak);
      const atkSamps = Math.max(1, Math.round(atkSec * sr));
      const decDur = Math.max(0.01, Math.max(atkSec + 0.01, decSec) - atkSec);
      const decSamps = Math.max(1, Math.round(decDur * sr));
      eArr[v] = 0;
      stepArr[v] = p / atkSamps;
      decArr[v] = Math.pow(0.0001 / p, 1 / decSamps);
      atkArr[v] = atkSamps;
    };

    initEnv(0.004, 0.24 * vel, tau, this.e1, this.e1Step, this.e1Dec, this.e1Atk);
    initEnv(0.02, (0.11 + 0.09 * bright) * vel, tau * 0.6, this.e2, this.e2Step, this.e2Dec, this.e2Atk);
    initEnv(0.03, (0.065 + 0.03 * bright) * vel, tau * 0.45, this.e3, this.e3Step, this.e3Dec, this.e3Atk);
    initEnv(0.002, (0.09 + 0.035 * bright) * vel, 0.02, this.en, this.enStep, this.enDec, this.enAtk);

    // Bandpass filter coefficients (RBJ / Web Audio BiquadFilterNode bandpass)
    const nf = Math.max(600, Math.min(2000, freq * 3));
    const w0 = (TWO_PI * nf) / sr;
    const alpha = Math.sin(w0) / (2 * 2.0); // Q = 2
    const invA0 = 1 / (1 + alpha);
    this.nb0[v] = alpha * invA0;
    this.nb2[v] = -alpha * invA0;
    this.na1[v] = -2 * Math.cos(w0) * invA0;
    this.na2[v] = (1 - alpha) * invA0;
    this.nx1[v] = 0;
    this.nx2[v] = 0;
    this.ny1[v] = 0;
    this.ny2[v] = 0;

    this.damp[v] = 1.0;
    this.dampMul[v] = 1.0;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const dstL = out && out[0];
    const dstR = out && out[1];
    if (!dstL || !dstR) return true;

    const blockLen = dstL.length;
    const blockStart = currentFrame;
    const blockEnd = blockStart + blockLen;

    while (this.heap.length > 0 && this.heap[0].frame < blockEnd) {
      const ev = this.popEvent();
      const delay = Math.max(0, ev.frame - blockStart);
      this.triggerVoice(ev, delay);
    }

    if (this.activeCount === 0) {
      if (this.busGain < 0.9999) {
        this.busGain += (1.0 - this.busGain) * 0.03;
      } else {
        this.busGain = 1.0;
      }
      return true;
    }

    dstL.fill(0);
    dstR.fill(0);

    let load = 0;
    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.active[v] !== 0) load += this.voiceAmplitude(v);
    }

    const targetGain = load <= 1.1 ? 1.0 : 1.0 / Math.sqrt(1 + (load - 1.1) * 0.55);
    const prevG = this.busGain;
    this.busGain += (targetGain - prevG) * (targetGain < prevG ? 0.2 : 0.03);
    const gStep = (this.busGain - prevG) / blockLen;

    let rng = this.rng;
    const sin = SIN_TABLE;

    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.active[v] === 0) continue;

      const start = this.startDelay[v];
      this.startDelay[v] = 0;

      const gL = this.gainL[v];
      const gR = this.gainR[v];

      let ph1 = this.ph1[v];
      let ph2 = this.ph2[v];
      let ph3 = this.ph3[v];
      let ph4 = this.ph4[v];
      const inc1 = this.inc1[v];
      const inc2 = this.inc2[v];
      const inc3 = this.inc3[v];
      const inc4 = this.inc4[v];

      let e1 = this.e1[v];
      const e1Step = this.e1Step[v];
      const e1Dec = this.e1Dec[v];
      let e1Atk = this.e1Atk[v];

      let e2 = this.e2[v];
      const e2Step = this.e2Step[v];
      const e2Dec = this.e2Dec[v];
      let e2Atk = this.e2Atk[v];

      let e3 = this.e3[v];
      const e3Step = this.e3Step[v];
      const e3Dec = this.e3Dec[v];
      let e3Atk = this.e3Atk[v];

      let en = this.en[v];
      const enStep = this.enStep[v];
      const enDec = this.enDec[v];
      let enAtk = this.enAtk[v];

      const hasNoise = enAtk > 0 || en > 0.0001;
      const nb0 = this.nb0[v];
      const nb2 = this.nb2[v];
      const na1 = this.na1[v];
      const na2 = this.na2[v];
      let nx1 = this.nx1[v];
      let nx2 = this.nx2[v];
      let ny1 = this.ny1[v];
      let ny2 = this.ny2[v];

      let damp = this.damp[v];
      const dampMul = this.dampMul[v];

      for (let i = start; i < blockLen; i++) {
        if (e1Atk > 0) { e1 += e1Step; e1Atk--; } else { e1 *= e1Dec; }
        if (e2Atk > 0) { e2 += e2Step; e2Atk--; } else { e2 *= e2Dec; }
        if (e3Atk > 0) { e3 += e3Step; e3Atk--; } else { e3 *= e3Dec; }

        let p = ph1 * TABLE_SIZE;
        let idx = p | 0;
        const s1 = sin[idx] + (p - idx) * (sin[idx + 1] - sin[idx]);

        p = ph2 * TABLE_SIZE;
        idx = p | 0;
        const s2 = sin[idx] + (p - idx) * (sin[idx + 1] - sin[idx]);

        let sample = (s1 + s2) * e1;

        ph1 += inc1; if (ph1 >= 1) ph1 -= 1;
        ph2 += inc2; if (ph2 >= 1) ph2 -= 1;

        if (e2 > 0.00005 || e2Atk > 0) {
          p = ph3 * TABLE_SIZE;
          idx = p | 0;
          sample += (sin[idx] + (p - idx) * (sin[idx + 1] - sin[idx])) * e2;
          ph3 += inc3; if (ph3 >= 1) ph3 -= 1;
        }

        if (e3 > 0.00005 || e3Atk > 0) {
          p = ph4 * TABLE_SIZE;
          idx = p | 0;
          sample += (sin[idx] + (p - idx) * (sin[idx + 1] - sin[idx])) * e3;
          ph4 += inc4; if (ph4 >= 1) ph4 -= 1;
        }

        if (hasNoise && (enAtk > 0 || en > 0.0001)) {
          if (enAtk > 0) { en += enStep; enAtk--; } else { en *= enDec; }
          rng ^= rng << 13;
          rng ^= rng >>> 17;
          rng ^= rng << 5;
          const white = (rng | 0) * 4.656612875245797e-10;
          let y = nb0 * white + nb2 * nx2 - na1 * ny1 - na2 * ny2;
          if (y > -1e-12 && y < 1e-12) y = 0;
          nx2 = nx1; nx1 = white;
          ny2 = ny1; ny1 = y;
          sample += y * en;
        }

        damp *= dampMul;
        sample *= damp;

        dstL[i] += sample * gL;
        dstR[i] += sample * gR;
      }

      if ((e1Atk === 0 && e1 < 0.00012 && e2Atk === 0 && e2 < 0.00012 && e3Atk === 0 && e3 < 0.00012 && enAtk === 0 && en < 0.00012) || damp < 0.0005) {
        this.active[v] = 0;
        this.activeCount--;
      } else {
        this.ph1[v] = ph1;
        this.ph2[v] = ph2;
        this.ph3[v] = ph3;
        this.ph4[v] = ph4;
        this.e1[v] = e1;
        this.e1Atk[v] = e1Atk;
        this.e2[v] = e2;
        this.e2Atk[v] = e2Atk;
        this.e3[v] = e3;
        this.e3Atk[v] = e3Atk;
        this.en[v] = en;
        this.enAtk[v] = enAtk;
        if (hasNoise) {
          this.nx1[v] = nx1;
          this.nx2[v] = nx2;
          this.ny1[v] = ny1;
          this.ny2[v] = ny2;
        }
        this.damp[v] = damp;
      }
    }

    if (prevG !== 1.0 || gStep !== 0) {
      let g = prevG;
      for (let i = 0; i < blockLen; i++) {
        dstL[i] *= g;
        dstR[i] *= g;
        g += gStep;
      }
    }

    this.rng = rng;
    return true;
  }
}

registerProcessor("${PAN_WORKLET_NAME}", PanSynthProcessor);
`;
