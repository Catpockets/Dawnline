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
    this.showRoutes = false;
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

    if (w.riverPaths && w.riverPaths.length) {
      tctx.save();
      tctx.lineCap = 'round';
      tctx.lineJoin = 'round';
      for (const river of w.riverPaths) {
        if (river.length < 2) continue;
        tctx.beginPath();
        tctx.moveTo(river[0].x * S, river[0].y * S);
        for (let i = 1; i < river.length; i++) tctx.lineTo(river[i].x * S, river[i].y * S);
        tctx.strokeStyle = 'rgba(20, 115, 160, 0.62)';
        tctx.lineWidth = Math.max(1, S * 0.42);
        tctx.stroke();
        tctx.strokeStyle = 'rgba(110, 220, 240, 0.72)';
        tctx.lineWidth = Math.max(1, S * 0.18);
        tctx.stroke();
      }
      tctx.restore();
    }
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
    } else if (this.overlay === 'trade') {
      for (let i = 0; i < n; i++) heat(i, sim.tradeMap[i] / 3.5, [95, 225, 245]);
    } else if (this.overlay === 'food-signal') {
      for (let i = 0; i < n; i++) heat(i, sim.foodSignal[i] / 2.5, [140, 245, 120]);
    } else if (this.overlay === 'danger-signal') {
      for (let i = 0; i < n; i++) heat(i, sim.dangerSignal[i] / 2.5, [255, 70, 70]);
    } else if (this.overlay === 'migration') {
      for (let i = 0; i < n; i++) heat(i, sim.migrationMap[i] / 3.5, [255, 205, 100]);
    } else if (this.overlay === 'resources') {
      // strongest specialty deposit per tile, color-coded
      const KINDS = [
        [w.herbs, [90, 230, 120]], [w.clay, [222, 148, 90]], [w.salt, [240, 240, 235]],
        [w.fish, [90, 190, 250]], [w.metal, [170, 175, 190]], [w.gems, [200, 120, 250]]
      ];
      for (let i = 0; i < n; i++) {
        let bv = 6, bc = null;
        for (const [layer, col] of KINDS) {
          if (layer && layer[i] > bv) { bv = layer[i]; bc = col; }
        }
        if (bc) set(i, bc[0], bc[1], bc[2], Math.min(230, 60 + bv * 3.4));
      }
    } else if (this.overlay === 'ideology') {
      // settlements glow in their dominant creed's color
      for (const s of sim.settlements) {
        if (s.dead || s.dominantIdeology == null) continue;
        const I = sim.ideologyById.get(s.dominantIdeology);
        if (!I) continue;
        const col = hueRgb(I.hue);
        const R = 5 + Math.sqrt(s.members) * 1.6;
        const x0 = Math.max(0, (s.x - R) | 0), x1 = Math.min(w.w - 1, (s.x + R) | 0);
        const y0 = Math.max(0, (s.y - R) | 0), y1 = Math.min(w.h - 1, (s.y + R) | 0);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dd = Math.hypot(x - s.x, y - s.y);
            if (dd > R) continue;
            const i = y * w.w + x;
            const v = (1 - dd / R) * 0.85;
            if (v * 210 > d[i * 4 + 3]) set(i, col[0], col[1], col[2], v * 210);
          }
        }
      }
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

    // --- trade routes: all routes when toggled, or focused routes for selected city ---
    const selectedSettlementId = this.selected?.type === 'settlement' ? this.selected.id : null;
    const highlightedSettlements = new Set();
    const showAllRoutes = this.showRoutes;
    if (selectedSettlementId !== null) highlightedSettlements.add(selectedSettlementId);
    if (showAllRoutes || selectedSettlementId !== null) {
      ctx.lineCap = 'round';
      for (const r of sim.routes.values()) {
        const A = sim.settlementById.get(r.a), B = sim.settlementById.get(r.b);
        if (!A || !B) continue;
        const selectedRoute = selectedSettlementId !== null && (r.a === selectedSettlementId || r.b === selectedSettlementId);
        if (!showAllRoutes && !selectedRoute) continue;
        if (selectedRoute) {
          highlightedSettlements.add(r.a);
          highlightedSettlements.add(r.b);
        }
        ctx.strokeStyle = selectedRoute
          ? `rgba(145, 245, 255, ${0.42 + r.strength * 0.48})`
          : `rgba(120, 230, 255, ${0.10 + r.strength * 0.32})`;
        ctx.lineWidth = selectedRoute ? (0.18 + r.strength * 0.28) : (0.08 + r.strength * 0.16);
        ctx.setLineDash([0.8, 0.6]);
        ctx.lineDashOffset = -(sim.tick % 1000) * 0.05;
        ctx.beginPath();
        if (r.path && r.path.length > 1) {
          ctx.moveTo(r.path[0].x, r.path[0].y);
          for (let i = 1; i < r.path.length; i++) ctx.lineTo(r.path[i].x, r.path[i].y);
        } else {
          const mx = (A.x + B.x) / 2 + (A.y - B.y) * 0.12;
          const my = (A.y + B.y) / 2 + (B.x - A.x) * 0.12;
          ctx.moveTo(A.x, A.y);
          ctx.quadraticCurveTo(mx, my, B.x, B.y);
        }
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

    // --- gravestones: the dead rest where they fell (clickable) ---
    if (v.scale > 3 && sim.graves && sim.graves.length) {
      for (const gr of sim.graves) {
        ctx.fillStyle = 'rgba(206, 212, 224, 0.88)';
        ctx.fillRect(gr.x - 0.14, gr.y - 0.26, 0.28, 0.3);
        ctx.beginPath(); ctx.arc(gr.x, gr.y - 0.26, 0.14, Math.PI, 0); ctx.fill();
        ctx.fillStyle = 'rgba(82, 88, 104, 0.95)';
        ctx.fillRect(gr.x - 0.025, gr.y - 0.24, 0.05, 0.15);
        ctx.fillRect(gr.x - 0.07, gr.y - 0.2, 0.14, 0.045);
      }
    }

    // --- agents: tiny glowing dots, colored by home settlement ---
    const rA = clamp(0.14 + v.scale * 0.006, 0.12, 0.32);
    for (const a of sim.agents) {
      if (a.dead) continue;
      let fill;
      if (this.overlay === 'ideology' && a.ideology != null) {
        const I = sim.ideologyById.get(a.ideology);
        fill = I ? `hsla(${I.hue}, 85%, 66%, 0.95)` : 'rgba(200,200,200,0.8)';
      }
      else if (a.sick) fill = 'rgba(150, 255, 90, 0.95)';
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
      ctx.arc(ax, ay, a.age < 14 ? rA * 0.6 : rA, 0, 6.283); // children are smaller
      ctx.fill();
    }

    // --- ruins: fallen settlements leave a small site marker ---
    const ruinLabels = [];
    if (sim.ruins && sim.ruins.length) {
      ctx.save();
      ctx.lineCap = 'round';
      for (const r of sim.ruins) {
        ctx.strokeStyle = r.color || 'rgba(226, 232, 240, 0.75)';
        ctx.lineWidth = 0.14;
        ctx.beginPath(); ctx.arc(r.x, r.y, 1.0, 0, 6.283); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(r.x - 0.62, r.y - 0.62);
        ctx.lineTo(r.x + 0.62, r.y + 0.62);
        ctx.moveTo(r.x + 0.62, r.y - 0.62);
        ctx.lineTo(r.x - 0.62, r.y + 0.62);
        ctx.stroke();
        if (v.scale > 3.5) ruinLabels.push(r);
      }
      ctx.restore();
    }

    // --- settlements: glow disc + ring ---
    const cityLabels = [];
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
      if (highlightedSettlements.has(s.id)) {
        ctx.strokeStyle = s.id === selectedSettlementId
          ? 'rgba(255, 255, 255, 0.95)'
          : 'rgba(145, 245, 255, 0.9)';
        ctx.lineWidth = s.id === selectedSettlementId ? 0.18 : 0.14;
        ctx.beginPath(); ctx.arc(s.x, s.y, R + 0.45, 0, 6.283); ctx.stroke();
      }
      // walls show as an extra square outline
      if (s.buildings.walls > 0) {
        ctx.strokeStyle = `hsla(${s.hue}, 40%, 85%, 0.8)`;
        ctx.lineWidth = 0.1;
        ctx.strokeRect(s.x - R - 0.3, s.y - R - 0.3, (R + 0.3) * 2, (R + 0.3) * 2);
      }
      if (v.scale > 5.5) cityLabels.push({ x: s.x, y: s.y - R - 0.55, name: s.name });
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
      }
    }

    // --- family circle highlighting for the selected agent ---
    if (this.selected && this.selected.type === 'agent') {
      const a = sim.agentById.get(this.selected.id);
      if (a) {
        const ring = (m, color, r) => {
          ctx.strokeStyle = color; ctx.lineWidth = 0.12;
          ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, 6.283); ctx.stroke();
          if (v.scale > 4) {
            ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 0.07;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(m.x, m.y); ctx.stroke();
          }
        };
        if (a.spouse >= 0) {
          const sp = sim.agentById.get(a.spouse);
          if (sp) ring(sp, 'rgba(125, 211, 252, 0.95)', 0.55);
        }
        for (const pid of [a.mother, a.father]) {
          const p = pid >= 0 ? sim.agentById.get(pid) : null;
          if (p) ring(p, 'rgba(251, 191, 36, 0.9)', 0.5);
        }
        for (const cid of a.children) {
          const c = sim.agentById.get(cid);
          if (c) ring(c, 'rgba(74, 222, 128, 0.9)', 0.4);
        }
      }
    }
    // --- colony ↔ parent-city lineage link for the selected settlement ---
    if (this.selected && this.selected.type === 'settlement') {
      const s = sim.settlementById.get(this.selected.id);
      const links = [];
      if (s && s.parentSettlementId != null) {
        const p = sim.settlementById.get(s.parentSettlementId);
        if (p) links.push([s, p]);
      }
      if (s) {
        for (const o of sim.settlements) {
          if (!o.dead && o.parentSettlementId === s.id) links.push([o, s]);
        }
      }
      ctx.setLineDash([0.5, 0.5]);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
      ctx.lineWidth = 0.12;
      for (const [A, B] of links) {
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- selection highlight ---
    if (this.selected) {
      let sx, sy, sr;
      if (this.selected.type === 'agent') {
        const a = sim.agentById.get(this.selected.id);
        if (a) { sx = a.x; sy = a.y; sr = 0.8; }
      } else if (this.selected.type === 'settlement') {
        const s = sim.settlementById.get(this.selected.id);
        if (s) { sx = s.x; sy = s.y; sr = 1 + Math.sqrt(s.members) * 0.25; }
      } else if (this.selected.type === 'ruin') {
        const r = sim.ruins?.find((ruin) => ruin.id === this.selected.id);
        if (r) { sx = r.x; sy = r.y; sr = 1.3; }
      } else if (this.selected.type === 'grave') {
        const gr = sim.graves?.find((g) => g.id === this.selected.id);
        if (gr) { sx = gr.x; sy = gr.y - 0.1; sr = 0.55; }
      }
      if (sx !== undefined) {
        const pulse = 0.15 + Math.sin(performance.now() / 220) * 0.08;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 0.12;
        ctx.beginPath(); ctx.arc(sx, sy, sr + pulse, 0, 6.283); ctx.stroke();
      }
    }
    ctx.restore();

    if (ruinLabels.length) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      for (const label of ruinLabels) {
        const [sx, sy] = this.worldToScreen(label.x, label.y);
        const color = label.color || '#f87171';
        ctx.font = '700 24px "Segoe UI Symbol", "Segoe UI Emoji", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(5, 8, 15, 0.82)';
        ctx.strokeText(label.icon || '☠', sx, sy - 7);
        ctx.fillStyle = color;
        ctx.fillText(label.icon || '☠', sx, sy - 7);
        if (v.scale > 5.5) {
          ctx.font = '700 12px "Segoe UI", sans-serif';
          ctx.textBaseline = 'top';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(5, 8, 15, 0.88)';
          ctx.strokeText(label.cause || 'Collapse', sx, sy + 9);
          ctx.fillStyle = 'rgba(246, 249, 255, 0.96)';
          ctx.fillText(label.cause || 'Collapse', sx, sy + 9);
        }
      }
      ctx.restore();
    }

    // --- event icons: emoji floating up over cities (war, trade, plague…) ---
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of sim.flashes) {
      if (f.kind !== 'icon') continue;
      const life = f.ttl0 || 70;
      const t = 1 - f.ttl / life;
      const [sx, sy] = this.worldToScreen(f.x, f.y);
      if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) continue;
      ctx.font = '22px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif';
      ctx.globalAlpha = Math.max(0, Math.min(1, (1 - t) * 2.2));
      ctx.fillText(f.char, sx, sy - 22 - t * 18);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    if (cityLabels.length) {
      ctx.save();
      ctx.font = '600 13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      for (const label of cityLabels) {
        const [sx, sy] = this.worldToScreen(label.x, label.y);
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(5, 8, 15, 0.78)';
        ctx.strokeText(label.name, sx, sy);
        ctx.fillStyle = 'rgba(246, 249, 255, 0.96)';
        ctx.fillText(label.name, sx, sy);
      }
      ctx.restore();
    }
  }

  /** Hit-test a click: nearest agent within ~1 tile, else settlement. */
  pickAt(px, py) {
    const [wx, wy] = this.screenToWorld(px, py);
    const sim = this.sim;
    let bestR = null, bestRPx = 24;
    if (sim.ruins) {
      for (const r of sim.ruins) {
        const [rx, ry] = this.worldToScreen(r.x, r.y);
        const d = Math.hypot(rx - px, ry - py);
        if (d < bestRPx) { bestRPx = d; bestR = r; }
      }
    }
    if (bestR) return { type: 'ruin', id: bestR.id };
    // gravestones: small, so use a screen-space hit radius
    let bestG = null, bestGPx = 12;
    if (sim.graves) {
      for (const gr of sim.graves) {
        const [gx, gy] = this.worldToScreen(gr.x, gr.y);
        const d = Math.hypot(gx - px, gy - py);
        if (d < bestGPx) { bestGPx = d; bestG = gr; }
      }
    }
    let bestA = null, bestD = 1.6;
    for (const a of sim.agents) {
      if (a.dead) continue;
      const d = Math.hypot(a.x - wx, a.y - wy);
      if (d < bestD) { bestD = d; bestA = a; }
    }
    if (bestA && bestD < 0.35 && bestG) return { type: 'agent', id: bestA.id };
    if (bestG) return { type: 'grave', id: bestG.id };
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
