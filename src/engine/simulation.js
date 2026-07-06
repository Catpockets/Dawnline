// ---------------------------------------------------------------------------
// Simulation engine: the orchestrator. Owns the world, all agents and
// settlements, and runs the tick pipeline:
//   climate → resource regen → spatial index → agents → settlements →
//   diplomacy/trade/war → disease → disasters → history sampling.
// Deliberately kept outside React: the UI only reads snapshots from it.
// ---------------------------------------------------------------------------
import { mulberry32, hashSeed, clamp, dist2, pick } from './rng.js';
import { generateWorld, TERRAIN, tileIndex, walkable, findBestTile, travelCost } from './world.js';
import { createAgent, updateAgent, nearbyAgents, remember, TICKS_PER_YEAR } from './agents.js';
import {
  createSettlement, updateSettlement, contributeBuild as buildContribute,
  cultureShift, dominantCulture, classifySettlement
} from './settlements.js';
import { createIdeology, ideologyConflict, tryConvert } from './ideologies.js';
import { learnReward } from './learning.js';


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
const RUIN_CAP = 80;

const DOWNFALLS = {
  abandoned: { label: 'Abandoned', color: '#cbd5e1' },
  famine: { label: 'Famine', color: '#facc15' },
  disease: { label: 'Disease', color: '#a3e635' },
  plague: { label: 'Plague', color: '#a3e635' },
  war: { label: 'War', color: '#fb923c' },
  drought: { label: 'Drought', color: '#fde047' },
  flood: { label: 'Flood', color: '#38bdf8' },
  earthquake: { label: 'Quake', color: '#e2e8f0' },
  wildfire: { label: 'Wildfire', color: '#fb7185' },
  migration: { label: 'Migration', color: '#fbbf24' },
  overextension: { label: 'Overextension', color: '#f59e0b' },
  inequality: { label: 'Inequality', color: '#c084fc' },
  isolation: { label: 'Isolation', color: '#94a3b8' },
  resources: { label: 'Resource depletion', color: '#a8a29e' },
  governance: { label: 'Governance crisis', color: '#f472b6' },
  unrest: { label: 'Unrest', color: '#f87171' },
  collapse: { label: 'Collapse', color: '#e2e8f0' }
};

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
    this.ruins = [];                // persistent markers for fallen settlements
    this.graves = [];               // clickable tombstones for dead agents
    this.nextGraveId = 1;
    this.milestones = [];           // timeline milestones (icon + summary)
    this.globalDiscoveries = new Set(); // first-in-the-world tech tracking
    this.routes = new Map();        // "aId-bId" -> {a, b, strength}
    this.tradeMap = new Float32Array(this.world.w * this.world.h);
    this.migrationMap = new Float32Array(this.world.w * this.world.h);
    // stigmergy signal fields: agents deposit, decay+diffuse staggered
    this.foodSignal = new Float32Array(this.world.w * this.world.h);
    this.dangerSignal = new Float32Array(this.world.w * this.world.h);
    this._signalScratch = new Float32Array(this.world.w * this.world.h);
    // ideology registry (deterministically generated on demand)
    this.ideologies = [];
    this.ideologyById = new Map();
    this.nextIdeologyId = 1;
    this.nextFamilyId = 1;
    this.debugAgentId = -1; // inspector target for AI-explain capture
    this.climate = { tempOffset: 0 };
    this.totals = { births: 0, deaths: 0, deathsWindow: 0, marriages: 0, colonies: 0, conversions: 0, rewardSum: 0, rewardCount: 0 };
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
    // bootstrap marriages between nearby opposite-sex adults so family
    // formation (and thus births) starts immediately
    const singles = this.agents.filter(a => a.age > 16 && a.age < 45);
    for (let i = 0; i < singles.length; i++) {
      const A = singles[i];
      if (A.spouse >= 0) continue;
      const jEnd = Math.min(singles.length, i + 200);
      for (let j = i + 1; j < jEnd; j++) {
        const B = singles[j];
        if (B.spouse >= 0 || B.sex === A.sex) continue;
        if (dist2(A.x, A.y, B.x, B.y) < 100 && this.rand() < 0.7) {
          A.spouse = B.id; B.spouse = A.id;
          break;
        }
      }
    }
  }

  addAgent(a) { this.agents.push(a); this.agentById.set(a.id, a); }

  /** A pregnant mother delivers. Child inherits the family surname. */
  giveBirth(mom) {
    mom.pregnant = false;
    mom.pregT = 0;
    mom.health = clamp(mom.health - 6, 1, 100);
    mom.energy = clamp(mom.energy - 25, 0, 100);
    const father = mom.spouse >= 0 ? this.agentById.get(mom.spouse) : null;
    const baby = createAgent(this, mom.x, mom.y, {
      age: 0,
      home: mom.home,
      mother: mom.id,
      father: father ? father.id : mom.spouse,
      lastName: father ? father.lastName : mom.lastName,
      familyId: father ? father.familyId : mom.familyId
    });
    baby.inv.food = 0;
    // partial personality inheritance with mutation
    const mix = (trait) => {
      const mv = mom[trait], fv = father ? father[trait] : mv;
      baby[trait] = clamp((mv + fv) / 2 + (this.rand() - 0.5) * 0.24, 0, 1);
    };
    for (const t of ['curiosity', 'aggression', 'sociability', 'greed', 'empathy', 'intelligence']) mix(t);
    // skill TENDENCIES inherited weakly; actual ability starts near zero
    for (const k of Object.keys(baby.skills)) {
      const pk = ((mom.skills[k] || 0) + (father ? father.skills[k] || 0 : 0)) / 2;
      baby.skills[k] = clamp(pk * 0.2 + baby.skills[k] * 0.15, 0.02, 0.4);
    }
    // ideology exposure from parents (children usually follow the family creed)
    const creed = mom.ideology != null ? mom.ideology : (father ? father.ideology : null);
    if (creed != null && this.rand() < 0.85) {
      baby.ideology = creed;
      baby.conviction = 0.3 + this.rand() * 0.3;
    }
    this.addAgent(baby);
    this.totals.births++;
    mom.children.push(baby.id);
    if (father && !father.dead) father.children.push(baby.id);
    remember(mom, `gave birth to ${baby.firstName}`);
    return baby;
  }

  killAgent(a, cause, killer = null) {
    if (a.dead) return;
    a.dead = true;
    this.agentById.delete(a.id);
    this.totals.deaths++;
    this.totals.deathsWindow++;
    // gravestone: clickable on the map, remembers how they died and by whom
    this.graves.push({
      id: this.nextGraveId++,
      x: a.x, y: a.y,
      name: `${a.firstName} ${a.lastName}`,
      sex: a.sex,
      age: a.age | 0,
      year: (this.tick / TICKS_PER_YEAR) | 0,
      cause,
      killer: killer ? (typeof killer === 'string' ? killer : `${killer.firstName} ${killer.lastName}`) : null,
      tick: this.tick
    });
    if (this.graves.length > 350) this.graves.shift();
    if (a.age < 12) {
      // losing a child is the strongest negative parenting signal
      for (const pid of [a.mother, a.father, a.guardian]) {
        const p = pid >= 0 ? this.agentById.get(pid) : null;
        if (p && !p.dead) learnReward(this, p, 'parenting', -1.4);
      }
      const dti = tileIndex(this.world, a.x, a.y);
      this.dangerSignal[dti] = Math.min(6, this.dangerSignal[dti] + 2);
    }
    if (a.spouse >= 0) {
      const p = this.agentById.get(a.spouse);
      if (p) { p.spouse = -1; remember(p, `mourned ${a.firstName}`); }
    }
    if (cause === 'violence' || cause === 'raid') {
      this.world.danger[tileIndex(this.world, a.x, a.y)] =
        clamp(this.world.danger[tileIndex(this.world, a.x, a.y)] + 0.05, 0, 1);
    }
  }

  addEvent(text, kind = 'info', icon = null) {
    const year = (this.tick / TICKS_PER_YEAR) | 0;
    this.events.push({ tick: this.tick, year, text, kind });
    if (this.events.length > 40) this.events.shift();
    if (icon) {
      this.milestones.push({ tick: this.tick, year, icon, kind, text });
      if (this.milestones.length > 600) this.milestones.shift();
    }
  }

  /** Float an emoji above a map location (wars, pacts, plagues...). */
  iconFlash(x, y, char, ttl = 70) {
    this.flashes.push({ x, y, ttl, ttl0: ttl, kind: 'icon', char });
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
    s.parentSettlementId = null;
    s.originReason = 'exploration';
    s.foundedByAgentId = a.id;
    this.settlements.push(s);
    this.settlementById.set(s.id, s);
    for (const f of founders) { f.home = s.id; remember(f, `helped found ${s.name}`); }
    learnReward(this, a, 'migrating', 1.2); // founding pays off
    // frontier settlements sometimes birth a new creed
    if (this.params.enableIdeology !== false && this.rand() < 0.3) {
      const ideo = createIdeology(this, `${a.firstName} ${a.lastName}`);
      if (ideo) {
        s.foundingIdeologyId = ideo.id;
        for (const f of founders) { f.ideology = ideo.id; f.conviction = 0.6; }
        this.addEvent(`${ideo.name} (${ideo.type}) emerges in ${s.name}`, 'tech', '🕯️');
      }
    }
    this.addEvent(`${s.name} founded (${founders.length} settlers)`, 'good', '🏠');
    this.iconFlash(s.x, s.y, '🏠');
  }

  collapseSettlement(s) {
    const downfall = this.getCollapseDownfall(s);
    this.addEvent(`${s.name} has COLLAPSED — ${downfall.label.toLowerCase()}; survivors scatter`, 'bad', '💥');
    this.iconFlash(s.x, s.y, '💥', 90);
    const w = this.world;
    let refugees = 0, casualties = 0;
    for (const a of this.agents) {
      if (a.dead || a.home !== s.id) continue;
      a.home = -1;
      a.fear = 70;
      a.refugeeCulture = dominantCulture(s);
      a.refugeeFrom = s.name;
      a.refugeeTick = this.tick;
      remember(a, `${s.name} collapsed`);
      if (this.rand() < 0.12) { this.killAgent(a, 'collapse'); casualties++; } // chaos casualties
      else { a.state = 'migrating'; a.stateT = 0; a.hasTarget = false; refugees++; }
    }
    s.lastDisplaced = { refugees, casualties };
    w.danger[tileIndex(w, s.x, s.y)] = clamp(w.danger[tileIndex(w, s.x, s.y)] + 0.25, 0, 1);
    this.removeSettlement(s, downfall.key);
  }

  dissolveSettlement(s, why) {
    this.addEvent(`${s.name} ${why}`, 'bad');
    this.removeSettlement(s, why);
  }

  removeSettlement(s, downfall = 'collapse') {
    if (s.dead) return;
    this.recordRuin(s, downfall);
    s.dead = true;
    this.settlementById.delete(s.id);
    // drop routes touching it
    for (const key of [...this.routes.keys()]) {
      const r = this.routes.get(key);
      if (r.a === s.id || r.b === s.id) this.routes.delete(key);
    }
    this.rebuildTradeMap();
    for (const o of this.settlements) { o.relations.delete(s.id); o.tradePartners.delete(s.id); }
  }

  recordRuin(s, downfall) {
    const info = downfallInfo(downfall);
    this.ruins.push({
      id: s.id,
      name: s.name,
      x: s.x,
      y: s.y,
      year: (this.tick / TICKS_PER_YEAR) | 0,
      cause: info.label,
      icon: '☠',
      color: info.color,
      finalMembers: s.members,
      stability: (s.stability * 100) | 0,
      foodStore: s.foodStore | 0,
      refugees: s.lastDisplaced?.refugees || 0,
      casualties: s.lastDisplaced?.casualties || 0,
      summary: ruinSummary(s, info)
    });
    if (this.ruins.length > RUIN_CAP) this.ruins.shift();
  }

  getCollapseDownfall(s) {
    if (s.lastDisaster && this.tick - s.lastDisaster.tick < 180) return downfallInfo(s.lastDisaster.kind);
    if (s.collapseCause) return downfallInfo(s.collapseCause);
    if (s.famineT > 30 || s.foodStore < Math.max(1, s.members * 0.35)) {
      if (s.tech >= 2 && s.tradePartners.size === 0) return downfallInfo('isolation');
      if (s.tech >= 2) return downfallInfo('resources');
      return downfallInfo('famine');
    }
    if (s.sickCount > Math.max(2, s.members * 0.3)) return downfallInfo('disease');
    if (this.tick - s.lastRaid < 160) return downfallInfo('war');
    return downfallInfo('unrest');
  }

  markSettlementShock(s, kind) {
    s.lastDisaster = { kind, tick: this.tick };
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
    if (this.params.enableIdeology !== false && this.tick % 40 === 11) this.updateIdeologies();
    if (this.params.enableIdeology !== false && this.tick % 200 === 77) this.checkSchisms();
    if (this.params.enableColonies !== false && this.tick % 90 === 33) this.evaluateColonies();
    this.maybeDisaster();
    if (this.tick % 10 === 0) this.fadeMigrationMap();
    if (this.params.enableSignals !== false && this.tick % 6 === 2) this.updateSignals();

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

  rebuildTradeMap() {
    this.tradeMap.fill(0);
    for (const route of this.routes.values()) {
      if (!route.path || route.path.length < 2) continue;
      const strength = 0.35 + route.strength;
      for (let i = 1; i < route.path.length; i++) {
        this.markTravelSegment(this.tradeMap, route.path[i - 1], route.path[i], strength);
      }
    }
  }

  markTravelSegment(map, a, b, amount) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      if (x < 0 || y < 0 || x >= this.world.w || y >= this.world.h) continue;
      const idx = y * this.world.w + x;
      map[idx] = Math.min(8, map[idx] + amount);
    }
  }

  recordMigrationTrail(x, y, amount = 1) {
    const tx = x | 0, ty = y | 0;
    if (tx < 0 || ty < 0 || tx >= this.world.w || ty >= this.world.h) return;
    const idx = ty * this.world.w + tx;
    this.migrationMap[idx] = Math.min(8, this.migrationMap[idx] + amount);
  }

  fadeMigrationMap() {
    for (let i = 0; i < this.migrationMap.length; i++) {
      const v = this.migrationMap[i] * 0.94;
      this.migrationMap[i] = v < 0.03 ? 0 : v;
    }
  }

  // ---- stigmergy: decay + 4-neighbour diffusion, ~every 6 ticks --------
  updateSignals() {
    const w = this.world.w, h = this.world.h;
    for (const field of [this.foodSignal, this.dangerSignal]) {
      const tmp = this._signalScratch;
      for (let i = 0; i < field.length; i++) tmp[i] = field[i];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const v = tmp[i];
          if (v < 0.01 && field[i] < 0.01) { field[i] = 0; continue; }
          const L = x > 0 ? tmp[i - 1] : v, R = x < w - 1 ? tmp[i + 1] : v;
          const U = y > 0 ? tmp[i - w] : v, D = y < h - 1 ? tmp[i + w] : v;
          field[i] = (v + 0.12 * ((L + R + U + D) / 4 - v)) * 0.92;
        }
      }
    }
  }

  // ---- ideology spread: family → spouse → settlement → drift ----------
  updateIdeologies() {
    // cache each settlement's dominant creed (single O(N) pass)
    for (const s of this.settlements) { if (!s.dead) { s.ideologyMix = s.ideologyMix || new Map(); s.ideologyMix.clear(); } }
    for (const a of this.agents) {
      if (a.dead || a.home < 0 || a.ideology == null) continue;
      const s = this.settlementById.get(a.home);
      if (s && s.ideologyMix) s.ideologyMix.set(a.ideology, (s.ideologyMix.get(a.ideology) || 0) + 1);
    }
    for (const I of this.ideologies) I.followers = 0;
    for (const a of this.agents) {
      if (!a.dead && a.ideology != null) {
        const I = this.ideologyById.get(a.ideology);
        if (I) I.followers++;
      }
    }
    for (const s of this.settlements) {
      if (s.dead || !s.ideologyMix) continue;
      let top = null, tn = 0;
      for (const [id, n] of s.ideologyMix) if (n > tn) { tn = n; top = id; }
      s.dominantIdeology = top;
      // creed cohesion steadies a settlement; a split creed frays it
      if (top != null && s.members > 6) {
        const share = tn / s.members;
        if (share > 0.7) s.stability = clamp(s.stability + 0.004, 0, 1);
        else if (share < 0.4 && s.ideologyMix.size > 1) s.stability -= 0.003;
      }
    }
    // conversions (staggered subset each pass)
    let converted = 0;
    for (const a of this.agents) {
      if (a.dead || a.age < 8 || (this.tick + a.id) % 3 !== 0) continue;
      // spouse pulls hardest
      if (a.spouse >= 0) {
        const sp = this.agentById.get(a.spouse);
        if (sp && sp.ideology != null && sp.ideology !== a.ideology) {
          const I = this.ideologyById.get(sp.ideology);
          if (I && tryConvert(this, a, I, 0.5, 0.7)) converted++;
        }
      }
      // then the home settlement's institutions
      if (a.home >= 0) {
        const s = this.settlementById.get(a.home);
        if (s && s.dominantIdeology != null && s.dominantIdeology !== a.ideology) {
          const I = this.ideologyById.get(s.dominantIdeology);
          if (I && tryConvert(this, a, I, 0.28, 0.5)) converted++;
        }
      }
    }
    this.totals.conversions += converted;
  }

  // ---- schism: big, unstable, zealous congregations split -------------
  checkSchisms() {
    for (const s of this.settlements) {
      if (s.dead || s.members < 45 || s.dominantIdeology == null) continue;
      const I = this.ideologyById.get(s.dominantIdeology);
      if (!I || I.zeal < 0.55 || s.stability > 0.45) continue;
      if (this.rand() > 0.3) continue;
      const fork = createIdeology(this, null, I);
      if (!fork) continue;
      let moved = 0;
      for (const a of this.agents) {
        if (!a.dead && a.home === s.id && a.ideology === I.id && this.rand() < 0.35) {
          a.ideology = fork.id; a.conviction = 0.55 + this.rand() * 0.3; moved++;
        }
      }
      if (moved > 3) {
        this.addEvent(`SCHISM in ${s.name}: ${fork.name} splits from ${I.name}`, 'bad', '🕯️');
        this.iconFlash(s.x, s.y, '🕯️', 80);
      }
    }
  }

  // ---- colony founding: overcrowded cities send out whole families ----
  evaluateColonies() {
    const w = this.world;
    for (const s of this.settlements) {
      if (s.dead || s.members < 42) continue;
      const cap = Math.max(20, s.infraCap || 40);
      const pressure = s.members / cap + (s.famineT > 25 ? 0.35 : 0) + (1 - s.stability) * 0.3;
      if (pressure < 1.18 || this.rand() > (pressure - 1.1)) continue;
      // viable land: fertile + watered, away from existing settlements
      const site = findBestTile(w, s.x, s.y, 30, (i, x, y) => {
        if (w.fertility[i] < 0.42 || w.water[i] < 32) return 0;
        const d = Math.sqrt(dist2(x, y, s.x, s.y));
        if (d < 13) return 0;
        for (const o of this.settlements) {
          if (!o.dead && dist2(o.x, o.y, x, y) < 150) return 0;
        }
        return w.fertility[i] + w.food[i] / 100 - this.dangerSignal[i] * 0.2;
      });
      if (site < 0) continue;
      const sx = site % w.w + 0.5, sy = (site / w.w | 0) + 0.5;
      // recruit WHOLE FAMILIES (kids travel with their parents, never alone)
      const byFamily = new Map();
      for (const a of this.agents) {
        if (a.dead || a.home !== s.id) continue;
        let g = byFamily.get(a.familyId);
        if (!g) { g = { adults: 0, members: [] }; byFamily.set(a.familyId, g); }
        g.members.push(a);
        if (a.age >= 16) g.adults++;
      }
      const party = [];
      let foundingFamilyId = -1;
      for (const [fid, g] of byFamily) {
        if (g.adults < 1) continue; // no unaccompanied children
        if (party.length && party.length + g.members.length > 18) continue;
        if (foundingFamilyId < 0) foundingFamilyId = fid;
        party.push(...g.members);
        if (party.length >= 10) break;
      }
      const adults = party.filter(a => a.age >= 16).length;
      if (adults < 4) continue;
      // found the colony; migrants carry a share of the granary
      const c = createSettlement(this, sx, sy, party.map(p => p.id));
      c.parentSettlementId = s.id;
      c.parentName = s.name;
      c.originReason = s.famineT > 25 ? 'famine' : 'overcrowding';
      c.foundingFamilyId = foundingFamilyId;
      c.foundingIdeologyId = s.dominantIdeology ?? null;
      c.foodStore = Math.min(40, s.foodStore * 0.18); s.foodStore -= c.foodStore;
      c.woodStore = s.woodStore * 0.15; s.woodStore -= c.woodStore;
      c.stoneStore = s.stoneStore * 0.15; s.stoneStore -= c.stoneStore;
      c.wealth = s.wealth * 0.1; s.wealth -= c.wealth;
      this.settlements.push(c);
      this.settlementById.set(c.id, c);
      for (const m of party) {
        m.home = c.id;
        remember(m, `set out to found ${c.name}`);
        if (m.age >= 12) {
          m.state = 'migrating'; m.stateT = 0;
          m.tx = sx + (this.rand() - 0.5) * 2; m.ty = sy + (this.rand() - 0.5) * 2;
          m.hasTarget = true;
          this.recordMigrationTrail(m.x, m.y, 2);
        } // children simply follow their guardians
        if (m.age >= 16) learnReward(this, m, 'migrating', 0.6);
      }
      s.stability = clamp(s.stability + 0.06, 0, 1); // pressure vents
      this.totals.colonies++;
      this.addEvent(`${c.name} founded as a colony of ${s.name} (${c.originReason}, ${party.length} settlers)`, 'good', '⛺');
      this.iconFlash(sx, sy, '⛺', 90);
      break; // at most one colony per evaluation pass
    }
  }

  travelBoostAt(x, y, agent) {
    const tx = x | 0, ty = y | 0;
    if (tx < 0 || ty < 0 || tx >= this.world.w || ty >= this.world.h) return 1;
    const idx = ty * this.world.w + tx;
    const route = Math.min(1.2, this.tradeMap[idx] * 0.24);
    const trail = Math.min(0.9, this.migrationMap[idx] * 0.08);
    const learned = 0.28 + (agent.pathSense || 0.08);
    return 1 + Math.min(0.48, (route + trail) * learned);
  }

  travelSteer(agent, tx, ty) {
    const ax = agent.x | 0, ay = agent.y | 0;
    let best = null, bestScore = 0.18;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = ax + dx, y = ay + dy;
        if (x < 0 || y < 0 || x >= this.world.w || y >= this.world.h) continue;
        const idx = y * this.world.w + x;
        const heat = this.tradeMap[idx] * 0.45 + this.migrationMap[idx] * 0.12;
        if (heat <= 0) continue;
        const toward = Math.hypot(agent.x - tx, agent.y - ty) - Math.hypot(x - tx, y - ty);
        const score = heat + toward * 0.08 - Math.hypot(dx, dy) * 0.06;
        if (score > bestScore) { bestScore = score; best = { x: x + 0.5, y: y + 0.5 }; }
      }
    }
    return best;
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

  updateSettlementEconomy(s) {
    const profile = this.localResourceProfile(s, 7);
    s.resourceProfile = profile;
    const labor = Math.sqrt(Math.max(1, s.members));
    s.foodStore += clamp(profile.food / 35, 0, 2.4) * labor * 0.35;
    s.woodStore += clamp(profile.wood / 55, 0, 1.8) * labor * 0.16;
    s.stoneStore += clamp(profile.stone / 45, 0, 1.8) * labor * 0.10;
    if (s.tech >= 4 || s.buildings.workshop > 0) s.metalStore += clamp(profile.metal / 38, 0, 1.6) * labor * 0.07;
    if (profile.fish > 4) s.foodStore += clamp(profile.fish / 40, 0, 1.5) * labor * 0.22;
    if (profile.salt > 4) s.wealth += clamp(profile.salt / 45, 0, 1) * labor * 0.03;
    if (profile.gems > 0) {
      const luxury = clamp(profile.gems / 18, 0, 1.4) * labor * 0.025;
      s.luxuryStore += luxury;
      s.wealth += luxury * (0.5 + s.culture.commercial);
    }
    if (profile.water < 24) s.stability -= 0.0025;
    else if (profile.river > 0.08 || profile.water > 70) s.stability += 0.0015;
  }

  updateSettlementFoodSystem(s) {
    const profile = s.resourceProfile || this.localResourceProfile(s, 7);
    s.resourceProfile = profile;
    const pop = Math.max(1, s.members);
    const fertility = clamp(profile.food / 62, 0.15, 1.65);
    const water = clamp(profile.water / 58, 0.25, 1.45);
    const hasAgriculture = s.tech >= 2 || s.discoveries.includes('Agriculture');
    const farmInfra = s.buildings.farms + Math.min(8, s.farmedTiles.size * 0.12);
    const techBoost = hasAgriculture
      ? 1 + s.tech * 0.055 + (s.tech >= 4 ? 0.18 : 0) + (s.tech >= 7 ? 0.22 : 0) + (s.tech >= 10 ? 0.28 : 0)
      : 0.25;
    const farmOutput = hasAgriculture
      ? pop * 0.018 * techBoost * (1 + farmInfra * 0.45) * fertility * water
      : pop * 0.006 * fertility * water;
    const forageOutput = pop * 0.005 * fertility + clamp(profile.food / 80, 0, 1.4);
    s.foodStore += farmOutput + forageOutput;

    const desiredFarms = hasAgriculture ? clamp(Math.ceil(pop / 55), 1, 7) : 0;
    if (desiredFarms > s.buildings.farms && s.woodStore >= 5 && s.stoneStore >= 1 &&
        (s.famineT > 6 || pop > 35 || s.tech >= 4) && this.tick - (s.lastFarmExpansion || -999) > 80) {
      s.woodStore -= 5;
      s.stoneStore -= 1;
      s.buildings.farms++;
      s.lastFarmExpansion = this.tick;
      this.addEvent(`${s.name} expanded farmland`, 'build');
    }
  }

  handleFoodCrisis(s) {
    if (this.tick - (s.lastFoodAppeal || -999) < 35) return false;
    s.lastFoodAppeal = this.tick;
    const pop = Math.max(1, s.members);
    let donor = null, best = 0, route = null, key = null;
    for (const r of this.routes.values()) {
      if (r.a !== s.id && r.b !== s.id) continue;
      const other = this.settlementById.get(r.a === s.id ? r.b : r.a);
      if (!other || other.dead) continue;
      const surplus = other.foodStore / Math.max(1, other.members) - 2.4;
      const score = surplus * r.strength * (1 + this.cultureCompatibility(s, other));
      if (score > best) { best = score; donor = other; route = r; }
    }
    if (!donor) {
      for (const t of this.settlements) {
        if (t.dead || t.id === s.id) continue;
        const d = Math.sqrt(dist2(s.x, s.y, t.x, t.y));
        if (d > 58) continue;
        const surplus = t.foodStore / Math.max(1, t.members) - 2.5;
        if (surplus <= 0) continue;
        const rel = s.relations.get(t.id) || 0;
        const score = surplus * (0.5 + this.cultureCompatibility(s, t)) * (1 + rel) / (1 + d * 0.03);
        if (score > best) { best = score; donor = t; }
      }
      if (donor) {
        key = s.id < donor.id ? `${s.id}-${donor.id}` : `${donor.id}-${s.id}`;
        route = this.ensureTradeRoute(s, donor, key, this.routes.get(key));
      }
    }
    if (donor && route) {
      const flow = Math.min(donor.foodStore - donor.members * 1.8, pop * 0.35, 28);
      if (flow > 2) {
        donor.foodStore -= flow;
        s.foodStore += flow;
        const payment = Math.min(s.wealth, flow * 0.45);
        s.wealth -= payment;
        donor.wealth += payment;
        s.stability += 0.025;
        this.addEvent(`${s.name} secured emergency grain from ${donor.name}`, 'good');
        return true;
      }
    }

    const bravery = s.culture.militaristic * 0.55 + s.culture.expansionist * 0.35 +
      clamp(s.tech / 10, 0, 0.45) + s.defense * 0.25 - s.culture.peaceful * 0.35;
    if (donor && this.tick - s.lastRaid > 80 && bravery > 0.55 && this.rand() < bravery * 0.22) {
      const rel = clamp((s.relations.get(donor.id) || 0) - 0.45, -1, 1);
      s.relations.set(donor.id, rel);
      donor.relations.set(s.id, rel);
      s.lastDesperation = this.tick;
      cultureShift(s, 'militaristic', 0.035);
      this.addEvent(`${s.name} prepares to seize food from ${donor.name}`, 'war');
    }
    return false;
  }

  localResourceProfile(s, radius) {
    const w = this.world;
    const x0 = Math.max(0, (s.x | 0) - radius), x1 = Math.min(w.w - 1, (s.x | 0) + radius);
    const y0 = Math.max(0, (s.y | 0) - radius), y1 = Math.min(w.h - 1, (s.y | 0) + radius);
    const out = { food: 0, wood: 0, stone: 0, metal: 0, gems: 0, water: 0, river: 0, herbs: 0, clay: 0, fish: 0, salt: 0 };
    let weight = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - s.x, y - s.y);
        if (d > radius) continue;
        const k = 1 - d / (radius + 0.5);
        const i = y * w.w + x;
        out.food += w.maxFood[i] * k;
        out.wood += w.wood[i] * k;
        out.stone += w.stone[i] * k;
        out.metal += w.metal[i] * k;
        out.gems += w.gems[i] * k;
        out.herbs += (w.herbs ? w.herbs[i] : 0) * k;
        out.clay += (w.clay ? w.clay[i] : 0) * k;
        out.fish += (w.fish ? w.fish[i] : 0) * k;
        out.salt += (w.salt ? w.salt[i] : 0) * k;
        out.water += w.water[i] * k;
        out.river += (w.river[i] || 0) * k;
        weight += k;
      }
    }
    if (weight <= 0) return out;
    for (const key of Object.keys(out)) out[key] /= weight;
    return out;
  }

  settlementResourceState(s) {
    const pop = Math.max(1, s.members);
    const foodPerCapita = s.foodStore / pop;
    const woodTarget = 0.45 * pop + s.buildings.huts * 2;
    const stoneTarget = 0.28 * pop + s.buildings.walls * 4;
    const metalTarget = (s.tech >= 6 ? 8 : 3) + s.buildings.workshop * 4;
    return {
      foodNeed: clamp((1.4 - foodPerCapita) / 1.4, 0, 1.8),
      foodSurplus: clamp((foodPerCapita - 2.2) / 2.8, 0, 1.8),
      woodNeed: clamp((woodTarget - s.woodStore) / (woodTarget + 1), 0, 1.2),
      woodSurplus: clamp((s.woodStore - woodTarget * 1.7) / (woodTarget * 1.7 + 1), 0, 1.5),
      stoneNeed: clamp((stoneTarget - s.stoneStore) / (stoneTarget + 1), 0, 1.2),
      stoneSurplus: clamp((s.stoneStore - stoneTarget * 1.6) / (stoneTarget * 1.6 + 1), 0, 1.5),
      metalNeed: clamp((metalTarget - (s.metalStore || 0)) / (metalTarget + 1), 0, 1.2),
      metalSurplus: clamp(((s.metalStore || 0) - metalTarget * 1.5) / (metalTarget * 1.5 + 1), 0, 1.5),
      luxurySurplus: clamp(((s.luxuryStore || 0) - 3) / 12, 0, 1.5)
    };
  }

  scarcityPressure(state) {
    return state.foodNeed * 1.7 + state.woodNeed * 0.35 + state.stoneNeed * 0.3 + state.metalNeed * 0.35;
  }

  cultureCompatibility(A, B) {
    let score = 0.45;
    const a = dominantCulture(A), b = dominantCulture(B);
    if (a === b) score += 0.22;
    score += (A.culture.commercial + B.culture.commercial) * 0.18;
    score += (A.culture.peaceful + B.culture.peaceful + A.culture.communal + B.culture.communal) * 0.08;
    score -= (A.culture.isolationist + B.culture.isolationist) * 0.14;
    score -= Math.abs(A.culture.authoritarian - B.culture.authoritarian) * 0.10;
    return clamp(score, 0, 1.2);
  }

  settlementJoinScore(a, s) {
    const capacity = 25 + s.buildings.huts * 10;
    if (s.members >= capacity || s.stability < 0.18) return -1;
    const d = Math.sqrt(dist2(a.x, a.y, s.x, s.y));
    if (d > 8) return -1;
    let score = 1 - d / 8 + s.stability * 0.55 + s.culture.communal * 0.25 + s.culture.peaceful * 0.15;
    score -= s.culture.isolationist * 0.35;
    if (a.refugeeCulture) score += (s.culture[a.refugeeCulture] || 0) * 0.85;
    if (a.refugeeCulture && dominantCulture(s) === a.refugeeCulture) score += 0.25;
    return score;
  }

  resourceComplement(a, b) {
    return a.foodNeed * b.foodSurplus + b.foodNeed * a.foodSurplus +
      (a.woodNeed * b.woodSurplus + b.woodNeed * a.woodSurplus) * 0.45 +
      (a.stoneNeed * b.stoneSurplus + b.stoneNeed * a.stoneSurplus) * 0.4 +
      (a.metalNeed * b.metalSurplus + b.metalNeed * a.metalSurplus) * 0.55 +
      (a.luxurySurplus + b.luxurySurplus) * 0.12;
  }

  // ---- trade routes + relations drift (the diplomacy layer) ----
  updateTradeAndDiplomacy() {
    const P = this.params;
    const live = this.settlements.filter(s => !s.dead);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const A = live[i], B = live[j];
        const d = Math.sqrt(dist2(A.x, A.y, B.x, B.y));
        if (d > 70) continue;
        const rel = A.relations.get(B.id) || 0;
        const stateA = this.settlementResourceState(A);
        const stateB = this.settlementResourceState(B);
        const complement = this.resourceComplement(stateA, stateB);
        const compat = this.cultureCompatibility(A, B);
        const pressure = Math.max(this.scarcityPressure(stateA), this.scarcityPressure(stateB));

        // --- trade formation: culture fit + concrete resource complement ---
        let tradeDrive = ((A.culture.commercial + B.culture.commercial) * 0.3 +
          compat * 0.45 + complement * 0.75 + pressure * 0.18) * P.tradeFriendliness + rel * 0.25;
        if (rel < -0.55) tradeDrive *= 0.35;
        if (d > 55) tradeDrive -= (d - 55) * 0.018;
        const key = A.id < B.id ? `${A.id}-${B.id}` : `${B.id}-${A.id}`;
        let route = this.routes.get(key);
        const capA = 4 + Math.round(A.culture.commercial * 4) + (stateA.foodNeed > 0.55 ? 2 : 0);
        const capB = 4 + Math.round(B.culture.commercial * 4) + (stateB.foodNeed > 0.55 ? 2 : 0);
        if (!route && (A.tradePartners.size >= capA || B.tradePartners.size >= capB)) tradeDrive -= 0.45;
        if (tradeDrive > 0.82 && d < 64) {
          route = this.ensureTradeRoute(A, B, key, route);
          if (!route) continue;
          route.strength = clamp(route.strength + 0.06, 0, 1);
          this.exchangeTrade(A, B, stateA, stateB, route);
          // trading improves relations
          const nr = clamp(rel + 0.02 + compat * 0.012, -1, 1);
          A.relations.set(B.id, nr); B.relations.set(A.id, nr);
        } else if (route) {
          route.strength -= 0.05;
          if (route.strength <= 0.03) this.closeTradeRoute(A, B, key);
        }

        // --- relations drift: proximity + culture friction ---
        let drift = -rel * 0.01; // decay toward neutral
        const friction = (A.culture.expansionist + B.culture.expansionist) * 0.5;
        if (d < 20 && friction > 0.5) drift -= 0.02 * P.aggression;      // border tension
        if (A.culture.peaceful > 0.55 && B.culture.peaceful > 0.55) drift += 0.015;
        if (complement > 0.45 && route) drift += 0.012;
        if (pressure > 1.25 && !route && compat < 0.45) drift -= 0.018 * P.aggression;
        const nr = clamp(rel + drift, -1, 1);
        A.relations.set(B.id, nr); B.relations.set(A.id, nr);

        // --- alliance: strong friendship → mutual aid during famine ---
        if (nr > 0.6) {
          if (A.famineT > 20 && B.foodStore > B.members * 3) { B.foodStore -= 15; A.foodStore += 15; }
          if (B.famineT > 20 && A.foodStore > A.members * 3) { A.foodStore -= 15; B.foodStore += 15; }
        }
      }
    }
    this.rebuildTradeMap();
  }

  ensureTradeRoute(A, B, key, route) {
    if (route) {
      if (!route.path) route.path = this.findTradePath(A, B);
      return route.path ? route : null;
    }
    const path = this.findTradePath(A, B);
    if (!path) return null;
    route = { a: A.id, b: B.id, strength: 0.1, path };
    this.routes.set(key, route);
    A.tradePartners.add(B.id); B.tradePartners.add(A.id);
    this.addEvent(`Trade opens: ${A.name} ↔ ${B.name}`, 'good', '🤝');
    this.iconFlash(A.x, A.y, '🤝');
    this.iconFlash(B.x, B.y, '🤝');
    return route;
  }

  closeTradeRoute(A, B, key) {
    this.routes.delete(key);
    A.tradePartners.delete(B.id); B.tradePartners.delete(A.id);
  }

  exchangeTrade(A, B, stateA, stateB, route) {
    const move = (donor, taker, store, amount, price) => {
      const available = Math.max(0, donor[store] - amount.reserve);
      const flow = Math.min(available, amount.max) * route.strength;
      if (flow <= 0.05) return 0;
      donor[store] -= flow;
      taker[store] += flow;
      const payment = flow * price;
      taker.wealth = Math.max(0, taker.wealth - payment);
      donor.wealth += payment;
      return flow;
    };
    const tradePair = (needA, surplusA, needB, surplusB, store, reserve, max, price) => {
      if (needA > needB && surplusB > 0.02) return move(B, A, store, { reserve, max: max * needA }, price);
      if (needB > needA && surplusA > 0.02) return move(A, B, store, { reserve, max: max * needB }, price);
      return 0;
    };
    const foodMoved = tradePair(stateA.foodNeed, stateA.foodSurplus, stateB.foodNeed, stateB.foodSurplus,
      'foodStore', 8, 16, 0.45);
    tradePair(stateA.woodNeed, stateA.woodSurplus, stateB.woodNeed, stateB.woodSurplus, 'woodStore', 4, 5, 0.25);
    tradePair(stateA.stoneNeed, stateA.stoneSurplus, stateB.stoneNeed, stateB.stoneSurplus, 'stoneStore', 3, 4, 0.32);
    tradePair(stateA.metalNeed, stateA.metalSurplus, stateB.metalNeed, stateB.metalSurplus, 'metalStore', 1, 2.5, 0.8);
    if (stateA.luxurySurplus > 0.1 && B.wealth > 8) move(A, B, 'luxuryStore', { reserve: 1, max: 1.4 }, 1.4);
    if (stateB.luxurySurplus > 0.1 && A.wealth > 8) move(B, A, 'luxuryStore', { reserve: 1, max: 1.4 }, 1.4);
    if (foodMoved > 4 && (A.famineT > 18 || B.famineT > 18) && this.tick - (route.lastAid || -999) > 120) {
      route.lastAid = this.tick;
      const hungry = A.famineT > B.famineT ? A : B;
      this.addEvent(`Food convoy reaches ${hungry.name}`, 'good');
    }
  }

  findTradePath(A, B) {
    const w = this.world;
    const sx = clamp(A.x | 0, 0, w.w - 1), sy = clamp(A.y | 0, 0, w.h - 1);
    const gx = clamp(B.x | 0, 0, w.w - 1), gy = clamp(B.y | 0, 0, w.h - 1);
    if (!Number.isFinite(travelCost(w, sx, sy)) || !Number.isFinite(travelCost(w, gx, gy))) return null;
    const start = sy * w.w + sx, goal = gy * w.w + gx;
    const n = w.w * w.h;
    const gScore = new Float32Array(n);
    gScore.fill(Infinity);
    const came = new Int32Array(n);
    came.fill(-1);
    const closed = new Uint8Array(n);
    const heap = [];
    const heuristic = (x, y) => Math.hypot(x - gx, y - gy);
    gScore[start] = 0;
    heapPush(heap, [heuristic(sx, sy), start]);
    let expanded = 0;

    while (heap.length && expanded < 7000) {
      const [, cur] = heapPop(heap);
      if (closed[cur]) continue;
      if (cur === goal) return simplifyPath(reconstructPath(w, came, start, goal, A, B));
      closed[cur] = 1;
      expanded++;
      const cx = cur % w.w, cy = (cur / w.w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w.w || ny >= w.h) continue;
          const j = ny * w.w + nx;
          if (closed[j]) continue;
          const tileCost = travelCost(w, nx, ny);
          if (!Number.isFinite(tileCost)) continue;
          const step = tileCost * (dx !== 0 && dy !== 0 ? 1.414 : 1);
          const ng = gScore[cur] + step;
          if (ng >= gScore[j]) continue;
          came[j] = cur;
          gScore[j] = ng;
          heapPush(heap, [ng + heuristic(nx, ny), j]);
        }
      }
    }
    return null;
  }

  // ---- settlement-scale raids/war (abstracted; agent fights are separate) --
  updateWar() {
    const P = this.params;
    const live = this.settlements.filter(s => !s.dead && s.members > 4);
    for (const s of live) {
      const needs = this.settlementResourceState(s);
      const pressure = this.scarcityPressure(needs) + (s.famineT > 12 ? 0.45 : 0);
      const restraint = s.culture.peaceful * 0.35 + s.culture.commercial * 0.18;
      const warDrive = (s.culture.militaristic * 0.65 + s.culture.expansionist * 0.32 +
        pressure * 0.45 - restraint) * P.aggression;
      if (warDrive < 0.45 || this.rand() > warDrive * 0.28) continue;
      if (this.tick - s.lastRaid < 90) continue;

      // choose the weakest neighbour with resources this settlement lacks
      let target = null, bestScore = 0;
      for (const t of live) {
        if (t.id === s.id) continue;
        const d = Math.sqrt(dist2(s.x, s.y, t.x, t.y));
        if (d > 52) continue;
        const rel = s.relations.get(t.id) || 0;
        if (rel > 0.5 && pressure < 1.35) continue; // won't raid friends unless desperate
        const targetState = this.settlementResourceState(t);
        const resourceValue = needs.foodNeed * targetState.foodSurplus * 3.0 +
          needs.woodNeed * targetState.woodSurplus * 0.8 +
          needs.stoneNeed * targetState.stoneSurplus * 0.7 +
          needs.metalNeed * targetState.metalSurplus * 1.1 +
          targetState.luxurySurplus * (0.3 + s.culture.commercial * 0.4) +
          t.foodStore / Math.max(1, t.members) * (s.famineT > 8 ? 0.16 : 0.05);
        const grievance = 1 - rel + s.culture.expansionist * 0.4 + s.culture.militaristic * 0.35;
        const score = resourceValue * grievance / (1 + t.defense * 3) / (5 + d);
        if (score > bestScore) { bestScore = score; target = t; }
      }
      if (!target) continue;

      s.lastRaid = this.tick;
      target.lastRaid = this.tick;
      const atk = s.members * (0.4 + s.culture.militaristic) * (0.8 + this.rand() * 0.4);
      const def = target.members * (0.5 + target.defense * 1.6) * (0.8 + this.rand() * 0.4);
      const win = atk > def;
      this.flashes.push({ x: target.x, y: target.y, ttl: 45, kind: 'war' });
      this.addEvent(`${s.name} raids ${target.name}${win ? ' — sacked!' : ' — repelled'}`, 'war', '⚔️');
      this.iconFlash(target.x, target.y, '⚔️', 80);
      this.iconFlash(s.x, s.y, '⚔️', 80);

      // casualties on both sides, heavier for the loser
      this.raidCasualties(s, win ? 0.04 : 0.1, target.name);
      this.raidCasualties(target, win ? 0.12 : 0.05, s.name);
      if (win) {
        const loot = target.foodStore * 0.4, gold = target.wealth * 0.35;
        const wood = target.woodStore * 0.25, stone = target.stoneStore * 0.22;
        const metal = (target.metalStore || 0) * 0.28, luxury = (target.luxuryStore || 0) * 0.22;
        target.foodStore -= loot; s.foodStore += loot;
        target.woodStore -= wood; s.woodStore += wood;
        target.stoneStore -= stone; s.stoneStore += stone;
        target.metalStore -= metal; s.metalStore += metal;
        target.luxuryStore -= luxury; s.luxuryStore += luxury;
        target.wealth -= gold; s.wealth += gold;
        target.stability -= 0.15;
        s.lastDesperation = this.tick;
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

  raidCasualties(s, frac, byName = null) {
    for (const a of this.agents) {
      if (!a.dead && a.home === s.id && this.rand() < frac) {
        this.killAgent(a, 'raid', byName ? `raiders of ${byName}` : null);
      }
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
        if (seeded && s.sickCount < 2) {
          this.addEvent(`Sickness spreads in ${s.name}`, 'bad', '☣️');
          this.iconFlash(s.x, s.y, '☣️', 80);
        }
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
          const dti = tileIndex(w, b.x, b.y);
          this.dangerSignal[dti] = Math.min(6, this.dangerSignal[dti] + 0.5);
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
    const DISASTER_ICONS = { drought: '☀️', flood: '🌊', earthquake: '🌋', wildfire: '🔥', plague: '☣️' };
    this.flashes.push({ x, y, ttl: 90, kind: 'disaster', label: kind, r: R });
    this.iconFlash(x, y, DISASTER_ICONS[kind] || '⚠️', 90);
    this.addEvent(`⚠ ${kind.toUpperCase()} strikes near (${x | 0},${y | 0})`, 'disaster', DISASTER_ICONS[kind] || '⚠️');

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
      this.markSettlementShock(s, kind);
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
    for (const s of this.settlements) if (!s.dead) this.markSettlementShock(s, 'drought');
    this.addEvent('⚠ CONTINENTAL DROUGHT — food and water crash', 'disaster', '☀️');
  }

  /** UI: rain of plenty — resources surge back. */
  addResources() {
    const w = this.world;
    for (let i = 0; i < w.food.length; i++) {
      w.food[i] = Math.min(w.maxFood[i] * 1.1, w.food[i] + w.maxFood[i] * 0.6);
      w.water[i] = Math.min(100, w.water[i] + 15);
    }
    for (const s of this.settlements) if (!s.dead) s.foodStore += 25;
    this.addEvent('✦ A season of plenty — resources surge', 'good', '✨');
  }

  /** UI: migration pressure — degrade a region so people move (targetable). */
  triggerMigrationPressure(atX, atY) {
    const live = this.settlements.filter(s => !s.dead);
    const w = this.world;
    let x = atX, y = atY;
    if (x === undefined) {
      if (live.length) { const s = pick(this.rand, live); x = s.x; y = s.y; }
      else { x = w.w / 2; y = w.h / 2; }
    }
    for (let i = 0; i < w.food.length; i++) {
      const tx = i % w.w, ty = (i / w.w) | 0;
      if (dist2(tx, ty, x, y) < 300) {
        w.food[i] *= 0.3; w.maxFood[i] *= 0.75;
        w.danger[i] = clamp(w.danger[i] + 0.2, 0, 1);
      }
    }
    for (const s of live) {
      if (!s.dead && dist2(s.x, s.y, x, y) < 300) this.markSettlementShock(s, 'migration');
    }
    for (const a of this.agents) {
      if (!a.dead && dist2(a.x, a.y, x, y) < 300) {
        a.fear = clamp(a.fear + 30, 0, 100);
        if (this.rand() < 0.5) { a.state = 'migrating'; a.stateT = 0; a.hasTarget = false; }
      }
    }
    this.addEvent('⚠ Migration pressure — a region turns hostile', 'disaster', '👣');
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

    // orphan census (bounded: only under-12s, map lookups only)
    let orphans = 0, children = 0;
    for (const a of this.agents) {
      if (a.dead || a.age >= 12) continue;
      children++;
      const m = a.mother >= 0 && this.agentById.get(a.mother);
      const f = a.father >= 0 && this.agentById.get(a.father);
      const g = a.guardian >= 0 && this.agentById.get(a.guardian);
      if (!m && !f && !g) orphans++;
    }
    const ideoSnapshot = this.ideologies
      .filter(I => I.followers > 0)
      .sort((x, y) => y.followers - x.followers)
      .slice(0, 8)
      .map(I => ({ id: I.id, name: I.name, type: I.type, followers: I.followers,
                   zeal: I.zeal, tolerance: I.tolerance, hue: I.hue,
                   parent: I.parentIdeologyId }));
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
      tempOffset: this.climate.tempOffset,
      marriages: this.totals.marriages,
      colonies: this.totals.colonies,
      conversions: this.totals.conversions,
      orphans, children,
      avgReward: this.totals.rewardCount ? this.totals.rewardSum / this.totals.rewardCount : 0,
      ideologies: ideoSnapshot
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

function reconstructPath(world, came, start, goal, A, B) {
  const path = [{ x: B.x, y: B.y }];
  let cur = goal;
  while (cur !== start) {
    cur = came[cur];
    if (cur < 0) return null;
    path.push({ x: cur % world.w + 0.5, y: ((cur / world.w) | 0) + 0.5 });
  }
  path[path.length - 1] = { x: A.x, y: A.y };
  path.reverse();
  return path;
}

function simplifyPath(path) {
  if (!path || path.length <= 4) return path;
  const out = [path[0]];
  for (let i = 2; i < path.length - 1; i += 3) out.push(path[i]);
  out.push(path[path.length - 1]);
  return out;
}

function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p][0] <= item[0]) break;
    heap[i] = heap[p];
    i = p;
  }
  heap[i] = item;
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length && last) {
    let i = 0;
    while (true) {
      let c = i * 2 + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++;
      if (heap[c][0] >= last[0]) break;
      heap[i] = heap[c];
      i = c;
    }
    heap[i] = last;
  }
  return top;
}

