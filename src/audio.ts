import { clamp } from "./math";
import { noteAt } from "./theory";

export function createAudio() {
  let ctx: AudioContext | null = null;
  let master!: GainNode;
  let bus!: GainNode;
  let hpf!: BiquadFilterNode;
  let lpf!: BiquadFilterNode;
  let dry!: GainNode;
  let revSend!: GainNode;
  let revOut!: GainNode;
  let noise!: AudioBuffer;
  let riserBP!: BiquadFilterNode;
  let riserGain!: GainNode;
  let uiBus!: GainNode;
  let musicBus!: GainNode;
  let echoSend!: GainNode;
  let echoDelay!: DelayNode;
  let nakedBus!: GainNode;
  let volume = 0.8;
  let width = 1;

  const ensure = () => {
    if (!ctx) initGraph();
    if (ctx!.state === "suspended") ctx!.resume();
    return ctx!;
  };

  const scheduleTime = (when?: number) => Math.max(ctx!.currentTime + 0.002, when ?? 0);

  return {
    ensure,
    isReady: () => ctx !== null,
    now: () => (ctx ? ctx.currentTime : 0),

    get width() {
      return width;
    },
    set width(value: number) {
      width = value;
    },

    get volume() {
      return volume;
    },
    setVolume(value: number) {
      volume = clamp(value, 0, 1);
      if (ctx) master.gain.setTargetAtTime(0.85 * volume, ctx.currentTime, 0.03);
    },

    pan(lane: number, when = 0, vel = 0.8, durSteps = 4, octave = 0, bare = false, bright = 0) {
      const c = ensure();
      const note = noteAt(lane);
      if (!note) return;

      const t = scheduleTime(when);
      const v = clamp(vel, 0.05, 1);
      const freq = note.freq * (octave ? 2 : 1);
      const tau = clamp(0.25 + durSteps * 0.22, 0.3, 3.6) * (lane <= 0 ? 1.3 : 1) * (lane > 8 ? 0.8 : 1);

      const out = c.createGain();
      const panner = c.createStereoPanner();
      panner.pan.value = clamp(note.pan * width, -1, 1);
      out.connect(panner);
      panner.connect(bare ? nakedBus : musicBus);

      const fundamental = createEnvelope(c, t, 0.004, 0.26 * v, tau);
      fundamental.connect(out);
      triggerOsc(c, "sine", freq, t, tau, fundamental);
      triggerOsc(c, "sine", freq + 0.7, t, tau, fundamental);

      const secondHarmonic = createEnvelope(c, t, 0.02, (0.12 + 0.1 * bright) * v, tau * 0.6);
      secondHarmonic.connect(out);
      triggerOsc(c, "sine", freq * 2.001, t, tau * 0.6, secondHarmonic);

      const thirdHarmonic = createEnvelope(c, t, 0.03, (0.07 + 0.03 * bright) * v, tau * 0.45);
      thirdHarmonic.connect(out);
      triggerOsc(c, "sine", freq * 2.998, t, tau * 0.45, thirdHarmonic);

      triggerNoiseHit(c, noise, t, "bandpass", clamp(freq * 3, 600, 2000), 2, (0.1 + 0.04 * bright) * v, 0.02, out);
    },

    kick(when: number, v = 0.8) {
      const c = ensure();
      const t = scheduleTime(when);
      const g = createEnvelope(c, t, 0.003, 0.7 * v, 0.3);
      g.connect(bus);
      const osc = triggerOsc(c, "sine", 130, t, 0.32, g);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    },

    bigKick(when: number, v = 1) {
      const c = ensure();
      const t = scheduleTime(when);
      const body = createEnvelope(c, t, 0.002, 0.95 * v, 0.48);
      body.connect(bus);
      const osc = triggerOsc(c, "sine", 165, t, 0.5, body);
      osc.frequency.exponentialRampToValueAtTime(46, t + 0.12);

      const transient = createEnvelope(c, t, 0.001, 0.35 * v, 0.025);
      transient.connect(bus);
      triggerOsc(c, "triangle", 1100, t, 0.03, transient);
      triggerNoiseHit(c, noise, t, "highpass", 3500, 0.7, 0.14 * v, 0.012, bus);
    },

    hat(when: number, v = 0.4, open = false) {
      const c = ensure();
      triggerNoiseHit(c, noise, scheduleTime(when), "highpass", open ? 6000 : 7500, 0.8, 0.12 * v, open ? 0.16 : 0.035, bus);
    },

    tak(when: number, v = 0.6, pitch = 1) {
      const c = ensure();
      const t = scheduleTime(when);
      triggerNoiseHit(c, noise, t, "bandpass", 2400 * pitch, 1.6, 0.26 * v, 0.07, bus);
      const g = createEnvelope(c, t, 0.002, 0.15 * v, 0.06);
      g.connect(bus);
      triggerOsc(c, "triangle", 300 * pitch, t, 0.06, g);
    },

    clap(when: number, v = 0.5) {
      const c = ensure();
      const t = scheduleTime(when);
      for (const offset of [0, 0.011, 0.023]) {
        triggerNoiseHit(c, noise, t + offset, "bandpass", 1500, 1.2, 0.28 * v, offset ? 0.03 : 0.16, bus);
      }
    },

    crash(when: number, v = 0.6) {
      const c = ensure();
      const t = scheduleTime(when);
      triggerNoiseHit(c, noise, t, "highpass", 5200, 0.6, 0.3 * v, 1.9, bus);
      triggerNoiseHit(c, noise, t, "bandpass", 9000, 0.8, 0.18 * v, 1.2, bus);
    },

    sub(when: number, hz: number, durSec: number, v = 0.45) {
      const c = ensure();
      const t = scheduleTime(when);
      const g = createEnvelope(c, t, 0.015, v, Math.max(0.1, durSec));
      const lp = createFilter(c, "lowpass", 220, 1);
      lp.connect(g);
      g.connect(musicBus);
      triggerOsc(c, "sine", hz, t, durSec, lp);
      triggerOsc(c, "triangle", hz * 2, t, durSec, lp);
    },

    bass(when: number, hz: number, durSec: number, v = 0.5) {
      const c = ensure();
      const t = scheduleTime(when);
      const g = createEnvelope(c, t, 0.006, v, Math.max(0.08, durSec));
      const lp = createFilter(c, "lowpass", 900, 5);
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + Math.max(0.08, durSec * 0.8));
      lp.connect(g);
      g.connect(musicBus);
      triggerOsc(c, "sawtooth", hz, t, durSec, lp);
      triggerOsc(c, "sine", hz / 2, t, durSec, lp);
    },

    impact(when: number, v = 1) {
      const c = ensure();
      const t = scheduleTime(when);
      const g = createEnvelope(c, t, 0.004, 0.8 * v, 1.4);
      g.connect(master);
      const osc = triggerOsc(c, "sine", 120, t, 1.4, g);
      osc.frequency.exponentialRampToValueAtTime(41, t + 0.1);
      triggerNoiseHit(c, noise, t, "lowpass", 3000, 0.7, 0.3 * v, 1.6, master);
    },

    release(when: number) {
      if (!ctx) return;
      const t = Math.max(ctx.currentTime, when);
      const targets: [AudioParam, number][] = [
        [hpf.frequency, 20],
        [riserGain.gain, 0.0001],
        [dry.gain, 1],
        [revSend.gain, 0.25],
        [revOut.gain, 0.5],
      ];
      for (const [param, value] of targets) {
        param.cancelScheduledValues(t);
        param.setTargetAtTime(value, t, 0.005);
      }
      hpf.Q.value = 0.7;
    },

    throwEcho(when: number, openSec: number, delaySec: number) {
      if (!ctx) return;
      const t = Math.max(ctx.currentTime, when);
      echoDelay.delayTime.setValueAtTime(delaySec, t);
      echoSend.gain.cancelScheduledValues(t);
      echoSend.gain.setTargetAtTime(1, t, 0.005);
      echoSend.gain.setTargetAtTime(0, t + openSec, 0.02);
    },

    duck(when: number, depth = 0.55, releaseSec = 0.16) {
      if (!ctx) return;
      const t = Math.max(ctx.currentTime, when);
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setTargetAtTime(1 - depth, t, 0.004);
      musicBus.gain.setTargetAtTime(1, t + 0.03, releaseSec / 3);
    },

    sweep(when: number, dur: number, peak = 1) {
      if (!ctx) return;
      const t = Math.max(ctx.currentTime, when);
      const ramps: [AudioParam, number, number][] = [
        [riserGain.gain, 0.0001, 0.24 * peak],
        [riserBP.frequency, 400, 5200],
        [hpf.frequency, 20, 700],
      ];
      for (const [param, from, to] of ramps) {
        param.cancelScheduledValues(t);
        param.setValueAtTime(from, t);
        param.exponentialRampToValueAtTime(to, t + dur);
      }
    },

    setRiser(amount: number) {
      if (!ctx) return;
      const t = ctx.currentTime;
      riserGain.gain.setTargetAtTime(Math.max(0.0001, amount ** 1.5 * 0.22), t, 0.04);
      riserBP.frequency.setTargetAtTime(300 + amount * 4500, t, 0.04);
    },

    setHPF(amount: number) {
      if (!ctx) return;
      hpf.frequency.setTargetAtTime(20 * 70 ** clamp(amount, 0, 1), ctx.currentTime, 0.03);
      hpf.Q.value = 0.7 + amount * 3;
    },

    setLPF(amount: number) {
      if (!ctx) return;
      lpf.frequency.setTargetAtTime(18000 * (400 / 18000) ** clamp(amount, 0, 1), ctx.currentTime, 0.03);
    },

    setFreeze(on: boolean) {
      if (!ctx) return;
      const t = ctx.currentTime;
      dry.gain.setTargetAtTime(on ? 0.0001 : 1, t, on ? 0.01 : 0.005);
      revSend.gain.setTargetAtTime(on ? 0.0001 : 0.25, t, 0.01);
      revOut.gain.setTargetAtTime(on ? 0.7 : 0.5, t, 0.05);
    },

    click(pitch = 1, strong = false) {
      if (!ctx) return;
      triggerNoiseHit(ctx, noise, ctx.currentTime + 0.001, "bandpass", 2200 * pitch, 5, strong ? 0.25 : 0.12, strong ? 0.025 : 0.012, uiBus);
    },
  };

  function initGraph() {
    // Safari legacy prefix fallback
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const c = (ctx = new AudioCtx());

    const compressor = c.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.ratio.value = 6;
    compressor.connect(c.destination);

    master = c.createGain();
    master.gain.value = 0.85 * volume;
    master.connect(compressor);

    lpf = createFilter(c, "lowpass", 18000, 0.7);
    hpf = createFilter(c, "highpass", 20, 0.7);
    dry = c.createGain();
    bus = c.createGain();
    bus.connect(hpf);
    hpf.connect(lpf);
    lpf.connect(dry);
    dry.connect(master);

    const convolver = c.createConvolver();
    convolver.buffer = createReverbImpulse(c, 2.6);
    revSend = c.createGain();
    revSend.gain.value = 0.25;
    revOut = c.createGain();
    revOut.gain.value = 0.5;
    lpf.connect(revSend);
    revSend.connect(convolver);
    convolver.connect(revOut);
    revOut.connect(master);

    noise = createNoiseBuffer(c, 2);
    const riserSource = c.createBufferSource();
    riserSource.buffer = noise;
    riserSource.loop = true;
    riserBP = createFilter(c, "bandpass", 400, 2);
    riserGain = c.createGain();
    riserGain.gain.value = 0.0001;
    riserSource.connect(riserBP);
    riserBP.connect(riserGain);
    riserGain.connect(master);
    riserSource.start();

    nakedBus = c.createGain();
    nakedBus.connect(master);
    const nakedReverbSend = c.createGain();
    nakedReverbSend.gain.value = 0.6;
    nakedBus.connect(nakedReverbSend);
    nakedReverbSend.connect(convolver);

    musicBus = c.createGain();
    musicBus.connect(bus);

    echoSend = c.createGain();
    echoSend.gain.value = 0;
    echoDelay = c.createDelay(2);
    const echoFeedback = c.createGain();
    const echoLP = createFilter(c, "lowpass", 2600, 0.7);
    echoFeedback.gain.value = 0.58;
    lpf.connect(echoSend);
    echoSend.connect(echoDelay);
    echoDelay.connect(echoLP);
    echoLP.connect(echoFeedback);
    echoFeedback.connect(echoDelay);
    echoLP.connect(master);

    uiBus = c.createGain();
    uiBus.gain.value = 0.2;
    uiBus.connect(master);
  }
}

