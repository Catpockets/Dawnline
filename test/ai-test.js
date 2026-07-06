// ---------------------------------------------------------------------------
// AI systems test suite: determinism, lifecycle safety, learning, ideology,
// resources, colonies, performance. Run: node test/ai-test.js
// ---------------------------------------------------------------------------
import { Simulation } from '../src/engine/simulation.js';
import { lifeStageOf, canAgentPerformAction } from '../src/engine/lifecycle.js';
import { learnReward, qValue, buildContext, CTX_DIM } from '../src/engine/learning.js';
import { areCloselyRelated } from '../src/engine/families.js';
import { PREGNANCY_TICKS, TICKS_PER_YEAR } from '../src/engine/agents.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}`); }
};

// ===== 1. DETERMINISM ======================================================
console.log('\n[determinism]');
{
  const run = () => {
    const sim = new Simulation({ seed: 'ai-det', startPop: 240 });
    for (let t = 0; t < 1500; t++) sim.tickOnce();
    return sim;
  };
  const A = run(), B = run();
  ok(A.stats.population === B.stats.population && A.stats.deaths === B.stats.deaths,
    `same population & deaths (${A.stats.population})`);
  const namesA = A.agents.slice(0, 10).map(a => a.firstName + a.lastName).join(',');
  const namesB = B.agents.slice(0, 10).map(a => a.firstName + a.lastName).join(',');
  ok(namesA === namesB, 'same agent names');
  ok(A.ideologies.map(i => i.name + i.type).join() === B.ideologies.map(i => i.name + i.type).join(),
    `same ideologies (${A.ideologies.length})`);
  let sumA = 0, sumB = 0;
  for (let i = 0; i < A.world.herbs.length; i += 7) { sumA += A.world.herbs[i] + A.world.salt[i]; sumB += B.world.herbs[i] + B.world.salt[i]; }
  ok(Math.abs(sumA - sumB) < 1e-6, 'same resource deposits');
  ok(A.milestones.slice(0, 15).map(m => m.text).join('|') === B.milestones.slice(0, 15).map(m => m.text).join('|'),
    'same first chronicle events');
  ok(A.totals.marriages === B.totals.marriages && A.totals.colonies === B.totals.colonies,
    `same marriages (${A.totals.marriages}) & colonies (${A.totals.colonies})`);
}

// ===== 2. LIFECYCLE SAFETY =================================================
console.log('\n[lifecycle]');
{
  const sim = new Simulation({ seed: 'ai-life', startPop: 300 });
  let minorViolations = 0, kidChecked = 0, followerKids = 0;
  for (let t = 0; t < 2500; t++) {
    sim.tickOnce();
    if (t % 50 === 0) {
      for (const a of sim.agents) {
        if (a.dead) continue;
        if (a.age < 12 && (a.state === 'exploring' || a.state === 'migrating' ||
            a.state === 'fighting' || a.state === 'trading')) minorViolations++;
        if (a.age >= 3 && a.age < 12) {
          kidChecked++;
          if (a.state === 'child') followerKids++;
        }
      }
    }
  }
  ok(minorViolations === 0, `no under-12 ever explores/migrates/fights/trades (${kidChecked} child-samples)`);
  ok(followerKids === kidChecked, 'all children run follow-guardian behaviour');
  ok(PREGNANCY_TICKS === Math.round(TICKS_PER_YEAR * 0.75), `pregnancy = ${PREGNANCY_TICKS} ticks = 9 months`);
  ok(lifeStageOf(1) === 'infant' && lifeStageOf(8) === 'child' && lifeStageOf(14) === 'adolescent' &&
     lifeStageOf(30) === 'adult' && lifeStageOf(70) === 'elder', 'life stage thresholds');
  ok(!canAgentPerformAction({ age: 5, lifeStage: 'child' }, 'exploring') &&
     !canAgentPerformAction({ age: 14, lifeStage: 'adolescent' }, 'migrating') &&
     canAgentPerformAction({ age: 30, lifeStage: 'adult' }, 'exploring'), 'permission matrix');
  const baby = sim.agents.find(a => !a.dead && a.age < 2 && a.mother >= 0);
  ok(!!baby && baby.familyId >= 0 && baby.lastName.length > 1, 'newborn has mother/family/surname refs');
  const mkA = { id: 1, mother: 10, father: 11, sex: 'M' };
  ok(areCloselyRelated(mkA, { id: 2, mother: 10, father: 12 }), 'siblings blocked (shared mother)');
  ok(areCloselyRelated(mkA, { id: 10, mother: -1, father: -1 }), 'parent-child blocked');
  ok(!areCloselyRelated(mkA, { id: 3, mother: 20, father: 21 }), 'unrelated pair allowed');
  const married = sim.agents.filter(a => !a.dead && a.spouse >= 0).slice(0, 30);
  let shared = 0, checked = 0;
  for (const a of married) {
    const sp = sim.agentById.get(a.spouse);
    if (sp) { checked++; if (sp.lastName === a.lastName) shared++; }
  }
  ok(checked > 0 && shared === checked, `married couples share surname (${shared}/${checked})`);
}

