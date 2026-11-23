import type { AudioEngine } from "./audio";
import type { Clock } from "./clock";
import { HUES, type Bounds } from "./layout";
import { clamp, hash01, mod, noteKey } from "./math";
import { METRIC, octaveOf, semiOf, type Harmony } from "./theory";

export type NoteSource = "gen" | "echo" | "lock" | "place" | "hold" | "user" | "roll" | "hook" | "drop";

export type LockNote = { off: number; lane: number; vel: number };

export type Lock = {
  id: number;
  hue: number;
  anchor: number;
  period: number;
  V: number;
  alive: boolean;
  muted?: boolean;
  notes: LockNote[];
  last: (Note | undefined)[];
  wallBox?: Bounds;
};

export type Note = {
  step: number;
  lane: number;
  vel: number;
  ghost: boolean;
  src: NoteSource;
  muted?: boolean;
  oct?: number;
  ring?: number;
  bright?: number;
  harm?: number | null;
  auto?: boolean;
  lock?: Lock;
  idx?: number;
  k?: number;
  varied?: boolean;
  pickup?: boolean;
  orig?: { step: number; lane: number };
  parent?: { step: number; lane: number };
  from?: Note;
  age?: number;
};

export type Marquee = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  px: number;
  py: number;
  zone: "wall" | "floor" | "box" | null;
  del?: boolean;
  all?: boolean;
  s0?: number;
  l0?: number;
  s1?: number;
  l1?: number;
};

export type VisibleFutureNote = { n: Note; x: number; y: number };
export type SideCell = { lock: Lock; off: number; lane: number };

export type FxHooks = {
  climaxNotes: (bar: number) => Note[];
  bloomOctave: (note: Note) => number;
  applyView: (bar: number, notes: Note[]) => Note[];
  scheduleDrums: (step: number, when: number) => void;
  isRollStutter: () => boolean;
  isFrozen: () => boolean;
  onFreezeTap: (lane: number) => void;
};

const HOLD_GRACE = 2;
const HOLD_AHEAD = 48;
const ECHO_QUIET = 6;

export const createNote = (step: number, lane: number, vel: number, src: NoteSource, extra?: Partial<Note>) => ({
  ...extra,
  step,
  lane,
  vel,
  ghost: vel < 0.5,
  src,
});

export const baseBar = (bar: number) => [createNote(bar * 16, 0, 0.6, "gen")];

export const isAliveLock = (note: Note) => Boolean(note.lock?.alive);

