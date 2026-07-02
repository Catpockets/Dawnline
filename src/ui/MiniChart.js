import React from 'react';

// Written with React.createElement (no JSX) so the project builds both under
// Vite and under the dependency-free standalone bundler in scripts/.
const { useEffect, useRef } = React;
const h = React.createElement;

/**
 * Tiny time-series chart drawn on its own canvas (no chart library).
 * Redraws whenever the snapshot re-renders; cheap enough at 4 Hz.
 */
export default function MiniChart({ label, data, color = '#5eead4', format = (v) => Math.round(v) }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const wCss = canvas.clientWidth || 120, hCss = 42;
    canvas.width = wCss * dpr; canvas.height = hCss * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, wCss, hCss);
    if (!data || data.length < 2) return;

    let min = Infinity, max = -Infinity;
    for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
    if (max - min < 1e-6) { max = min + 1; }
    const pad = 3;
    const xw = (wCss - 2) / (data.length - 1);
    const yOf = (v) => hCss - pad - ((v - min) / (max - min)) * (hCss - pad * 2);

    // gradient area fill under the line
    const grad = ctx.createLinearGradient(0, 0, 0, hCss);
    grad.addColorStop(0, color + '55');
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(1, yOf(data[0]));
    for (let i = 1; i < data.length; i++) ctx.lineTo(1 + i * xw, yOf(data[i]));
    ctx.lineTo(1 + (data.length - 1) * xw, hCss);
    ctx.lineTo(1, hCss);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(1, yOf(data[0]));
    for (let i = 1; i < data.length; i++) ctx.lineTo(1 + i * xw, yOf(data[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  });

  const last = data && data.length ? data[data.length - 1] : 0;
  return h('div', { className: 'chart-box' },
    h('div', { className: 'label' },
      h('span', null, label),
      h('b', null, format(last))
    ),
    h('canvas', { ref })
  );
}