// ===== 3. LEARNING =========================================================
console.log('\n[learning]');
{
  const sim = new Simulation({ seed: 'ai-learn', startPop: 120 });
  for (let t = 0; t < 100; t++) sim.tickOnce();
  const a = sim.agents.find(x => !x.dead && x.age > 16);
  a.lastCtx = a.lastCtx || new Float32Array(CTX_DIM);
  buildContext(sim, a, a.lastCtx);
  const before = qValue(a, 'trading', a.lastCtx);
  for (let i = 0; i < 25; i++) learnReward(sim, a, 'trading', 1);
  const after = qValue(a, 'trading', a.lastCtx);
  ok(after > before + 0.3, `reward raises learned preference (${before.toFixed(2)} -> ${after.toFixed(2)})`);
  for (let i = 0; i < 400; i++) learnReward(sim, a, 'trading', 5);
  let bounded = true;
  for (const w of a.theta.trading) if (Math.abs(w) > 2.001) bounded = false;
  ok(bounded, 'weights stay bounded under extreme reward');
  ok(a.rewards.length <= 6, 'reward memory bounded');
  for (let i = 0; i < 25; i++) learnReward(sim, a, 'exploring', -1.5);
  ok(qValue(a, 'trading', a.lastCtx) > qValue(a, 'exploring', a.lastCtx), 'learning reorders action ranking');
  const sim2 = new Simulation({ seed: 'ai-inherit', startPop: 260 });
  for (let t = 0; t < 3000; t++) sim2.tickOnce();
  let inherited = 0, kids = 0;
  for (const c of sim2.agents) {
    if (c.dead || c.age < 4 || c.age >= 12) continue;
    kids++;
    if (Object.keys(c.theta).length > 0) inherited++;
  }
  ok(kids === 0 || inherited > 0, `children absorb caretaker behaviour (${inherited}/${kids})`);
}

// ===== 4. IDEOLOGY =========================================================
console.log('\n[ideology]');
{
  const sim = new Simulation({ seed: 'ai-ideo', startPop: 320 });
  for (let t = 0; t < 4000; t++) sim.tickOnce();
  ok(sim.ideologies.length > 0, `ideologies emerged (${sim.ideologies.length})`);
  const withCreed = sim.agents.filter(a => !a.dead && a.ideology != null).length;
  ok(withCreed > 10, `ideology spread through population (${withCreed} followers)`);
  ok(sim.totals.conversions > 0, `conversions occurred (${sim.totals.conversions})`);
  let starvingSeekers = 0, starving = 0;
  for (const a of sim.agents) {
    if (!a.dead && a.age >= 16 && a.hunger > 85 && a.ideology != null) {
      starving++;
      if (a.state === 'seekFood' || a.state === 'returningHome' || a.state === 'farming') starvingSeekers++;
    }
  }
  ok(starving === 0 || starvingSeekers / starving > 0.4, `survival overrides creed (${starvingSeekers}/${starving})`);
}

// ===== 5. RESOURCES & SPECIALIZATION =======================================
console.log('\n[resources]');
{
  const sim = new Simulation({ seed: 'ai-res', startPop: 300, worldW: 150, worldH: 96 });
  const w = sim.world;
  let herbT = 0, saltT = 0, fishT = 0, clayT = 0;
  for (let i = 0; i < w.herbs.length; i++) {
    if (w.herbs[i] > 5) herbT++;
    if (w.salt[i] > 5) saltT++;
    if (w.fish[i] > 5) fishT++;
    if (w.clay[i] > 5) clayT++;
  }
  ok(herbT > 20 && saltT > 10 && fishT > 20 && clayT > 20,
    `deposits exist (herbs ${herbT}, salt ${saltT}, fish ${fishT}, clay ${clayT} tiles)`);
  ok(herbT < w.herbs.length * 0.2, 'herbs are scarce & clustered, not uniform');
  const quad = [0, 0, 0, 0];
  for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
    quad[(y < w.h / 2 ? 0 : 2) + (x < w.w / 2 ? 0 : 1)] += w.herbs[y * w.w + x];
  }
  const spread = Math.max(...quad) - Math.min(...quad);
  ok(spread > 50, `regional inequality in herbs (quadrant spread ${spread | 0})`);
  for (let t = 0; t < 4000; t++) sim.tickOnce();
  const specialties = new Set(sim.settlements.filter(s => !s.dead && s.specialty).map(s => s.specialty));
  ok(specialties.size >= 1, `settlements specialized: ${[...specialties].join(', ') || 'none'}`);
}

// ===== 6. COLONIES =========================================================
console.log('\n[colonies]');
{
  const sim = new Simulation({ seed: 'ai-colony', startPop: 700 });
  for (let t = 0; t < 6000 && sim.totals.colonies === 0; t++) sim.tickOnce();
  ok(sim.totals.colonies > 0, `overcrowding produced colonies (${sim.totals.colonies})`);
  const colony = sim.settlements.find(s => s.parentSettlementId != null);
  ok(!!colony, 'colony stores parentSettlementId + originReason: ' + (colony ? colony.originReason : 'none'));
  if (colony) {
    let solo = 0;
    for (const a of sim.agents) {
      if (a.dead || a.home !== colony.id || a.age >= 12) continue;
      const m = a.mother >= 0 && sim.agentById.get(a.mother);
      const f = a.father >= 0 && sim.agentById.get(a.father);
      const g = a.guardian >= 0 && sim.agentById.get(a.guardian);
      if (!m && !f && !g) solo++;
    }
    ok(solo === 0, 'no unaccompanied children in the colony');
  }
}

// ===== 7. PERFORMANCE ======================================================
console.log('\n[performance]');
{
  const sim = new Simulation({ seed: 'ai-stress', startPop: 2200, worldW: 150, worldH: 96 });
  const t0 = performance.now();
  for (let t = 0; t < 400; t++) sim.tickOnce();
  const ms = (performance.now() - t0) / 400;
  ok(ms < 12, `stress tick ${ms.toFixed(2)} ms (< 12 ms keeps 60fps at 1x)`);
  ok(sim.stats.population > 1200, `stress population alive (${sim.stats.population})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
