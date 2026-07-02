// ---------------------------------------------------------------------------
// Dependency-free single-file builder.
//
// Produces dist/index.html: a fully self-contained app that runs from disk
// (file://) with zero install. The React API is provided by preact/compat
// (vendored in ./vendor, API-compatible with React 18); the app source is
// plain createElement JavaScript, so no JSX transform is required.
//
// If you have network access, `npm install && npm run build` produces the
// same app on real React via Vite instead.
//
// Usage: node scripts/build-standalone.mjs
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Modules concatenated in dependency order (imports/exports stripped).
const MODULES = [
  'src/engine/rng.js',
  'src/engine/world.js',
  'src/engine/agents.js',
  'src/engine/settlements.js',
  'src/engine/simulation.js',
  'src/render/renderer.js',
  'src/ui/MiniChart.js',
  'src/ui/Controls.js',
  'src/ui/Analytics.js',
  'src/ui/Inspector.js',
  'src/App.js',
  'src/main.js'
];

/** Strip ES module syntax so files concatenate into one classic script. */
function stripModuleSyntax(code) {
  return code
    // import { a, b as c } from '...';  (possibly multi-line)
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    // import './styles.css';
    .replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+default\s+function/gm, 'function')
    .replace(/^export\s+default\s+class/gm, 'class')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+function/gm, 'function')
    .replace(/^export\s+const/gm, 'const')
    .replace(/^export\s+class/gm, 'class')
    // per-file React helper aliases would collide when concatenated into one
    // scope — they are emitted once in the prelude instead
    .replace(/^const h = React\.createElement;\s*$/gm, '')
    .replace(/^const \{[^}]*\} = React;\s*$/gm, '');
}

let app = '';
for (const m of MODULES) {
  // simulation.js aliases contributeBuild on import; recreate the alias here
  if (m === 'src/engine/simulation.js') {
    app += '\nconst buildContribute = contributeBuild;\n';
  }
  app += `\n// ========== ${m} ==========\n` + stripModuleSyntax(read(m));
}

const prelude = `
// React API provided by preact/compat (vendored). createRoot shim matches
// the react-dom/client entry the Vite build uses.
const React = self.preactCompat;
const createRoot = (container) => ({
  render: (el) => React.render(el, container),
  unmount: () => React.render(null, container)
});
const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Human Civilization Emergence Simulator</title>
<style>
${read('src/styles.css')}
</style>
</head>
<body>
<div id="root"></div>
<script>${read('vendor/preact.min.umd.js')}</script>
<script>${read('vendor/hooks.umd.js')}</script>
<script>${read('vendor/compat.umd.js')}</script>
<script>
(function () {
'use strict';
${prelude}
${app}
})();
</script>
</body>
</html>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/index.html'), html);
console.log(`dist/index.html written (${(html.length / 1024).toFixed(0)} KB)`);
