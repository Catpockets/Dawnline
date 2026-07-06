// ---------------------------------------------------------------------------
// Settlement model. Settlements are emergent: founded when migrating agents
// find good land, grown by births and immigration, and destroyed by famine,
// war, disease and instability. Each carries an evolving CULTURE vector that
// drifts in response to events (a tiny "culture model"), a technology level
// with discrete discoveries, buildings, wealth and diplomatic relations.
// ---------------------------------------------------------------------------
import { clamp, makeName } from './rng.js';
import { tileIndex, TERRAIN } from './world.js';
import { createAgent, TICKS_PER_YEAR } from './agents.js';

export const CULTURE_TRAITS = [
  'expansionist', 'peaceful', 'religious', 'militaristic', 'commercial',
  'isolationist', 'innovative', 'authoritarian', 'communal'
];

/** Technology thresholds → named discoveries (drives events + capabilities). */
export const DISCOVERIES = [
  [0.5, 'Fire mastery'], [1, 'Stone tools'], [2, 'Agriculture'], [3, 'Pottery'],
  [4, 'The wheel'], [5, 'Writing'], [6, 'Metallurgy'], [7, 'Masonry'],
  [8, 'Medicine'], [9, 'Mathematics'], [10, 'Engineering'], [12, 'Philosophy']
];

export function createSettlement(sim, x, y, founderIds) {
  const r = sim.rand;
  const s = {
    id: sim.nextSetId++,
    x, y,
    name: makeName(r),
    hue: (r() * 360) | 0,
    members: founderIds.length,
    foodStore: 20, woodStore: 5, stoneStore: 0, metalStore: 0, luxuryStore: 0, wealth: 5,
    buildings: { huts: 1, farms: 0, walls: 0, granary: 0, market: 0, temple: 0, workshop: 0 },
    defense: 0.1, tech: 0, stability: 0.7, leaderInfluence: 0.3 + r() * 0.4,
    culture: {},
    relations: new Map(),    // settlementId -> -1 (war) .. 1 (alliance)
    tradePartners: new Set(),
    archetype: 'hunter-gatherer camp',
    discoveries: [],
    farmedTiles: new Set(),
    sickCount: 0,
    founded: sim.tick,
    lastRaid: -999, raidedT: 0, famineT: 0,
    lastDesperation: -999,
    avgWealth: 0, dead: false
  };
  for (const t of CULTURE_TRAITS) s.culture[t] = 0.15 + r() * 0.3;
  return s;
}

/** Push a culture trait up/down; competing traits get squeezed slightly. */
export function cultureShift(s, trait, amt) {
  s.culture[trait] = clamp(s.culture[trait] + amt, 0, 1);
  const opposites = {
    peaceful: 'militaristic', militaristic: 'peaceful',
    isolationist: 'commercial', commercial: 'isolationist',
    communal: 'authoritarian', authoritarian: 'communal'
  };
  const op = opposites[trait];
  if (op && amt > 0) s.culture[op] = clamp(s.culture[op] - amt * 0.6, 0, 1);
}

/** Dominant culture trait (used for coloring + archetypes + AI weighting). */
export function dominantCulture(s) {
  let best = CULTURE_TRAITS[0], bv = -1;
  for (const t of CULTURE_TRAITS) if (s.culture[t] > bv) { bv = s.culture[t]; best = t; }
  return best;
}

/**
 * Settlement update, run every few ticks (staggered) — the "government" layer.
 * Handles tech growth, culture drift, buildings, births, stability, collapse.
 */
