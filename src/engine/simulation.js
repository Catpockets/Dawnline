// ---------------------------------------------------------------------------
// Simulation engine: the orchestrator. Owns the world, all agents and
// settlements, and runs the tick pipeline:
//   climate → resource regen → spatial index → agents → settlements →
//   diplomacy/trade/war → disease → disasters → history sampling.
// Deliberately kept outside React: the UI only reads snapshots from it.
// ---------------------------------------------------------------------------
import { mulberry32, hashSeed, clamp, dist2, pick } from './rng.js';
import { generateWorld, TERRAIN, tileIndex, walkable, findBestTile } from './world.js';
import { createAgent, updateAgent, nearbyAgents, remember, TICKS_PER_YEAR } from './agents.js';
import {
  createSettlement, updateSettlement, contributeBuild as buildContribute,
  cultureShift, dominantCulture, classifySettlement
} from './settlements.js';

export const DEFAULT_PARAMS = {
  seed: 'genesis-42',
  worldW: 112, worldH: 72,
  startPop: 260,
  resourceAbundance: 1.0,   // 0.4 .. 2
  aggression: 1.0,          // 0 .. 2.5  (global multiplier)
  climateVolatility: 1.0,   // 0 .. 3
  diseaseSeverity: 1.0,     // 0 .. 3
  techSpeed: 1.0,           // 0.2 .. 3
  tradeFriendliness: 1.0,   // 0 .. 2.5
  disasterFrequency: 1.0    // 0 .. 3
};

const HISTORY_CAP = 460;   // samples kept per series
const SAMPLE_EVERY = 6;    // ticks between history samples

export class Simulation {
  constructor(params = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    const seed = hashSeed(this.params.seed);
    this.rand = mulberry32(seed ^ 0xc0ffee);
    this.world = generateWorld(this.params.worldW, this.params.worldH, seed, this.params.resourceAbundance);

    this.tick = 0;
    this.agents = [];
    this.agentById = new Map();
    this.settlements = [];
    this.settlementById = new Map();
    this.grid = new Map();          // tileIndex -> [agentId,...] spatial hash
    this.nextAgentId = 1;
    this.nextSetId = 1;
    this.events = [];               // rolling event log for the UI
    this.flashes = [];              // transient visual markers (fights, disasters)
    this.routes = new Map();        // "aId-bId" -> {a, b, strength}
    this.climate = { tempOffset: 0 };
    this.totals = { births: 0, deaths: 0, deathsWindow: 0 };
    this.stats = {};
    this.history = {
      pop: [], food: [], settlements: [], conflicts: [], disease: [],
      tech: [], inequality: [], deaths: []
    };

    this.spawnInitialPopulation();
    this.sampleHistory();
  }

  // ---- population seeding: small bands dropped on liveable coastal land ----
  spawnInitialPopulation() {
    const w = this.world;
    const bands = Math.max(3, Math.round(this.params.startPop / 45));
    const spots = [];
    for (let tries = 0; tries < 900 && spots.length < bands; tries++) {
      const x = 2 + this.rand() * (w.w - 4), y = 2 + this.rand() * (w.h - 4);
      const i = tileIndex(w, x, y);
      if (walkable(w, x, y) && w.fertility[i] > 0.35 && w.water[i] > 35) {
        if (spots.every(s => dist2(s[0], s[1], x, y) > 90)) spots.push([x, y]);
      }
    }
    if (spots.length === 0) spots.push([w.w / 2, w.h / 2]);
    for (let n = 0; n < this.params.startPop; n++) {
      const [sx, sy] = spots[n % spots.length];
      let x = sx + (this.rand() - 0.5) * 7, y = sy + (this.rand() - 0.5) * 7;
      if (!walkable(w, x, y)) { x = sx; y = sy; }
      this.addAgent(createAgent(this, x, y));
    }
  }

  addAgent(a) { this.agents.push(a); this.agentById.set(a.id, a); }

  /** Spawn a newborn (used by nomad + settlement reproduction). */
  spawnBaby(x, y, home) {
    const baby = createAgent(this, x, y, { age: 0, home });
    baby.inv.food = 0;
    this.addAgent(baby);
    this.totals.births++;
    return baby;
  }

