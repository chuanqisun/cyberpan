import { clamp, mod } from "./math";

export const KEYS = "asdfghjkl";
export const EXT_GAP = 1.25;
export const METRIC = [1, 0.3, 0.55, 0.8, 0.85, 0.25, 0.55, 0.8, 0.95, 0.3, 0.5, 0.85, 0.85, 0.2, 0.55, 0.75];

const semiHz = (semitone: number) => 440 * 2 ** (semitone / 12);

const CORE_PITCHES: [string, number][] = [
  ["E3", -17],
  ["B3", -10],
  ["C4", -9],
  ["D4", -7],
  ["E4", -5],
  ["F#4", -3],
  ["G4", -2],
  ["A4", 0],
  ["B4", 2],
];

const EXT_PITCHES: Record<number, [string, number]> = {
  [-3]: ["B2", -22],
  [-2]: ["C3", -21],
  [-1]: ["D3", -19],
  9: ["C5", 3],
  10: ["D5", 5],
  11: ["E5", 7],
};

const EXT_LANES = Object.keys(EXT_PITCHES).map(Number);

export const NOTES = CORE_PITCHES.map(([name, semi], idx) => ({
  name,
  idx,
  semi,
  freq: semiHz(semi),
  pan: (idx / 8 - 0.5) * 0.5,
}));

export const PROG = [
  { sym: "i", pool: [0, 1, 4, 6, 8], bassHz: semiHz(-29) },
  { sym: "VI", pool: [2, 4, 6, 8, 1], bassHz: semiHz(-33) },
  { sym: "VII", pool: [3, 5, 7, 8, 1], bassHz: semiHz(-31) },
  { sym: "i", pool: [0, 1, 4, 6, 5], bassHz: semiHz(-29) },
];

export const isExtendedLane = (lane: number) => lane < 0 || lane > 8;

export const visualLane = (lane: number) => (lane < -0.5 ? -EXT_GAP : lane > 8.5 ? 8 + EXT_GAP : lane);

export const semiOf = (lane: number) => (lane in EXT_PITCHES ? EXT_PITCHES[lane][1] : NOTES[lane].semi);

export const noteAt = (lane: number) => {
  if (NOTES[lane]) return NOTES[lane];
  const ext = EXT_PITCHES[lane];
  return ext && { name: ext[0], idx: lane, semi: ext[1], freq: semiHz(ext[1]), pan: clamp((lane / 8 - 0.5) * 0.5, -0.6, 0.6) };
};

export const octaveOf = (lane: number, direction: number) => {
  const baseSemi = semiOf(lane);
  for (const dir of [direction, -direction]) {
    const match = EXT_LANES.find((extLane) => EXT_PITCHES[extLane][1] === baseSemi + 12 * dir);
    if (match != null) return match;
  }
  return null;
};

export type HarmonySegment = { from: number; off: number };

export function createHarmony() {
  let segments: HarmonySegment[] = [{ from: -1e9, off: 0 }];

  const progressionIndex = (bar: number) => {
    let offset = 0;
    for (const seg of segments) if (bar >= seg.from) offset = seg.off;
    return mod(bar - offset, PROG.length);
  };

  const chordAt = (bar: number) => PROG[progressionIndex(bar)];

  const pushSegment = (fromBar: number) => {
    const segment = { from: fromBar, off: mod(fromBar, PROG.length) };
    segments.push(segment);
    return segment;
  };

  const removeSegment = (segment: HarmonySegment) => {
    segments = segments.filter((entry) => entry !== segment);
  };

  return { chordAt, progressionIndex, pushSegment, removeSegment };
}

export type Harmony = ReturnType<typeof createHarmony>;
