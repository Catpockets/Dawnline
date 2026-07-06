// ---------------------------------------------------------------------------
// FAMILIES: marriage rules (incest-blocked, ideology-aware), shared surnames,
// family ids, guardianship lookup. Families are the unit of colony migration
// and household resource sharing.
// ---------------------------------------------------------------------------
import { remember } from './agents.js';
import { ideologyConflict } from './ideologies.js';

/** Obvious close-kin check: parent/child/sibling via recorded lineage. */
export function areCloselyRelated(a, b) {
  if (a.mother >= 0 && (a.mother === b.id || (b.mother >= 0 && a.mother === b.mother))) return true;
  if (a.father >= 0 && (a.father === b.id || (b.father >= 0 && a.father === b.father))) return true;
  if (b.mother === a.id || b.father === a.id) return true;
  return false;
}

/**
 * Attempt a marriage. Enforces: adults only, opposite sex, both single,
 * not close kin, and ideological compatibility (zealous opposed creeds
 * rarely intermarry). On success: shared surname + shared familyId.
 * Returns true if the marriage happened.
 */
export function tryMarry(sim, a, b) {
  if (a.spouse >= 0 || b.spouse >= 0) return false;
  if (a.sex === b.sex) return false;
  if (a.age <= 16 || a.age >= 55 || b.age <= 16 || b.age >= 55) return false;
  if (areCloselyRelated(a, b)) return false;
  // ideology friction: conflicting creeds block most intermarriage
  if (sim.params.enableIdeology !== false) {
    const IA = a.ideology != null ? sim.ideologyById.get(a.ideology) : null;
    const IB = b.ideology != null ? sim.ideologyById.get(b.ideology) : null;
    const conflict = ideologyConflict(IA, IB);
    if (conflict > 0.12 && sim.rand() < Math.min(0.92, conflict * 2.4)) return false;
  }
  const husband = a.sex === 'M' ? a : b;
  const wife = husband === a ? b : a;
  // shared surname + household id (the family registry key)
  wife.lastName = husband.lastName;
  wife.familyId = husband.familyId;
  a.spouse = b.id; b.spouse = a.id;
  remember(a, `married ${b.firstName}`, b, 0.4);
  remember(b, `married ${a.firstName}`, a, 0.4);
  sim.totals.marriages++;
  if (sim.totals.marriages % 12 === 1) {
    sim.addEvent(`${husband.firstName} & ${wife.firstName} ${husband.lastName} wed`, 'good');
  }
  return true;
}

/** Living caretaker in priority order: mother → father → guardian. */
export function findGuardian(sim, a) {
  for (const id of [a.mother, a.father, a.guardian]) {
    if (id >= 0) {
      const p = sim.agentById.get(id);
      if (p && !p.dead) return p;
    }
  }
  return null;
}

/** Snapshot of an agent's close family for UI highlighting (bounded). */
export function familyCircle(sim, a) {
  const out = { spouse: null, mother: null, father: null, children: [] };
  if (a.spouse >= 0) out.spouse = sim.agentById.get(a.spouse) || null;
  if (a.mother >= 0) out.mother = sim.agentById.get(a.mother) || null;
  if (a.father >= 0) out.father = sim.agentById.get(a.father) || null;
  for (const cid of a.children) {
    const c = sim.agentById.get(cid);
    if (c) out.children.push(c);
    if (out.children.length >= 10) break;
  }
  return out;
}
