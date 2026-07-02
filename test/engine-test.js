// Headless stress test: runs the simulation engine in Node (no DOM) to verify
// the tick pipeline, emergence and performance before it ever hits a browser.
import { Simulation } from '../src/engine/simulation.js';

function run(label, params, ticks) {
  const t0 = performance.now();
  const sim = new Simulation(params);
  const genMs = performance.now() - t0;

  const t1 = performance.now();
  for (let i = 0; i < ticks; i++) sim.tickOnce();
  const simMs = performance.now() - t1;

  const s = sim.stats;
  console.log(`\n=== ${label} ===`);
  console.log(`worldgen ${genMs.toFixed(0)}ms | ${ticks} ticks in ${simMs.toFixed(0)}ms (${(simMs / ticks).toFixed(2)} ms/tick)`);
  console.log(`year ${s.year} | pop ${s.population} (births ${s.births}, deaths ${s.deaths})`);
  console.log(`settlements ${s.settlements} | routes ${s.tradeRoutes} | conflicts ${s.conflicts} | sick ${s.diseaseCases}`);
  console.log(`avg health ${s.avgHealth.toFixed(1)} | avg hunger ${s.avgHunger.toFixed(1)} | avg tech ${s.avgTech.toFixed(2)}`);
  console.log(`inequality ${s.inequality.toFixed(2)} | collapse risk ${(s.collapseRisk * 100).toFixed(0)}% | largest ${s.largest}`);
  console.log(`events logged: ${sim.events.length}, last: "${sim.events[sim.events.length - 1]?.text ?? '—'}"`);

  if (s.population <= 0) console.log('⚠ WARNING: population extinct');
  if (!(simMs / ticks < 50)) console.log('⚠ WARNING: tick too slow');
  return sim;
}

// determinism check: same seed twice must produce identical stats
const a = run('Determinism A (seed=det, 300 ticks)', { seed: 'det', startPop: 200 }, 300);
const b = run('Determinism B (seed=det, 300 ticks)', { seed: 'det', startPop: 200 }, 300);
console.log(`\nDeterministic: ${a.stats.population === b.stats.population && a.stats.deaths === b.stats.deaths ? 'YES ✓' : 'NO ✗ (pop ' + a.stats.population + ' vs ' + b.stats.population + ')'}`);

run('Standard (260 agents, 2400 ticks ≈ 80 years)', { seed: 'genesis-42', startPop: 260 }, 2400);
run('Stress (2200 agents, large world, 800 ticks)', { seed: 'stress', startPop: 2200, worldW: 150, worldH: 96 }, 800);
console.log('\nEngine test complete.');