export type AudioEngine = ReturnType<typeof createAudio>;

function createFilter(ctx: AudioContext, type: BiquadFilterType, frequency: number, q: number) {
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

function createEnvelope(ctx: AudioContext, start: number, attack: number, peak: number, decay: number) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(Math.max(0.0002, peak), start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(attack + 0.01, decay));
  return gain;
}

function triggerOsc(ctx: AudioContext, type: OscillatorType, freq: number, start: number, dur: number, dest: AudioNode) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  osc.connect(dest);
  osc.start(start);
  osc.stop(start + dur + 0.05);
  return osc;
}

function triggerNoiseHit(
  ctx: AudioContext,
  noiseBuffer: AudioBuffer,
  start: number,
  type: BiquadFilterType,
  freq: number,
  q: number,
  peak: number,
  dur: number,
  dest: AudioNode,
) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = createFilter(ctx, type, freq, q);
  const gain = createEnvelope(ctx, start, 0.002, peak, dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  src.start(start);
  src.stop(start + dur + 0.03);
}

function createReverbImpulse(ctx: AudioContext, seconds: number) {
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * seconds);
  const buffer = ctx.createBuffer(2, length, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45;
      data[i] = lp * (1 - i / length) ** 2.4 * 0.5;
    }
  }
  return buffer;
}

function createNoiseBuffer(ctx: AudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
