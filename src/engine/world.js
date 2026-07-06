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
    gems: new Float32Array(n),
    clay: new Float32Array(n),
    herbs: new Float32Array(n),
    fish: new Float32Array(n),
    salt: new Float32Array(n),
    river: new Float32Array(n),
    riverPaths: [],
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
      let food = 0, wood = 0, stone = 0, metal = 0, gems = 0;
      switch (t) {
        case TERRAIN.WATER: food = 26; break; // coastal fishing, gathered from shore
        case TERRAIN.PLAINS: food = 38; wood = 6; stone = 6; break;
        case TERRAIN.FOREST: food = 55; wood = 60; break;
        case TERRAIN.DESERT: food = 4; stone = 10; metal = 6; break;
        case TERRAIN.MOUNTAIN: food = 0; stone = 70; metal = 45; break;
        case TERRAIN.FERTILE: food = 80; wood = 12; stone = 4; break;
      }
      const jitter = 0.75 + rand() * 0.5;
      if (t === TERRAIN.MOUNTAIN && elev > 0.84 && rand() < 0.22) gems = 18 + rand() * 34;
      else if (t === TERRAIN.DESERT && rand() < 0.035) gems = 8 + rand() * 18;
      world.maxFood[i] = food * abundance * jitter;
      world.food[i] = world.maxFood[i];
      world.wood[i] = wood * abundance * jitter;
      world.stone[i] = stone * abundance * jitter;
      world.metal[i] = metal * abundance * jitter;
      world.gems[i] = gems * abundance;

      let fert = (t === TERRAIN.WATER || t === TERRAIN.MOUNTAIN)
        ? 0
        : clamp(moist * 0.7 + temp * 0.5 - Math.abs(temp - 0.55) * 0.6, 0, 1);
      if (t === TERRAIN.DESERT) fert *= 0.35;
      world.fertility[i] = fert;
      // Warm + wet = higher endemic disease risk (swamps, standing water).
      world.disease[i] = clamp(moist * temp * 1.2 - 0.15, 0, 1) * (t === TERRAIN.WATER ? 0.3 : 1);
      world.danger[i] =
        t === TERRAIN.MOUNTAIN ? 0.55 + rand() * 0.3 :
        t === TERRAIN.DESERT ? 0.45 + rand() * 0.3 :
        t === TERRAIN.FOREST ? 0.25 + rand() * 0.25 : 0.08 + rand() * 0.15;
      world.capacity[i] = (t === TERRAIN.WATER || t === TERRAIN.MOUNTAIN)
        ? 0
        : (world.maxFood[i] / 8) * (0.5 + fert);
    }
  }

  generateRivers(world, seed);
  computeWaterAccess(world);
  depositResourceClusters(world, seed);
  return world;
}

// ---------------------------------------------------------------------------
// UNEVEN RESOURCE DEPOSITS: each specialty resource is dropped as a handful
// of deterministic radial blobs in terrain that suits it. One region gets
// herbs, another salt, another iron-rich hills — so settlements specialize
// and trade routes carry real economic meaning.
// ---------------------------------------------------------------------------
function depositResourceClusters(world, seed) {
  const { w, h, terrain, elevation, fertility, water } = world;
  const rand = mulberry32(seed ^ 0x7e50ca7e);
  const blob = (layer, cx, cy, radius, amount) => {
    const x0 = Math.max(0, cx - radius | 0), x1 = Math.min(w - 1, cx + radius | 0);
    const y0 = Math.max(0, cy - radius | 0), y1 = Math.min(h - 1, cy + radius | 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius) continue;
        const i = y * w + x;
        if (terrain[i] === TERRAIN.WATER && layer !== world.fish) continue;
        layer[i] = Math.max(layer[i], amount * (1 - d / radius) * (0.7 + rand() * 0.6));
      }
    }
  };
  const clusters = Math.max(4, Math.round((w * h) / 1500));
  // suitability tests per resource kind
  const kinds = [
    { layer: world.herbs, amount: 42, radius: 4, ok: (i) => fertility[i] > 0.5 && (terrain[i] === TERRAIN.FOREST || terrain[i] === TERRAIN.FERTILE) },
    { layer: world.clay, amount: 40, radius: 4, ok: (i) => water[i] > 55 && terrain[i] !== TERRAIN.WATER && terrain[i] !== TERRAIN.MOUNTAIN },
    { layer: world.salt, amount: 45, radius: 3, ok: (i) => terrain[i] === TERRAIN.DESERT || (elevation[i] > 0.34 && elevation[i] < 0.4 && water[i] > 70) },
    { layer: world.fish, amount: 55, radius: 5, ok: (i) => terrain[i] === TERRAIN.WATER && elevation[i] > 0.2 }
  ];
  for (const k of kinds) {
    let placed = 0;
    for (let tries = 0; tries < 500 && placed < clusters; tries++) {
      const x = (rand() * w) | 0, y = (rand() * h) | 0;
      const i = y * w + x;
      if (!k.ok(i)) continue;
      blob(k.layer, x, y, k.radius, k.amount * world.abundance);
      placed++;
    }
  }
}

