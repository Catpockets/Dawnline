import React from 'react';

const h = React.createElement;
const { useState } = React;

const WINDOW_YEARS = 80; // how much history stays visible before sliding off

/**
 * "Birds on a wire" timeline. Milestones (wars, foundings, collapses,
 * discoveries, plagues, disasters) perch as emoji on a horizontal wire that
 * slides left as the years pass; click one for a summary bubble. Mostly
 * static — new events appear at the right edge and drift off the left.
 */
export default function Timeline({ milestones, tick, ticksPerYear }) {
  const [popup, setPopup] = useState(null);

  const now = tick / ticksPerYear;
  const t0 = Math.max(0, now - WINDOW_YEARS);
  const span = Math.max(1, now - t0);
  const xOf = (yr) => `${((yr - t0) / span) * 96 + 2}%`;

  // decade gridlines
  const decades = [];
  for (let y = Math.ceil(t0 / 10) * 10; y <= now; y += 10) decades.push(y);

  const visible = [];
  for (let i = milestones.length - 1; i >= 0 && visible.length < 90; i--) {
    const m = milestones[i];
    if (m.tick / ticksPerYear < t0) break;
    visible.push(m);
  }
  visible.reverse();

  return h('div', { className: 'timeline' },
    h('div', { className: 'tl-title' }, 'CHRONICLE · last ' + Math.round(span) + ' years'),
    h('div', { className: 'wire' }),
    decades.map((y) => h('div', { key: 'y' + y, className: 'yearmark', style: { left: xOf(y) } },
      h('div', { className: 'tickline' }),
      h('span', null, 'Y' + y)
    )),
    visible.map((m, i) => h('button', {
      key: m.tick + '-' + i,
      className: 'milestone' + (i % 2 ? ' row1' : ''),
      style: { left: xOf(m.tick / ticksPerYear) },
      title: `Y${m.year} — ${m.text}`,
      onClick: (e) => {
        e.stopPropagation();
        setPopup(popup && popup.m === m ? null : { m, x: e.currentTarget.offsetLeft });
      }
    }, m.icon)),
    h('div', { className: 'tl-now' }, 'Y' + (now | 0)),
    popup ? h('div', {
      className: 'tl-popup',
      style: { left: Math.max(120, Math.min(popup.x, 99999)) }
    },
      h('b', null, `Y${popup.m.year} `),
      `${popup.m.icon} ${popup.m.text}`,
      h('button', { className: 'tiny', style: { marginLeft: 8 }, onClick: () => setPopup(null) }, '✕')
    ) : null
  );
}
