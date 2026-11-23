import { clamp } from "./math";
import { PAN_WORKLET_CODE, PAN_WORKLET_NAME } from "./pan-worklet";
import { noteAt } from "./theory";

const SOFT_CLIP_MAX_IN = 8;
const SOFT_CLIP_KNEE = 0.72;
const SOFT_CLIP_CEILING = 0.92;
const MAX_FALLBACK_PAN_VOICES = 24;
const MAX_PERC_VOICES = 28;
const STALE_EVENT_SEC = 0.06;

type ChokeableVoice = {
  endAt: number;
  choke: (at: number, fadeSec?: number) => void;
};

type FallbackPanVoice = ChokeableVoice & {
  pitchKey: number;
  bare: boolean;
  startAt: number;
  damping: boolean;
};

export function createAudio() {
  let ctx: AudioContext | null = null;
  let masterMix!: GainNode;
  let masterOut!: GainNode;
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
  let panFallbackBus!: GainNode;
  let echoSend!: GainNode;
  let echoDelay!: DelayNode;
  let nakedBus!: GainNode;
  let workletNode: AudioWorkletNode | null = null;
  let workletReady: Promise<void> = Promise.resolve();

  let volume = 0.8;
  let width = 1;

  // Cached real-time automation amounts to avoid redundant 60fps AudioParam spam
  let lastHpf = -1;
  let lastLpf = -1;
  let lastRiser = -1;
  let lastFreeze: boolean | null = null;

  // Voice tracking for monophonic low-end, bounded percussion, and Web Audio pan fallback
  let activeSub: ChokeableVoice | null = null;
  let activeBass: ChokeableVoice | null = null;
  let activeKick: ChokeableVoice | null = null;
  let activeImpact: ChokeableVoice | null = null;
  const activePerc: ChokeableVoice[] = [];
  const activeFallbackPan: FallbackPanVoice[] = [];

  const ensure = () => {
    if (!ctx) initGraph();
    if (ctx!.state === "suspended") ctx!.resume();
    return ctx!;
  };

  // Returns null if a scheduled timestamp is stale (>60ms in the past) to avoid stall bursts.
  // when === 0 or undefined means immediate live playback.
  const scheduleTime = (when?: number): number | null => {
    const now = ctx!.currentTime;
    if (when != null && when > 0) {
      if (when < now - STALE_EVENT_SEC) return null;
      return Math.max(now + 0.002, when);
    }
    return now + 0.002;
  };

  const trackPerc = (voice: ChokeableVoice, at: number) => {
    pruneEnded(activePerc, at);
    while (activePerc.length >= MAX_PERC_VOICES) {
      const oldest = activePerc.shift()!;
      oldest.choke(at, 0.008);
    }
    activePerc.push(voice);
  };

  const updateFallbackPanGain = (at: number) => {
    if (!ctx) return;
    pruneEnded(activeFallbackPan, at);
    let sounding = 0;
    for (const v of activeFallbackPan) {
      if (!v.damping) sounding++;
    }
    const target = sounding <= 2 ? 1 : 1 / Math.sqrt(1 + (sounding - 2) * 0.35);
    panFallbackBus.gain.setTargetAtTime(target, at, 0.015);
  };

  return {
    ensure,
    ready: () => workletReady,
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
      if (ctx) {
        const t = ctx.currentTime;
        cancelAndHold(masterOut.gain, t);
        masterOut.gain.setTargetAtTime(volume, t, 0.02);
      }
    },

    pan(lane: number, when = 0, vel = 0.8, durSteps = 4, octave = 0, bare = false, bright = 0) {
      const c = ensure();
      const note = noteAt(lane);
      if (!note) return;

      const t = scheduleTime(when);
      if (t === null) return;

      const v = clamp(vel, 0.05, 1);
      const freq = note.freq * (octave ? 2 : 1);
      const tau = clamp(0.25 + durSteps * 0.22, 0.3, 3.6) * (lane <= 0 ? 1.3 : 1) * (lane > 8 ? 0.8 : 1);
      const panVal = clamp(note.pan * width, -1, 1);
      const pitchKey = lane * 2 + (octave ? 1 : 0);

      // Fast path: zero-allocation AudioWorklet polyphonic handpan synth
      if (workletNode) {
        workletNode.port.postMessage({
          type: "pan",
          t,
          key: pitchKey,
          freq,
          vel: v,
          tau,
          bright: clamp(bright, 0, 1),
          pan: panVal,
          bare,
        });
        return;
      }

      // Voice-managed Web Audio fallback (active only during initial ~10ms worklet load or if AudioWorklet unavailable)
      pruneEnded(activeFallbackPan, t);
      for (const existing of activeFallbackPan) {
        if (existing.pitchKey === pitchKey && existing.bare === bare && !existing.damping) {
          if (Math.abs(t - existing.startAt) < 0.005) return;
          existing.damping = true;
          existing.choke(t, 0.02);
        }
      }
      while (activeFallbackPan.length >= MAX_FALLBACK_PAN_VOICES) {
        const oldest = activeFallbackPan.shift()!;
        oldest.choke(t, 0.01);
      }

      const out = c.createGain();
      out.gain.setValueAtTime(1, t);
      const panner = c.createStereoPanner();
      panner.pan.setValueAtTime(panVal, t);
      out.connect(panner);
      panner.connect(bare ? nakedBus : panFallbackBus);

      const sources: AudioScheduledSourceNode[] = [];
      const nodes: AudioNode[] = [out, panner];

      const fundamental = createEnvelope(c, t, 0.004, 0.24 * v, tau);
      fundamental.connect(out);
      nodes.push(fundamental);
      sources.push(
        triggerOsc(c, "sine", freq, t, tau, fundamental),
        triggerOsc(c, "sine", freq + 0.7, t, tau, fundamental),
      );

      const secondHarmonic = createEnvelope(c, t, 0.02, (0.11 + 0.09 * bright) * v, tau * 0.6);
      secondHarmonic.connect(out);
      nodes.push(secondHarmonic);
      sources.push(triggerOsc(c, "sine", freq * 2.001, t, tau * 0.6, secondHarmonic));

      const thirdHarmonic = createEnvelope(c, t, 0.03, (0.065 + 0.03 * bright) * v, tau * 0.45);
      thirdHarmonic.connect(out);
      nodes.push(thirdHarmonic);
      sources.push(triggerOsc(c, "sine", freq * 2.998, t, tau * 0.45, thirdHarmonic));

      const mallet = triggerNoiseHit(c, noise, t, "bandpass", clamp(freq * 3, 600, 2000), 2, (0.09 + 0.035 * bright) * v, 0.02, out);
      sources.push(mallet.src);
      nodes.push(mallet.filter, mallet.gain);

      const endAt = t + tau + 0.04;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        disconnectAll(nodes);
        removeVoice(activeFallbackPan, voice);
      };

      sources[0].onended = cleanup;

      const voice: FallbackPanVoice = {
        pitchKey,
        bare,
        startAt: t,
        endAt,
        damping: false,
        choke(at: number, fadeSec = 0.015) {
          if (cleaned) return;
          const stopAt = chokeGainAndSources(out.gain, sources, at, fadeSec);
          voice.endAt = Math.min(voice.endAt, stopAt);
        },
      };

      activeFallbackPan.push(voice);
      if (!bare) updateFallbackPanGain(t);
    },

    kick(when: number, v = 0.8) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 1.1);

      activeKick?.choke(t, 0.01);

      const dur = 0.3;
      const g = createEnvelope(c, t, 0.003, 0.56 * vel, dur);
      g.connect(bus);
      const osc = triggerOsc(c, "sine", 130, t, dur, g);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);

      const voice = makeVoice([g], [osc], g.gain, t + dur + 0.03, () => {
        if (activeKick === voice) activeKick = null;
      });
      activeKick = voice;
    },

    bigKick(when: number, v = 1) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 1.15);

      activeKick?.choke(t, 0.01);

      const bodyDur = 0.46;
      const body = createEnvelope(c, t, 0.002, 0.68 * vel, bodyDur);
      body.connect(bus);
      const bodyOsc = triggerOsc(c, "sine", 160, t, bodyDur, body);
      bodyOsc.frequency.exponentialRampToValueAtTime(44, t + 0.12);

      const transientDur = 0.025;
      const transient = createEnvelope(c, t, 0.002, 0.22 * vel, transientDur);
      transient.connect(bus);
      const triOsc = triggerOsc(c, "triangle", 1050, t, transientDur, transient);

      const hit = triggerNoiseHit(c, noise, t, "highpass", 3500, 0.7, 0.1 * vel, 0.012, bus);

      const voice = makeVoice([body, transient, hit.filter, hit.gain], [bodyOsc, triOsc, hit.src], body.gain, t + bodyDur + 0.03, () => {
        if (activeKick === voice) activeKick = null;
      });
      activeKick = voice;
    },

    hat(when: number, v = 0.4, open = false) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 1.1);
      const dur = open ? 0.16 : 0.035;
      const hit = triggerNoiseHit(c, noise, t, "highpass", open ? 6000 : 7500, 0.8, 0.11 * vel, dur, bus);
      const voice = makeVoice([hit.filter, hit.gain], [hit.src], hit.gain.gain, t + dur + 0.03, () => removeVoice(activePerc, voice));
      trackPerc(voice, t);
    },

    tak(when: number, v = 0.6, pitch = 1) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 1.1);
      const p = clamp(pitch, 0.4, 3);

      const dur = 0.07;
      const hit = triggerNoiseHit(c, noise, t, "bandpass", clamp(2400 * p, 200, 14000), 1.6, 0.22 * vel, dur, bus);
      const g = createEnvelope(c, t, 0.002, 0.13 * vel, 0.06);
      g.connect(bus);
      const osc = triggerOsc(c, "triangle", 300 * p, t, 0.06, g);

      const voice = makeVoice([hit.filter, hit.gain, g], [hit.src, osc], hit.gain.gain, t + dur + 0.03, () => removeVoice(activePerc, voice));
      trackPerc(voice, t);
    },

    clap(when: number, v = 0.5) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 1.1);

      for (const offset of [0, 0.011, 0.023]) {
        const dur = offset ? 0.03 : 0.16;
        const hit = triggerNoiseHit(c, noise, t + offset, "bandpass", 1500, 1.2, 0.2 * vel, dur, bus);
        const voice = makeVoice([hit.filter, hit.gain], [hit.src], hit.gain.gain, t + offset + dur + 0.03, () => removeVoice(activePerc, voice));
        trackPerc(voice, t);
      }
    },

    crash(when: number, v = 0.6) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 1.1);

      const h1 = triggerNoiseHit(c, noise, t, "highpass", 5200, 0.6, 0.22 * vel, 1.85, bus);
      const h2 = triggerNoiseHit(c, noise, t, "bandpass", 9000, 0.8, 0.14 * vel, 1.2, bus);
      const voice = makeVoice([h1.filter, h1.gain, h2.filter, h2.gain], [h1.src, h2.src], h1.gain.gain, t + 1.9, () => removeVoice(activePerc, voice));
      trackPerc(voice, t);
    },

    sub(when: number, hz: number, durSec: number, v = 0.45) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 0.85);
      const dur = Math.max(0.1, durSec);

      activeSub?.choke(t, 0.015);

      const g = createEnvelope(c, t, 0.015, vel, dur);
      const lp = createFilter(c, "lowpass", 220, 0.8);
      const sineGain = c.createGain();
      sineGain.gain.value = 0.65;
      const triGain = c.createGain();
      triGain.gain.value = 0.35;

      sineGain.connect(lp);
      triGain.connect(lp);
      lp.connect(g);
      g.connect(musicBus);

      const osc1 = triggerOsc(c, "sine", hz, t, dur, sineGain);
      const osc2 = triggerOsc(c, "triangle", hz * 2, t, dur, triGain);

      const voice = makeVoice([sineGain, triGain, lp, g], [osc1, osc2], g.gain, t + dur + 0.03, () => {
        if (activeSub === voice) activeSub = null;
      });
      activeSub = voice;
    },

    bass(when: number, hz: number, durSec: number, v = 0.5) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 0.85);
      const dur = Math.max(0.08, durSec);

      activeBass?.choke(t, 0.012);

      const g = createEnvelope(c, t, 0.006, vel, dur);
      const lp = createFilter(c, "lowpass", 880, 3.2);
      lp.frequency.setValueAtTime(880, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + Math.max(0.08, dur * 0.8));

      const sawGain = c.createGain();
      sawGain.gain.value = 0.42;
      const subGain = c.createGain();
      subGain.gain.value = 0.38;

      sawGain.connect(lp);
      subGain.connect(lp);
      lp.connect(g);
      g.connect(musicBus);

      const osc1 = triggerOsc(c, "sawtooth", hz, t, dur, sawGain);
      const osc2 = triggerOsc(c, "sine", hz / 2, t, dur, subGain);

      const voice = makeVoice([sawGain, subGain, lp, g], [osc1, osc2], g.gain, t + dur + 0.03, () => {
        if (activeBass === voice) activeBass = null;
      });
      activeBass = voice;
    },

    impact(when: number, v = 1) {
      const c = ensure();
      const t = scheduleTime(when);
      if (t === null) return;
      const vel = clamp(v, 0, 1);

      activeImpact?.choke(t, 0.015);

      const dur = 1.4;
      const g = createEnvelope(c, t, 0.005, 0.48 * vel, dur);
      g.connect(masterMix);
      const osc = triggerOsc(c, "sine", 115, t, dur, g);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.11);

      const hit = triggerNoiseHit(c, noise, t, "lowpass", 2800, 0.7, 0.22 * vel, 1.5, masterMix);

      const voice = makeVoice([g, hit.filter, hit.gain], [osc, hit.src], g.gain, t + 1.55, () => {
        if (activeImpact === voice) activeImpact = null;
      });
      activeImpact = voice;
    },

    release(when: number) {
      if (!ctx) return;
      const t = Math.max(ctx.currentTime, when);
      const targets: [AudioParam, number, number][] = [
        [hpf.frequency, 20, 0.012],
        [hpf.Q, 0.7, 0.015],
        [riserGain.gain, 0.0001, 0.01],
        [dry.gain, 1, 0.008],
        [revSend.gain, 0.24, 0.01],
        [revOut.gain, 0.48, 0.012],
      ];
      for (const [param, value, tc] of targets) {
        cancelAndHold(param, t);
        param.setTargetAtTime(value, t, tc);
      }
      lastHpf = -1;
      lastRiser = -1;
      lastFreeze = false;
    },

    throwEcho(when: number, openSec: number, delaySec: number) {
      if (!ctx) return;
      const t = Math.max(ctx.currentTime, when);
      const safeDelay = clamp(delaySec, 0.01, 1.95);
      cancelAndHold(echoDelay.delayTime, t);
      echoDelay.delayTime.setTargetAtTime(safeDelay, t, 0.015);
      cancelAndHold(echoSend.gain, t);
      echoSend.gain.setTargetAtTime(0.85, t, 0.008);
      echoSend.gain.setTargetAtTime(0, t + Math.max(0.02, openSec), 0.025);
    },

    duck(when: number, depth = 0.55, releaseSec = 0.16) {
      if (!ctx) return;
      const t = Math.max(ctx.currentTime, when);
      const safeDepth = clamp(depth, 0, 0.92);
      cancelAndHold(musicBus.gain, t);
      musicBus.gain.setTargetAtTime(1 - safeDepth, t, 0.004);
      musicBus.gain.setTargetAtTime(1, t + 0.03, Math.max(0.015, releaseSec / 3));
    },

    sweep(when: number, dur: number, peak = 1) {
      if (!ctx) return;
      const t = Math.max(ctx.currentTime, when);
      const safeDur = Math.max(0.05, dur);
      const ramps: [AudioParam, number, number][] = [
        [riserGain.gain, 0.0001, 0.22 * clamp(peak, 0, 1.2)],
        [riserBP.frequency, 400, 5200],
        [hpf.frequency, 20, 700],
      ];
      for (const [param, from, to] of ramps) {
        cancelAndHold(param, t);
        param.linearRampToValueAtTime(from, t + 0.008);
        param.exponentialRampToValueAtTime(to, t + safeDur);
      }
      lastHpf = -1;
      lastRiser = -1;
    },

    setRiser(amount: number) {
      if (!ctx) return;
      const clamped = clamp(amount, 0, 1);
      if (Math.abs(clamped - lastRiser) < 1e-4) return;
      lastRiser = clamped;
      const t = ctx.currentTime;
      riserGain.gain.setTargetAtTime(Math.max(0.0001, clamped ** 1.5 * 0.2), t, 0.04);
      riserBP.frequency.setTargetAtTime(300 + clamped * 4500, t, 0.04);
    },

    setHPF(amount: number) {
      if (!ctx) return;
      const clamped = clamp(amount, 0, 1);
      if (Math.abs(clamped - lastHpf) < 1e-4) return;
      lastHpf = clamped;
      const t = ctx.currentTime;
      hpf.frequency.setTargetAtTime(20 * 70 ** clamped, t, 0.03);
      hpf.Q.setTargetAtTime(0.7 + clamped * 2.5, t, 0.03);
    },

    setLPF(amount: number) {
      if (!ctx) return;
      const clamped = clamp(amount, 0, 1);
      if (Math.abs(clamped - lastLpf) < 1e-4) return;
      lastLpf = clamped;
      lpf.frequency.setTargetAtTime(18000 * (400 / 18000) ** clamped, ctx.currentTime, 0.03);
    },

    setFreeze(on: boolean) {
      if (!ctx || lastFreeze === on) return;
      lastFreeze = on;
      const t = ctx.currentTime;
      dry.gain.setTargetAtTime(on ? 0.0001 : 1, t, on ? 0.01 : 0.008);
      revSend.gain.setTargetAtTime(on ? 0.0001 : 0.24, t, 0.01);
      revOut.gain.setTargetAtTime(on ? 0.65 : 0.48, t, 0.05);
    },

    click(pitch = 1, strong = false) {
      if (!ctx) return;
      const t = ctx.currentTime + 0.001;
      const dur = strong ? 0.025 : 0.012;
      const hit = triggerNoiseHit(ctx, noise, t, "bandpass", clamp(2200 * pitch, 200, 12000), 5, strong ? 0.22 : 0.11, dur, uiBus);
      const voice = makeVoice([hit.filter, hit.gain], [hit.src], hit.gain.gain, t + dur + 0.03, () => removeVoice(activePerc, voice));
      trackPerc(voice, t);
    },
  };

  function initGraph() {
    // Safari legacy prefix fallback
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const c = (ctx = new AudioCtx());

    // Mastering chain: masterMix -> dcBlocker -> busComp -> softCeiling (4x oversampled) -> masterOut (user volume) -> destination
    // Placing user volume after dynamics keeps tonal balance consistent at every volume level and prevents DAC clipping even at 100%.
    masterMix = c.createGain();
    masterMix.gain.value = 1;

    const dcBlocker = createFilter(c, "highpass", 24, 0.707);

    const compressor = c.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 10;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.1;

    const postCompTrim = c.createGain();
    postCompTrim.gain.value = 0.85;

    const softClipPre = c.createGain();
    softClipPre.gain.value = 1 / SOFT_CLIP_MAX_IN;

    const softCeiling = c.createWaveShaper();
    softCeiling.curve = createSoftCeilingCurve(32769, SOFT_CLIP_MAX_IN, SOFT_CLIP_KNEE, SOFT_CLIP_CEILING);
    softCeiling.oversample = "4x";

    masterOut = c.createGain();
    masterOut.gain.value = volume;

    masterMix.connect(dcBlocker);
    dcBlocker.connect(compressor);
    compressor.connect(postCompTrim);
    postCompTrim.connect(softClipPre);
    softClipPre.connect(softCeiling);
    softCeiling.connect(masterOut);
    masterOut.connect(c.destination);

    lpf = createFilter(c, "lowpass", 18000, 0.707);
    hpf = createFilter(c, "highpass", 20, 0.707);
    dry = c.createGain();
    bus = c.createGain();
    bus.connect(hpf);
    hpf.connect(lpf);
    lpf.connect(dry);
    dry.connect(masterMix);

    // High-pass the reverb send at 200 Hz so kicks, sub-bass, and bass don't muddy the 2.6s reverb or eat master headroom
    const revHPF = createFilter(c, "highpass", 200, 0.707);
    const convolver = c.createConvolver();
    convolver.buffer = createReverbImpulse(c, 2.6);
    revSend = c.createGain();
    revSend.gain.value = 0.24;
    revOut = c.createGain();
    revOut.gain.value = 0.48;
    lpf.connect(revSend);
    revSend.connect(revHPF);
    revHPF.connect(convolver);
    convolver.connect(revOut);
    revOut.connect(masterMix);

    noise = createNoiseBuffer(c, 2);
    const riserSource = c.createBufferSource();
    riserSource.buffer = noise;
    riserSource.loop = true;
    riserBP = createFilter(c, "bandpass", 400, 2);
    riserGain = c.createGain();
    riserGain.gain.value = 0.0001;
    riserSource.connect(riserBP);
    riserBP.connect(riserGain);
    riserGain.connect(masterMix);
    riserSource.start();

    nakedBus = c.createGain();
    nakedBus.connect(masterMix);
    const nakedReverbSend = c.createGain();
    nakedReverbSend.gain.value = 0.55;
    nakedBus.connect(nakedReverbSend);
    nakedReverbSend.connect(revHPF);

    musicBus = c.createGain();
    musicBus.connect(bus);

    panFallbackBus = c.createGain();
    panFallbackBus.connect(musicBus);

    // High-pass inside echo feedback loop to prevent sub-bass/DC accumulation across repeats
    echoSend = c.createGain();
    echoSend.gain.value = 0;
    echoDelay = c.createDelay(2);
    const echoHPF = createFilter(c, "highpass", 180, 0.707);
    const echoLP = createFilter(c, "lowpass", 2600, 0.707);
    const echoFeedback = c.createGain();
    echoFeedback.gain.value = 0.54;
    lpf.connect(echoSend);
    echoSend.connect(echoDelay);
    echoDelay.connect(echoHPF);
    echoHPF.connect(echoLP);
    echoLP.connect(echoFeedback);
    echoFeedback.connect(echoDelay);
    echoLP.connect(masterMix);

    uiBus = c.createGain();
    uiBus.gain.value = 0.2;
    uiBus.connect(masterMix);

    // Load AudioWorklet polyphonic handpan synth asynchronously; Web Audio fallback handles any immediate notes until ready
    if (c.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      const blob = new Blob([PAN_WORKLET_CODE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      workletReady = c.audioWorklet
        .addModule(url)
        .then(() => {
          URL.revokeObjectURL(url);
          if (ctx !== c) return;
          const node = new AudioWorkletNode(c, PAN_WORKLET_NAME, {
            numberOfInputs: 0,
            numberOfOutputs: 2,
            outputChannelCount: [2, 2],
          });
          node.connect(musicBus, 0);
          node.connect(nakedBus, 1);
          workletNode = node;
        })
        .catch(() => {
          URL.revokeObjectURL(url);
        });
    }
  }
}

export type AudioEngine = ReturnType<typeof createAudio>;

function cancelAndHold(param: AudioParam, time: number) {
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(time);
  } else {
    param.cancelScheduledValues(time);
    param.setValueAtTime(param.value, time);
  }
}