function generateRivers(world, seed) {
  const { w, h, terrain, elevation, river } = world;
  const rand = mulberry32(seed ^ 0x51f15e);
  const candidates = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (terrain[i] === TERRAIN.MOUNTAIN && elevation[i] > 0.79 && rand() < 0.35) candidates.push(i);
    }
  }
  const count = Math.min(candidates.length, Math.max(3, Math.round(Math.max(w, h) / 18)));
  for (let n = 0; n < count; n++) {
    const start = candidates.splice((rand() * candidates.length) | 0, 1)[0];
    if (start === undefined) break;
    const path = carveRiver(world, start, rand);
    if (path.length > 3) world.riverPaths.push(path);
  }

  for (let i = 0; i < river.length; i++) {
    if (river[i] <= 0) continue;
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (terrain[j] === TERRAIN.WATER || terrain[j] === TERRAIN.MOUNTAIN) continue;
        const k = dx === 0 && dy === 0 ? 1 : 0.45;
        world.fertility[j] = clamp(world.fertility[j] + 0.15 * k, 0, 1);
        world.maxFood[j] += 7 * k * world.abundance;
        world.food[j] = Math.max(world.food[j], world.maxFood[j] * 0.85);
        world.capacity[j] = Math.max(world.capacity[j], (world.maxFood[j] / 8) * (0.5 + world.fertility[j]));
      }
    }
  }
}

function carveRiver(world, start, rand) {
  const { w, h, terrain, elevation, river } = world;
  let x = start % w, y = (start / w) | 0;
  const seen = new Set();
  const path = [];
  for (let step = 0; step < w + h; step++) {
    const i = y * w + x;
    path.push({ x: x + 0.5, y: y + 0.5 });
    river[i] = Math.max(river[i], 1);
    if (terrain[i] === TERRAIN.WATER && step > 3) break;
    seen.add(i);

    let best = -1, bestScore = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
        const j = ny * w + nx;
        if (seen.has(j)) continue;
        const edge = Math.min(nx, ny, w - 1 - nx, h - 1 - ny) / Math.max(w, h);
        const downhill = Math.max(0, elevation[j] - elevation[i]) * 2.5;
        const waterBonus = terrain[j] === TERRAIN.WATER ? -3 : 0;
        const score = elevation[j] + downhill + edge * 0.55 + rand() * 0.08 + waterBonus;
        if (score < bestScore) { bestScore = score; best = j; }
      }
    }
    if (best < 0) break;
    x = best % w; y = (best / w) | 0;
  }
  return path;
}

/** BFS from every water tile so land tiles know how close fresh water is. */
function computeWaterAccess(world) {
  const { w, h, terrain, river, water } = world;
  const dist = new Int16Array(w * h).fill(999);
  const queue = [];
  for (let i = 0; i < w * h; i++) {
    if (terrain[i] === TERRAIN.WATER || river[i] > 0) { dist[i] = 0; queue.push(i); }
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

export function travelCost(world, x, y) {
  if (x < 0 || y < 0 || x >= world.w || y >= world.h) return Infinity;
  const i = (y | 0) * world.w + (x | 0);
  const t = world.terrain[i];
  if (t === TERRAIN.WATER || t === TERRAIN.MOUNTAIN) return Infinity;
  let cost = 1;
  if (t === TERRAIN.FOREST) cost += 0.35;
  else if (t === TERRAIN.DESERT) cost += 0.8;
  if (world.elevation[i] > 0.68) cost += (world.elevation[i] - 0.68) * 4;
  if (world.river[i] > 0) cost -= 0.25;
  cost += world.danger[i] * 0.5;
  return Math.max(0.45, cost);
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
