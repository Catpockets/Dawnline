// ---------------------------------------------------------------------------
// Seeded RNG + small math utilities. Everything in the simulation flows from
// mulberry32 streams so a given seed always produces the same world & history.
// ---------------------------------------------------------------------------

/** Mulberry32: tiny, fast, decent-quality 32-bit seeded PRNG. Returns fn -> [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string/number into a 32-bit seed. */
export function hashSeed(v) {
  const s = String(v);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist2 = (x1, y1, x2, y2) => (x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2);

/** Pick a random element of an array using rng stream. */
export const pick = (rand, arr) => arr[(rand() * arr.length) | 0];

/** Approximately gaussian in [0,1] centered at 0.5 (sum of 3 uniforms). */
export const gauss01 = (rand) => (rand() + rand() + rand()) / 3;

/**
 * Value-noise factory. Builds a lattice of random values; sampling bilinearly
 * interpolates between lattice points. Cheap and deterministic.
 */
export function makeNoise2D(rand, latticeSize = 64) {
  const n = latticeSize;
  const vals = new Float32Array(n * n);
  for (let i = 0; i < vals.length; i++) vals[i] = rand();
  const at = (x, y) => vals[((y % n + n) % n) * n + ((x % n + n) % n)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
  };
}

/** Fractal brownian motion: layered octaves of value noise. Output ~[0,1]. */
export function makeFbm(rand, octaves = 4) {
  const noise = makeNoise2D(rand);
  return function fbm(x, y) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

// Procedural settlement names -----------------------------------------------
const SYL_A = ['Ka', 'Bel', 'Dor', 'Mar', 'Tal', 'Vor', 'Esh', 'Nim', 'Ral', 'Sun', 'Or', 'Ith', 'Ubar', 'Qel', 'Han', 'Zar'];
const SYL_B = ['an', 'or', 'eth', 'ia', 'un', 'ar', 'iel', 'os', 'em', 'ash', 'il', 'ua'];
const SYL_C = ['grad', 'holm', 'wick', 'dun', 'mor', 'stead', 'fell', 'gate', 'reach', 'haven', 'crest', ''];
export function makeName(rand) {
  return pick(rand, SYL_A) + pick(rand, SYL_B) + (rand() < 0.65 ? pick(rand, SYL_C) : '');
}