function downfallInfo(value = 'collapse') {
  const key = normalizeDownfallKey(value);
  return { key, ...(DOWNFALLS[key] || DOWNFALLS.collapse) };
}

function ruinSummary(s, info) {
  const pop = s.members || 0;
  const food = s.foodStore | 0;
  const stability = (s.stability * 100) | 0;
  const displaced = s.lastDisplaced
    ? `${s.lastDisplaced.refugees} fled, ${s.lastDisplaced.casualties} died in the collapse.`
    : 'No organized survivor record remained.';
  if (info.key === 'abandoned') return `${s.name} was abandoned after its population fell away. Final stores: ${food} food, stability ${stability}%.`;
  if (info.key === 'famine') return `${s.name} starved under severe food stress. Final population ${pop}, food stores ${food}, stability ${stability}%. ${displaced}`;
  if (info.key === 'war') return `${s.name} broke after raids and border violence. Final population ${pop}, defense ${(s.defense * 100) | 0}%. ${displaced}`;
  if (info.key === 'disease' || info.key === 'plague') return `${s.name} fell during sickness. ${s.sickCount || 0} residents were sick near the end. ${displaced}`;
  if (info.key === 'drought' || info.key === 'flood' || info.key === 'earthquake' || info.key === 'wildfire') {
    return `${s.name} collapsed after a ${info.label.toLowerCase()} shock destabilized the settlement. Final population ${pop}, stability ${stability}%. ${displaced}`;
  }
  if (info.key === 'migration') return `${s.name} emptied out after migration pressure made the region unsustainable. Final stability ${stability}%.`;
  if (info.key === 'overextension') return `${s.name} outgrew its local land and infrastructure. Final population ${pop}, stability ${stability}%. ${displaced}`;
  if (info.key === 'inequality') return `${s.name} fractured as wealth and authority concentrated. Final wealth ${s.wealth | 0}, stability ${stability}%. ${displaced}`;
  if (info.key === 'isolation') return `${s.name} lacked trade partners when its local food system failed. Final population ${pop}, food stores ${food}. ${displaced}`;
  if (info.key === 'resources') return `${s.name} exhausted critical local resources and could not replace them in time. Final population ${pop}, stability ${stability}%. ${displaced}`;
  if (info.key === 'governance') return `${s.name} fell into a governance crisis as leadership lost legitimacy. Final stability ${stability}%. ${displaced}`;
  if (info.key === 'unrest') return `${s.name} collapsed from internal unrest and weak stability. Final population ${pop}, stability ${stability}%. ${displaced}`;
  return `${s.name} collapsed. Final population ${pop}, food stores ${food}, stability ${stability}%. ${displaced}`;
}

function normalizeDownfallKey(value) {
  const key = String(value || 'collapse').toLowerCase();
  if (key.includes('abandon')) return 'abandoned';
  if (key.includes('plague')) return 'plague';
  if (key.includes('disease') || key.includes('sick')) return 'disease';
  if (key.includes('famine') || key.includes('starv')) return 'famine';
  if (key.includes('raid') || key.includes('war')) return 'war';
  if (key.includes('drought')) return 'drought';
  if (key.includes('flood')) return 'flood';
  if (key.includes('quake') || key.includes('earth')) return 'earthquake';
  if (key.includes('fire')) return 'wildfire';
  if (key.includes('migration')) return 'migration';
  if (key.includes('overextension') || key.includes('overcrowd')) return 'overextension';
  if (key.includes('inequality') || key.includes('wealth')) return 'inequality';
  if (key.includes('isolation')) return 'isolation';
  if (key.includes('resource')) return 'resources';
  if (key.includes('govern')) return 'governance';
  if (key.includes('unrest') || key.includes('stability')) return 'unrest';
  return Object.prototype.hasOwnProperty.call(DOWNFALLS, key) ? key : 'collapse';
}
