// ---------------------------------------------------------------------------
// Agent model. Each agent is an autonomous unit with needs, personality,
// skills, memory and relationships. Decisions come from a UTILITY AI: every
// few ticks the agent scores a menu of candidate actions against its current
// needs, personality and learned strategy weights, then commits to the winner
// as an FSM state (seekFood, exploring, fleeing...). No scripted behaviour.
// ---------------------------------------------------------------------------
import { clamp, dist2 } from './rng.js';
import { TERRAIN, walkable, tileIndex, findBestTile } from './world.js';

export const TICKS_PER_YEAR = 30;

let SKILL_NAMES = ['gather', 'farm', 'build', 'fight', 'trade', 'heal', 'explore'];

/** Create one agent. Personality traits are stable; needs fluctuate. */
export function createAgent(sim, x, y, opts = {}) {
  const r = sim.rand;
  const a = {
    id: sim.nextAgentId++,
    x, y, tx: x, ty: y, hasTarget: false,
    px: x, py: y, // position at the start of the current tick (for render interpolation)
    age: opts.age !== undefined ? opts.age : 14 + r() * 22,
    health: 80 + r() * 20,
    hunger: r() * 30,        // 0 good .. 100 starving
    thirst: r() * 30,
    energy: 60 + r() * 40,   // 0 exhausted .. 100 rested
    fear: r() * 10,
    // Personality (fixed for life, 0..1)
    curiosity: r(), aggression: r() * r(), intelligence: 0.3 + r() * 0.7,
    sociability: r(), greed: r(), empathy: r(),
    fertility: 0.4 + r() * 0.6,
    sick: false, immunity: r() * 0.3, sickT: 0,
    inv: { food: 2 + r() * 4, wood: 0, stone: 0, wealth: r() * 2 },
    home: opts.home !== undefined ? opts.home : -1,
    partner: -1,
    rel: new Map(),          // id -> -1..1 trust/hostility
    memory: [],              // short ring of recent event strings
    state: 'idle', stateT: 0,
    goal: 'survive',
    skills: {},
    // Reinforcement-like strategy weights: nudged up when a strategy pays off.
    strat: { gather: 1, farm: 1, trade: 1, raid: 1, explore: 1 },
    trail: [],               // recent positions for migration-trail rendering
    kills: 0, birthTick: sim.tick,
    dead: false
  };
  // Skill weights sum to ~1 with one specialty emphasized.
  let total = 0;
  for (const s of SKILL_NAMES) { a.skills[s] = 0.2 + r(); total += a.skills[s]; }
  for (const s of SKILL_NAMES) a.skills[s] /= total;
  const spec = SKILL_NAMES[(r() * SKILL_NAMES.length) | 0];
  a.skills[spec] += 0.25;
  return a;
}

/** Record a memory + optional relationship change with another agent. */
export function remember(a, text, other = null, delta = 0) {
  a.memory.push(text);
  if (a.memory.length > 6) a.memory.shift();
  if (other) {
    const cur = a.rel.get(other.id) || 0;
    a.rel.set(other.id, clamp(cur + delta, -1, 1));
    if (a.rel.size > 14) { // cap memory of relationships (forget oldest)
      const first = a.rel.keys().next().value;
      a.rel.delete(first);
    }
  }
}

/** Reinforcement nudge: reward>0 strengthens the strategy, <0 weakens it. */
export function reinforce(a, strategy, reward) {
  if (a.strat[strategy] === undefined) return;
  a.strat[strategy] = clamp(a.strat[strategy] * (1 + reward * 0.06), 0.4, 2.5);
}