export function updateSettlement(sim, s) {
  const w = sim.world;
  const P = sim.params;
  const r = sim.rand;
  const ti = tileIndex(w, s.x, s.y);
  if (s.stability > 0.32 && s.famineT < 10 && s.sickCount < Math.max(2, s.members * 0.1)) s.collapseCause = null;

  if (s.members <= 0) {
    // fully abandoned → mark dead, tile becomes slightly dangerous ruins
    sim.dissolveSettlement(s, 'abandoned');
    return;
  }

  if (sim.tick % 9 === 0) sim.updateSettlementEconomy(s);

  // ---- technology: scales with population, innovation culture, workshops ----
  const techRate = 0.003 * Math.sqrt(s.members) *
    (0.5 + s.culture.innovative) * (1 + s.buildings.workshop * 0.3) * P.techSpeed;
  s.tech = clamp(s.tech + techRate / (1 + s.tech * 0.18), 0, 14);
  for (const [lvl, name] of DISCOVERIES) {
    if (s.tech >= lvl && !s.discoveries.includes(name)) {
      s.discoveries.push(name);
      const firstEver = !sim.globalDiscoveries.has(name);
      if (firstEver) sim.globalDiscoveries.add(name);
      sim.addEvent(`${s.name} discovered ${name}`, 'tech', firstEver ? '💡' : null);
      cultureShift(s, 'innovative', 0.04);
      if (name === 'Agriculture') cultureShift(s, 'communal', 0.05);
      if (name === 'Metallurgy') { s.defense += 0.15; cultureShift(s, 'militaristic', 0.03); }
      if (name === 'Writing') s.wealth += 10;
    }
  }

  sim.updateSettlementFoodSystem(s);

  // ---- food & famine bookkeeping ----
  const perCapita = s.foodStore / Math.max(1, s.members);
  const farmResilience = clamp(s.tech * 0.045 + s.buildings.farms * 0.055 +
    s.buildings.granary * 0.08 + s.tradePartners.size * 0.035, 0, 0.72);
  if (perCapita < 0.5) {
    s.famineT++;
    if (s.famineT > 8 && sim.tick % 15 === 0) sim.handleFoodCrisis(s);
    s.stability -= 0.0025 * (1 - farmResilience);
    cultureShift(s, 'expansionist', 0.008); // hunger pushes outward
    if (s.famineT === 30) sim.addEvent(`Famine grips ${s.name}`, 'bad');
  } else {
    s.famineT = Math.max(0, s.famineT - (perCapita > 1.5 ? 4 : 2));
    s.stability += 0.0035 + farmResilience * 0.0015;
  }

  // granaries slow food spoilage; without them surplus rots
  const storageTech = 1 + s.buildings.granary * 0.8 + (s.tech >= 4 ? 0.35 : 0) + (s.tech >= 8 ? 0.35 : 0);
  const spoil = (0.004 / storageTech) * Math.max(0, s.foodStore - 40 * (1 + s.buildings.granary));
  s.foodStore = Math.max(0, s.foodStore - spoil);

  // ---- births: fertility * food surplus * pair bonds (agent-level input) ----
  const cap = 18 + s.buildings.huts * 9;
  const infraCap = cap + s.buildings.farms * 35 + s.buildings.granary * 20 +
    s.buildings.market * 18 + Math.min(s.tech, 12) * 7;
  const capacityFactor = s.members < infraCap ? 1 : clamp(infraCap / Math.max(1, s.members), 0.04, 0.35);
  // births now emerge from agent-level marriage + pregnancy (agents.js);
  // the settlement contributes a 'family climate' factor read at conception.
  s.birthFactor = clamp(perCapita / 1.2, 0.25, 1.35) * capacityFactor * (1 - stabilityPenalty(s));

  // ---- culture drift: environment + events + slow random walk ----
  if (sim.tick % 20 === 0) {
    const drift = 0.01;
    cultureShift(s, CULTURE_TRAITS[(r() * CULTURE_TRAITS.length) | 0], (r() - 0.5) * drift * 2);
    if (w.fertility[ti] > 0.55) cultureShift(s, 'communal', drift * 0.5);
    if (s.tradePartners.size > 0) cultureShift(s, 'commercial', drift);
    if (sim.tick - s.lastRaid < 100) cultureShift(s, 'militaristic', drift * 1.5);
    if (s.sickCount > s.members * 0.2) cultureShift(s, 'religious', drift * 2);
    if (s.wealth > 80) cultureShift(s, 'authoritarian', drift * 0.7);
  }

  // ---- inequality & leader influence ----
  s.leaderInfluence = clamp(s.leaderInfluence + (s.culture.authoritarian - 0.4) * 0.002, 0.05, 1);
  // authoritarian + wealthy = wealth concentrates → stability slowly erodes
  if (s.wealth > 50 && s.culture.authoritarian > 0.5) s.stability -= 0.0015;

  // ---- defense from walls + militaristic culture ----
  s.defense = clamp(0.1 + s.buildings.walls * 0.18 + s.culture.militaristic * 0.3 +
    (s.tech >= 6 ? 0.15 : 0), 0, 0.95);

  // ---- stability clamps + collapse check ----
  const thriving = clamp((perCapita - 1.4) * 0.002 + s.tradePartners.size * 0.0008 +
    s.buildings.farms * 0.0009 + s.tech * 0.00025, 0, 0.008);
  s.stability += thriving;
  s.stability += (0.62 - s.stability) * 0.0012; // slow drift toward a norm
  s.stability = clamp(s.stability, 0, 1);
  const overcrowded = s.members > w.capacity[ti] * 6 + infraCap;
  if (overcrowded) { s.stability -= 0.003; s.collapseCause = 'overextension'; }
  if (s.wealth > 90 && s.culture.authoritarian > 0.55 && s.leaderInfluence > 0.65) {
    s.stability -= 0.0018;
    s.collapseCause = 'inequality';
  }
  if (s.members > 45 && s.leaderInfluence < 0.16 && s.stability < 0.3) {
    s.stability -= 0.0012;
    s.collapseCause = 'governance';
  }
  if (s.tradePartners.size === 0 && s.famineT > 35 && s.tech >= 2) s.collapseCause = 'isolation';
  if (s.famineT > 75 || (s.famineT > 45 && s.tech < 2)) {
    if (s.tech >= 2 && s.tradePartners.size === 0) s.collapseCause = 'isolation';
    else if (s.tech >= 2 || (s.resourceProfile && s.resourceProfile.food < 35)) s.collapseCause = 'resources';
    else s.collapseCause = 'famine';
  }
  else if (s.famineT > 35 && s.tech >= 2 && s.tradePartners.size === 0) s.collapseCause = 'isolation';
  else if (s.famineT > 25 && s.foodStore < s.members * 0.25) s.collapseCause = 'resources';
  if (s.stability < 0.12 && s.members > 0) {
    sim.collapseSettlement(s);
    return;
  }

  // ---- classification into archetypes (simple rule-based clustering) ----
  if (sim.tick % 30 === 0) s.archetype = classifySettlement(s);
}

