// ---------------------------------------------------------------------------
// BUNDLE RUNTIME TEST: the standalone build strips ES-module syntax and
// concatenates files into one scope. `node --check` catches syntax errors but
// NOT missing identifiers (e.g. stripped import aliases) — those only explode
// at runtime in the browser. This test runs the engine through the exact same
// strip pipeline and ticks it hard, so any concatenation bug fails CI here.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// keep in sync with build-standalone.mjs (engine subset, same order)
const ENGINE_MODULES = [
  'src/engine/rng.js',
  'src/engine/names.js',
  'src/engine/world.js',
  'src/engine/lifecycle.js',
  'src/engine/learning.js',
  'src/engine/ideologies.js',
  'src/engine/families.js',
  'src/engine/search.js',
  'src/engine/agents.js',
  'src/engine/settlements.js',
  'src/engine/simulation.js'
];

function stripModuleSyntax(code) {
  return code
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+default\s+function/gm, 'function')
    .replace(/^export\s+default\s+class/gm, 'class')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+function/gm, 'function')
    .replace(/^export\s+const/gm, 'const')
    .replace(/^export\s+class/gm, 'class')
    .replace(/^const h = React\.createElement;\s*$/gm, '')
    .replace(/^const \{[^}]*\} = React;\s*$/gm, '');
}

let src = "'use strict';\n";
for (const m of ENGINE_MODULES) {
  if (m === 'src/engine/simulation.js') src += '\nconst buildContribute = contributeBuild;\n';
  src += `\n// ===== ${m} =====\n` + stripModuleSyntax(read(m));
}
src += '\nreturn { Simulation, searchAgents };';

let engine;
try {
  engine = new Function(src)();
} catch (e) {
  console.error('BUNDLE EVAL FAILED:', e.message);
  process.exit(1);
}

// run long enough to hit every staggered subsystem:
// ideology pass (t=11), colonies (t=33), births (t≈24+), schism check (t=277)
const sim = new engine.Simulation({ seed: 'bundle-check', startPop: 300 });
try {
  for (let t = 0; t < 900; t++) sim.tickOnce();
} catch (e) {
  console.error(`BUNDLE RUNTIME FAILED at tick ${sim.tick}:`, e.message);
  process.exit(1);
}
const s = sim.stats;
const hits = engine.searchAgents(sim, sim.agents.find(a => !a.dead).lastName);
console.log(`bundle engine ran 900 ticks: pop=${s.population} births=${s.births} marriages=${s.marriages} ideologies=${sim.ideologies.length} search=${hits.length} hits`);
if (s.births === 0) { console.error('FAIL: no births in bundled engine'); process.exit(1); }
if (s.population === 0) { console.error('FAIL: extinction in bundled engine'); process.exit(1); }
console.log('BUNDLE_RUNTIME_OK');
