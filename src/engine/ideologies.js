// ---------------------------------------------------------------------------
// IDEOLOGIES: religions, philosophies, codes and creeds. Generated
// deterministically from the sim's RNG stream, spread through families,
// spouses, settlements and trade, and able to schism under stress.
// Ideology biases decisions and diplomacy but never overrides survival.
// ---------------------------------------------------------------------------
import { clamp, pick } from './rng.js';

const TYPES = [
  'religion', 'philosophy', 'clan-code', 'trade-guild',
  'ancestor-cult', 'nature-cult', 'warrior-code', 'civic-creed'
];
const NAME_A = ['Sun', 'Deep', 'Ash', 'River', 'Star', 'Stone', 'Ember', 'Tide', 'Moon', 'Root', 'Storm', 'Dawn', 'Iron', 'Silent', 'Golden', 'Wild'];
const NAME_B = ['path', 'song', 'flame', 'oath', 'circle', 'court', 'kin', 'wake', 'ledger', 'grove', 'creed', 'covenant', 'way', 'writ'];
const MAX_IDEOLOGIES = 24;

/** Deterministically generate a new ideology (optionally forked). */
export function createIdeology(sim, founderName, parentIdeology = null) {
  if (sim.ideologies.length >= MAX_IDEOLOGIES) return null;
  const r = sim.rand;
  const base = parentIdeology;
  const mut = (v) => clamp(v + (r() - 0.5) * 0.4, 0.05, 0.95);
  const ideo = {
    id: sim.nextIdeologyId++,
    name: `The ${pick(r, NAME_A)}${pick(r, NAME_B)}`,
    type: base ? base.type : pick(r, TYPES),
    hue: base ? (base.hue + 40 + r() * 80) % 360 : (r() * 360) | 0,
    zeal: base ? mut(base.zeal) : 0.15 + r() * 0.7,
    tolerance: base ? mut(base.tolerance) : 0.15 + r() * 0.7,
    spreadRate: 0.2 + r() * 0.6,
    biases: {
      cooperation: r() - 0.5,   // socializing/building
      aggression: r() - 0.5,    // fighting/raiding
      fertility: 0.8 + r() * 0.5, // conception multiplier
      trade: r() - 0.5,
      exploration: r() - 0.5
    },
    founder: founderName || null,
    originTick: sim.tick,
    parentIdeologyId: base ? base.id : null,
    followers: 0
  };
  sim.ideologies.push(ideo);
  sim.ideologyById.set(ideo.id, ideo);
  return ideo;
}

/** Friction between two creeds: zeal × intolerance × doctrinal distance. */
export function ideologyConflict(A, B) {
  if (!A || !B || A.id === B.id) return 0;
  const dist = (Math.abs(A.biases.aggression - B.biases.aggression) +
    Math.abs(A.biases.cooperation - B.biases.cooperation) +
    Math.abs(A.biases.trade - B.biases.trade)) / 3;
  return A.zeal * B.zeal * (1 - A.tolerance) * (1 - B.tolerance) * (0.4 + dist);
}

/** Bias an action's decision score by the agent's creed (small, bounded). */
export function ideologyActionBias(sim, a, action) {
  if (a.ideology == null) return 0;
  const I = sim.ideologyById.get(a.ideology);
  if (!I) return 0;
  const c = a.conviction || 0.5;
  const b = I.biases;
  switch (action) {
    case 'fighting': return b.aggression * 0.35 * c;
    case 'trading': return b.trade * 0.35 * c;
    case 'exploring': case 'migrating': return b.exploration * 0.3 * c;
    case 'socializing': case 'building': return b.cooperation * 0.3 * c;
    default: return 0;
  }
}

/**
 * Exposure-based conversion roll. exposure ∈ (0,1] is how strongly the
 * source (parent/spouse/settlement/trade) projects the creed.
 */
export function tryConvert(sim, agent, ideology, exposure, sourceTrust = 0.5) {
  if (!ideology) return false;
  if (agent.ideology === ideology.id) {
    agent.conviction = clamp((agent.conviction || 0.5) + exposure * 0.05, 0, 1);
    return false;
  }
  const p = exposure * sourceTrust * ideology.spreadRate *
    (0.4 + agent.tolerance) * (1 - (agent.conviction || 0) * 0.8) * 0.4;
  if (sim.rand() < p) {
    agent.ideology = ideology.id;
    agent.conviction = 0.35 + sim.rand() * 0.3;
    return true;
  }
  return false;
}