  killAgent(a, cause) {
    if (a.dead) return;
    a.dead = true;
    this.agentById.delete(a.id);
    this.totals.deaths++;
    this.totals.deathsWindow++;
    if (a.partner >= 0) {
      const p = this.agentById.get(a.partner);
      if (p) { p.partner = -1; remember(p, 'lost a partner'); }
    }
    if (cause === 'violence' || cause === 'raid') {
      this.world.danger[tileIndex(this.world, a.x, a.y)] =
        clamp(this.world.danger[tileIndex(this.world, a.x, a.y)] + 0.05, 0, 1);
    }
  }

  addEvent(text, kind = 'info') {
    this.events.push({ tick: this.tick, year: (this.tick / TICKS_PER_YEAR) | 0, text, kind });
    if (this.events.length > 40) this.events.shift();
  }

  contributeBuild(s, agent) { buildContribute(this, s, agent); }

  // ---- settlement founding: emergent, triggered by migrating homeless agents
  maybeFound(a) {
    if (a.home >= 0) return;
    const w = this.world;
    const i = tileIndex(w, a.x, a.y);
    if (w.fertility[i] < 0.38 || w.water[i] < 30 || w.food[i] < 12) return;
    // not too close to an existing settlement
    for (const s of this.settlements) {
      if (!s.dead && dist2(s.x, s.y, a.x, a.y) < 140) return;
    }
    // need a founding band: several homeless agents nearby
    const ids = nearbyAgents(this, a.x, a.y, 4);
    const founders = [];
    for (const id of ids) {
      const b = this.agentById.get(id);
      if (b && !b.dead && b.home < 0) founders.push(b);
    }
    if (founders.length < 3) return;
    const s = createSettlement(this, a.x, a.y, founders.map(f => f.id));
    this.settlements.push(s);
    this.settlementById.set(s.id, s);
    for (const f of founders) { f.home = s.id; remember(f, `helped found ${s.name}`); }
    this.addEvent(`${s.name} founded (${founders.length} settlers)`, 'good');
  }

  collapseSettlement(s) {
    this.addEvent(`${s.name} has COLLAPSED — survivors scatter`, 'bad');
    const w = this.world;
    for (const a of this.agents) {
      if (a.dead || a.home !== s.id) continue;
      a.home = -1;
      a.fear = 70;
      remember(a, `${s.name} collapsed`);
      if (this.rand() < 0.12) this.killAgent(a, 'collapse'); // chaos casualties
      else { a.state = 'migrating'; a.stateT = 0; a.hasTarget = false; }
    }
    w.danger[tileIndex(w, s.x, s.y)] = clamp(w.danger[tileIndex(w, s.x, s.y)] + 0.25, 0, 1);
    this.removeSettlement(s);
  }

  dissolveSettlement(s, why) {
    this.addEvent(`${s.name} ${why}`, 'bad');
    this.removeSettlement(s);
  }

  removeSettlement(s) {
    s.dead = true;
    this.settlementById.delete(s.id);
    // drop routes touching it
    for (const key of [...this.routes.keys()]) {
      const r = this.routes.get(key);
      if (r.a === s.id || r.b === s.id) this.routes.delete(key);
    }
    for (const o of this.settlements) { o.relations.delete(s.id); o.tradePartners.delete(s.id); }
  }