/** Agents on nearby tiles, via the simulation's spatial hash grid. */
export function nearbyAgents(sim, x, y, radius) {
  const out = [];
  const x0 = Math.max(0, (x | 0) - radius), x1 = Math.min(sim.world.w - 1, (x | 0) + radius);
  const y0 = Math.max(0, (y | 0) - radius), y1 = Math.min(sim.world.h - 1, (y | 0) + radius);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const bucket = sim.grid.get(ty * sim.world.w + tx);
      if (bucket) for (const id of bucket) out.push(id);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// UTILITY AI: score candidate actions, pick the best, set FSM state + target.
// --------------------------------------------------------------------------
function decide(sim, a) {
  const w = sim.world;
  const ti = tileIndex(w, a.x, a.y);
  const home = a.home >= 0 ? sim.settlementById.get(a.home) : null;
  const P = sim.params;

  const scores = [];
  const add = (name, s) => { if (s > 0) scores.push([name, s]); };

  // --- survival needs (urgency curves are quadratic so crises dominate) ---
  const hungerU = (a.hunger / 100) ** 2 * 3.2;
  const thirstU = (a.thirst / 100) ** 2 * 3.6;
  const tiredU = ((100 - a.energy) / 100) ** 2 * 1.6;

  add('seekFood', hungerU * (0.6 + a.skills.gather) * a.strat.gather);
  add('seekWater', thirstU);
  add('resting', tiredU + (a.health < 40 ? 0.8 : 0));
  add('fleeing', (a.fear / 100) ** 1.5 * 2.4);

  // --- farming: needs a home with agriculture tech and fertile land ---
  if (home && home.tech >= 2 && w.fertility[ti] > 0.35) {
    add('farming', (0.5 + hungerU * 0.5) * a.skills.farm * 2.2 * a.strat.farm);
  }
  // --- social / economic drives, only when needs are under control ---
  const calm = hungerU < 0.7 && thirstU < 0.7;
  if (calm) {
    add('exploring', a.curiosity * 0.85 * a.strat.explore * (a.home < 0 ? 1.4 : 0.8));
    add('socializing', a.sociability * 0.75);
    if (home && home.buildings.market > 0) {
      add('trading', a.greed * a.skills.trade * 1.6 * P.tradeFriendliness * a.strat.trade);
    }
    if (home) {
      add('building', a.skills.build * 1.2 * (home.woodStore > 10 ? 1 : 0.3));
      if (a.skills.heal > 0.2) {
        add('healing', a.empathy * a.skills.heal * (home.sickCount > 0 ? 2.5 : 0.1));
      }
    }
  }
  // --- aggression: fight when hostile neighbours are near & bold enough ---
  const enemyNear = a.fear > 25 || a.threat;
  if (enemyNear && a.aggression * P.aggression > 0.45 && a.health > 45) {
    add('fighting', a.aggression * P.aggression * 1.8 * a.strat.raid);
  }
  // --- migration: leave depleted / dangerous regions ---
  const localFood = w.food[ti] / (w.maxFood[ti] + 1);
  const push = (1 - localFood) * 0.5 + w.danger[ti] * 0.6 + (a.fear / 100) * 0.5;
  if (push > 0.55 && (!home || home.stability < 0.35)) {
    add('migrating', push * 1.3);
  }
  // --- go home to deposit food / rest / mate ---
  if (home && (a.inv.food > 8 || a.energy < 35)) {
    add('returningHome', 0.9 + a.inv.food * 0.03);
  }
  add('idle', 0.15);

  // pick argmax
  let best = 'idle', bestS = -1;
  for (const [name, s] of scores) if (s > bestS) { bestS = s; best = name; }
  setState(sim, a, best);
}

/** Transition into a state: pick a movement target appropriate to it. */
function setState(sim, a, state) {
  const w = sim.world;
  a.state = state;
  a.stateT = 0;
  a.hasTarget = false;
  const home = a.home >= 0 ? sim.settlementById.get(a.home) : null;

  switch (state) {
    case 'seekFood': {
      const idx = findBestTile(w, a.x, a.y, 9, (i) => w.food[i] > 4 ? w.food[i] : 0);
      if (idx >= 0) setTarget(a, idx % w.w + 0.5, (idx / w.w | 0) + 0.5);
      else if (home && home.foodStore > 2) setTarget(a, home.x, home.y);
      else wander(sim, a, 8);
      break;
    }
    case 'seekWater': {
      const idx = findBestTile(w, a.x, a.y, 10, (i) => w.water[i] > 45 ? w.water[i] : 0);
      if (idx >= 0) setTarget(a, idx % w.w + 0.5, (idx / w.w | 0) + 0.5);
      else wander(sim, a, 10);
      break;
    }
    case 'farming': {
      const idx = findBestTile(w, a.x, a.y, 6, (i) =>
        w.fertility[i] > 0.4 && w.terrain[i] !== TERRAIN.WATER ? w.fertility[i] : 0);
      if (idx >= 0) setTarget(a, idx % w.w + 0.5, (idx / w.w | 0) + 0.5);
      break;
    }
    case 'exploring': case 'migrating':
      wander(sim, a, state === 'migrating' ? 22 : 12);
      break;
    case 'returningHome': case 'building': case 'trading': case 'socializing': case 'healing':
      if (home) setTarget(a, home.x + (sim.rand() - 0.5) * 2, home.y + (sim.rand() - 0.5) * 2);
      break;
    case 'fleeing': {
      // run away from the remembered threat direction
      const dx = a.x - (a.threatX ?? a.x + (sim.rand() - 0.5));
      const dy = a.y - (a.threatY ?? a.y + (sim.rand() - 0.5));
      const len = Math.hypot(dx, dy) || 1;
      setTarget(a, a.x + (dx / len) * 8, a.y + (dy / len) * 8);
      break;
    }
    default: break; // idle / resting / fighting stay in place
  }
}

function setTarget(a, x, y) { a.tx = x; a.ty = y; a.hasTarget = true; }

/** Pick a random walkable target roughly `range` tiles away. */
function wander(sim, a, range) {
  for (let tries = 0; tries < 6; tries++) {
    const ang = sim.rand() * Math.PI * 2;
    const d = range * (0.5 + sim.rand() * 0.5);
    const nx = a.x + Math.cos(ang) * d, ny = a.y + Math.sin(ang) * d;
    if (walkable(sim.world, nx, ny)) { setTarget(a, nx, ny); return; }
  }
}

/** Steering movement with cheap water/mountain avoidance (no full A*). */
function move(sim, a, speed) {
  if (!a.hasTarget) return true;
  const dx = a.tx - a.x, dy = a.ty - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.4) { a.hasTarget = false; return true; }
  let nx = a.x + (dx / d) * speed, ny = a.y + (dy / d) * speed;
  if (!walkable(sim.world, nx, ny)) {
    // try sliding perpendicular either way
    const px = -dy / d, py = dx / d;
    if (walkable(sim.world, a.x + px * speed, a.y + py * speed)) { nx = a.x + px * speed; ny = a.y + py * speed; }
    else if (walkable(sim.world, a.x - px * speed, a.y - py * speed)) { nx = a.x - px * speed; ny = a.y - py * speed; }
    else { a.hasTarget = false; return true; } // boxed in; re-decide
  }
  a.x = clamp(nx, 0.5, sim.world.w - 0.5);
  a.y = clamp(ny, 0.5, sim.world.h - 0.5);
  return false;
}

