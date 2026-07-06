// ---------------------------------------------------------------------------
// AGENT SEARCH: find people by name, id, family, settlement, ideology or
// life stage. Runs only when the user types — never in the tick loop.
// ---------------------------------------------------------------------------
export function searchAgents(sim, query, limit = 24) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  const idQ = /^#?\d+$/.test(q) ? parseInt(q.replace('#', ''), 10) : null;
  for (const a of sim.agents) {
    if (a.dead) continue;
    const full = `${a.firstName} ${a.lastName}`.toLowerCase();
    const home = a.home >= 0 ? sim.settlementById.get(a.home) : null;
    const ideo = a.ideology != null ? sim.ideologyById.get(a.ideology) : null;
    let score = 0;
    if (idQ !== null && a.id === idQ) score = 100;
    else if (full === q) score = 90;
    else if (full.startsWith(q)) score = 80;
    else if (a.firstName.toLowerCase().startsWith(q) || a.lastName.toLowerCase().startsWith(q)) score = 60;
    else if (full.includes(q)) score = 40;
    else if (home && home.name.toLowerCase().includes(q)) score = 25;
    else if (ideo && ideo.name.toLowerCase().includes(q)) score = 22;
    else if ((a.lifeStage || '').startsWith(q)) score = 15;
    if (score > 0) {
      results.push({
        id: a.id, score,
        name: `${a.firstName} ${a.lastName}`,
        sex: a.sex, age: a.age | 0, stage: a.lifeStage,
        home: home ? home.name : 'nomad',
        ideology: ideo ? ideo.name : '—',
        state: a.state,
        family: a.lastName
      });
    }
  }
  results.sort((x, y) => y.score - x.score || x.age - y.age);
  return results.slice(0, limit);
}