  // =========================================================================
  // MAIN TICK
  // =========================================================================
  tickOnce() {
    this.tick++;
    this.updateClimate();
    if (this.tick % 2 === 0) this.regenResources();
    this.rebuildGrid();

    // agents (the hot loop)
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.dead) updateAgent(this, a);
    }
    // compact the dead out of the array occasionally (cheap swap-filter)
    if (this.tick % 20 === 0) this.agents = this.agents.filter(a => !a.dead);

    // settlements: staggered so not all update on the same tick
    this.recountMembers();
    for (const s of this.settlements) {
      if (!s.dead && (this.tick + s.id) % 3 === 0) updateSettlement(this, s);
    }
    if (this.tick % 20 === 0) this.settlements = this.settlements.filter(s => !s.dead);

    if (this.tick % 25 === 0) this.updateTradeAndDiplomacy();
    if (this.tick % 30 === 5) this.updateWar();
    if (this.tick % 12 === 0) this.updateDisease();
    this.maybeDisaster();

    // fade transient visuals
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      if (--this.flashes[i].ttl <= 0) this.flashes.splice(i, 1);
    }
    if (this.tick % SAMPLE_EVERY === 0) this.sampleHistory();
  }

  // ---- climate: slow warming + volatility oscillation ----
  updateClimate() {
    const P = this.params;
    const c = this.climate;
    c.tempOffset += 0.000012 * P.climateVolatility;                       // creeping change
    c.tempOffset += (this.rand() - 0.5) * 0.0006 * P.climateVolatility;   // noise
    c.tempOffset = clamp(c.tempOffset, -0.2, 0.4);
  }

  // ---- resources regrow toward maxFood, modulated by climate stress ----
  regenResources() {
    const w = this.world;
    const off = this.climate.tempOffset;
    for (let i = 0; i < w.food.length; i++) {
      const mf = w.maxFood[i];
      if (w.food[i] >= mf) continue;
      // climate stress: tiles pushed away from a temperate optimum regen slower
      const stress = Math.abs(w.temp[i] + off - 0.55);
      const rate = 0.10 * (0.3 + w.fertility[i]) * clamp(1.15 - stress * 1.3, 0.1, 1.2);
      w.food[i] = Math.min(mf, w.food[i] + rate);
      if (w.wood[i] < 60) w.wood[i] += 0.008;
    }
  }

  rebuildGrid() {
    this.grid.clear();
    const w = this.world.w;
    for (const a of this.agents) {
      if (a.dead) continue;
      const key = (a.y | 0) * w + (a.x | 0);
      let bucket = this.grid.get(key);
      if (!bucket) { bucket = []; this.grid.set(key, bucket); }
      bucket.push(a.id);
    }
  }

  recountMembers() {
    for (const s of this.settlements) { s.members = 0; s.sickCount = 0; s.avgWealth = 0; }
    for (const a of this.agents) {
      if (a.dead || a.home < 0) continue;
      const s = this.settlementById.get(a.home);
      if (!s) { a.home = -1; continue; }
      s.members++;
      if (a.sick) s.sickCount++;
      s.avgWealth += a.inv.wealth;
    }
    for (const s of this.settlements) if (s.members > 0) s.avgWealth /= s.members;
  }

  // ---- trade routes + relations drift (the diplomacy layer) ----
  updateTradeAndDiplomacy() {
    const P = this.params;
    const live = this.settlements.filter(s => !s.dead);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const A = live[i], B = live[j];
        const d = Math.sqrt(dist2(A.x, A.y, B.x, B.y));
        if (d > 55) continue;
        const rel = A.relations.get(B.id) || 0;

        // --- trade formation: commercial cultures + friendliness param ---
        const tradeDrive = (A.culture.commercial + B.culture.commercial) / 2 *
          P.tradeFriendliness * (rel > -0.2 ? 1 : 0);
        const key = A.id < B.id ? `${A.id}-${B.id}` : `${B.id}-${A.id}`;
        let route = this.routes.get(key);
        if (tradeDrive > 0.28 && d < 48) {
          if (!route) {
            route = { a: A.id, b: B.id, strength: 0.1 };
            this.routes.set(key, route);
            A.tradePartners.add(B.id); B.tradePartners.add(A.id);
            this.addEvent(`Trade opens: ${A.name} ↔ ${B.name}`, 'good');
          }
          route.strength = clamp(route.strength + 0.06, 0, 1);
          // exchange: food flows to the hungrier side, wealth flows back
          const donor = A.foodStore / (A.members + 1) > B.foodStore / (B.members + 1) ? A : B;
          const taker = donor === A ? B : A;
          const flow = Math.min(donor.foodStore * 0.06, 12) * route.strength;
          donor.foodStore -= flow; taker.foodStore += flow;
          donor.wealth += flow * 0.5; taker.wealth = Math.max(0, taker.wealth - flow * 0.3);
          // trading improves relations
          const nr = clamp(rel + 0.03, -1, 1);
          A.relations.set(B.id, nr); B.relations.set(A.id, nr);
        } else if (route) {
          route.strength -= 0.05;
          if (route.strength <= 0.03) {
            this.routes.delete(key);
            A.tradePartners.delete(B.id); B.tradePartners.delete(A.id);
          }
        }

        // --- relations drift: proximity + culture friction ---
        let drift = -rel * 0.01; // decay toward neutral
        const friction = (A.culture.expansionist + B.culture.expansionist) * 0.5;
        if (d < 20 && friction > 0.5) drift -= 0.02 * P.aggression;      // border tension
        if (A.culture.peaceful > 0.55 && B.culture.peaceful > 0.55) drift += 0.015;
        const nr = clamp(rel + drift, -1, 1);
        A.relations.set(B.id, nr); B.relations.set(A.id, nr);

        // --- alliance: strong friendship → mutual aid during famine ---
        if (nr > 0.6) {
          if (A.famineT > 20 && B.foodStore > B.members * 3) { B.foodStore -= 15; A.foodStore += 15; }
          if (B.famineT > 20 && A.foodStore > A.members * 3) { A.foodStore -= 15; B.foodStore += 15; }
        }
      }
    }
  }

  // ---- settlement-scale raids/war (abstracted; agent fights are separate) --
  updateWar() {
    const P = this.params;
    const live = this.settlements.filter(s => !s.dead && s.members > 4);
    for (const s of live) {
      const warDrive = (s.culture.militaristic * 0.7 + (s.famineT > 25 ? 0.45 : 0) +
        s.culture.expansionist * 0.25) * P.aggression;
      if (warDrive < 0.5 || this.rand() > warDrive * 0.35) continue;
      if (this.tick - s.lastRaid < 90) continue;

      // choose the weakest disliked neighbour
      let target = null, bestScore = 0;
      for (const t of live) {
        if (t.id === s.id) continue;
        const d = Math.sqrt(dist2(s.x, s.y, t.x, t.y));
        if (d > 45) continue;
        const rel = s.relations.get(t.id) || 0;
        if (rel > 0.25) continue; // won't raid friends
        const score = (1 - rel) * (t.foodStore + t.wealth) / (1 + t.defense * 3) / (5 + d);
        if (score > bestScore) { bestScore = score; target = t; }
      }
      if (!target) continue;

      s.lastRaid = this.tick;
      target.lastRaid = this.tick;
      const atk = s.members * (0.4 + s.culture.militaristic) * (0.8 + this.rand() * 0.4);
      const def = target.members * (0.5 + target.defense * 1.6) * (0.8 + this.rand() * 0.4);
      const win = atk > def;
      this.flashes.push({ x: target.x, y: target.y, ttl: 45, kind: 'war' });
      this.addEvent(`${s.name} raids ${target.name}${win ? ' — sacked!' : ' — repelled'}`, 'war');

      // casualties on both sides, heavier for the loser
      this.raidCasualties(s, win ? 0.04 : 0.1);
      this.raidCasualties(target, win ? 0.12 : 0.05);
      if (win) {
        const loot = target.foodStore * 0.4, gold = target.wealth * 0.35;
        target.foodStore -= loot; s.foodStore += loot;
        target.wealth -= gold; s.wealth += gold;
        target.stability -= 0.15;
        cultureShift(s, 'militaristic', 0.05);
        cultureShift(target, 'militaristic', 0.06); // victims militarise too
      } else {
        s.stability -= 0.08;
        cultureShift(s, 'peaceful', 0.04); // failed war sours the public
      }
      const rel = clamp((s.relations.get(target.id) || 0) - 0.35, -1, 1);
      s.relations.set(target.id, rel); target.relations.set(s.id, rel);
      // fear ripples through the target's population
      for (const a of this.agents) {
        if (!a.dead && a.home === target.id) {
          a.fear = clamp(a.fear + 45, 0, 100);
          a.threatX = s.x; a.threatY = s.y;
        }
      }
    }
  }

  raidCasualties(s, frac) {
    for (const a of this.agents) {
      if (!a.dead && a.home === s.id && this.rand() < frac) this.killAgent(a, 'raid');
    }
  }

  // ---- disease: outbreaks seeded by tile risk + density, spread by contact --
  updateDisease() {
    const P = this.params;
    const w = this.world;
    // new outbreaks in crowded, high-risk settlements
    for (const s of this.settlements) {
      if (s.dead || s.members < 6) continue;
      const risk = w.disease[tileIndex(w, s.x, s.y)] *
        clamp(s.members / 40, 0.2, 1.6) * 0.02 * P.diseaseSeverity;
      if (this.rand() < risk) {
        let seeded = false;
        for (const a of this.agents) {
          if (!a.dead && a.home === s.id && !a.sick && this.rand() < 0.3) {
            a.sick = true; seeded = true;
            if (this.rand() < 0.5) break;
          }
        }
        if (seeded && s.sickCount < 2) this.addEvent(`Sickness spreads in ${s.name}`, 'bad');
      }
    }
    // contact spread via the spatial grid
    for (const a of this.agents) {
      if (a.dead || !a.sick) continue;
      const ids = nearbyAgents(this, a.x, a.y, 1);
      for (const id of ids) {
        const b = this.agentById.get(id);
        if (b && !b.sick && !b.dead &&
            this.rand() < 0.05 * P.diseaseSeverity * (1 - b.immunity)) {
          b.sick = true;
        }
      }
    }
  }

  // ---- disasters: random draws + manual triggers from the UI ----
  maybeDisaster() {
    if (this.rand() < 0.0011 * this.params.disasterFrequency) {
      const kind = pick(this.rand, ['drought', 'flood', 'earthquake', 'wildfire', 'plague']);
      this.spawnDisaster(kind);
    }
  }

  /** Trigger a disaster (also called from UI buttons). */
  spawnDisaster(kind, atX, atY) {
    const w = this.world;
    // default location: near a random settlement, else random land
    let x = atX, y = atY;
    if (x === undefined) {
      const live = this.settlements.filter(s => !s.dead);
      if (live.length && this.rand() < 0.75) { const s = pick(this.rand, live); x = s.x; y = s.y; }
      else { x = this.rand() * w.w; y = this.rand() * w.h; }
    }
    const R = kind === 'drought' ? 16 : kind === 'wildfire' ? 11 : 9;
    this.flashes.push({ x, y, ttl: 90, kind: 'disaster', label: kind, r: R });
    this.addEvent(`⚠ ${kind.toUpperCase()} strikes near (${x | 0},${y | 0})`, 'disaster');

    const inRange = (i) => {
      const tx = i % w.w, ty = (i / w.w) | 0;
      return dist2(tx, ty, x, y) < R * R;
    };
    for (let i = 0; i < w.food.length; i++) {
      if (!inRange(i)) continue;
      switch (kind) {
        case 'drought':
          w.food[i] *= 0.35; w.maxFood[i] *= 0.85; w.water[i] = Math.max(0, w.water[i] - 30);
          break;
        case 'flood':
          if (w.water[i] > 40) { w.food[i] *= 0.45; w.danger[i] = clamp(w.danger[i] + 0.1, 0, 1); }
          break;
        case 'wildfire':
          if (w.terrain[i] === TERRAIN.FOREST) { w.food[i] *= 0.2; w.wood[i] *= 0.25; }
          break;
        case 'earthquake':
          w.danger[i] = clamp(w.danger[i] + 0.15, 0, 1);
          break;
        default: break;
      }
    }
    // direct effects on people & settlements in range
    for (const s of this.settlements) {
      if (s.dead || dist2(s.x, s.y, x, y) > R * R) continue;
      if (kind === 'earthquake') {
        for (const k of Object.keys(s.buildings)) {
          s.buildings[k] = Math.max(0, s.buildings[k] - (this.rand() < 0.4 ? 1 : 0));
        }
        s.stability -= 0.12;
      }
      if (kind === 'plague') {
        for (const a of this.agents) {
          if (!a.dead && a.home === s.id && this.rand() < 0.5) a.sick = true;
        }
      }
      if (kind === 'drought') s.stability -= 0.06;
      cultureShift(s, 'religious', 0.06); // catastrophe breeds faith
    }
    if (kind !== 'plague') {
      for (const a of this.agents) {
        if (!a.dead && dist2(a.x, a.y, x, y) < R * R) {
          a.fear = clamp(a.fear + 50, 0, 100);
          if (kind !== 'drought' && this.rand() < 0.06) a.health -= 25 + this.rand() * 25;
        }
      }
    }
  }

  /** UI: global drought — climate stress everywhere, water tables drop. */
  forceDrought() {
    const w = this.world;
    this.climate.tempOffset = clamp(this.climate.tempOffset + 0.08, -0.2, 0.4);
    for (let i = 0; i < w.food.length; i++) {
      w.food[i] *= 0.5;
      w.water[i] = Math.max(0, w.water[i] - 18);
    }
    this.addEvent('⚠ CONTINENTAL DROUGHT — food and water crash', 'disaster');
  }

  /** UI: rain of plenty — resources surge back. */
  addResources() {
    const w = this.world;
    for (let i = 0; i < w.food.length; i++) {
      w.food[i] = Math.min(w.maxFood[i] * 1.1, w.food[i] + w.maxFood[i] * 0.6);
      w.water[i] = Math.min(100, w.water[i] + 15);
    }
    for (const s of this.settlements) if (!s.dead) s.foodStore += 25;
    this.addEvent('✦ A season of plenty — resources surge', 'good');
  }

  /** UI: migration pressure — degrade a populated region so people move. */
  triggerMigrationPressure() {
    const live = this.settlements.filter(s => !s.dead);
    const w = this.world;
    let x, y;
    if (live.length) { const s = pick(this.rand, live); x = s.x; y = s.y; }
    else { x = w.w / 2; y = w.h / 2; }
    for (let i = 0; i < w.food.length; i++) {
      const tx = i % w.w, ty = (i / w.w) | 0;
      if (dist2(tx, ty, x, y) < 300) {
        w.food[i] *= 0.3; w.maxFood[i] *= 0.75;
        w.danger[i] = clamp(w.danger[i] + 0.2, 0, 1);
      }
    }
    for (const a of this.agents) {
      if (!a.dead && dist2(a.x, a.y, x, y) < 300) {
        a.fear = clamp(a.fear + 30, 0, 100);
        if (this.rand() < 0.5) { a.state = 'migrating'; a.stateT = 0; a.hasTarget = false; }
      }
    }
    this.addEvent('⚠ Migration pressure — a region turns hostile', 'disaster');
  }

  // =========================================================================
  // ANALYTICS: aggregate stats + time series (sampled, not per-tick)
  // =========================================================================
  sampleHistory() {
    const H = this.history;
    const live = this.settlements.filter(s => !s.dead);
    let pop = 0, hSum = 0, huSum = 0, sick = 0, food = 0, techSum = 0;
    for (const a of this.agents) {
      if (a.dead) continue;
      pop++; hSum += a.health; huSum += a.hunger; food += a.inv.food;
      if (a.sick) sick++;
    }
    for (const s of live) { food += s.foodStore; techSum += s.tech; }
    const avgTech = live.length ? techSum / live.length : 0;
    const conflicts = this.flashes.filter(f => f.kind === 'fight' || f.kind === 'war').length;
    const gini = this.computeGini();

    const push = (arr, v) => { arr.push(v); if (arr.length > HISTORY_CAP) arr.shift(); };
    push(H.pop, pop);
    push(H.food, food);
    push(H.settlements, live.length);
    push(H.conflicts, conflicts);
    push(H.disease, sick);
    push(H.tech, avgTech);
    push(H.inequality, gini);
    push(H.deaths, this.totals.deathsWindow);
    this.totals.deathsWindow = 0;

    // headline stats for the analytics panel
    let richest = null, largest = null, angriest = null;
    for (const s of live) {
      if (!richest || s.wealth > richest.wealth) richest = s;
      if (!largest || s.members > largest.members) largest = s;
      if (!angriest || s.culture.militaristic > angriest.culture.militaristic) angriest = s;
    }
    const collapseRisk = live.length
      ? live.reduce((acc, s) => acc + (1 - s.stability), 0) / live.length
      : 0;

    this.stats = {
      tick: this.tick,
      year: (this.tick / TICKS_PER_YEAR) | 0,
      population: pop,
      births: this.totals.births,
      deaths: this.totals.deaths,
      settlements: live.length,
      avgHealth: pop ? hSum / pop : 0,
      avgHunger: pop ? huSum / pop : 0,
      totalFood: food,
      conflicts,
      tradeRoutes: this.routes.size,
      avgTech,
      diseaseCases: sick,
      richest: richest ? `${richest.name} (${richest.wealth | 0})` : '—',
      largest: largest ? `${largest.name} (${largest.members})` : '—',
      mostAggressive: angriest ? `${angriest.name}` : '—',
      collapseRisk,
      inequality: gini,
      tempOffset: this.climate.tempOffset
    };
  }

  /** Gini coefficient over a sample of agent wealth (inequality metric). */
  computeGini() {
    const sample = [];
    const step = Math.max(1, (this.agents.length / 200) | 0);
    for (let i = 0; i < this.agents.length; i += step) {
      const a = this.agents[i];
      if (!a.dead) sample.push(a.inv.wealth);
    }
    if (sample.length < 4) return 0;
    sample.sort((a, b) => a - b);
    let cum = 0, weighted = 0;
    for (let i = 0; i < sample.length; i++) { cum += sample[i]; weighted += cum; }
    if (cum <= 0) return 0;
    const n = sample.length;
    return clamp((n + 1 - 2 * (weighted / cum)) / n, 0, 1);
  }
}
