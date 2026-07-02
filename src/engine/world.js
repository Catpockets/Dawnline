// ---------------------------------------------------------------------------
// World generation. Produces a tile grid stored in flat typed arrays (Struct of
// Arrays) for cache-friendly iteration: terrain, resources, fertility, temp,
// disease risk, danger and carrying capacity. Fully deterministic per seed.
// ---------------------------------------------------------------------------
import { mulberry32, makeFbm, clamp } from './rng.js';

export const TERRAIN = { WATER: 0, PLAINS: 1, FOREST: 2, DESERT: 3, MOUNTAIN: 4, FERTILE: 5 };
export const TERRAIN_NAME = ['Water', 'Plains', 'Forest', 'Desert', 'Mountain', 'Fertile'];

/**
 * Generate a world.
 * @param {number} w tiles wide
 * @param {number} h tiles high
 * @param {number} seed 32-bit seed
 * @param {number} abundance resource multiplier (0.3 .. 2)
 */
export function generateWorld(w, h, seed, abundance = 1) {
  const rand = mulberry32(seed);
  const elevN = makeFbm(mulberry32(seed ^ 0x9e3779b9), 5);
  const moistN = makeFbm(mulberry32(seed ^ 0x1b873593), 4);
  const tempN = makeFbm(mulberry32(seed ^ 0x85ebca6b), 3);

  const n = w * h;
  const world = {
    w, h, seed, abundance,
    terrain: new Uint8Array(n),
    elevation: new Float32Array(n),
    food: new Float32Array(n),      // current food on tile
    maxFood: new Float32Array(n),   // regeneration ceiling
    wood: new Float32Array(n),
    stone: new Float32Array(n),
    metal: new Float32Array(n),
    water: new Float32Array(n),     // drinkable-water access 0..100
    fertility: new Float32Array(n), // 0..1, drives regen + farming
    temp: new Float32Array(n),      // 0..1 (cold..hot)
    disease: new Float32Array(n),   // outbreak risk 0..1
    danger: new Float32Array(n),    // predators/terrain hazard 0..1
    capacity: new Float32Array(n)   // rough carrying capacity (people)
  };

  const cx = w / 2, cy = h / 2;
  const sc = 7.5 / Math.max(w, h); // noise scale normalised to world size

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Radial falloff carves a continent with coastal seas at the edges.
      const dx = (x - cx) / (w * 0.55), dy = (y - cy) / (h * 0.55);
      const falloff = Math.sqrt(dx * dx + dy * dy);
      let elev = elevN(x * sc * 3, y * sc * 3) * 1.15 - falloff * falloff * 0.85;
      elev = clamp(elev + 0.18, 0, 1);
      const moist = moistN(x * sc * 4, y * sc * 4);
      // Latitude gradient + noise; equator (map middle) is warm.
      let temp = 1 - Math.abs(y - cy) / cy;
      temp = clamp(temp * 0.75 + tempN(x * sc * 5, y * sc * 5) * 0.35 - elev * 0.25, 0, 1);

      world.elevation[i] = elev;
      world.temp[i] = temp;

      let t;
      if (elev < 0.34) t = TERRAIN.WATER;
      else if (elev > 0.8) t = TERRAIN.MOUNTAIN;
      else if (temp > 0.62 && moist < 0.34) t = TERRAIN.DESERT;
      else if (moist > 0.6 && temp > 0.3) t = TERRAIN.FOREST;
      else if (moist > 0.44 && temp > 0.4 && elev < 0.58) t = TERRAIN.FERTILE;
      else t = TERRAIN.PLAINS;
      world.terrain[i] = t;

      // Base resources per terrain (scaled by abundance slider).
      let food = 0, wood = 0, stone = 0, metal = 0;
      switch (t) {
        case TERRAIN.WATER: food = 26; break; // coastal fishing, gathered from shore
        case TERRAIN.PLAINS: food = 38; wood = 6; stone = 6; break;
        case TERRAIN.FOREST: food = 55; wood = 60; break;
        case TERRAIN.DESERT: food = 6; stone = 10; metal = 6; break;
        case TERRAIN.MOUNTAIN: food = 4; stone = 55; metal = 30; break;
        case TERRAIN.FERTILE: food = 80; wood = 12; stone = 4; break;
      }
      const jitter = 0.75 + rand() * 0.5;
      world.maxFood[i] = food * abundance * jitter;
      world.food[i] = world.maxFood[i];
      world.wood[i] = wood * abundance * jitter;
      world.stone[i] = stone * abundance * jitter;
      world.metal[i] = metal * abundance * jitter;

      const fert = t === TERRAIN.WATER ? 0 : clamp(moist * 0.7 + temp * 0.5 - Math.abs(temp - 0.55) * 0.6, 0, 1);
      world.fertility[i] = fert;
      // Warm + wet = higher endemic disease risk (swamps, standing water).
      world.disease[i] = clamp(moist * temp * 1.2 - 0.15, 0, 1) * (t === TERRAIN.WATER ? 0.3 : 1);
      world.danger[i] =
        t === TERRAIN.MOUNTAIN ? 0.55 + rand() * 0.3 :
        t === TERRAIN.DESERT ? 0.45 + rand() * 0.3 :
        t === TERRAIN.FOREST ? 0.25 + rand() * 0.25 : 0.08 + rand() * 0.15;
      world.capacity[i] = (world.maxFood[i] / 8) * (0.5 + fert);
    }
  }

  computeWaterAccess(world);
  return world;
}

/** BFS from every water tile so land tiles know how close fresh water is. */
function computeWaterAccess(world) {
  const { w, h, terrain, water } = world;
  const dist = new Int16Array(w * h).fill(999);
  const queue = [];
  for (let i = 0; i < w * h; i++) {
    if (terrain[i] === TERRAIN.WATER) { dist[i] = 0; queue.push(i); }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0, d = dist[i];
    if (d >= 12) continue;
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (dist[j] > d + 1) { dist[j] = d + 1; queue.push(j); }
    }
  }
  for (let i = 0; i < w * h; i++) {
    water[i] = clamp(100 - dist[i] * 11, 0, 100);
  }
}

/** Is this tile walkable for agents? */
export function walkable(world, x, y) {
  if (x < 0 || y < 0 || x >= world.w || y >= world.h) return false;
  const t = world.terrain[(y | 0) * world.w + (x | 0)];
  return t !== TERRAIN.WATER && t !== TERRAIN.MOUNTAIN;
}

export const tileIndex = (world, x, y) => (y | 0) * world.w + (x | 0);

/**
 * Spiral-search for the best tile around (x,y) by a scoring callback.
 * Used for "find food", "find water", "find farm land" — approximate, cheap.
 */
export function findBestTile(world, x, y, radius, score) {
  let best = -1, bestScore = 0;
  const x0 = x | 0, y0 = y | 0;
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
        const nx = x0 + dx, ny = y0 + dy;
        if (nx < 0 || ny < 0 || nx >= world.w || ny >= world.h) continue;
        const s = score(ny * world.w + nx, nx, ny);
        if (s > bestScore) { bestScore = s; best = ny * world.w + nx; }
      }
    }
    if (best >= 0 && r >= 3) break; // good enough nearby, stop early
  }
  return best;
}
