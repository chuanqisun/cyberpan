import { bisect, clamp, inBounds } from "./math";
import { EXT_GAP, visualLane } from "./theory";

export const PAST = 120;
export const FUT = 96;
export const DECEL = 2;
export const FONT = "11px monospace";
export const HOT = "#ff5a1f";
export const SIDE_BOX = { col: 11, row: 5, gapY: 28 };
export const HUES: [number, number, number][] = [
  [110, 160, 210],
  [140, 190, 120],
  [190, 140, 205],
  [205, 185, 110],
];

const ZONE_PAD = EXT_GAP + 1.5;
const ZONE_PAD_Y = 24;

export type Point = { x: number; y: number };
export type ProjectedPoint = { x: number; y: number; s: number };
export type Bounds = { x0: number; y0: number; x1: number; y1: number };
export type SideRect = { x: number; y: number; w: number; h: number; side: number };

export type SideBoxLock = {
  period: number;
  notes: { off: number; lane: number; vel: number }[];
  last: (unknown | undefined)[];
};

export const ink = (alpha: number) => `rgba(255,255,255,${clamp(alpha, 0, 1).toFixed(3)})`;

export const hot = (alpha: number) => `rgba(255,90,31,${clamp(alpha, 0, 1).toFixed(3)})`;

export const hueAlpha = (hueIndex: number, alpha: number) => {
  const [r, g, b] = HUES[hueIndex];
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1).toFixed(3)})`;
};

export const drawRing = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
};

export const drawDot = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
};

export const drawLine = (ctx: CanvasRenderingContext2D, a: Point | null, b: Point | null) => {
  if (!a || !b) return;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
};

export function createLayout<TLock extends SideBoxLock>(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const sideRects = new Map<TLock, SideRect>();

  let width = 0;
  let height = 0;
  let tape = { nowY: 0, gap: 0, cx: 0, top: 34, frontH: 0, flare: 1, v0: 1, T: Infinity, c: DECEL };

  const wallOff = (age: number) => (tape.T === Infinity ? tape.v0 * age : tape.v0 * tape.T * Math.log1p(age / tape.T));
  const wallAge = (off: number) => (tape.T === Infinity ? off / tape.v0 : tape.T * Math.expm1(off / (tape.v0 * tape.T)));
  const qOf = (u: number) => (tape.c < 1e-6 ? u : Math.expm1(tape.c * u) / Math.expm1(tape.c));
  const uOf = (q: number) => (tape.c < 1e-6 ? q : Math.log1p(q * Math.expm1(tape.c)) / tape.c);

  const proj = (step: number, vLane: number, pos: number) => {
    const d = step - pos;
    if (d < 0) {
      if (-d > PAST + 1e-6) return null;
      return { x: tape.cx + (vLane - 4) * tape.gap, y: tape.nowY - wallOff(-d), s: 1 };
    }
    if (d > FUT + 1e-6) return null;
    const q = qOf(Math.min(1, d / FUT));
    const s = 1 + (tape.flare - 1) * q;
    return { x: tape.cx + (vLane - 4) * tape.gap * s, y: tape.nowY + q * tape.frontH, s };
  };

  const floorAt = (x: number, y: number, pos: number) => {
    const q = clamp((y - tape.nowY) / tape.frontH, 0, 1);
    const s = 1 + (tape.flare - 1) * q;
    return { step: pos + FUT * uOf(q), lane: (x - tape.cx) / (tape.gap * s) + 4 };
  };

  const zoneAt = (x: number, y: number, pos: number) => {
    if (y <= tape.nowY && y >= tape.nowY - wallOff(PAST) - ZONE_PAD_Y && Math.abs(x - tape.cx) <= (4.5 + ZONE_PAD) * tape.gap) {
      return "wall" as const;
    }
    if (y > tape.nowY && y <= tape.nowY + tape.frontH + ZONE_PAD_Y) {
      const floor = floorAt(x, y, pos);
      if (floor.lane >= -0.5 - ZONE_PAD && floor.lane <= 8.5 + ZONE_PAD) return "floor" as const;
    }
    return null;
  };

  const cellAt = (x: number, y: number, pos: number) => {
    if (y <= tape.nowY || y > tape.nowY + tape.frontH) return null;
    const floor = floorAt(x, y, pos);
    const lane = Math.round(floor.lane);
    return lane < 0 || lane > 8 ? null : { step: Math.round(floor.step), lane };
  };

  const layoutSideBoxes = (locks: TLock[]) => {
    sideRects.clear();
    const wallL = tape.cx - (4.5 + EXT_GAP) * tape.gap;
    const wallR = tape.cx + (4.5 + EXT_GAP) * tape.gap;
    const w = SIDE_BOX.col * 9;
    const nextY = [tape.top + 14, tape.top + 14];

    locks.forEach((lock, i) => {
      const side = i % 2;
      const h = lock.period * SIDE_BOX.row;
      const x = side ? wallR + 34 : wallL - 58 - w;
      sideRects.set(lock, { x, y: nextY[side], w, h, side });
      nextY[side] += h + SIDE_BOX.gapY;
    });
  };

  const sideRect = (lock: TLock) => sideRects.get(lock);

  const sideBoxBounds = (lock: TLock) => {
    const r = sideRects.get(lock);
    return r && { x0: r.x - 4, y0: r.y - 16, x1: r.x + r.w + 4, y1: r.y + r.h + 4 };
  };

  const sideCellAt = (x: number, y: number) => {
    for (const [lock, r] of sideRects) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        return { lock, off: Math.floor((y - r.y) / SIDE_BOX.row), lane: Math.floor((x - r.x) / SIDE_BOX.col) };
      }
    }
    return null;
  };

  const sideTitleAt = (x: number, y: number) => {
    for (const [lock, r] of sideRects) {
      if (inBounds(x, y, r.x - 4, r.y - 16, r.x + r.w + 4, r.y - 0.001)) return lock;
    }
    return null;
  };

  const sideNotePoint = (lock: TLock, index: number) => {
    const r = sideRects.get(lock);
    const note = lock.notes[index];
    return r && note && { x: r.x + (visualLane(note.lane) + 0.5) * SIDE_BOX.col, y: r.y + (note.off + 0.5) * SIDE_BOX.row, s: 1 };
  };

  const sideExactIndex = (cell: { lock: TLock; off: number; lane: number }) =>
    cell.lock.notes.findIndex((note) => note.off === cell.off && note.lane === cell.lane);

  const sideNearestIndex = (cell: { lock: TLock; off: number; lane: number }) => {
    const exact = sideExactIndex(cell);
    if (exact >= 0) return exact;

    let best = -1;
    let bestDist = 1.6;
    cell.lock.notes.forEach((note, i) => {
      const dist = Math.abs(note.off - cell.off) + Math.abs(note.lane - cell.lane) * 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  };

  const lockWallBounds = <TNote>(lock: { last: (TNote | undefined)[] }, projectNote: (note: TNote) => ProjectedPoint | null, pad = 7) => {
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;

    for (const note of lock.last) {
      const pt = note && projectNote(note);
      if (!pt) continue;
      x0 = Math.min(x0, pt.x);
      y0 = Math.min(y0, pt.y);
      x1 = Math.max(x1, pt.x);
      y1 = Math.max(y1, pt.y);
    }
    return x0 > x1 ? null : { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  };

  function fit() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    width = rect.width;
    height = rect.height;
    const nowY = Math.round(height * 0.54);
    const gap = Math.min(30, width / 22);
    const top = 34;
    const span = nowY - top;
    const v0 = span / 40;
    const T = v0 * PAST <= span + 1e-6 ? Infinity : bisect((candidate) => v0 * candidate * Math.log(1 + PAST / candidate) - span, 1e-3, 1e7);

    tape = {
      nowY,
      gap,
      cx: width / 2,
      top,
      frontH: height - nowY - 44,
      flare: Math.min(2.4, (width * 0.47) / (gap * (4.5 + EXT_GAP))),
      v0,
      T,
      c: DECEL,
    };
  }

  addEventListener("resize", fit);
  fit();

  return {
    ctx,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get tape() {
      return tape;
    },
    wallOff,
    wallAge,
    proj,
    floorAt,
    zoneAt,
    cellAt,
    layoutSideBoxes,
    sideRect,
    sideBoxBounds,
    sideCellAt,
    sideTitleAt,
    sideNotePoint,
    sideExactIndex,
    sideNearestIndex,
    lockWallBounds,
  };
}

export type Layout<TLock extends SideBoxLock = SideBoxLock> = ReturnType<typeof createLayout<TLock>>;