/** Convenience: instability penalty 0..0.8 used to damp growth. */
export function stabilityPenalty(s) {
  return clamp((0.5 - s.stability) * 1.6, 0, 0.8);
}

/**
 * Rule-based archetype clustering. Buckets settlements into readable types
 * from their stats — the "classification" layer of the sim.
 */
export function classifySettlement(s) {
  if (s.stability < 0.25 || s.famineT > 60) return 'collapsing settlement';
  if (s.buildings.huts <= 1 && s.tech < 2) return s.members < 12 ? 'hunter-gatherer camp' : 'nomadic tribe';
  if (s.tech >= 10) return 'engineered city';
  if (s.tech >= 8 && (s.buildings.workshop >= 1 || s.discoveries.includes('Medicine'))) return 'technological center';
  if (s.tech >= 5 && s.members > 80) return 'city-state';
  if (s.buildings.walls >= 2 && s.culture.militaristic > 0.5) return 'fortress city';
  if (s.tradePartners.size >= 2 && s.buildings.market >= 1) return 'trade hub';
  if (s.tech >= 3 && s.buildings.market >= 1) return 'market town';
  if (s.tech >= 2 || s.buildings.farms > 0 || s.farmedTiles.size >= 2) {
    return s.members > 45 ? 'agrarian town' : 'farming village';
  }
  return s.members > 18 ? 'settled village' : 'hunter-gatherer camp';
}

/**
 * Building construction, driven by agents in the 'building' FSM state.
 * Costs come from communal stores; choice follows current pressures.
 */
export function contributeBuild(sim, s, agent) {
  const b = s.buildings;
  const effort = 0.2 + agent.skills.build;
  s.buildProgress = (s.buildProgress || 0) + effort;
  if (s.buildProgress < 10) return;
  s.buildProgress = 0;

  // priority: shelter → farms → granary → market → walls → workshop → temple
  const wantHuts = s.members > b.huts * 8;
  const wantFarms = s.tech >= 2 && b.farms < 3 && s.famineT > 5;
  const wantGranary = s.foodStore > 50 && b.granary < 2;
  const wantMarket = s.culture.commercial > 0.4 && b.market < 2 && s.tech >= 3;
  const wantWalls = (sim.tick - s.lastRaid < 200 || s.culture.militaristic > 0.55) && b.walls < 3;
  const wantWorkshop = s.culture.innovative > 0.5 && b.workshop < 3 && s.tech >= 4;
  const wantTemple = s.culture.religious > 0.55 && b.temple < 1;

  const tryBuild = (kind, wood, stone) => {
    if (s.woodStore >= wood && s.stoneStore >= stone) {
      s.woodStore -= wood; s.stoneStore -= stone;
      b[kind]++;
      sim.addEvent(`${s.name} built a ${kind === 'huts' ? 'hut' : kind}`, 'build');
      if (kind === 'temple') s.stability += 0.08;
      return true;
    }
    return false;
  };

  if (wantHuts && tryBuild('huts', 8, 0)) return;
  if (wantFarms && tryBuild('farms', 6, 2)) { s.foodStore += 10; return; }
  if (wantGranary && tryBuild('granary', 10, 4)) return;
  if (wantMarket && tryBuild('market', 8, 4)) return;
  if (wantWalls && tryBuild('walls', 6, 10)) return;
  if (wantWorkshop && tryBuild('workshop', 10, 6)) return;
  if (wantTemple) tryBuild('temple', 12, 8);
}
