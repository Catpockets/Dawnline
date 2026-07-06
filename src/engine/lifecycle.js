// ---------------------------------------------------------------------------
// LIFECYCLE: age → life stage → action permission matrix.
// This is the hard safety layer that guarantees toddlers never wander the
// wilderness: if the utility AI or the learner picks an illegal action for an
// agent's life stage, it is blocked and replaced with a safe fallback.
// ---------------------------------------------------------------------------

/** Age thresholds (sim years). */
export const STAGE_BOUNDS = { infant: 3, child: 12, adolescent: 16, elder: 60 };

export function lifeStageOf(age) {
  if (age < STAGE_BOUNDS.infant) return 'infant';
  if (age < STAGE_BOUNDS.child) return 'child';
  if (age < STAGE_BOUNDS.adolescent) return 'adolescent';
  if (age < STAGE_BOUNDS.elder) return 'adult';
  return 'elder';
}

// Which FSM actions each stage may INDEPENDENTLY choose.
// (infants/children never reach decide() — they run the follow-guardian
// behaviour — but the matrix still guards against any stray transition.)
const P_INFANT = new Set(['idle', 'resting', 'child']);
const P_CHILD = new Set(['idle', 'resting', 'socializing', 'child']);
const P_ADOLESCENT = new Set([
  'idle', 'resting', 'socializing', 'seekFood', 'seekWater',
  'farming', 'building', 'returningHome', 'healing', 'fleeing', 'child'
]);
const P_ADULT = null; // null = everything allowed

const PERMISSIONS = {
  infant: P_INFANT,
  child: P_CHILD,
  adolescent: P_ADOLESCENT,
  adult: P_ADULT,
  elder: P_ADULT
};

/** May this agent independently perform this action right now? */
export function canAgentPerformAction(agent, action) {
  const allowed = PERMISSIONS[agent.lifeStage || lifeStageOf(agent.age)];
  return !allowed || allowed.has(action);
}

/** Legal, boring, safe thing to do when everything else is forbidden. */
export function getSafeFallbackAction(agent) {
  const stage = agent.lifeStage || lifeStageOf(agent.age);
  if (stage === 'infant' || stage === 'child') return 'child';
  return 'resting';
}

/** Physical performance multiplier by stage (speed, work output). */
export function physicalAbility(stage) {
  switch (stage) {
    case 'infant': return 0.25;
    case 'child': return 0.55;
    case 'adolescent': return 0.85;
    case 'elder': return 0.7;
    default: return 1;
  }
}

/** Risk appetite modifier: elders and parents of young kids take fewer risks. */
export function riskPenalty(agent, action) {
  if (action !== 'exploring' && action !== 'migrating' && action !== 'fighting') return 0;
  let pen = 0;
  if ((agent.lifeStage || lifeStageOf(agent.age)) === 'elder') pen += 0.45;
  if (agent.hasYoungKids) pen += 0.5; // parents don't gamble with dependents
  return pen;
}