function chokeGainAndSources(gainParam: AudioParam, sources: AudioScheduledSourceNode[], at: number, fadeSec: number) {
  const stopAt = at + fadeSec + 0.005;
  try {
    cancelAndHold(gainParam, at);
    gainParam.linearRampToValueAtTime(0, at + fadeSec);
    for (const src of sources) {
      try {
        src.stop(stopAt);
      } catch {}
    }
  } catch {}
  return stopAt;
}

function disconnectAll(nodes: AudioNode[]) {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {}
  }
}

function makeVoice(
  nodes: AudioNode[],
  sources: AudioScheduledSourceNode[],
  gainParam: AudioParam,
  endAt: number,
  onDone: () => void,
): ChokeableVoice {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    disconnectAll(nodes);
    onDone();
  };
  sources[0].onended = cleanup;

  const voice: ChokeableVoice = {
    endAt,
    choke(at: number, fadeSec = 0.012) {
      if (cleaned) return;
      const stopAt = chokeGainAndSources(gainParam, sources, at, fadeSec);
      voice.endAt = Math.min(voice.endAt, stopAt);
    },
  };
  return voice;
}

function pruneEnded<T extends ChokeableVoice>(list: T[], now: number) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].endAt <= now) list.splice(i, 1);
  }
}

function removeVoice<T>(list: T[], item: T) {
  const idx = list.indexOf(item);
  if (idx >= 0) list.splice(idx, 1);
}

