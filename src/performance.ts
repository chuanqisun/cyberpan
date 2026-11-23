import type { AudioEngine } from "./audio";
import type { Clock } from "./clock";
import { baseBar, createNote, type Engine, type FxHooks, type Lock, type Note } from "./engine";
import { FUT, type Layout } from "./layout";
import { clamp, hash01, lerp, mod, nearestIndex } from "./math";
import { METRIC, type Harmony, type HarmonySegment } from "./theory";

export type FxMode = "groove" | "build" | "freeze" | "armed" | "climax" | "stop";
export type DropKind = "half" | "full" | "fake";
export type StopKind = "cut" | "echo" | "fade";

export type HudSelection =
  | { zone: "drop"; i: number; kind: DropKind }
  | { zone: "stop"; i: number; kind: StopKind };

export const DROP_PADS: { kind: DropKind; label: string }[] = [
  { kind: "half", label: "HALF" },
  { kind: "full", label: "FULL" },
  { kind: "fake", label: "FAKEOUT" },
];

export const STOP_PADS: { kind: StopKind; label: string }[] = [
  { kind: "cut", label: "CUT" },
  { kind: "echo", label: "ECHO OUT" },
  { kind: "fade", label: "FADE" },
];

export const HUD = { dead: 60, band: 36, rowY: 118, dx: 136, side: 68, w: 116, h: 38 };

const BUILD_STEPS = 32;
const ROLL_LENGTHS = [8, 4, 2, 1];
const CLIMAX_DING_STEPS = [0, 8];

const nowMs = () => performance.now();
const isPlayerNote = (note: Note) => note.src === "place" || note.src === "hold";