export function createEngine(audio: AudioEngine, clock: Clock, harmony: Harmony) {
  let fx: FxHooks | null = null;
  let nextId = 1;
  let lastTap = -1e9;
  let holdSince = 0;
  let holdReleasedAt = -1e9;
  let holdCursor = 0;
  let holdHist = METRIC.map((m) => m * 0.5);

  const barCache = new Map<number, Note[]>();
  const contentCache = new Map<number, Note[]>();

  const state = {
    past: [] as Note[],
    locks: [] as Lock[],
    placed: new Map<string, Note>(),
    dismissed: new Set<string>(),
    plan: new Map<string, Note>(),
    nextStep: 0,
    pos: 0,
    sel: null as Lock | null,
    hover: null as Lock | null,
    hoverTitle: null as Lock | null,
    hoverCell: null as SideCell | null,
    shiftKey: false,
    ctrlKey: false,
    marquee: null as Marquee | null,
    visibleFuture: [] as VisibleFutureNote[],
    holdKeys: new Map<number, number>(),
    holdDensity: 1,
  };

  for (let b = -8; b < 0; b++) state.past.push(...baseBar(b));

  const invalidate = () => {
    barCache.clear();
    contentCache.clear();
  };

  const invalidateView = () => {
    barCache.clear();
  };

  const echoYield = (step: number) => state.holdKeys.size > 0 || (step >= lastTap && step - lastTap < ECHO_QUIET);

  const holdIntensity = (step: number) => 0.25 + 0.75 * clamp((step - holdSince) / 32, 0, 1);

  const futureNotes = (to: number) => {
    const out: Note[] = [];
    for (let b = Math.floor(state.nextStep / 16); b * 16 < to; b++) {
      for (const note of genBar(b)) {
        if (note.step >= state.nextStep && note.step < to) out.push(note);
      }
    }
    return out;
  };

  const replan = () => {
    for (const [k, note] of state.plan) {
      if (note.step >= state.nextStep) state.plan.delete(k);
    }
    holdCursor = state.nextStep;
    extendPlan();
  };

  const pressHold = (lane: number) => {
    audio.ensure();
    if (!state.holdKeys.size && state.nextStep - holdReleasedAt > 16) holdSince = state.nextStep;
    state.holdKeys.set(lane, state.nextStep + HOLD_GRACE);
    replan();
  };

  const releaseHold = (lane: number) => {
    if (!state.holdKeys.has(lane)) return;
    state.holdKeys.delete(lane);
    for (const [k, note] of state.plan) {
      if (note.lane === lane && note.step >= state.nextStep) state.plan.delete(k);
    }
    if (!state.holdKeys.size) holdReleasedAt = state.nextStep;
    replan();
  };

  const releaseAllHold = () => {
    for (const lane of [...state.holdKeys.keys()]) releaseHold(lane);
  };

  const setHoldDensity = (density: number) => {
    const next = clamp(density, 0.25, 4);
    if (next === state.holdDensity) return;
    state.holdDensity = next;
    audio.click(0.6 + next * 0.3);
    replan();
  };

  const playKey = (lane: number) => {
    audio.ensure();
    lastTap = Math.round(clock.pos());
    const bare = fx?.isFrozen() ?? false;
    audio.pan(lane, 0, 0.85, bare ? 12 : 4, 0, bare);
    if (bare) fx?.onFreezeTap(lane);

    const step = Math.round(clock.pos());
    const existing = state.past.find((n) => n.step === step && n.lane === lane);
    if (existing) {
      existing.src = "user";
      existing.vel = 0.85;
      existing.ghost = false;
    } else {
      state.past.push(createNote(step, lane, 0.85, "user"));
    }
    learnGroove(step, 0.5);
    invalidate();
  };

  const makeLock = (selected: Note[]) => {
    let notes = selected.filter((n) => n.step < state.nextStep || n.step < state.pos);
    if (!notes.length) return null;

    notes.sort((a, b) => a.step - b.step || a.lane - b.lane);
    let lo = notes[0].step;
    if (notes[notes.length - 1].step - lo >= 32) {
      let bestCount = -1;
      for (const note of notes) {
        const count = notes.filter((m) => m.step >= note.step && m.step < note.step + 32).length;
        if (count > bestCount) {
          bestCount = count;
          lo = note.step;
        }
      }
    }

    notes = notes.filter((n) => n.step >= lo && n.step < lo + 32);
    const hi = notes[notes.length - 1].step;
    const period = hi - lo < 16 ? 16 : 32;
    const anchor = [Math.floor(lo / 16) * 16, Math.floor(lo / 4) * 4, lo].find((a) => hi < a + period)!;
    const id = nextId++;

    const lock: Lock = {
      id,
      hue: (id - 1) % HUES.length,
      anchor,
      period,
      V: 0.2,
      alive: true,
      notes: notes.map((n) => ({ off: n.step - anchor, lane: n.lane, vel: n.vel })),
      last: [...notes],
    };

    notes.forEach((n) => {
      n.lock = lock;
    });
    state.locks.push(lock);
    invalidate();
    audio.click(1.4, true);
    return lock;
  };

  const removeLock = (lock: Lock) => {
    lock.alive = false;
    state.locks = state.locks.filter((item) => item !== lock);
    if (state.sel === lock) state.sel = null;
    if (state.hover === lock) state.hover = null;
    if (state.hoverTitle === lock) state.hoverTitle = null;
    invalidate();
    audio.click(0.6, true);
  };

  const addLockNote = (lock: Lock, off: number, lane: number) => {
    if (off < 0 || off >= lock.period || lane < 0 || lane > 8 || lock.notes.some((n) => n.off === off && n.lane === lane)) return;
    lock.notes.push({ off, lane, vel: 0.85 });
    lock.last.push(undefined);
    invalidate();
    audio.ensure();
    audio.pan(lane, 0, 0.5, 2);
  };

  const removeLockNotes = (lock: Lock, indices: number[], strong = true) => {
    if (!indices.length) return;
    [...indices]
      .sort((a, b) => b - a)
      .forEach((i) => {
        lock.notes.splice(i, 1);
        lock.last.splice(i, 1);
      });
    if (!lock.notes.length) return removeLock(lock);
    invalidate();
    audio.click(0.6, strong);
  };

  const removeLockNote = (lock: Lock, index: number) => removeLockNotes(lock, [index], false);

  const applyMute = (muted: boolean) => {
    invalidate();
    audio.click(muted ? 0.5 : 1.2, true);
  };

  const toggleMute = (lock: Lock) => {
    lock.muted = !lock.muted;
    applyMute(lock.muted);
  };

  const toggleMuteAll = (target: Lock) => {
    const muted = !target.muted;
    state.locks.forEach((lock) => {
      lock.muted = muted;
    });
    applyMute(muted);
  };

  const toggleMuteOthers = (target: Lock) => {
    const others = state.locks.filter((lock) => lock !== target);
    if (!others.length) return;
    const targetMuted = Boolean(target.muted);
    const hasSameAsTarget = others.some((lock) => Boolean(lock.muted) === targetMuted);
    const nextMuted = hasSameAsTarget ? !targetMuted : targetMuted;
    others.forEach((lock) => {
      lock.muted = nextMuted;
    });
    applyMute(nextMuted);
  };

  const setVariability = (lock: Lock, value: number) => {
    const next = Math.round(clamp(value, 0, 1) * 20) / 20;
    if (next === lock.V) return;
    lock.V = next;
    invalidate();
    audio.click(0.7 + next);
  };

  const toggleDismiss = (note: Note) => {
    const k = noteKey(note.step, note.lane);
    if (note.src === "place") state.placed.delete(k);
    else if (state.dismissed.has(k)) state.dismissed.delete(k);
    else state.dismissed.add(k);
    invalidate();
    audio.click(0.8);
  };

  const dismissMany = (notes: Note[]) => {
    for (const note of notes) {
      const k = noteKey(note.step, note.lane);
      if (note.src === "place") state.placed.delete(k);
      else state.dismissed.add(k);
    }
    if (notes.length) {
      invalidate();
      audio.click(0.8, true);
    }
  };

  const placeNote = (step: number, lane: number) => {
    if (step < state.nextStep) return;
    const k = noteKey(step, lane);
    state.dismissed.delete(k);
    state.placed.set(k, createNote(step, lane, 0.85, "place"));
    invalidate();
    audio.pan(lane, 0, 0.4, 2);
  };

  const clearForStop = () => {
    for (const lock of state.locks) lock.muted = true;
    state.plan.clear();
    state.placed.clear();
    state.dismissed.clear();
    invalidate();
  };

  const seekFreezeDrop = (dropStep: number) => {
    clock.seek(dropStep);
    state.nextStep = dropStep;
    for (const [k, note] of state.plan) {
      if (note.step < dropStep) state.plan.delete(k);
    }
    holdCursor = dropStep;
  };

  const attachFx = (hooks: FxHooks) => {
    fx = hooks;
  };

  clock.onStep(scheduleStep);

  return {
    state,
    attachFx,
    invalidate,
    invalidateView,
    futureNotes,
    replan,
    pressHold,
    releaseHold,
    releaseAllHold,
    setHoldDensity,
    playKey,
    makeLock,
    removeLock,
    addLockNote,
    removeLockNote,
    removeLockNotes,
    toggleMute,
    toggleMuteAll,
    toggleMuteOthers,
    setVariability,
    toggleDismiss,
    dismissMany,
    placeNote,
    clearForStop,
    seekFreezeDrop,
  };

  function scheduleStep(step: number, when: number) {
    if (step < state.nextStep) return;
    const stepInBar = mod(step, 16);
    const bar = Math.floor(step / 16);
    fx?.scheduleDrums(step, when);

    let placedConsumed = false;
    const stepNotes = genBar(bar).filter((note) => note.step === step && !note.muted);
    const playedLanes = new Set<number>();
    for (const note of stepNotes) {
      if (!note.oct) playedLanes.add(note.lane);
    }

    for (const note of stepNotes) {
      audio.pan(note.lane, when, note.vel, note.ring || (note.ghost ? 2 : 4), note.oct ?? 0, false, note.bright ?? 0);
      if (note.harm != null && !playedLanes.has(note.harm)) {
        playedLanes.add(note.harm);
        audio.pan(note.harm, when, note.vel * 0.42, 4);
      }
      if (note.src === "roll" && fx?.isRollStutter()) audio.pan(note.lane, when + clock.stepDur() / 2, note.vel * 0.8, 1);

      const isHold = note.src === "hold";
      const pastNote: Note = {
        step,
        lane: note.lane,
        vel: note.vel,
        ghost: note.ghost,
        src: note.src === "place" || isHold ? "user" : note.src,
        auto: isHold,
        lock: note.lock,
        idx: note.idx,
        pickup: note.pickup,
      };

      if (isHold) {
        state.plan.delete(noteKey(step, note.lane));
        learnGroove(step, 0.03);
      }
      state.past.push(pastNote);
      if (note.lock && !note.pickup && note.idx != null) note.lock.last[note.idx] = pastNote;
      if (note.src === "place") {
        state.placed.delete(noteKey(step, note.lane));
        placedConsumed = true;
      }
    }

    state.nextStep = step + 1;
    extendPlan();
    if (stepInBar === 15) {
      const minStep = step - 16 * 12;
      state.past = state.past.filter((n) => n.step > minStep);
      const minBar = bar - 2;
      for (const cachedBar of contentCache.keys()) {
        if (cachedBar < minBar) contentCache.delete(cachedBar);
      }
      for (const cachedBar of barCache.keys()) {
        if (cachedBar < minBar) barCache.delete(cachedBar);
      }
      for (const k of state.dismissed) {
        const s = Number(k.slice(0, k.indexOf(":")));
        if (s < minStep) state.dismissed.delete(k);
      }
    }
    if (placedConsumed) invalidate();
  }

  function contentBar(bar: number) {
    const cached = contentCache.get(bar);
    if (cached) return cached;

    const locks = state.locks.flatMap((lock) => lockInto(lock, bar));
    const echoes = echoInto(bar);
    const bySlot = new Map<string, Note>();
    const lockSteps = new Set(locks.filter((n) => !n.pickup).map((n) => n.step));
    const echoSteps = new Set(echoes.map((n) => n.step));
    const put = (note: Note) => bySlot.set(noteKey(note.step, note.lane), note);

    baseBar(bar)
      .filter((n) => !lockSteps.has(n.step) && !echoSteps.has(n.step))
      .forEach(put);
    echoes.filter((n) => !lockSteps.has(n.step)).forEach(put);

    locks
      .filter((n) => n.pickup)
      .forEach((n) => {
        const existing = bySlot.get(noteKey(n.step, n.lane));
        if (!existing || existing.src === "gen") put(n);
      });
    locks.filter((n) => !n.pickup).forEach(put);

    for (const note of fx?.climaxNotes(bar) ?? []) {
      const existing = bySlot.get(noteKey(note.step, note.lane));
      if (!existing || existing.src === "gen" || existing.src === "echo" || (note.src === "hook" && existing.src === "lock")) {
        put(note);
      }
    }

    for (const note of state.placed.values()) {
      if (Math.floor(note.step / 16) === bar) put(note);
    }

    const out = [...bySlot.values()].sort((a, b) => a.step - b.step || a.lane - b.lane);
    out.forEach((note) => {
      note.muted = state.dismissed.has(noteKey(note.step, note.lane));
      note.oct = fx?.bloomOctave(note) ?? 0;
    });
    contentCache.set(bar, out);
    return out;
  }

  function genBar(bar: number) {
    const cached = barCache.get(bar);
    if (cached) return cached;

    const bySlot = new Map(contentBar(bar).map((n) => [noteKey(n.step, n.lane), n]));
    for (const [k, note] of state.plan) {
      if (Math.floor(note.step / 16) === bar && bySlot.get(k)?.src !== "place") {
        note.muted = state.dismissed.has(k);
        bySlot.set(k, note);
      }
    }

    const notes = [...bySlot.values()].filter((n) => n.src !== "echo" || n.step < state.nextStep || !echoYield(n.step));
    const out = fx ? fx.applyView(bar, notes) : notes.sort((a, b) => a.step - b.step || a.lane - b.lane);
    barCache.set(bar, out);
    return out;
  }

  function echoInto(bar: number) {
    const out: Note[] = [];
    for (const note of state.past) {
      if (note.src !== "user" || note.auto) continue;
      const age = bar - Math.floor(note.step / 16);
      if (age < 1 || age > 2 || hash01(note.step * 9 + note.lane, bar, 21) > (age === 1 ? 0.8 : 0.35)) continue;
      out.push(createNote(bar * 16 + mod(note.step, 16), note.lane, note.vel * (age === 1 ? 0.8 : 0.55), "echo", { from: note, age }));
    }
    return out;
  }

  function lockInto(lock: Lock, bar: number) {
    if (lock.muted) return [];
    const out: Note[] = [];
    const b0 = bar * 16;
    const b1 = b0 + 16;
    const V = Math.min(1, lock.V);

    for (let k = Math.max(1, Math.floor((b0 - lock.anchor) / lock.period) - 1); lock.anchor + k * lock.period <= b1; k++) {
      const base = lock.anchor + k * lock.period;
      lock.notes.forEach((n, idx) => {
        const h = (salt: number) => hash01(lock.id * 131 + idx, k, salt);
        const at = base + n.off;
        const isDownbeat = mod(lock.anchor + n.off, 16) === 0;
        const pool = harmony.chordAt(Math.floor(at / 16)).pool;

        let lane = n.lane;
        let off = n.off;
        if (V > 0 && h(1) < V && !(isDownbeat && lane === 0)) lane = substituteLane(n.lane, pool, V, h(2));
        if (V > 0.35 && !(isDownbeat && lane === 0) && h(7) < (V - 0.35) * 0.7) {
          const oct = octaveOf(lane, h(8) < 0.5 ? -1 : 1);
          if (oct != null) lane = oct;
        }
        if (V > 0.3 && !isDownbeat && h(3) < (V - 0.3) * 0.8) off += h(4) < 0.5 ? -1 : 1;

        const step = base + off;
        if (step >= b0 && step < b1) {
          out.push(
            createNote(step, lane, n.vel, "lock", {
              lock,
              idx,
              k,
              varied: lane !== n.lane || off !== n.off,
              orig: { step: at, lane: n.lane },
            }),
          );
        }
        if (V > 0.2 && h(5) < V * 0.5 && step - 1 >= b0 && step - 1 < b1) {
          out.push(
            createNote(step - 1, pool[Math.floor(h(6) * pool.length)], 0.28, "lock", {
              lock,
              idx,
              k,
              varied: true,
              pickup: true,
              parent: { step, lane },
            }),
          );
        }
      });
    }
    return out;
  }

  function learnGroove(step: number, weight: number) {
    for (let i = 0; i < 16; i++) holdHist[i] *= 1 - weight * 0.2;
    holdHist[mod(step, 16)] += weight;
    const peak = Math.max(...holdHist);
    if (peak > 1) holdHist = holdHist.map((v) => v / peak);
  }

  function lastHoldBefore(step: number) {
    const byLane = new Map<number, number>();
    let latestStep = -1e9;
    let prevLane: number | null = null;

    const candidates = [...state.past.filter((n) => n.src === "user" && n.step > step - 48), ...state.plan.values()];
    for (const note of candidates) {
      if (note.step >= step) continue;
      if ((byLane.get(note.lane) ?? -1e9) < note.step) byLane.set(note.lane, note.step);
      if (note.step > latestStep) {
        latestStep = note.step;
        prevLane = note.lane;
      }
    }

    return { byLane, latestStep, prevLane };
  }

  function planBar(bar: number, from: number) {
    const t0 = Math.max(from, bar * 16);
    const t1 = bar * 16 + 16;
    const pool = harmony.chordAt(bar).pool;
    const heldCount = state.holdKeys.size;
    const intensity = holdIntensity(t0);
    const density = state.holdDensity;

    const targetNotes = Math.round(density * (1 + 3 * intensity + (heldCount - 1) * intensity) * ((t1 - t0) / 16));
    const minGap = clamp(Math.round(4.5 - 1.5 * density * intensity), 1, 4);
    const content = contentBar(bar).filter((n) => !n.muted);
    const fit = (lane: number, metric: number) => (pool.includes(lane) ? 0.35 : metric < 0.6 ? -0.1 : -0.8);
    const lanes = [...state.holdKeys.keys()];

    const slots: { t: number; sc: number }[] = [];
    for (let t = t0; t < t1; t++) {
      const s = mod(t, 16);
      const metric = METRIC[s];
      const occupied = content.filter((n) => n.step === t).length;
      const sc = metric + 0.6 * holdHist[s] + Math.max(...lanes.map((l) => fit(l, metric))) - 0.25 * occupied + 0.15 * (hash01(t, heldCount, 78) - 0.5);
      slots.push({ t, sc });
    }
    slots.sort((a, b) => b.sc - a.sc);

    const recent = lastHoldBefore(t0);
    const taken = [recent.latestStep];
    const chosen: number[] = [];
    for (const slot of slots) {
      if (chosen.length >= targetNotes || slot.sc < 0.5) break;
      if (taken.some((u) => Math.abs(u - slot.t) < minGap)) continue;
      chosen.push(slot.t);
      taken.push(slot.t);
    }
    chosen.sort((a, b) => a - b);

    let prevLane = recent.prevLane;
    const lastByLane = new Map(recent.byLane);

    for (const t of chosen) {
      const metric = METRIC[mod(t, 16)];
      const occupiedLanes = new Set(content.filter((n) => n.step === t).map((n) => n.lane));
      const candidates = [...state.holdKeys]
        .filter(([lane, pressed]) => t >= pressed && !occupiedLanes.has(lane) && !state.dismissed.has(noteKey(t, lane)) && fit(lane, metric) > -0.5)
        .map(([lane, pressed]) => {
          const since = t - Math.max(lastByLane.get(lane) ?? -1e9, pressed - 10);
          let sc = fit(lane, metric) + clamp(since / 16, 0, 1) * 0.5;
          if (heldCount > 1 && prevLane != null) sc += lane === prevLane ? -0.3 : Math.abs(lane - prevLane) <= 2 ? 0.12 : 0;
          return { lane, sc: sc + 0.1 * (hash01(t, lane, 79) - 0.5) };
        })
        .sort((a, b) => b.sc - a.sc);

      if (!candidates.length) continue;

      const picks = [candidates[0]];
      if (metric >= 0.85 && intensity > 0.5 && density >= 1.5 && pool.includes(candidates[0].lane)) {
        const companion = candidates
          .slice(1)
          .find((cand) => pool.includes(cand.lane) && ![1, 2].includes(Math.abs(semiOf(cand.lane) - semiOf(candidates[0].lane))));
        if (companion) picks.push(companion);
      }

      for (const { lane } of picks) {
        state.plan.set(noteKey(t, lane), createNote(t, lane, metric < 0.4 ? 0.4 : 0.55 + 0.35 * metric, "hold"));
        lastByLane.set(lane, t);
        prevLane = lane;
      }
    }
  }

  function extendPlan() {
    const end = state.nextStep + HOLD_AHEAD;
    let changed = false;
    if (!state.holdKeys.size) {
      holdCursor = Math.max(holdCursor, state.nextStep);
    } else {
      while (holdCursor < end) {
        const bar = Math.floor(holdCursor / 16);
        planBar(bar, holdCursor);
        holdCursor = bar * 16 + 16;
        changed = true;
      }
    }
    if (changed || state.holdKeys.size > 0 || state.nextStep - lastTap <= ECHO_QUIET + 16) {
      invalidateView();
    }
  }
}

export type Engine = ReturnType<typeof createEngine>;

function substituteLane(lane: number, pool: number[], variability: number, rand: number) {
  const candidates = pool.filter((l) => l !== lane && l !== 0);
  if (variability >= 0.6) return candidates[Math.floor(rand * candidates.length)];
  candidates.sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane));
  return candidates[rand < 0.7 ? 0 : Math.min(1, candidates.length - 1)];
}