function createFilter(ctx: AudioContext, type: BiquadFilterType, frequency: number, q: number) {
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

function createEnvelope(ctx: AudioContext, start: number, attack: number, peak: number, decay: number) {
  const gain = ctx.createGain();
  const safePeak = Math.max(0.0002, peak);
  const decayEnd = start + Math.max(attack + 0.01, decay);
  gain.gain.setValueAtTime(0, 0);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(safePeak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, decayEnd);
  gain.gain.linearRampToValueAtTime(0, decayEnd + 0.012);
  return gain;
}

function triggerOsc(ctx: AudioContext, type: OscillatorType, freq: number, start: number, dur: number, dest: AudioNode) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  osc.connect(dest);
  osc.start(start);
  osc.stop(start + Math.max(0.03, dur) + 0.025);
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
  src.loop = true;
  const filter = createFilter(ctx, type, freq, q);
  const gain = createEnvelope(ctx, start, 0.002, peak, dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  // Randomize start offset so simultaneous noise hits are decorrelated (no coherent summing or comb filtering)
  src.start(start, Math.random() * noiseBuffer.duration);
  src.stop(start + Math.max(0.02, dur) + 0.025);
  return { src, filter, gain };
}

function createSoftCeilingCurve(samples: number, maxIn: number, knee: number, ceiling: number) {
  const curve = new Float32Array(samples);
  const headroom = ceiling - knee;
  const half = (samples - 1) / 2;
  for (let i = 0; i < samples; i++) {
    const raw = ((i - half) / half) * maxIn;
    const abs = Math.abs(raw);
    if (abs <= knee) {
      curve[i] = raw;
    } else {
      curve[i] = Math.sign(raw) * (knee + headroom * Math.tanh((abs - knee) / headroom));
    }
  }
  return curve;
}

function createReverbImpulse(ctx: AudioContext, seconds: number) {
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * seconds);
  const fadeInSamples = Math.max(1, Math.floor(sr * 0.012));
  const buffer = ctx.createBuffer(2, length, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    let sum = 0;
    for (let i = 0; i < length; i++) {
      lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45;
      const onset = i < fadeInSamples ? i / fadeInSamples : 1;
      const val = lp * onset * (1 - i / length) ** 2.4 * 0.5;
      data[i] = val;
      sum += val;
    }
    const mean = sum / length;
    for (let i = 0; i < length; i++) data[i] -= mean;
  }
  return buffer;
}

function createNoiseBuffer(ctx: AudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