// --------------------------------------------------------------------------
// Per-tick agent update: needs drift, FSM behaviour, combat, memory decay.
// --------------------------------------------------------------------------
export function updateAgent(sim, a) {
  const w = sim.world;
  const P = sim.params;
  const ti = tileIndex(w, a.x, a.y);
  const home = a.home >= 0 ? sim.settlementById.get(a.home) : null;

  // remember tick-start position so the renderer can interpolate at slow speeds
  a.px = a.x; a.py = a.y;

  // ---- physiological drift ----
  a.age += 1 / TICKS_PER_YEAR;
  const heat = clamp(w.temp[ti] + sim.climate.tempOffset, 0, 1.4);
  a.hunger = clamp(a.hunger + 0.35, 0, 100);
  a.thirst = clamp(a.thirst + 0.45 + heat * 0.25, 0, 100);
  a.energy = clamp(a.energy + (a.state === 'resting' || a.state === 'idle' ? 1.6 : -0.35), 0, 100);
  a.fear = clamp(a.fear - 0.6, 0, 100);
  a.threat = false;

  // eat/drink automatically when possible
  if (a.hunger > 30 && a.inv.food > 0) {
    const bite = Math.min(a.inv.food, 3);
    a.inv.food -= bite; a.hunger = clamp(a.hunger - bite * 12, 0, 100);
  }
  if (a.hunger > 40 && home && dist2(a.x, a.y, home.x, home.y) < 9 && home.foodStore > 1) {
    home.foodStore -= 2; a.hunger = clamp(a.hunger - 22, 0, 100);
  }
  if (w.water[ti] > 55) a.thirst = clamp(a.thirst - 18, 0, 100);

  // starvation / dehydration / sickness damage; mild regen otherwise
  let dmg = 0;
  if (a.hunger >= 98) dmg += 1.1;
  if (a.thirst >= 98) dmg += 1.6;
  if (a.sick) {
    dmg += 0.45 * P.diseaseSeverity * (1 - a.immunity);
    a.sickT++;
    const med = home ? home.tech >= 8 ? 0.05 : 0 : 0;
    if (sim.rand() < 0.02 + a.immunity * 0.03 + med) { a.sick = false; a.immunity = clamp(a.immunity + 0.3, 0, 0.95); }
  }
  if (dmg > 0) a.health -= dmg;
  else if (a.hunger < 55 && a.thirst < 55) a.health = clamp(a.health + 0.25, 0, 100);

  // ageing mortality (rises sharply past ~55 sim-years)
  if (a.age > 55 && sim.rand() < (a.age - 55) * 0.00012) a.health = -1;
  if (a.health <= 0) { sim.killAgent(a, a.sick ? 'disease' : a.hunger >= 98 ? 'starvation' : 'death'); return; }

  // ---- re-decide periodically or when current state has run its course ----
  a.stateT++;
  const staleness = a.state === 'migrating' ? 80 : a.state === 'exploring' ? 40 : 24;
  if (a.stateT > staleness || (!a.hasTarget && a.stateT > 4)) decide(sim, a);

  // ---- behave according to FSM state ----
  const speed = 0.28 * (0.5 + a.energy / 200) * (a.state === 'fleeing' ? 1.5 : 1);
  switch (a.state) {
    case 'seekFood': {
      if (move(sim, a, speed)) {
        // arrived: harvest the tile (depletes it — scarcity is real)
        const take = Math.min(w.food[ti], 3.5 * (0.5 + a.skills.gather));
        if (take > 0.3) {
          w.food[ti] -= take; a.inv.food += take;
          reinforce(a, 'gather', 0.5);
          if (a.inv.food > 10) decide(sim, a);
        } else { reinforce(a, 'gather', -0.3); decide(sim, a); }
      }
      break;
    }
    case 'seekWater': move(sim, a, speed); if (a.thirst < 15) decide(sim, a); break;
    case 'farming': {
      if (move(sim, a, speed)) {
        // farming slowly raises maxFood of the tile toward an agri ceiling
        const boost = 0.25 * a.skills.farm * P.techSpeed;
        w.maxFood[ti] = Math.min(w.maxFood[ti] + boost, 140 * w.fertility[ti] + 30);
        w.food[ti] = Math.min(w.food[ti] + boost * 2, w.maxFood[ti]);
        if (home) { home.farmedTiles.add(ti); }
        if (a.stateT % 10 === 0) { a.inv.food += 1.5; reinforce(a, 'farm', 0.6); }
      }
      break;
    }
    case 'returningHome': {
      if (move(sim, a, speed) && home) {
        // deposit surplus into communal storage → settlements accumulate food
        const deposit = Math.max(0, a.inv.food - 4);
        home.foodStore += deposit; a.inv.food -= deposit;
        home.woodStore += a.inv.wood; a.inv.wood = 0;
        home.stoneStore += a.inv.stone; a.inv.stone = 0;
        decide(sim, a);
      }
      break;
    }
    case 'building': {
      if (move(sim, a, speed) && home) {
        sim.contributeBuild(home, a);
        if (a.stateT > 14) decide(sim, a);
      }
      break;
    }
    case 'exploring': case 'migrating': {
      const arrived = move(sim, a, speed);
      // explorers pick up wood/stone they pass over
      if (w.wood[ti] > 2 && a.inv.wood < 6) { w.wood[ti] -= 0.4; a.inv.wood += 0.4; }
      if (w.stone[ti] > 2 && a.inv.stone < 6) { w.stone[ti] -= 0.3; a.inv.stone += 0.3; }
      if (arrived) {
        if (a.state === 'migrating') {
          // migration success = found somewhere better than where we started
          reinforce(a, 'explore', w.food[ti] > 20 ? 0.5 : -0.2);
          if (home && dist2(a.x, a.y, home.x, home.y) > 400) { a.home = -1; } // left for good
          sim.maybeFound(a); // homeless migrants may found new settlements
        }
        decide(sim, a);
      }
      break;
    }
    case 'socializing': {
      if (move(sim, a, speed)) {
        const ids = nearbyAgents(sim, a.x, a.y, 1);
        for (const id of ids) {
          if (id === a.id) continue;
          const b = sim.agentById.get(id);
          if (!b || b.dead) continue;
          // positive interaction builds mutual trust; empathy amplifies
          const warmth = 0.05 + a.empathy * 0.05;
          remember(a, 'shared stories', b, warmth);
          remember(b, 'shared stories', a, warmth);
          // pair-bond if both unattached and friendly
          if (a.partner < 0 && b.partner < 0 && (a.rel.get(b.id) || 0) > 0.35 &&
              a.age > 15 && a.age < 50 && b.age > 15 && b.age < 50) {
            a.partner = b.id; b.partner = a.id;
            remember(a, 'found a partner', b, 0.3);
          }
          break;
        }
        if (a.stateT > 8) decide(sim, a);
      }
      break;
    }
    case 'trading': {
      if (move(sim, a, speed) && home) {
        // simple market trade: convert surplus food into wealth
        if (a.inv.food > 5) {
          const sold = a.inv.food - 4;
          a.inv.food = 4;
          const gain = sold * 0.4 * (1 + home.buildings.market * 0.15);
          a.inv.wealth += gain; home.wealth += gain * 0.3;
          reinforce(a, 'trade', 0.5);
        } else reinforce(a, 'trade', -0.2);
        decide(sim, a);
      }
      break;
    }
    case 'healing': {
      if (move(sim, a, speed) && home) {
        const ids = nearbyAgents(sim, a.x, a.y, 2);
        for (const id of ids) {
          const b = sim.agentById.get(id);
          if (b && b.sick && sim.rand() < a.skills.heal * 0.4) {
            b.sick = false; b.health = clamp(b.health + 8, 0, 100);
            remember(b, 'was healed', a, 0.25);
            home.wealth += 0.2;
          }
        }
        if (a.stateT > 10) decide(sim, a);
      }
      break;
    }
    case 'fighting': {
      // find nearest enemy (hostile relation or foreign settlement at war)
      const ids = nearbyAgents(sim, a.x, a.y, 2);
      let target = null, bestD = 99;
      for (const id of ids) {
        if (id === a.id) continue;
        const b = sim.agentById.get(id);
        if (!b || b.dead) continue;
        const hostileRel = (a.rel.get(b.id) || 0) < -0.25;
        const atWar = home && b.home >= 0 && b.home !== a.home &&
          (home.relations.get(b.home) || 0) < -0.4;
        if (hostileRel || atWar) {
          const d = dist2(a.x, a.y, b.x, b.y);
          if (d < bestD) { bestD = d; target = b; }
        }
      }
      if (target) {
        setTarget(a, target.x, target.y);
        move(sim, a, speed * 1.2);
        if (bestD < 1.5) resolveCombat(sim, a, target);
      } else decide(sim, a);
      break;
    }
    case 'fleeing': if (move(sim, a, speed)) decide(sim, a); break;
    case 'resting': if (a.energy > 85) decide(sim, a); break;
    default: if (a.stateT > 6) decide(sim, a); break;
  }

  // ---- ambient danger: wilderness can hurt lone agents ----
  if (sim.tick % 8 === 0 && w.danger[ti] > 0.4 && sim.rand() < w.danger[ti] * 0.02) {
    a.health -= 6 + sim.rand() * 8;
    a.fear = clamp(a.fear + 40, 0, 100);
    a.threatX = a.x + (sim.rand() - 0.5) * 2; a.threatY = a.y + (sim.rand() - 0.5) * 2;
    remember(a, 'attacked by predators');
  }

  // ---- group dynamics for the homeless: found or join settlements ----
  if (a.home < 0 && (sim.tick + a.id) % 30 === 0) {
    // try founding on good land (emergent villages even without migration)
    sim.maybeFound(a);
    // or join a nearby settlement if it'll have us (sociability-gated)
    if (a.home < 0 && a.sociability > 0.3) {
      for (const s of sim.settlements) {
        if (s.dead) continue;
        if (dist2(a.x, a.y, s.x, s.y) < 64 && s.members < 25 + s.buildings.huts * 10) {
          a.home = s.id;
          remember(a, `joined ${s.name}`);
          break;
        }
      }
    }
  }
  // agents with low loyalty leave unstable settlements (leave group)
  if (home && home.stability < 0.25 && (sim.tick + a.id) % 45 === 0 &&
      sim.rand() < 0.2 * (1 - a.sociability)) {
    remember(a, `abandoned ${home.name}`);
    a.home = -1;
    setState(sim, a, 'migrating');
  }

  // ---- nomad reproduction (settlement births are handled by settlements) ---
  if (a.home < 0 && a.age > 16 && a.age < 45 && a.health > 55 && a.hunger < 55 &&
      sim.rand() < 0.0025 * a.fertility * (a.partner >= 0 ? 1.7 : 0.7)) {
    const baby = sim.spawnBaby(a.x, a.y, -1);
    if (baby) { remember(a, 'a child was born'); a.inv.food = Math.max(0, a.inv.food - 2); }
  }

  // ---- auto-deposit surplus when passing near home ----
  if (home && a.inv.food > 6 && dist2(a.x, a.y, home.x, home.y) < 6) {
    home.foodStore += a.inv.food - 4;
    a.inv.food = 4;
  }

  // ---- migration trail (sampled, short) ----
  if (sim.tick % 4 === 0) {
    a.trail.push(a.x, a.y);
    if (a.trail.length > 16) a.trail.splice(0, 2);
  }
}

/** Melee resolution between two agents. Winner may loot; both remember it. */
function resolveCombat(sim, a, b) {
  const pa = a.skills.fight * (0.5 + a.health / 150) * (1 + a.aggression);
  const pb = b.skills.fight * (0.5 + b.health / 150) * (1 + b.aggression);
  const dmgToB = 6 + pa * 14 * sim.rand();
  const dmgToA = 4 + pb * 12 * sim.rand();
  b.health -= dmgToB; a.health -= dmgToA;
  b.fear = clamp(b.fear + 35, 0, 100);
  b.threatX = a.x; b.threatY = a.y;
  remember(a, 'fought', b, -0.3);
  remember(b, 'was attacked', a, -0.5);
  sim.flashes.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ttl: 20, kind: 'fight' });
  if (b.health <= 0) {
    a.kills++;
    a.inv.food += b.inv.food * 0.7; a.inv.wealth += b.inv.wealth * 0.7;
    reinforce(a, 'raid', 0.8);
    sim.killAgent(b, 'violence');
  } else if (a.health < 30) {
    reinforce(a, 'raid', -0.6);
    a.fear = 80; setState(sim, a, 'fleeing');
  }
}
