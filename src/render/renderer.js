// ---------------------------------------------------------------------------
// Canvas renderer. React never touches individual agents — this class draws
// the whole world every animation frame straight to a single <canvas>:
//   terrain (pre-rendered offscreen, 1px per tile, scaled smoothly)
//   → data overlay (offscreen heat map, refreshed every ~12 ticks)
//   → trade routes → migration trails → agents → settlements → flashes.
// Supports smooth zoom (wheel) and pan (drag) via a world-space view.
// ---------------------------------------------------------------------------
import { TERRAIN } from '../engine/world.js';
import { dominantCulture } from '../engine/settlements.js';
import { clamp, mulberry32 } from '../engine/rng.js';

const CULTURE_COLORS = {
  expansionist: [230, 120, 60], peaceful: [110, 200, 150], religious: [190, 150, 240],
  militaristic: [235, 80, 80], commercial: [250, 200, 90], isolationist: [130, 140, 160],
  innovative: [90, 200, 240], authoritarian: [180, 90, 140], communal: [140, 220, 100]
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = null;
    this.view = { cx: 0, cy: 0, scale: 8 };
    this.overlay = 'none';
    this.showRoutes = true;
    this.showTrails = true;
    this.selected = null; // {type:'agent'|'settlement', id}
    this.terrainCanvas = document.createElement('canvas');
    this.overlayCanvas = document.createElement('canvas');
    this.lastOverlayTick = -999;
  }

  attach(sim) {
    this.sim = sim;
    const w = sim.world;
    this.overlayCanvas.width = w.w; this.overlayCanvas.height = w.h;
    this.renderTerrain();
    this.lastOverlayTick = -999;
    // fit world to screen
    this.view.cx = w.w / 2; this.view.cy = w.h / 2;
    this.fit();
  }

  fit() {
    if (!this.sim) return;
    const w = this.sim.world;
    this.view.scale = Math.min(this.canvas.width / w.w, this.canvas.height / w.h) * 0.96;
    this.view.cx = w.w / 2; this.view.cy = w.h / 2;
  }

  resize(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  // ---- pre-render terrain to a SUPERSAMPLED offscreen canvas --------------
  // Instead of 1 pixel per tile (which upscales blurry), the map is baked at
  // 4–8 px per tile with bilinear biome blending, hillshading from the
  // elevation gradient, depth-graded water, shoreline bands, beaches,
  // snowcaps and fine texture noise. One-time cost per world generation.
  renderTerrain() {
    const w = this.sim.world;
    const S = Math.max(4, Math.min(8, Math.floor(1300 / Math.max(w.w, w.h))));
    const W = w.w * S, H = w.h * S;
    this.terrainCanvas.width = W; this.terrainCanvas.height = H;
    const tctx = this.terrainCanvas.getContext('2d');

    // per-tile base colors with deterministic jitter (breaks up flat fields)
    const rand = mulberry32(w.seed ^ 0xbeefcafe);
    const nT = w.w * w.h;
    const baseR = new Float32Array(nT), baseG = new Float32Array(nT), baseB = new Float32Array(nT);
    for (let i = 0; i < nT; i++) {
      let r, g, b;
      switch (w.terrain[i]) {
        case TERRAIN.WATER: r = 30; g = 70; b = 118; break; // overridden by depth below
        case TERRAIN.PLAINS: r = 126; g = 148; b = 84; break;
        case TERRAIN.FOREST: r = 50; g = 102; b = 58; break;
        case TERRAIN.DESERT: r = 216; g = 186; b = 124; break;
        case TERRAIN.MOUNTAIN: r = 130; g = 126; b = 128; break;
        case TERRAIN.FERTILE: r = 104; g = 158; b = 72; break;
        default: r = g = b = 0;
      }
      const j = 0.9 + rand() * 0.2;
      baseR[i] = r * j; baseG[i] = g * j; baseB[i] = b * j;
    }

    const img = tctx.createImageData(W, H);
    const d = img.data;
    const elev = new Float32Array(W * H);
    const ew = w.w, eh = w.h;
    const cx = (v, hi) => v < 0 ? 0 : v > hi ? hi : v;

    // pass 1: bilinear-blend biome colors + elevation for every subpixel
    for (let py = 0; py < H; py++) {
      const fy = (py + 0.5) / S - 0.5;
      const y0 = Math.floor(fy), ty = fy - y0;
      const ya = cx(y0, eh - 1), yb = cx(y0 + 1, eh - 1);
      for (let px = 0; px < W; px++) {
        const fx = (px + 0.5) / S - 0.5;
        const x0 = Math.floor(fx), tx = fx - x0;
        const xa = cx(x0, ew - 1), xb = cx(x0 + 1, ew - 1);
        const i00 = ya * ew + xa, i10 = ya * ew + xb, i01 = yb * ew + xa, i11 = yb * ew + xb;
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        const idx = py * W + px;
        elev[idx] = w.elevation[i00] * w00 + w.elevation[i10] * w10 +
                    w.elevation[i01] * w01 + w.elevation[i11] * w11;
        d[idx * 4]     = baseR[i00] * w00 + baseR[i10] * w10 + baseR[i01] * w01 + baseR[i11] * w11;
        d[idx * 4 + 1] = baseG[i00] * w00 + baseG[i10] * w10 + baseG[i01] * w01 + baseG[i11] * w11;
        d[idx * 4 + 2] = baseB[i00] * w00 + baseB[i10] * w10 + baseB[i01] * w01 + baseB[i11] * w11;
        d[idx * 4 + 3] = 255;
      }
    }

    // pass 2: water depth, shorelines, beaches, snowcaps, hillshade, texture
    const sea = 0.34;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const idx = py * W + px;
        const e = elev[idx];
        let r = d[idx * 4], g = d[idx * 4 + 1], b = d[idx * 4 + 2];

        if (e < sea) {
          // depth-graded ocean: deep navy → shallow turquoise
          const t = Math.max(0, e / sea); const tt = t * t;
          r = 10 + 40 * tt; g = 32 + 84 * tt; b = 64 + 112 * tt;
          if (e > sea - 0.035) { // bright aqua band hugging the coast
            const k = (e - (sea - 0.035)) / 0.035;
            r += 34 * k; g += 50 * k; b += 42 * k;
          }
        } else {
          if (e < sea + 0.045) { // sandy beach ring on low coastal land
            const k = 1 - (e - sea) / 0.045;
            r += (218 - r) * 0.55 * k; g += (198 - g) * 0.55 * k; b += (152 - b) * 0.55 * k;
          }
          if (e > 0.88) { // snowcaps on the highest peaks
            const k = (e - 0.88) / 0.12;
            r += (236 - r) * k; g += (241 - g) * k; b += (248 - b) * k;
          }
          // hillshade from the local elevation gradient (light from NW)
          const eL = px > 0 ? elev[idx - 1] : e;
          const eU = py > 0 ? elev[idx - W] : e;
          const sh = clamp(1 + ((e - eL) + (e - eU)) * S * 1.5, 0.7, 1.3);
          r *= sh; g *= sh; b *= sh;
        }

        // fine deterministic texture noise (grain that survives zoom)
        let hsh = (px * 374761393 + py * 668265263) | 0;
        hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177);
        const nz = 0.955 + (((hsh >>> 16) & 255) / 255) * 0.09;
        d[idx * 4] = clamp(r * nz, 0, 255);
        d[idx * 4 + 1] = clamp(g * nz, 0, 255);
        d[idx * 4 + 2] = clamp(b * nz, 0, 255);
      }
    }
    tctx.putImageData(img, 0, 0);
  }

  // ---- data overlays as translucent heat maps -----------------------------
  updateOverlay() {
    const sim = this.sim, w = sim.world;
    const ctx = this.overlayCanvas.getContext('2d');
    const img = ctx.createImageData(w.w, w.h);
    const d = img.data;
    const set = (i, r, g, b, a) => { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; };
    const heat = (i, v, col) => { const a = clamp(v, 0, 1); set(i, col[0], col[1], col[2], a * 200); };
    const n = w.w * w.h;

    if (this.overlay === 'food') {
      for (let i = 0; i < n; i++) heat(i, w.food[i] / 90, [110, 235, 120]);
    } else if (this.overlay === 'water') {
      for (let i = 0; i < n; i++) heat(i, w.water[i] / 100, [80, 170, 255]);
    } else if (this.overlay === 'fertility') {
      for (let i = 0; i < n; i++) heat(i, w.fertility[i], [200, 240, 90]);
    } else if (this.overlay === 'disease') {
      const sickMap = new Float32Array(n);
      for (const a of sim.agents) if (!a.dead && a.sick) sickMap[(a.y | 0) * w.w + (a.x | 0)] += 0.5;
      for (let i = 0; i < n; i++) heat(i, w.disease[i] * 0.35 + sickMap[i], [170, 240, 60]);
    } else if (this.overlay === 'conflict') {
      for (let i = 0; i < n; i++) heat(i, w.danger[i], [255, 80, 60]);
    } else if (this.overlay === 'density') {
      const dm = new Float32Array(n);
      for (const a of sim.agents) if (!a.dead) dm[(a.y | 0) * w.w + (a.x | 0)] += 0.25;
      for (let i = 0; i < n; i++) heat(i, dm[i], [255, 180, 80]);
    } else if (['influence', 'tech', 'wealth', 'culture'].includes(this.overlay)) {
      // settlement-field overlays: paint radial gradients per settlement
      for (const s of sim.settlements) {
        if (s.dead) continue;
        const R = 5 + Math.sqrt(s.members) * 1.6;
        let col, mag;
        if (this.overlay === 'influence') { col = hueRgb(s.hue); mag = 0.8; }
        else if (this.overlay === 'tech') { col = [90, 210, 255]; mag = clamp(s.tech / 10, 0.08, 1); }
        else if (this.overlay === 'wealth') { col = [255, 215, 90]; mag = clamp(s.wealth / 120, 0.08, 1); }
        else { col = CULTURE_COLORS[dominantCulture(s)] || [200, 200, 200]; mag = 0.85; }
        const x0 = Math.max(0, (s.x - R) | 0), x1 = Math.min(w.w - 1, (s.x + R) | 0);
        const y0 = Math.max(0, (s.y - R) | 0), y1 = Math.min(w.h - 1, (s.y + R) | 0);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dd = Math.hypot(x - s.x, y - s.y);
            if (dd > R) continue;
            const i = y * w.w + x;
            const v = (1 - dd / R) * mag;
            const prev = d[i * 4 + 3] / 255;
            if (v > prev) set(i, col[0], col[1], col[2], v * 210);
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---- coordinate transforms ----------------------------------------------
  worldToScreen(x, y) {
    const v = this.view;
    return [
      (x - v.cx) * v.scale + this.canvas.width / 2,
      (y - v.cy) * v.scale + this.canvas.height / 2
    ];
  }
  screenToWorld(px, py) {
    const v = this.view;
    return [
      (px - this.canvas.width / 2) / v.scale + v.cx,
      (py - this.canvas.height / 2) / v.scale + v.cy
    ];
  }
  zoomAt(px, py, factor) {
    const [wx, wy] = this.screenToWorld(px, py);
    this.view.scale = clamp(this.view.scale * factor, 2, 42);
    const [nx, ny] = this.screenToWorld(px, py);
    this.view.cx += wx - nx; this.view.cy += wy - ny;
  }
  panBy(dxPx, dyPx) {
    this.view.cx -= dxPx / this.view.scale;
    this.view.cy -= dyPx / this.view.scale;
  }

  // ---- main draw, called every animation frame ----------------------------
  // `alpha` (0..1) interpolates agent positions between the previous and the
  // current simulation tick, keeping motion silky at sub-1× speeds.
  draw(alpha = 1) {
    const sim = this.sim;
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, W, H);
    if (!sim) return;
    const w = sim.world;
    const v = this.view;

    if (this.overlay !== 'none' && sim.tick - this.lastOverlayTick >= 12) {
      this.updateOverlay();
      this.lastOverlayTick = sim.tick;
    }

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(v.scale, v.scale);
    ctx.translate(-v.cx, -v.cy);
    ctx.imageSmoothingEnabled = true;

    ctx.drawImage(this.terrainCanvas, 0, 0, w.w, w.h);
    if (this.overlay !== 'none' && this.overlay !== 'trade') {
      ctx.globalAlpha = 0.75;
      ctx.drawImage(this.overlayCanvas, 0, 0, w.w, w.h);
      ctx.globalAlpha = 1;
    }

    // --- trade routes: animated dashed arcs between settlements ---
    if (this.showRoutes || this.overlay === 'trade') {
      ctx.lineCap = 'round';
      for (const r of sim.routes.values()) {
        const A = sim.settlementById.get(r.a), B = sim.settlementById.get(r.b);
        if (!A || !B) continue;
        ctx.strokeStyle = `rgba(120, 230, 255, ${0.15 + r.strength * 0.5})`;
        ctx.lineWidth = (0.1 + r.strength * 0.22);
        ctx.setLineDash([0.8, 0.6]);
        ctx.lineDashOffset = -(sim.tick % 1000) * 0.05;
        const mx = (A.x + B.x) / 2 + (A.y - B.y) * 0.12; // slight arc
        const my = (A.y + B.y) / 2 + (B.x - A.x) * 0.12;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.quadraticCurveTo(mx, my, B.x, B.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- migration trails ---
    if (this.showTrails) {
      ctx.strokeStyle = 'rgba(255, 235, 170, 0.22)';
      ctx.lineWidth = 0.12;
      for (const a of sim.agents) {
        if (a.dead || a.state !== 'migrating' || a.trail.length < 4) continue;
        ctx.beginPath();
        ctx.moveTo(a.trail[0], a.trail[1]);
        for (let i = 2; i < a.trail.length; i += 2) ctx.lineTo(a.trail[i], a.trail[i + 1]);
        ctx.stroke();
      }
    }

    // --- agents: tiny glowing dots, colored by home settlement ---
    const rA = clamp(0.14 + v.scale * 0.006, 0.12, 0.32);
    for (const a of sim.agents) {
      if (a.dead) continue;
      let fill;
      if (a.sick) fill = 'rgba(150, 255, 90, 0.95)';
      else if (a.state === 'fighting') fill = 'rgba(255, 70, 70, 0.95)';
      else if (a.home >= 0) {
        const s = sim.settlementById.get(a.home);
        fill = s ? `hsla(${s.hue}, 75%, 68%, 0.92)` : 'rgba(230,230,215,0.85)';
      } else fill = 'rgba(235, 232, 210, 0.8)';
      ctx.fillStyle = fill;
      // interpolate between tick-start (px,py) and current (x,y) positions
      const ax = a.px !== undefined ? a.px + (a.x - a.px) * alpha : a.x;
      const ay = a.py !== undefined ? a.py + (a.y - a.py) * alpha : a.y;
      ctx.beginPath();
      ctx.arc(ax, ay, rA, 0, 6.283);
      ctx.fill();
    }

    // --- settlements: glow disc + ring + population label ---
    for (const s of sim.settlements) {
      if (s.dead) continue;
      const R = 0.7 + Math.sqrt(s.members) * 0.22;
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, R * 2.2);
      g.addColorStop(0, `hsla(${s.hue}, 85%, 65%, 0.35)`);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.x, s.y, R * 2.2, 0, 6.283); ctx.fill();
      ctx.strokeStyle = `hsla(${s.hue}, 85%, 70%, 0.95)`;
      ctx.lineWidth = 0.14;
      ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, 6.283); ctx.stroke();
      // walls show as an extra square outline
      if (s.buildings.walls > 0) {
        ctx.strokeStyle = `hsla(${s.hue}, 40%, 85%, 0.8)`;
        ctx.lineWidth = 0.1;
        ctx.strokeRect(s.x - R - 0.3, s.y - R - 0.3, (R + 0.3) * 2, (R + 0.3) * 2);
      }
      if (v.scale > 5.5) {
        ctx.font = '0.9px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(240, 245, 255, 0.92)';
        ctx.fillText(s.name, s.x, s.y - R - 0.5);
        ctx.font = '0.65px "Segoe UI", sans-serif';
        ctx.fillStyle = 'rgba(190, 205, 225, 0.75)';
        ctx.fillText(`${s.members} · ${s.archetype}`, s.x, s.y + R + 1.0);
      }
    }

    // --- transient flashes: fights, wars, disasters ---
    for (const f of sim.flashes) {
      const t = f.kind === 'disaster' ? 1 - f.ttl / 90 : 1 - f.ttl / (f.kind === 'war' ? 45 : 20);
      if (f.kind === 'fight') {
        ctx.strokeStyle = `rgba(255, 90, 60, ${1 - t})`;
        ctx.lineWidth = 0.15;
        ctx.beginPath(); ctx.arc(f.x, f.y, 0.4 + t * 1.6, 0, 6.283); ctx.stroke();
      } else if (f.kind === 'war') {
        ctx.strokeStyle = `rgba(255, 150, 40, ${0.9 - t * 0.9})`;
        ctx.lineWidth = 0.25;
        ctx.beginPath(); ctx.arc(f.x, f.y, 1 + t * 4, 0, 6.283); ctx.stroke();
      } else if (f.kind === 'disaster') {
        ctx.strokeStyle = `rgba(255, 60, 90, ${0.8 - t * 0.8})`;
        ctx.lineWidth = 0.3;
        ctx.beginPath(); ctx.arc(f.x, f.y, (f.r || 9) * (0.4 + t * 0.8), 0, 6.283); ctx.stroke();
        if (v.scale > 4 && f.label) {
          ctx.font = '1.1px "Segoe UI", sans-serif';
          ctx.fillStyle = `rgba(255, 120, 120, ${1 - t})`;
          ctx.textAlign = 'center';
          ctx.fillText(f.label.toUpperCase(), f.x, f.y - (f.r || 9) * 0.5);
        }
      }
    }

    // --- selection highlight ---
    if (this.selected) {
      let sx, sy, sr;
      if (this.selected.type === 'agent') {
        const a = sim.agentById.get(this.selected.id);
        if (a) { sx = a.x; sy = a.y; sr = 0.8; }
      } else {
        const s = sim.settlementById.get(this.selected.id);
        if (s) { sx = s.x; sy = s.y; sr = 1 + Math.sqrt(s.members) * 0.25; }
      }
      if (sx !== undefined) {
        const pulse = 0.15 + Math.sin(performance.now() / 220) * 0.08;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 0.12;
        ctx.beginPath(); ctx.arc(sx, sy, sr + pulse, 0, 6.283); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Hit-test a click: nearest agent within ~1 tile, else settlement. */
  pickAt(px, py) {
    const [wx, wy] = this.screenToWorld(px, py);
    const sim = this.sim;
    let bestA = null, bestD = 1.6;
    for (const a of sim.agents) {
      if (a.dead) continue;
      const d = Math.hypot(a.x - wx, a.y - wy);
      if (d < bestD) { bestD = d; bestA = a; }
    }
    if (bestA && bestD < 0.9) return { type: 'agent', id: bestA.id };
    let bestS = null, bestSD = 99;
    for (const s of sim.settlements) {
      if (s.dead) continue;
      const d = Math.hypot(s.x - wx, s.y - wy);
      const R = 1.4 + Math.sqrt(s.members) * 0.25;
      if (d < R + 0.6 && d < bestSD) { bestSD = d; bestS = s; }
    }
    if (bestS) return { type: 'settlement', id: bestS.id };
    if (bestA) return { type: 'agent', id: bestA.id };
    return null;
  }
}

function hueRgb(h) {
  // quick hue → rgb (s=0.7, l=0.6)
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = 0.6 - 0.28 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255);
  };
  return [f(0), f(8), f(4)];
}
