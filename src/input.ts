import type { AudioEngine } from "./audio";
import type { Clock } from "./clock";
import type { Engine, Lock } from "./engine";
import type { Layout } from "./layout";
import { clamp, inBounds } from "./math";
import type { Performance } from "./performance";
import type { Renderer } from "./render";
import { KEYS } from "./theory";

export type DomControls = {
  canvas: HTMLCanvasElement;
  playBtn: HTMLButtonElement;
  bpmInput: HTMLInputElement;
  volumeEl: HTMLDivElement;
  guideDialog: HTMLDialogElement;
};

const VOLUME_STEPS = 32;

export function wireInput(
  dom: DomControls,
  audio: AudioEngine,
  clock: Clock,
  layout: Layout<Lock>,
  engine: Engine,
  fx: Performance,
  renderer: Renderer,
) {
  const { canvas, playBtn, bpmInput, volumeEl, guideDialog } = dom;

  const syncPlayButton = (playing: boolean) => {
    playBtn.textContent = playing ? "STOP" : "PLAY";
  };

  const togglePlay = () => {
    clock.toggle();
    if (!clock.playing) engine.releaseAllHold();
    syncPlayButton(clock.playing);
  };

  const setVolume = wireVolume(volumeEl, audio);
  wireGuide(guideDialog);
  wireBpm(bpmInput, clock);

  playBtn.addEventListener("click", () => {
    if (fx.state.mode !== "groove" && fx.state.mode !== "climax") fx.cancel();
    togglePlay();
    playBtn.blur();
  });

  const pointerPos = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const lockAt = (x: number, y: number) =>
    engine.state.locks.find((lock) => {
      const r = layout.sideBoxBounds(lock);
      return Boolean(r && inBounds(x, y, r.x0, r.y0, r.x1, r.y1));
    });

  const futureNoteAt = (x: number, y: number) => {
    let best = null;
    let bestDist = 9;
    for (const item of engine.state.visibleFuture) {
      const dist = Math.hypot(item.x - x, item.y - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = item.n;
      }
    }
    return best;
  };

  const handleRightClick = (x: number, y: number) => {
    const cell = layout.sideCellAt(x, y);
    if (cell) {
      const i = layout.sideNearestIndex(cell);
      if (i >= 0) engine.removeLockNote(cell.lock, i);
      return;
    }

    const lock = lockAt(x, y);
    if (lock) return engine.removeLock(lock);

    const note = futureNoteAt(x, y);
    if (note) engine.toggleDismiss(note);
  };

  canvas.addEventListener("pointerdown", (e) => {
    audio.ensure();
    engine.state.pos = clock.pos();

    if (e.button === 0 && fx.state.mode === "freeze") {
      fx.state.mouse = true;
      return;
    }

    if (e.button === 0 && fx.state.hud) {
      const [x, y] = pointerPos(e);
      fx.state.mx = x;
      fx.state.my = y;
      fx.hudMove();

      const sel = fx.state.hsel;
      if (!sel) return;
      if (sel.zone === "stop") {
        fx.state.spaceUsed = true;
        fx.closeHud();
        fx.commitStop(sel.kind);
        return;
      }
      if (fx.state.mode !== "build") return;
      fx.state.kind = sel.kind;
      fx.state.mouse = true;
      fx.enterFreeze(x, y);
      tryCapturePointer(canvas, e.pointerId);
      return;
    }

    if (e.button === 2) {
      const [x, y] = pointerPos(e);
      const zone = lockAt(x, y) ? "box" : layout.zoneAt(x, y, engine.state.pos);
      engine.state.marquee = { x0: x, y0: y, x1: x, y1: y, px: x, py: y, del: true, zone };
      if (zone === "floor") {
        const floor = layout.floorAt(x, y, engine.state.pos);
        Object.assign(engine.state.marquee, { s0: floor.step, l0: floor.lane, s1: floor.step, l1: floor.lane });
      }
      tryCapturePointer(canvas, e.pointerId);
      return;
    }

    if (e.button !== 0) return;

    const [x, y] = pointerPos(e);
    const titleLock = layout.sideTitleAt(x, y);
    if (titleLock) {
      if (e.ctrlKey || e.metaKey) engine.toggleMuteAll(titleLock);
      else engine.toggleMute(titleLock);
      return;
    }

    const sideCell = layout.sideCellAt(x, y);
    if (sideCell) {
      engine.state.sel = sideCell.lock;
      if (layout.sideExactIndex(sideCell) < 0) engine.addLockNote(sideCell.lock, sideCell.off, sideCell.lane);
      return;
    }

    const cell = layout.cellAt(x, y, engine.state.pos);
    if (cell && cell.step >= engine.state.nextStep) {
      if (!futureNoteAt(x, y)) engine.placeNote(cell.step, cell.lane);
      return;
    }

    if (layout.zoneAt(x, y, engine.state.pos) !== "wall") {
      engine.state.sel = lockAt(x, y) ?? null;
      return;
    }

    engine.state.marquee = {
      x0: x,
      y0: y,
      x1: x,
      y1: y,
      px: x,
      py: y,
      all: e.shiftKey,
      zone: "wall",
      s0: engine.state.pos - layout.wallAge(layout.tape.nowY - y),
      l0: (x - layout.tape.cx) / layout.tape.gap + 4,
    };
    tryCapturePointer(canvas, e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    const [x, y] = pointerPos(e);
    fx.state.mx = x;
    fx.state.my = y;
    fx.hudMove();

    if (engine.state.marquee) {
      engine.state.marquee.x1 = x;
      engine.state.marquee.y1 = y;
      engine.state.marquee.all = e.shiftKey;
      renderer.syncMarquee();
    }

    engine.state.hover = lockAt(x, y) ?? null;
    engine.state.hoverCell = layout.sideCellAt(x, y);
  });

  canvas.addEventListener("pointerup", (e) => {
    if (fx.state.mouse && e.button === 0) {
      fx.state.mouse = false;
      if (fx.state.mode === "freeze") {
        fx.closeHud();
        fx.dropFromFreeze(fx.state.kind);
      }
      return;
    }

    const m = engine.state.marquee;
    if (!m) return;

    engine.state.pos = clock.pos();
    renderer.syncMarquee();
    const dragged = Math.abs(m.x1 - m.x0) > 4 || Math.abs(m.y1 - m.y0) > 4;

    if (m.del) {
      if (!dragged) {
        handleRightClick(m.px, m.py);
      } else if (m.zone) {
        for (const lock of [...engine.state.locks]) {
          engine.removeLockNotes(
            lock,
            lock.notes.map((_, i) => i).filter((i) => renderer.inMarquee(layout.sideNotePoint(lock, i))),
          );
        }
        engine.dismissMany(engine.state.visibleFuture.filter((f) => !f.n.muted && renderer.inMarquee(f, f.n)).map((f) => f.n));
      }
      engine.state.marquee = null;
      return;
    }

    if (dragged) engine.makeLock(renderer.marqueePick());
    else engine.state.sel = lockAt(m.px, m.py) ?? null;
    engine.state.marquee = null;
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (engine.state.holdKeys.size) {
        engine.setHoldDensity(engine.state.holdDensity * (e.deltaY < 0 ? 1.25 : 0.8));
        return;
      }
      const [x, y] = pointerPos(e);
      const lock = lockAt(x, y);
      if (!lock) return setVolume(audio.volume - Math.sign(e.deltaY) / VOLUME_STEPS);
      engine.setVariability(lock, lock.V - Math.sign(e.deltaY) * 0.05);
    },
    { passive: false },
  );

  const isTyping = (e: KeyboardEvent) => (e.target as HTMLElement | null)?.tagName === "INPUT";

  addEventListener("keydown", (e) => {
    if (guideDialog.open || isTyping(e)) return;
    if (e.key === "Shift" && engine.state.marquee) engine.state.marquee.all = true;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const lane = KEYS.indexOf(e.key.toLowerCase());
    if (lane >= 0) {
      if (!e.repeat) {
        engine.playKey(lane);
        if (clock.playing) engine.pressHold(lane);
      }
      return;
    }

    const activeLock = engine.state.hover ?? engine.state.sel;
    if (e.code === "Space") {
      e.preventDefault();
      if (e.repeat || fx.state.space) return;
      fx.state.space = true;
      fx.state.spaceUsed = false;
      fx.state.spaceAt = performance.now();
      fx.state.spaceStartedPlay = !clock.playing && fx.state.mode !== "freeze";
      if (fx.state.spaceStartedPlay) togglePlay();
    } else if (e.key === "Escape") {
      if (fx.state.hud && fx.state.mode !== "freeze") {
        if (fx.state.mode === "build") fx.cancel();
        fx.closeHud();
      } else if (fx.state.mode !== "groove" && fx.state.mode !== "climax") {
        fx.cancel();
      }
      engine.state.sel = null;
      engine.state.marquee = null;
    } else if ((e.key === "Backspace" || e.key === "Delete") && activeLock) {
      e.preventDefault();
      engine.removeLock(activeLock);
    } else if (e.key === "[" && activeLock) {
      engine.setVariability(activeLock, activeLock.V - 0.05);
    } else if (e.key === "]" && activeLock) {
      engine.setVariability(activeLock, activeLock.V + 0.05);
    }
  });

  addEventListener("keyup", (e) => {
    if ((guideDialog.open || isTyping(e)) && !fx.state.space) return;

    if (e.code === "Space" && fx.state.hud && fx.state.mode !== "freeze") {
      fx.state.space = false;
      const sel = fx.state.hsel;
      fx.closeHud();
      if (sel?.zone === "drop" && fx.state.mode === "build") fx.releaseBuild(sel.kind);
      else if (sel?.zone === "stop" && !fx.state.spaceUsed) fx.commitStop(sel.kind);
      else if (fx.state.mode === "build") fx.cancel();
      return;
    }

    if (e.code === "Space") {
      const held = performance.now() - fx.state.spaceAt;
      fx.state.space = false;
      if (fx.state.mode === "build") {
        if (!fx.state.mouse) fx.releaseBuild();
      } else if (fx.state.mode === "freeze") {
        if (!fx.state.mouse) fx.dropFromFreeze();
      } else if (held < 180 && !fx.state.spaceStartedPlay && (fx.state.mode === "groove" || fx.state.mode === "climax")) {
        togglePlay();
      }
      return;
    }

    const lane = KEYS.indexOf(e.key.toLowerCase());
    if (lane >= 0) engine.releaseHold(lane);
    if (e.key === "Shift" && engine.state.marquee) engine.state.marquee.all = false;
  });

  addEventListener("blur", () => {
    engine.releaseAllHold();
    fx.closeHud();
    fx.state.space = fx.state.mouse = false;
    if (fx.state.mode === "build" || fx.state.mode === "freeze") fx.cancel();
  });

  return { syncPlayButton };
}

function wireGuide(guideDialog: HTMLDialogElement) {
  // Fallback for browsers without native Invoker Commands (commandfor/command)
  if (!("commandForElement" in HTMLButtonElement.prototype)) {
    document.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[commandfor]");
      if (!btn) return;
      const target = document.getElementById(btn.getAttribute("commandfor") ?? "") as HTMLDialogElement | null;
      const command = btn.getAttribute("command");
      if (command === "show-modal" && target && !target.open) target.showModal();
      else if (command === "close" && target) target.close();
    });
  }

  // Blur focused element after closing so Space controls playback instead of re-opening Help
  guideDialog.addEventListener("close", () => setTimeout(() => (document.activeElement as HTMLElement | null)?.blur()));
}

