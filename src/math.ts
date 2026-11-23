const SEED = (() => {
  const param = new URLSearchParams(location.search).get("seed");
  return param ? parseInt(param, 36) | 0 : (Math.random() * 2 ** 31) | 0;
})();

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const lerp = (start: number, end: number, t: number) => start + (end - start) * t;

export const mod = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;

export const inBounds = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
  x >= x0 && x <= x1 && y >= y0 && y <= y1;

export const noteKey = (step: number, lane: number) => `${step}:${lane}`;

export const nearestIndex = (values: number[], target: number) =>
  values.reduce((best, value, i) => (Math.abs(value - target) < Math.abs(values[best] - target) ? i : best), 0);

export const bisect = (fn: (x: number) => number, lo: number, hi: number, iterations = 60) => {
  for (let i = 0; i < iterations; i++) {
    const mid = Math.sqrt(lo * hi);
    if (fn(mid) > 0) hi = mid;
    else lo = mid;
  }
  return Math.sqrt(lo * hi);
};

export const hash01 = (a: number, b = 0, c = 0) => {
  let x = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647) + Math.imul(SEED, 1597334677)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
