import { isAliveLock, type Engine, type Lock, type Marquee, type Note } from "./engine";
import {
  drawDot,
  drawLine,
  drawRing,
  FONT,
  FUT,
  HOT,
  hot,
  hueAlpha,
  ink,
  PAST,
  SIDE_BOX,
  type Layout,
  type Point,
  type ProjectedPoint,
} from "./layout";
import { clamp, inBounds, lerp, mod } from "./math";
import { DROP_PADS, HUD, STOP_PADS, type Performance } from "./performance";
import { EXT_GAP, isExtendedLane, KEYS, visualLane, type Harmony } from "./theory";

export function createRenderer(layout: Layout<Lock>, harmony: Harmony, engine: Engine, fx: Performance) {
  const ctx = layout.ctx;

  const isLockActive = (lock: Lock) => {
    if (engine.state.hoverTitle && !engine.state.marquee) {
      if (engine.state.ctrlKey) return lock !== engine.state.hoverTitle;
      if (engine.state.shiftKey) return true;
    }
    return lock === engine.state.hover || lock === engine.state.sel;
  };

  const noteColor = (note: Note, alpha: number) =>
    !isAliveLock(note) ? ink(alpha) : isLockActive(note.lock!) ? hot(alpha) : hueAlpha(note.lock!.hue, alpha);

  const noteRadius = (note: Note, pt: ProjectedPoint) => (note.ghost ? 2.6 : 4.2) * pt.s;

  const projectNote = (note: { step: number; lane: number }) => {
    const pt = layout.proj(note.step, visualLane(note.lane), engine.state.pos);
    if (!pt || note.step < engine.state.pos) return pt;
    const { dx, dy } = fx.noteOffset(note);
    return { x: pt.x + dx, y: pt.y + dy, s: pt.s };
  };

  const syncMarquee = () => {
    const m = engine.state.marquee;
    if (!m) return;

    const { cx, gap, nowY } = layout.tape;
    const pos = engine.state.pos;
    if (m.zone === "wall" && m.l0 != null && m.s0 != null) {
      m.x0 = cx + (m.l0 - 4) * gap;
      m.y0 = nowY - layout.wallOff(Math.max(0, pos - m.s0));
    } else if (m.zone === "floor" && m.s0 != null && m.l0 != null) {
      const floor = layout.floorAt(m.x1, m.y1, pos);
      m.s1 = floor.step;
      m.l1 = floor.lane;
      const anchor = layout.proj(clamp(m.s0, pos, pos + FUT), m.l0, pos);
      if (anchor) {
        m.x0 = anchor.x;
        m.y0 = anchor.y;
      }
    }
  };

  const inMarquee = (pt: Point | null | undefined, note?: Note) => {
    const m = engine.state.marquee;
    if (!m || !pt) return false;
    if (m.zone === "floor" && m.s0 != null && m.s1 != null && m.l0 != null && m.l1 != null) {
      return (
        Boolean(note) &&
        inBounds(note!.step, visualLane(note!.lane), Math.min(m.s0, m.s1), Math.min(m.l0, m.l1), Math.max(m.s0, m.s1), Math.max(m.l0, m.l1))
      );
    }
    return inBounds(pt.x, pt.y, Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
  };

  const marqueePick = () =>
    engine.state.past.filter((n) => n.step < engine.state.pos && (engine.state.marquee?.all || !isAliveLock(n)) && inMarquee(projectNote(n)));

  const draw = () => {
    fx.update();
    layout.layoutSideBoxes(engine.state.locks);
    syncMarquee();

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, layout.width, layout.height);

    ctx.save();
    if (fx.state.shake > 0.3) {
      ctx.translate((Math.random() - 0.5) * 2 * fx.state.shake, (Math.random() - 0.5) * 2 * fx.state.shake);
    }

    drawGrid();
    drawFxUnder();

    let fut = engine.futureNotes(engine.state.pos + FUT + 1);
    if (fx.state.stop && fx.isStopLanding()) {
      const lineStep = fx.stopLineStep();
      fut = [
        ...fx.state.stop.ghost.filter((n) => n.step >= engine.state.nextStep && n.step < lineStep),
        ...fut.filter((n) => n.step >= lineStep),
      ];
    }

    drawLinks(fut);
    drawNowLine();
    drawNotes(fut);
    drawSideBoxes();
    ctx.restore();

    drawFxOver();
    drawMarquee();
  };

  return { draw, projectNote, syncMarquee, inMarquee, marqueePick };

  function drawGrid() {
    const { cx, gap, nowY } = layout.tape;
    const pos = engine.state.pos;
    const wallTop = nowY - layout.wallOff(PAST);

    ctx.lineWidth = 1;
    ctx.font = FONT;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";

    for (let lane = 0; lane < 9; lane++) {
      const x = cx + (lane - 4) * gap;
      ctx.strokeStyle = ink(0.07);
      drawLine(ctx, { x, y: wallTop }, { x, y: nowY });
      drawLine(ctx, layout.proj(pos, lane, pos), layout.proj(pos + FUT, lane, pos));
    }

    const first = Math.ceil((pos - PAST) / 4) * 4;
    for (let step = first; step <= pos + FUT; step += 4) {
      const left = layout.proj(step, -0.5, pos);
      const right = layout.proj(step, 8.5, pos);
      if (!left || !right) continue;

      const isBar = mod(step, 16) === 0;
      ctx.strokeStyle = ink(isBar ? 0.2 : 0.06);
      drawLine(ctx, left, right);

      if (isBar) {
        const labelPos = layout.proj(step, -EXT_GAP - 0.6, pos);
        if (labelPos) {
          ctx.fillStyle = ink(0.35);
          ctx.fillText(`${step / 16} ${harmony.chordAt(step / 16).sym}`, labelPos.x, labelPos.y);
        }
      }
    }
  }

  function drawFxUnder() {
    const stop = fx.state.stop;
    if (!stop) return;
    const pos = engine.state.pos;

    const lineStep = fx.stopLineStep();
    const a = layout.proj(lineStep, -1.5, pos);
    const z = layout.proj(lineStep, 9.5, pos);
    if (a && z) {
      ctx.strokeStyle = ink(0.95);
      ctx.lineWidth = 2;
      drawLine(ctx, a, z);
      ctx.lineWidth = 1;
    }

    if (stop.end !== stop.start) {
      const e1 = layout.proj(stop.end, -1.5, pos);
      const e2 = layout.proj(stop.end, 9.5, pos);
      if (e1 && e2) {
        ctx.strokeStyle = ink(0.5);
        ctx.setLineDash([6, 4]);
        drawLine(ctx, e1, e2);
        ctx.setLineDash([]);
      }
    }
  }

  function drawLinks(fut: Note[]) {
    ctx.lineWidth = 1;
    for (const note of fut) {
      const dst = projectNote(note);
      if (!dst) continue;

      if (note.src === "lock" && note.lock) {
        const src = note.pickup
          ? note.parent && projectNote(note.parent)
          : note.idx != null
            ? layout.sideNotePoint(note.lock, note.idx)
            : null;
        if (!src) continue;

        const active = isLockActive(note.lock);
        ctx.strokeStyle = active ? hot(0.75) : hueAlpha(note.lock.hue, 0.42);
        if (note.pickup) drawVarianceArc(dst, src, true);
        else drawParabola(src, dst, note);

        if (note.varied && !note.pickup && note.orig) {
          const orig = projectNote(note.orig);
          if (orig) {
            ctx.strokeStyle = active ? HOT : hueAlpha(note.lock.hue, 0.7);
            drawVarianceArc(dst, orig);
            ctx.fillStyle = active ? HOT : hueAlpha(note.lock.hue, 0.8);
            drawDot(ctx, orig.x, orig.y, 1.5);
          }
        }
      } else if (note.src === "echo" && note.from) {
        const src = projectNote(note.from);
        if (!src) continue;
        ctx.strokeStyle = ink((0.32 / (note.age ?? 1)) * clamp(1 - (engine.state.pos - note.from.step) / 40, 0.15, 1));
        ctx.setLineDash([2, 3]);
        drawParabola(src, dst, note);
        ctx.setLineDash([]);
      }
    }
  }

  function drawParabola(src: Point, dst: Point, note: Note) {
    const midX = (src.x + dst.x) / 2;
    const side = Math.sign(midX - layout.tape.cx) || (note.lane < 4 || (note.lane === 4 && (note.idx ?? 0) % 2) ? -1 : 1);
    const span = Math.abs(dst.y - src.y);
    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.quadraticCurveTo(midX + side * (12 + span * 0.32), layout.tape.nowY, dst.x, dst.y);
    ctx.stroke();
  }

  function drawVarianceArc(from: Point, to: Point, flip = false) {
    const { nowY, frontH } = layout.tape;
    const h = clamp(Math.hypot(to.x - from.x, to.y - from.y) * 0.3, 8, 70);
    const ctrlY = flip ? Math.min(nowY + frontH + 14, Math.max(from.y, to.y) + h) : Math.max(nowY + 2, Math.min(from.y, to.y) - h);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(from.x, ctrlY, to.x, ctrlY, to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawNowLine() {
    const { cx, gap, nowY } = layout.tape;
    ctx.strokeStyle = ink(0.85);
    ctx.lineWidth = 1;
    drawLine(ctx, { x: cx + (-EXT_GAP - 4.4) * gap, y: nowY }, { x: cx + (EXT_GAP + 4.4) * gap, y: nowY });

    ctx.font = FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let lane = 0; lane < 9; lane++) {
      const held = engine.state.holdKeys.has(lane);
      const x = cx + (lane - 4) * gap;
      ctx.fillStyle = ink(held ? 1 : 0.45);
      ctx.fillText(KEYS[lane].toUpperCase(), x, nowY + 3);
      if (held) {
        ctx.strokeStyle = ink(0.9);
        drawLine(ctx, { x: x - 5, y: nowY + 16 }, { x: x + 5, y: nowY + 16 });
      }
    }

    ctx.fillStyle = ink(0.22);
    ctx.fillText("lo", cx + (-EXT_GAP - 4) * gap, nowY + 3);
    ctx.fillText("hi", cx + (EXT_GAP + 4) * gap, nowY + 3);

    if (engine.state.holdKeys.size) {
      const x0 = cx + (EXT_GAP + 4.8) * gap;
      const y0 = nowY - 4;
      const w = 60;
      const f = (Math.log2(engine.state.holdDensity) + 2) / 4;
      ctx.strokeStyle = ink(0.4);
      ctx.strokeRect(x0, y0, w, 8);
      ctx.fillStyle = ink(0.85);
      ctx.fillRect(x0 + 1, y0 + 1, (w - 2) * f, 6);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`×${engine.state.holdDensity.toFixed(2)}`, x0 + w + 6, nowY);
    }
  }

  function drawNote(pt: ProjectedPoint, note: Note, isPast: boolean, r: number, picked: boolean, dim = 1) {
    const alpha = (note.ghost ? 0.42 : 0.92) * dim;
    ctx.lineWidth = 1;

    if (note.muted) {
      ctx.strokeStyle = ink(0.3);
      ctx.beginPath();
      ctx.moveTo(pt.x - r, pt.y - r);
      ctx.lineTo(pt.x + r, pt.y + r);
      ctx.moveTo(pt.x + r, pt.y - r);
      ctx.lineTo(pt.x - r, pt.y + r);
      ctx.stroke();
      return;
    }

    if (isPast) {
      ctx.fillStyle = noteColor(note, alpha);
      drawDot(ctx, pt.x, pt.y, r);
      if (note.src === "user") {
        ctx.strokeStyle = ink(0.6);
        drawRing(ctx, pt.x, pt.y, r + 2.5);
      }
    } else {
      ctx.strokeStyle = noteColor(note, alpha);
      if (note.varied) ctx.setLineDash([2, 2]);
      drawRing(ctx, pt.x, pt.y, r);
      ctx.setLineDash([]);
      if (note.harm != null) drawRing(ctx, pt.x, pt.y, r + 3);
      if (note.src === "place" || note.src === "hold") {
        ctx.fillStyle = ink(0.9);
        drawDot(ctx, pt.x, pt.y, 1.5);
      }
      if (note.oct) drawRing(ctx, pt.x, pt.y, r + 3);
    }

    if (picked) {
      ctx.strokeStyle = HOT;
      drawRing(ctx, pt.x, pt.y, r + 3);
    }
  }

  function drawNotes(fut: Note[]) {
    const m = engine.state.marquee;
    const isDelete = Boolean(m?.del);
    const picked = m && !isDelete ? new Set(marqueePick()) : null;
    const dimGrouped = Boolean(m && !m.all && !isDelete);

    engine.state.visibleFuture = [];

    for (const note of engine.state.past) {
      const pt = projectNote(note);
      if (pt) drawNote(pt, note, true, noteRadius(note, pt), Boolean(picked?.has(note)), dimGrouped && isAliveLock(note) ? 0.3 : 1);
    }

    for (const note of fut) {
      const pt = projectNote(note);
      if (!pt) continue;
      engine.state.visibleFuture.push({ n: note, x: pt.x, y: pt.y });
      drawNote(pt, note, false, noteRadius(note, pt), isDelete && !note.muted && inMarquee(pt, note));
    }
  }

  function drawSideBoxes() {
    ctx.font = FONT;
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 1;

    for (const lock of engine.state.locks) {
      const r = layout.sideRect(lock);
      if (!r) continue;

      const active = isLockActive(lock);
      const muted = Boolean(lock.muted);
      const color = active ? HOT : hueAlpha(lock.hue, muted ? 0.3 : 0.65);

      ctx.fillStyle = "#000";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = color;
      ctx.strokeRect(r.x, r.y, r.w, r.h);

      ctx.fillStyle = color;
      ctx.textAlign = r.side ? "left" : "right";
      ctx.fillText(`${muted ? "MUTED " : ""}L${lock.id} V${lock.V.toFixed(2)} /${lock.period}`, r.side ? r.x : r.x + r.w, r.y - 3);

      for (let b = mod(-lock.anchor, 4) || 4; b < lock.period; b += 4) {
        ctx.strokeStyle = ink(0.1);
        drawLine(ctx, { x: r.x, y: r.y + b * SIDE_BOX.row }, { x: r.x + r.w, y: r.y + b * SIDE_BOX.row });
      }

      const hc = engine.state.hoverCell?.lock === lock ? engine.state.hoverCell : null;
      if (hc && !isExtendedLane(hc.lane)) {
        ctx.strokeStyle = ink(0.5);
        ctx.strokeRect(r.x + hc.lane * SIDE_BOX.col + 0.5, r.y + hc.off * SIDE_BOX.row + 0.5, SIDE_BOX.col - 1, SIDE_BOX.row - 1);
      }

      const phase = mod(engine.state.pos - lock.anchor, lock.period);
      ctx.strokeStyle = active ? HOT : hueAlpha(lock.hue, 0.9);
      drawLine(ctx, { x: r.x, y: r.y + phase * SIDE_BOX.row }, { x: r.x + r.w, y: r.y + phase * SIDE_BOX.row });

      lock.notes.forEach((n, i) => {
        const pt = layout.sideNotePoint(lock, i);
        if (!pt) return;
        const age = mod(phase - n.off, lock.period);
        const flash = age < 1.5 ? 1 - age / 1.5 : 0;
        const alpha = (n.vel < 0.5 ? 0.5 : 0.95) * (muted ? 0.35 : 1);
        ctx.fillStyle = flash && !muted ? ink(0.6 + flash * 0.4) : active ? hot(alpha) : hueAlpha(lock.hue, alpha);
        drawDot(ctx, pt.x, pt.y, (n.vel < 0.5 ? 1.6 : 2.4) + flash * 1.5);
        if (engine.state.marquee?.del && inMarquee(pt)) {
          ctx.strokeStyle = HOT;
          drawRing(ctx, pt.x, pt.y, 4);
        }
      });

      const target = layout.lockWallBounds(lock, projectNote, 6);
      if (target) {
        lock.wallBox = lock.wallBox
          ? {
              x0: lerp(lock.wallBox.x0, target.x0, 0.18),
              y0: lerp(lock.wallBox.y0, target.y0, 0.18),
              x1: lerp(lock.wallBox.x1, target.x1, 0.18),
              y1: lerp(lock.wallBox.y1, target.y1, 0.18),
            }
          : target;
      }

      const wb = lock.wallBox;
      if (!wb || wb.y1 < layout.tape.top) continue;

      ctx.strokeStyle = active ? HOT : hueAlpha(lock.hue, muted ? 0.25 : 0.7);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(wb.x0, wb.y0, wb.x1 - wb.x0, wb.y1 - wb.y0);

      ctx.strokeStyle = hueAlpha(lock.hue, active ? 0.5 : 0.2);
      ctx.setLineDash([1, 3]);
      drawLine(ctx, { x: r.side ? r.x : r.x + r.w, y: r.y + r.h / 2 }, { x: r.side ? wb.x1 : wb.x0, y: (wb.y0 + wb.y1) / 2 });
      ctx.setLineDash([]);
    }
  }

  function drawFxOver() {
    const t = performance.now();
    const { cx, gap, nowY } = layout.tape;
    const tension = fx.isBuildingOrArmed(engine.state.pos) ? fx.state.build : 0;

    if (tension > 0) {
      const w = (4.4 + EXT_GAP) * gap * tension;
      ctx.strokeStyle = HOT;
      ctx.lineWidth = 3;
      drawLine(ctx, { x: cx - w, y: nowY }, { x: cx + w, y: nowY });
      ctx.lineWidth = 1;
    }

    if (fx.state.mode === "freeze") {
      ctx.fillStyle = `rgba(0,0,0,${0.35 + 0.2 * fx.state.charge})`;
      ctx.fillRect(0, 0, layout.width, layout.height);
      const w = (4.4 + EXT_GAP) * gap * fx.state.charge;
      ctx.strokeStyle = ink(0.95);
      ctx.lineWidth = 3;
      drawLine(ctx, { x: cx - w, y: nowY }, { x: cx + w, y: nowY });
      ctx.lineWidth = 1;
    }

    if (fx.state.hud) drawHud(t);

    for (const r of fx.state.rings) {
      const u = (t - r.t) / (r.dur * 1000);
      const ease = 1 - (1 - u) ** 3;
      ctx.strokeStyle = `${r.col}${(1 - u).toFixed(3)})`;
      ctx.lineWidth = r.w * (1 - u) + 0.5;
      drawRing(ctx, r.x, r.y, r.r1 * ease);
    }
    ctx.lineWidth = 1;

    if (fx.state.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${fx.state.flash.toFixed(3)})`;
      ctx.fillRect(0, 0, layout.width, layout.height);
    }
  }

  function drawHud(now: number) {
    const hud = fx.state.hud!;
    const sel = fx.state.hsel;
    const frozen = fx.state.mode === "freeze";

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    drawDot(ctx, hud.ax, hud.ay, HUD.dead);

    ctx.strokeStyle = ink(hud.ready ? 0.35 : 0.5 + 0.3 * Math.sin(now / 120));
    drawRing(ctx, hud.ax, hud.ay, HUD.dead);

    ctx.fillStyle = ink(0.6);
    drawDot(ctx, hud.ax, hud.ay, 2);

    ctx.font = FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = ink(0.4);
    ctx.fillText("DROP ↑", hud.ax, hud.ay - HUD.dead + 14);
    ctx.fillText("STOP ↓", hud.ax, hud.ay + HUD.dead - 14);

    const rows: ["drop" | "stop", { kind: string; label: string }[], number][] = [
      ["drop", DROP_PADS, -1],
      ["stop", STOP_PADS, 1],
    ];

    for (const [zone, pads, dir] of rows) {
      if (frozen && zone === "stop") continue;
      const rowActive = !sel || sel.zone === zone;
      const y = hud.ay + dir * HUD.rowY;

      pads.forEach((pad, i) => {
        const x = hud.ax + (i - 1) * HUD.dx;
        const hovered = sel?.zone === zone && sel.i === i;
        const pressed = frozen && fx.state.kind === pad.kind;
        const rx = x - HUD.w / 2;
        const ry = y - HUD.h / 2;

        ctx.fillStyle = "#000";
        ctx.fillRect(rx, ry, HUD.w, HUD.h);

        if (pressed) {
          ctx.fillStyle = hot(0.35 + 0.65 * fx.state.charge);
          ctx.fillRect(rx, ry, HUD.w * fx.state.charge, HUD.h);
        }

        ctx.strokeStyle = hovered || pressed ? HOT : ink(rowActive ? 0.55 : 0.2);
        ctx.lineWidth = hovered || pressed ? 2 : 1;
        ctx.strokeRect(rx + 0.5, ry + 0.5, HUD.w - 1, HUD.h - 1);
        ctx.lineWidth = 1;

        ctx.fillStyle = pressed ? "#fff" : hovered ? HOT : ink(rowActive ? 0.85 : 0.3);
        ctx.fillText(pad.label, x, y);

        if (hovered && !frozen) {
          const dist = Math.hypot(x - hud.ax, y - hud.ay);
          ctx.strokeStyle = hot(0.6);
          drawLine(
            ctx,
            { x: hud.ax + ((x - hud.ax) / dist) * HUD.dead, y: hud.ay + ((y - hud.ay) / dist) * HUD.dead },
            { x, y: y - (dir * HUD.h) / 2 },
          );
        }
      });
    }
  }

  function drawMarquee() {
    const m = engine.state.marquee;
    if (!m?.zone) return;

    ctx.strokeStyle = hot(0.8);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);

    let labelAt: Point = { x: Math.min(m.x0, m.x1), y: Math.max(m.y0, m.y1) };
    if (m.zone === "floor") labelAt = drawTapeMarquee(m) ?? labelAt;
    else ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));

    ctx.setLineDash([]);
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = hot(0.8);
    ctx.fillText(m.del ? "delete" : m.all ? "+ grouped" : "free only", labelAt.x, labelAt.y + 3);
  }

  function drawTapeMarquee(m: Marquee) {
    if (m.s0 == null || m.s1 == null || m.l0 == null || m.l1 == null) return null;
    const pos = engine.state.pos;
    const s0 = clamp(Math.min(m.s0, m.s1), pos, pos + FUT);
    const s1 = clamp(Math.max(m.s0, m.s1), pos, pos + FUT);
    const l0 = Math.min(m.l0, m.l1);
    const l1 = Math.max(m.l0, m.l1);
    const corners = [layout.proj(s0, l0, pos), layout.proj(s0, l1, pos), layout.proj(s1, l1, pos), layout.proj(s1, l0, pos)];
    if (corners.some((c) => !c)) return null;

    ctx.beginPath();
    ctx.moveTo(corners[0]!.x, corners[0]!.y);
    for (const c of corners.slice(1)) ctx.lineTo(c!.x, c!.y);
    ctx.closePath();
    ctx.stroke();
    return corners[3]!;
  }
}

export type Renderer = ReturnType<typeof createRenderer>;