function wireBpm(bpmInput: HTMLInputElement, clock: Clock) {
  const setBpm = (value: number) => {
    const next = Math.round(clamp(value, 60, 180));
    bpmInput.value = String(next);
    if (next !== clock.bpm) clock.setBpm(next);
  };

  bpmInput.addEventListener("change", () => setBpm(Number(bpmInput.value) || clock.bpm));
  bpmInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      if (e.key === "Escape") bpmInput.value = String(clock.bpm);
      bpmInput.blur();
    }
  });
  bpmInput.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setBpm(clock.bpm - Math.sign(e.deltaY) * (e.shiftKey ? 5 : 1));
    },
    { passive: false },
  );
}

function wireVolume(volumeEl: HTMLDivElement, audio: AudioEngine) {
  const bars = Array.from({ length: VOLUME_STEPS }, () => volumeEl.appendChild(document.createElement("i")));

  const setVolume = (value: number) => {
    audio.setVolume(Math.round(clamp(value, 0, 1) * VOLUME_STEPS) / VOLUME_STEPS);
    const activeBars = Math.round(audio.volume * VOLUME_STEPS);
    bars.forEach((bar, i) => bar.classList.toggle("on", i < activeBars));
    volumeEl.setAttribute("aria-valuenow", String(Math.round(audio.volume * 100)));
  };

  const applyPointerVolume = (e: PointerEvent) => {
    const r = volumeEl.getBoundingClientRect();
    setVolume(Math.ceil(((e.clientX - r.left) / r.width) * VOLUME_STEPS) / VOLUME_STEPS);
  };

  setVolume(audio.volume);

  volumeEl.addEventListener("pointerdown", (e) => {
    tryCapturePointer(volumeEl, e.pointerId);
    applyPointerVolume(e);
  });
  volumeEl.addEventListener("pointermove", (e) => {
    if (volumeEl.hasPointerCapture(e.pointerId)) applyPointerVolume(e);
  });
  volumeEl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setVolume(audio.volume - Math.sign(e.deltaY) / VOLUME_STEPS);
    },
    { passive: false },
  );
  volumeEl.addEventListener("keydown", (e) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    setVolume(audio.volume + dir / VOLUME_STEPS);
  });

  return setVolume;
}

function tryCapturePointer(el: Element, pointerId: number) {
  // Synthetic pointer events throw on setPointerCapture
  try {
    el.setPointerCapture(pointerId);
  } catch {}
}
