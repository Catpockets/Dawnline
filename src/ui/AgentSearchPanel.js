import React from 'react';

const h = React.createElement;
const { useState } = React;

/**
 * Find-a-person panel: search by name, family, settlement, ideology, life
 * stage or #id. Search runs only on keystrokes (never in the sim loop);
 * clicking a result selects, centers and follows the agent on the map.
 */
export default function AgentSearchPanel({ onSearch, onPick }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);

  const run = (value) => {
    setQ(value);
    setResults(value.trim() ? onSearch(value) : []);
  };

  return h('div', { className: 'section' },
    h('h3', null, 'Find People'),
    h('input', {
      type: 'text', value: q, placeholder: 'name, family, city, creed, #id…',
      onChange: (e) => run(e.target.value)
    }),
    results.length > 0 ? h('div', { className: 'search-results' },
      results.map((r) => h('button', {
        key: r.id, className: 'search-hit',
        onClick: () => { onPick(r.id); setResults([]); setQ(''); }
      },
        h('b', null, `${r.sex === 'F' ? '♀' : '♂'} ${r.name}`),
        h('span', null, `${r.stage}, ${r.age} · ${r.home} · ${r.state}`)
      ))
    ) : (q.trim() ? h('div', { className: 'mem' }, 'No one found.') : null)
  );
}