export function createPerformance(
  audio: AudioEngine,
  clock: Clock,
  harmony: Harmony,
  layout: Layout<Lock>,
  engine: Engine,
  onPlayStateChange: (playing: boolean) => void,
) {
  const state = {
    mode: "groove" as FxMode,
    space: false,
    spaceAt: 0,
    spaceStartedPlay: false,
    spaceUsed: false,
    mouse: false,
    mx: 0,
    my: 0,
    build: 0,
    buildStart: 0,
    rollLen: 0,
    rollOrigin: 0,
    rollSrc: [] as { off: number; lane: number; vel: number }[],
    charge: 0,
    freezeAt: 0,
    kind: "full" as DropKind,
    hud: null as { ax: number; ay: number; ready: boolean } | null,
    hsel: null as HudSelection | null,
    drop: null as { step: number; slam: number; e: number; kind: DropKind } | null,
    hook: null as { base: number; cells: { off: number; rel: number }[] } | null,
    stop: null as { kind: StopKind; start: number; end: number; base: number; t: number; seg: HarmonySegment | null; ghost: Note[] } | null,
    events: [] as { at: number; fn: () => void }[],
    kicks: [] as { t: number; v: number }[],
    boom: null as { t: number; e: number } | null,
    shake: 0,
    flash: 0,
    rings: [] as { t: number; x: number; y: number; r1: number; dur: number; col: string; w: number }[],
  };

  const scheduleVisual = (when: number, fn: () => void) => state.events.push({ at: when, fn });

  const shock = (x: number, y: number, r1: number, dur: number, col: string, w = 2) =>
    state.rings.push({ t: nowMs(), x, y, r1, dur, col, w });

  const inClimax = (step: number) => Boolean(state.drop && step >= state.drop.slam && step < state.drop.slam + 128);

  const climaxBar = (step: number) => Math.floor((step - state.drop!.slam) / 16);

  const isBuildingOrArmed = (step: number) =>
    state.mode === "build" || (state.mode === "armed" && !(state.drop && step >= state.drop.step));

  const stopProgress = (step: number) =>
    clamp((step - state.stop!.start) / Math.max(1, state.stop!.end - state.stop!.start), 0, 1);

  const stopLineStep = () => {
    const u = clamp((nowMs() - state.stop!.t) / 750, 0, 1);
    return lerp(engine.state.pos + FUT, state.stop!.start, 1 - (1 - u) ** 3);
  };

  const isStopLanding = () => Boolean(state.stop && nowMs() - state.stop.t < 750);

  const openHud = () => {
    const mx = state.mx || layout.tape.cx;
    const my = state.my || layout.tape.nowY;
    const ax = clamp(mx, HUD.dx + HUD.w / 2 + 12, layout.width - HUD.dx - HUD.w / 2 - 12);
    const ay = clamp(my, HUD.rowY + HUD.h / 2 + 40, layout.height - HUD.rowY - HUD.h / 2 - 12);
    state.hud = { ax, ay, ready: Math.hypot(mx - ax, my - ay) < HUD.dead };
    state.hsel = null;
  };

  const closeHud = () => {
    state.hud = null;
    state.hsel = null;
  };

  const hudMove = () => {
    const hud = state.hud;
    if (!hud || state.mode === "freeze") return;
    if (!hud.ready && Math.hypot(state.mx - hud.ax, state.my - hud.ay) < HUD.dead) hud.ready = true;

    const picked = hudPick();
    const prev = state.hsel;
    if (picked && (!prev || prev.kind !== picked.kind)) {
      audio.click(0.7 + 0.35 * picked.i, picked.zone !== prev?.zone);
    }
    state.hsel = picked;

    if (picked?.zone === "drop" && (state.mode === "groove" || state.mode === "climax")) startBuild();
    if (picked?.zone === "stop" && state.mode === "build") cancel();
  };

  const releaseBuild = (kind: DropKind = "full") => {
    if (state.build < 0.08) return cancel();
    let dropStep = (Math.floor(engine.state.pos / 16) + 1) * 16;
    if (dropStep - engine.state.pos < 1.5) dropStep += 16;
    setDrop(dropStep, 0.35 + 0.45 * state.build, kind);
    state.mode = "armed";
  };

  const enterFreeze = (x: number, y: number) => {
    state.mode = "freeze";
    state.spaceUsed = true;
    state.freezeAt = nowMs();
    state.mx = x;
    state.my = y;
    clock.stop();
    audio.setFreeze(true);
    audio.setRiser(0);
    audio.pan(8, 0, 0.55, 14, 0, true);
    state.flash = 0.25;
    shock(layout.tape.cx, layout.tape.nowY, Math.max(layout.width, layout.height), 0.9, "rgba(255,255,255,", 1);
  };

  const dropFromFreeze = (kind: DropKind = state.kind || "full") => {
    const dropStep = Math.ceil(engine.state.pos / 16 - 1e-6) * 16 || 16;
    engine.seekFreezeDrop(dropStep);
    setDrop(dropStep, 0.55 + 0.45 * state.charge, kind);
    state.mode = "armed";
    clock.start();
    onPlayStateChange(true);
  };

  const commitStop = (kind: StopKind) => {
    const pos = engine.state.pos;
    const nextBar = (Math.floor(pos / 16) + 1) * 16;
    let end = (nextBar - pos < 3 ? nextBar + 16 : nextBar) + 16;

    if (kind === "fade") {
      let targetBar = end / 16 + 2;
      while (harmony.progressionIndex(targetBar) !== 0 && harmony.progressionIndex(targetBar) !== 3) targetBar++;
      end = targetBar * 16;
    }

    const seg = kind === "fade" ? null : harmony.pushSegment(end / 16);
    const ghost = engine.futureNotes(pos + FUT + 1);
    state.stop = { kind, start: kind === "fade" ? nextBar : end, end, base: end + 32, t: nowMs(), seg, ghost };
    state.mode = "stop";
    engine.releaseAllHold();
    audio.click(0.5, true);
    engine.invalidate();
  };

  const cancel = () => {
    if (state.mode === "stop" && state.stop) {
      if (state.stop.seg) harmony.removeSegment(state.stop.seg);
      state.stop = null;
      state.mode = state.drop && inClimax(engine.state.pos) ? "climax" : "groove";
      audio.setLPF(0);
      engine.invalidate();
      return;
    }

    const wasFrozen = state.mode === "freeze";
    state.mode = state.drop && inClimax(engine.state.pos) ? "climax" : "groove";
    state.build = 0;
    audio.setFreeze(false);
    audio.setHPF(0);
    audio.setRiser(0);
    if (wasFrozen) clock.start();
    engine.invalidate();
  };

  const update = () => {
    const t = nowMs();
    const pos = engine.state.pos;

    state.events = state.events.filter((ev) => (audio.now() >= ev.at - 0.005 ? (ev.fn(), false) : true));

    if (state.space && clock.playing && !state.spaceStartedPlay && !state.spaceUsed && (state.mode === "groove" || state.mode === "climax")) {
      if (t - state.spaceAt > 180 && !state.hud) openHud();
    }

    if (state.mode === "build") {
      state.build = clamp((pos - state.buildStart) / BUILD_STEPS, 0, 1);
      const nextLen = ROLL_LENGTHS[state.build < 0.3 ? 0 : state.build < 0.55 ? 1 : state.build < 0.8 ? 2 : 3];
      if (nextLen !== state.rollLen) {
        state.rollLen = nextLen;
        engine.invalidateView();
      }
    }

    if (isBuildingOrArmed(pos)) {
      audio.setHPF(0.7 * state.build);
      audio.setRiser(state.build);
    }

    if (state.mode === "freeze") state.charge = clamp((t - state.freezeAt) / 1800, 0, 1);

    if (state.mode === "climax" && state.drop && pos > state.drop.slam + 128) {
      state.mode = "groove";
      engine.invalidate();
    }

    if (state.stop?.kind === "fade") audio.setLPF(0.3 + 0.38 * stopProgress(pos));

    audio.width = state.mode === "climax" && state.drop && state.drop.kind !== "half" ? 1.4 : 1;
    state.kicks = state.kicks.filter((k) => t - k.t < 1200);
    state.shake *= 0.88;
    state.flash *= 0.8;
    state.rings = state.rings.filter((r) => t - r.t < r.dur * 1000);
  };

  const noteOffset = (note: { step: number; lane: number }) => {
    const t = nowMs();
    const h1 = hash01(note.step, note.lane, 401);
    const h2 = hash01(note.step, note.lane, 402);

    let kickImpulse = 0;
    for (const kick of state.kicks) {
      const u = (t - kick.t) / 1000;
      if (u >= 0) kickImpulse += kick.v * Math.exp(-u * 10);
    }

    let boomSpring = 0;
    if (state.boom) {
      const u = (t - state.boom.t) / 1000;
      boomSpring = state.boom.e * Math.exp(-u * 2.4) * Math.cos(u * 13);
    }

    let dx = 0;
    let dy = -(30 * kickImpulse * (0.4 + 0.9 * h1) + 140 * boomSpring * (0.4 + 0.9 * h2));

    const tense =
      state.mode === "freeze"
        ? 2 + 7 * state.charge
        : state.mode === "build" || state.mode === "armed"
          ? 4 * state.build * state.build
          : 0;
    if (tense) {
      const frame = Math.floor(t / 40);
      dx += (hash01(note.step, note.lane, frame) - 0.5) * 2 * tense;
      dy += (hash01(note.lane, note.step, frame + 7) - 0.5) * 2 * tense;
    }

    return { dx, dy };
  };

  const hooks: FxHooks = {
    climaxNotes,
    bloomOctave: (note) =>
      inClimax(note.step) &&
      climaxBar(note.step) >= 2 &&
      note.lock &&
      (note.idx ?? 0) % 2 === 0 &&
      note.lane >= 1 &&
      note.lane <= 4 &&
      harmony.chordAt(Math.floor(note.step / 16)).pool.includes(note.lane)
        ? 1
        : 0,
    applyView,
    scheduleDrums,
    isRollStutter: () => state.rollLen === 1 && state.build > 0.9,
    isFrozen: () => state.mode === "freeze",
    onFreezeTap: (lane) => shock(layout.tape.cx + (lane - 4) * layout.tape.gap, layout.tape.nowY, 160, 1.2, "rgba(255,255,255,", 1.5),
  };

  engine.attachFx(hooks);

  return {
    state,
    openHud,
    closeHud,
    hudMove,
    releaseBuild,
    enterFreeze,
    dropFromFreeze,
    commitStop,
    cancel,
    update,
    noteOffset,
    isBuildingOrArmed,
    stopLineStep,
    isStopLanding,
  };

  function hudPick() {
    const hud = state.hud;
    if (!hud?.ready) return null;
    const dx = state.mx - hud.ax;
    const dy = state.my - hud.ay;
    if (Math.hypot(dx, dy) < HUD.dead || Math.abs(dy) < HUD.band) return null;

    const i = dx < -HUD.side ? 0 : dx > HUD.side ? 2 : 1;
    return dy < 0
      ? { zone: "drop" as const, i, kind: DROP_PADS[i].kind }
      : { zone: "stop" as const, i, kind: STOP_PADS[i].kind };
  }

  function startBuild() {
    state.mode = "build";
    state.buildStart = engine.state.pos;
    state.build = 0;
    state.rollOrigin = engine.state.nextStep;

    const windowLen = ROLL_LENGTHS[0];
    const windowStart = state.rollOrigin - windowLen;
    state.rollSrc = engine.state.past
      .filter((n) => n.step >= windowStart && n.step < state.rollOrigin && !n.muted && n.src !== "roll")
      .map((n) => ({ off: n.step - windowStart, lane: n.lane, vel: n.vel }));

    if (state.rollSrc.length < 2) {
      const pool = harmony.chordAt(Math.floor(state.rollOrigin / 16)).pool.filter((l) => l > 0);
      [0, 3, 6, 9]
        .filter((o) => o < windowLen)
        .forEach((o, i) => {
          if (!state.rollSrc.some((n) => n.off === windowLen - 1 - o)) {
            state.rollSrc.push({ off: windowLen - 1 - o, lane: i ? pool[i % pool.length] : 0, vel: 0.6 });
          }
        });
    }

    state.rollLen = windowLen;
    engine.invalidate();
  }

  function rollAt(step: number) {
    const len = state.rollLen;
    const latest = Math.max(...state.rollSrc.map((n) => n.off));
    const start = Math.floor(latest / len) * len;
    const off = mod(step - state.rollOrigin, len) + start;
    return state.rollSrc
      .filter((n) => n.off === off)
      .map((n) => createNote(step, n.lane, clamp(n.vel * (0.65 + 0.4 * state.build), 0.2, 1), "roll"));
  }

  function setDrop(step: number, energy: number, kind: DropKind = "full") {
    const slam = step + (kind === "fake" ? 16 : 0);
    state.drop = { step, slam, e: energy, kind };
    state.hook = makeHook();
    harmony.pushSegment(slam / 16);
    engine.invalidate();
    engine.replan();
  }

  function onDropStep(when: number) {
    audio.release(when);
    state.mode = "climax";
    if (state.drop?.kind === "fake") {
      scheduleVisual(when, () => {
        state.boom = { t: nowMs(), e: 0.18 };
        state.shake = 3;
        shock(layout.tape.cx, layout.tape.nowY, layout.width * 0.35, 0.45, "rgba(255,255,255,", 1);
      });
    }
  }

  function onSlam(when: number, energy: number) {
    scheduleVisual(when, () => {
      const { cx, nowY } = layout.tape;
      const diag = Math.hypot(layout.width, layout.height);
      state.boom = { t: nowMs(), e: energy };
      state.shake = 18 * energy;
      state.flash = 0.4 * energy;
      shock(cx, nowY, diag, 0.7, "rgba(255,90,31,", 3);
      shock(cx, nowY, diag * 0.7, 1.1, "rgba(255,255,255,", 1.5);
    });
  }

  function pushKickFx(when: number, velocity: number) {
    scheduleVisual(when, () => {
      state.kicks.push({ t: nowMs(), v: velocity });
      state.shake = Math.max(state.shake, 2.5 * velocity);
    });
  }

  function finishStop() {
    state.drop = null;
    state.stop = null;
    state.mode = "groove";
    audio.setLPF(0);
    engine.clearForStop();
  }

  function stopKeep(note: Note, step: number) {
    const f = stopProgress(step);
    const s = mod(step, 16);
    const metric = METRIC[s];
    if (f < 0.25) return !note.oct;
    if (f < 0.5) return !note.pickup && note.src !== "echo" && !note.ghost;
    if (f < 0.75) return metric >= 0.8 && !note.ghost;
    return note.lane === 0 || Boolean(note.lock && s % 8 === 0);
  }

  function applyView(bar: number, input: Note[]) {
    const b0 = bar * 16;
    let notes = input;

    if (state.mode === "build" || state.mode === "armed" || state.mode === "freeze") {
      const until = state.drop && state.mode === "armed" ? state.drop.step : Infinity;
      const kept = notes.filter((n) => n.step < state.rollOrigin || n.step >= until || isPlayerNote(n));
      for (let t = Math.max(b0, state.rollOrigin); t < Math.min(b0 + 16, until); t++) kept.push(...rollAt(t));
      notes = kept;
    }

    if (state.drop?.kind === "fake" && b0 >= state.drop.step && b0 < state.drop.slam) {
      notes = notes.filter(isPlayerNote);
      const melodic = state.rollSrc.filter((n) => n.lane > 0);
      const last = melodic.length ? melodic.reduce((a, b) => (b.off > a.off ? b : a)) : { lane: 4 };
      for (let s = 12; s < 16; s++) notes.push(createNote(b0 + s, last.lane, 0.45 + 0.1 * (s - 12), "roll"));
    }

    if (state.drop?.kind === "half" && inClimax(b0)) {
      notes = notes.filter((n) => METRIC[mod(n.step, 16)] >= 0.85 || isPlayerNote(n));
    }

    if (state.stop) {
      const stop = state.stop;
      if (b0 >= stop.base) {
        return [...baseBar(bar), ...notes.filter((n) => isPlayerNote(n) && !(n.lane === 0 && mod(n.step, 16) === 0))];
      }
      if (b0 >= stop.end) {
        if (b0 !== stop.end) return [];
        const vel = stop.kind === "fade" ? 0.6 : 0.9;
        const tail = [createNote(b0, 0, vel, "gen", { ring: 16 }), createNote(b0, 4, vel * 0.42, "gen", { ring: 16 })];
        return stop.kind === "cut" ? [...tail, createNote(b0, 8, 0.3, "gen", { ring: 16 })] : tail;
      }
      if (stop.kind === "fade" && b0 + 16 > stop.start) {
        notes = notes.filter((n) => n.step < stop.start || isPlayerNote(n) || stopKeep(n, n.step));
      }
    }

    return notes.sort((a, b) => a.step - b.step || a.lane - b.lane);
  }

  function makeHook() {
    const ref = harmony
      .chordAt(Math.floor(state.rollOrigin / 16) || 0)
      .pool.filter((l) => l > 0)
      .sort((a, b) => a - b);

    const cell = new Map<number, number>();
    for (const n of state.rollSrc) {
      if (n.lane > 0 && n.lane <= 8) {
        const off = n.off % 8;
        if (!cell.has(off) || cell.get(off)! < n.lane) cell.set(off, n.lane);
      }
    }

    const motif = [...cell].map(([off, lane]) => ({ off, lane })).sort((a, b) => a.off - b.off);
    if (motif.length < 3) {
      for (const off of [0, 3, 6]) {
        if (!motif.some((n) => n.off === off)) motif.push({ off, lane: motif.length ? motif[0].lane : 4 });
      }
    }
    motif.sort((a, b) => a.off - b.off);
    if (motif[0].off !== 0) motif.unshift({ off: 0, lane: motif[0].lane });

    const baseIdx = nearestIndex(ref, motif[0].lane);
    let rel = motif.map((n) => nearestIndex(ref, n.lane) - baseIdx);
    if (new Set(rel).size < 2) rel = motif.map((_, i) => [0, 1, 2, 1, 3, 2, 1, 0][i % 8]);

    return { base: motif[0].lane, cells: motif.map((n, i) => ({ off: n.off, rel: rel[i] })) };
  }

  function middlePool(bar: number) {
    return harmony.chordAt(bar).pool.filter((l) => l > 0 && l <= 6);
  }

  function hookNotes(bar: number, barIndex: number) {
    const full = harmony
      .chordAt(bar)
      .pool.filter((l) => l > 0)
      .sort((a, b) => a - b);
    const pool = full.filter((l) => l <= 6);
    const baseIdx = nearestIndex(pool, state.hook!.base);
    const halves = state.drop!.kind === "half" ? [0] : [0, 8];
    const b0 = bar * 16;
    const out: Note[] = [];

    for (const half of halves) {
      for (const cell of state.hook!.cells) {
        const shift = half === 8 ? (barIndex % 4 === 3 ? -1 : 1) : 0;
        const lane = pool[clamp(baseIdx + cell.rel + shift, 0, pool.length - 1)];
        const s = half + cell.off;
        const metric = METRIC[s];
        const li = full.indexOf(lane);
        const harm = barIndex >= 2 && metric >= 0.8 ? (li >= 2 ? full[li - 2] : li >= 1 ? full[li - 1] : null) : null;
        out.push(createNote(b0 + s, lane, 0.62 + 0.24 * metric, "hook", { bright: lane <= 4 ? 0.6 : 0.3, harm }));
      }
    }
    return out;
  }

  function climaxNotes(bar: number) {
    const b0 = bar * 16;
    if (!inClimax(b0)) return [];

    const barIndex = climaxBar(b0);
    const out: Note[] = [];
    if (state.hook) out.push(...hookNotes(bar, barIndex));

    for (const s of state.drop!.kind === "half" ? [0] : CLIMAX_DING_STEPS) {
      out.push(createNote(b0 + s, 0, s ? 0.62 : 0.85, "drop"));
    }

    const nextMid = middlePool(bar + 1);
    out.push(createNote(b0 + 15, nextMid[nearestIndex(nextMid, 4)], 0.5, "drop"));

    const curMid = middlePool(bar);
    if (barIndex >= 2) out.push(createNote(b0 + 7, curMid[nearestIndex(curMid, 4)], 0.45, "drop"));
    if (barIndex >= 4) {
      [3, 6, 9].forEach((s, i) => out.push(createNote(b0 + s, curMid[(i + 1) % curMid.length], 0.3, "drop")));
    }
    return out;
  }

  function scheduleDrums(step: number, when: number) {
    const s = mod(step, 16);
    const bar = Math.floor(step / 16);
    const sd = clock.stepDur();

    if (state.drop && step === state.drop.step && state.mode === "armed") onDropStep(when);

    if (state.drop && step === state.drop.slam) {
      const bassHz = harmony.chordAt(bar).bassHz;
      audio.impact(when, state.drop.e);
      audio.bigKick(when, 1.15);
      audio.sub(when, bassHz / 2, sd * 16, 0.75);
      audio.bass(when, bassHz, sd * 3, 0.6);
      audio.crash(when, 0.5 + 0.4 * state.drop.e);
      if (state.drop.kind === "fake") audio.release(when);
      onSlam(when, state.drop.e);
    }

    if (state.stop && step >= state.stop.end) {
      const stop = state.stop;
      if (step === stop.end) {
        const bassHz = harmony.chordAt(bar).bassHz;
        if (stop.kind === "cut") {
          audio.bigKick(when, 1);
          audio.sub(when, bassHz / 2, sd * 16, 0.6);
          audio.crash(when, 0.6);
        } else if (stop.kind === "echo") {
          audio.kick(when, 0.7);
          audio.sub(when, bassHz / 2, sd * 10, 0.4);
        } else {
          audio.sub(when, bassHz, sd * 14, 0.28);
        }
        scheduleVisual(when, () =>
          shock(layout.tape.cx - 4 * layout.tape.gap, layout.tape.nowY, Math.hypot(layout.width, layout.height), 2.6, "rgba(255,255,255,", 2),
        );
      }
      if (step === stop.base) scheduleVisual(when, finishStop);
      if (step < stop.base) return;
    }

    if (state.stop?.kind === "echo" && step === state.stop.end - 4) audio.throwEcho(when, sd * 4.5, sd * 3);

    if (state.stop?.kind === "fade" && step >= state.stop.start && step < state.stop.end) {
      const f = stopProgress(step);
      if (s === 0 && f < 0.5) audio.sub(when, harmony.chordAt(bar).bassHz, sd * 15, 0.3 * (1 - f));
      if ((s === 0 && f < 0.75) || (s === 8 && f < 0.5)) audio.kick(when, (s ? 0.3 : 0.5) * (1 - 0.5 * f));
      if ((s === 4 || s === 12) && f < 0.5) audio.tak(when, 0.28 * (1 - f));
      if (s % 2 && f < 0.25) audio.hat(when, (s % 4 === 3 ? 0.22 : 0.1) * (1 - f));
      return;
    }

    const effectiveMode: FxMode =
      state.stop && step >= state.stop.base
        ? "groove"
        : state.mode === "stop"
          ? state.drop && inClimax(step)
            ? "climax"
            : "groove"
          : state.mode;

    if (effectiveMode === "build" || (effectiveMode === "armed" && !(state.drop && step >= state.drop.step))) {
      const B = state.build;
      const rel = step - state.rollOrigin;
      if (B < 0.75 && s % 4 === 0) audio.kick(when, 0.55 * (1 - B));
      const interval = state.rollLen === 8 ? 4 : state.rollLen === 4 ? 2 : 1;
      if (mod(rel, interval) === 0) audio.tak(when, 0.14 + 0.36 * B, 1 + 0.45 * B);
      if (state.rollLen === 1 && B > 0.9) audio.tak(when + sd / 2, 0.3 + 0.2 * B, 1.5);
      return;
    }

    if (effectiveMode === "climax" && state.drop && step >= state.drop.step) {
      if (step < state.drop.slam) {
        const u = s / 15;
        if (s === 0) {
          audio.tak(when, 0.85, 1.15);
          audio.sweep(when + sd * 4, sd * 12);
        }
        if (s >= 4 && s < 8 && s % 2 === 0) audio.tak(when, 0.3, 1.05);
        if (s >= 8 && s < 12) {
          audio.tak(when, 0.35 + 0.2 * u, 1.1 + 0.4 * u);
          if (s % 2 === 0) audio.clap(when, 0.25 + 0.2 * u);
        }
        if (s >= 12) {
          audio.tak(when, 0.55 + 0.3 * u, 1.2 + 0.5 * u);
          audio.tak(when + sd / 2, 0.45 + 0.3 * u, 1.3 + 0.5 * u);
          if (s % 2 === 0) {
            audio.clap(when, 0.4 + 0.25 * u);
            audio.kick(when, 0.4 + 0.25 * u);
          }
        }
        return;
      }

      const k = climaxBar(step);
      const env = 1 - k / 9;
      const root = harmony.chordAt(bar).bassHz;

      if (state.drop.kind === "half") {
        if (s === 0) {
          if (step !== state.drop.slam) audio.bigKick(when, 1);
          audio.duck(when, 0.6, sd * 2);
          pushKickFx(when, 0.6 + 0.9 * env);
          if (step !== state.drop.slam) audio.sub(when, root / 2, sd * 15, 0.6);
        }
        if (s === 0 || s === 7 || s === 10) audio.bass(when, root, sd * (s ? 1.5 : 3), 0.5);
        if (s === 8) {
          audio.tak(when, 0.55);
          pushKickFx(when, 0.4 + 0.7 * env);
        }
        if (s === 10 && k % 2) audio.kick(when, 0.45);
        if (s % 2 === 0) audio.hat(when, s % 4 === 2 ? 0.14 : 0.06);
        if (k >= 4 && s % 4 === 2) audio.hat(when, 0.2, true);
        return;
      }

      if (s % 4 === 0) {
        if (step !== state.drop.slam) audio.bigKick(when, 0.95);
        audio.duck(when, 0.55, sd * 1.1);
        pushKickFx(when, 0.4 + 0.6 * env);
      }
      if (s === 0 && step !== state.drop.slam) audio.sub(when, root / 2, sd * 15, 0.55);
      if (s % 4 === 2) audio.bass(when, s === 14 && k % 2 ? root * 1.5 : root, sd * 1.7, 0.5);
      if (k >= 2 && s % 4 === 3) audio.bass(when, root * 2, sd * 0.6, 0.22);
      if (s === 4 || s === 12) {
        audio.clap(when, 0.55);
        audio.tak(when, 0.32);
      }
      audio.hat(when, s % 2 ? 0.17 : 0.08);
      if (s % 4 === 2) audio.hat(when, k >= 2 ? 0.3 : 0.22, true);
      if (k >= 4 && s % 3 === 0) audio.tak(when, 0.14, 1.3);
      if (k === 7 && s >= 12) audio.tak(when, 0.18 + 0.08 * (s - 12), 1.2 + 0.1 * (s - 12));
      return;
    }

    if (s === 0) {
      audio.sub(when, harmony.chordAt(bar).bassHz, sd * 15, 0.3);
      audio.kick(when, 0.5);
    }
    if (s === 8) audio.kick(when, 0.3);
    if (s === 4 || s === 12) audio.tak(when, 0.28);
    if (s % 2) audio.hat(when, s % 4 === 3 ? 0.22 : 0.1);
  }
}

export type Performance = ReturnType<typeof createPerformance>;
