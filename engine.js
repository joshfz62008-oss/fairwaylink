/* ============================================================
   engine.js — canvas 3D view for the simulator
   Painted terrain mesh (painter's algorithm), billboard trees,
   ball, traces, flags, targets, minimap and adaptive quality.
   ============================================================ */
(function (global) {
  'use strict';
  const T = global.Terrain.T;
  const D2R = Math.PI / 180;

  const SKIES = {
    day:    { top: '#5aa9e6', mid: '#a9d7f2', hor: '#dff0f6', sun: '#fff8d8', fog: '#cfe6ea', amb: 1.00, sunDir: -0.55 },
    morning:{ top: '#4b86c9', mid: '#b6d9ea', hor: '#f0ead6', sun: '#ffe9b0', fog: '#e2e3d2', amb: 0.98, sunDir: -0.8 },
    dusk:   { top: '#2c4a7c', mid: '#d98c62', hor: '#ffd9a0', sun: '#ffb765', fog: '#e5bb95', amb: 0.88, sunDir: 0.85 },
    overcast:{top: '#7d8f9c', mid: '#9fadb6', hor: '#c3ccd1', sun: '#e8eef1', fog: '#bcc6cb', amb: 0.90, sunDir: -0.3 },
    night:  { top: '#0a1730', mid: '#132846', hor: '#27405f', sun: '#cfe4ff', fog: '#1b2c46', amb: 0.62, sunDir: -0.4 }
  };
  const GROUND = {
    [T.WATER]:   [40, 96, 150],
    [T.SAND]:    [223, 205, 156],
    [T.GREEN]:   [122, 197, 104],
    [T.FAIRWAY]: [96, 168, 84],
    [T.ROUGH]:   [67, 121, 63],
    [T.TREE]:    [38, 74, 42]
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mix(a, b, t) { return a + (b - a) * t; }
  function mixRGB(c1, c2, t) {
    return [Math.round(mix(c1[0], c2[0], t)), Math.round(mix(c1[1], c2[1], t)), Math.round(mix(c1[2], c2[2], t))];
  }
  function hexToRGB(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  function Engine(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1; this.w = 800; this.h = 600;
    this.cam = { x: 0, y: 2, z: 0, yaw: 0, pitch: -0.05, fov: 55 };
    this.quality = { scale: 0.9, step: 2, trees: 130, auto: true, frames: [], targetMs: 26 };
    this.sky = 'day';
    this.t = 0;
    this.lastStats = { ms: 0, tris: 0, trees: 0 };
    this.resize();
  }

  Engine.prototype = {
    resize() {
      const cv = this.cv;
      const r = cv.getBoundingClientRect();
      const w = Math.max(200, Math.round(r.width)), h = Math.max(160, Math.round(r.height));
      this.dpr = Math.min(2, global.devicePixelRatio || 1);
      // cap the internal buffer (~1.25 MP) — a 1080p-class phone can't rasterise
      // 4 MP of canvas at 60 fps, and the picture softens only slightly
      const maxPx = 1.25e6;
      const want = w * h * this.dpr * this.dpr;
      const cap = want > maxPx ? Math.sqrt(maxPx / want) : 1;
      const s = Math.min(this.quality.scale, cap);
      cv.width = Math.round(w * this.dpr * s);
      cv.height = Math.round(h * this.dpr * s);
      this.w = cv.width; this.h = cv.height;
      this.cw = w; this.ch = h;
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.imageSmoothingEnabled = true;
    },

    /* ---------- camera maths ---------- */
    _cam() {
      const c = this.cam, cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
      this.fwd = { x: sy * cp, y: sp, z: cy * cp };
      this.right = { x: cy, y: 0, z: -sy };
      // up = fwd x right  (right-handed: fwd -Z-ish, right +X, up +Y)
      this.up = {
        x: this.fwd.y * this.right.z - this.fwd.z * this.right.y,
        y: this.fwd.z * this.right.x - this.fwd.x * this.right.z,
        z: this.fwd.x * this.right.y - this.fwd.y * this.right.x
      };
      this.focal = (this.h * 0.5) / Math.tan(c.fov * 0.5 * D2R);
      this.cxp = this.w * 0.5; this.cyp = this.h * 0.5;
    },
    /* world → screen. returns null when behind the camera */
    project(x, y, z) {
      const dx = x - this.cam.x, dy = y - this.cam.y, dz = z - this.cam.z;
      const cz = dx * this.fwd.x + dy * this.fwd.y + dz * this.fwd.z;
      if (cz <= 0.35) return null;
      const cx = dx * this.right.x + dy * this.right.y + dz * this.right.z;
      const cyy = dx * this.up.x + dy * this.up.y + dz * this.up.z;
      const inv = this.focal / cz;
      return { x: this.cxp + cx * inv, y: this.cyp - cyy * inv, z: cz, s: inv };
    },

    setScene(scene) {
      this.scene = scene;
      this.sky = scene.sky || 'day';
      if (scene.terrain && scene.terrain.W) this._prep(scene.terrain);
    },
    _prep(ter) {
      this.ter = ter;
      this.rows = ter.H; this.cols = ter.W;
    },

    /* ---------- main render ---------- */
    render(frame, dt) {
      const t0 = (global.performance || Date).now();
      this.t += dt || 0.016;
      const ctx = this.ctx, sc = this.scene || {};
      const ter = this.ter;
      this._cam();
      const S = SKIES[this.sky] || SKIES.day;
      this.ambient = S.amb;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.tris = 0;

      this.paintSky(S);
      if (ter) {
        const cull = this.quality.step >= 3 ? 420 : 620;
        this.paintTerrain(ter, S, cull);
        this.paintTrees(ter, S, cull * 0.85);
      }
      this.paintObjects(frame, S);
      this.paintBall(frame, S);
      this.paintOverlay(frame, S);
      ctx.restore();

      const ms = (global.performance || Date).now() - t0;
      this.lastStats.ms = ms;
      this.autoQuality(ms);
    },

    autoQuality(ms) {
      const q = this.quality;
      if (!q.auto) return;
      q.frames.push(ms);
      if (q.frames.length < 24) return;
      const avg = q.frames.reduce((a, b) => a + b, 0) / q.frames.length;
      q.frames.length = 0;
      if (avg > q.targetMs && q.scale > 0.55) { q.scale = Math.max(0.55, q.scale - 0.1); this.resize(); }
      else if (avg > q.targetMs && q.step < 4) { q.step++; }
      else if (avg < q.targetMs * 0.55 && q.step > 1) { q.step--; }
      else if (avg < q.targetMs * 0.5 && q.scale < 1) { q.scale = Math.min(1, q.scale + 0.05); this.resize(); }
      q.lastAvg = avg;
    },

    /* ---------- sky ---------- */
    paintSky(S) {
      const ctx = this.ctx, w = this.w, h = this.h;
      // horizon screen position (where the view direction meets the flat plane at eye height ~0)
      const horizon = this.cyp + this.focal * Math.tan(clamp(this.cam.pitch, -1.2, 1.2));
      const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
      g.addColorStop(0, S.top); g.addColorStop(0.72, S.mid); g.addColorStop(1, S.hor);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, Math.max(0, horizon));
      // ground haze below the horizon
      const g2 = ctx.createLinearGradient(0, horizon, 0, h);
      g2.addColorStop(0, S.hor); g2.addColorStop(0.35, S.fog); g2.addColorStop(1, S.fog);
      ctx.fillStyle = g2;
      ctx.fillRect(0, Math.max(0, horizon - 1), w, h - Math.max(0, horizon - 1));

      // sun glow
      const sunAz = S.sunDir * Math.PI;
      const rel = ((sunAz - this.cam.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (Math.abs(rel) < 1.5) {
        const sx = this.cxp + Math.tan(rel) * this.focal;
        const sy = horizon - this.focal * 0.34;
        const R = Math.max(40, this.h * 0.28);
        const sg = ctx.createRadialGradient(sx, sy, 1, sx, sy, R);
        sg.addColorStop(0, S.sun); sg.addColorStop(0.25, 'rgba(255,255,255,.28)');
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath(); ctx.arc(sx, sy, R, 0, 7); ctx.fillStyle = sg; ctx.fill(); ctx.restore();
      }
      this.horizonY = horizon;
    },

    /* ---------- terrain ---------- */
    paintTerrain(ter, S, cull) {
      const ctx = this.ctx, step = this.quality.step;
      const W = ter.W, H = ter.H;
      const cellX = ter.cellX, cellZ = ter.cellZ;
      const fogRGB = hexToRGB(S.fog);
      const cam = this.cam;
      const tanHalfV = Math.tan(this.cam.fov * 0.5 * D2R);
      const tanHalfH = tanHalfV * (this.w / this.h);
      const yawL = cam.yaw - Math.atan(tanHalfH);
      const yawR = cam.yaw + Math.atan(tanHalfH);
      const cL = Math.cos(yawL), sL = Math.sin(yawL);
      const cR = Math.cos(yawR), sR = Math.sin(yawR);

      let iFar = clamp(Math.round((ter.length - Math.min(ter.length, cam.z + cull)) / cellZ), 0, H - 1);
      let iNear = clamp(Math.round((ter.length - Math.max(-cellZ * 2, cam.z - 4)) / cellZ), 0, H - 1);
      let tris = 0;
      const cache = new Map();
      const px = (ix, iz) => {
        const key = ix * 8192 + iz;
        let v = cache.get(key);
        if (v === undefined) {
          const cx = clamp(ix, 0, W - 1), cz = clamp(iz, 0, H - 1);
          const wx = cx * cellX - ter.width / 2;
          const wz = ter.length - cz * cellZ;
          v = this.project(wx, ter.elevs[cz * W + cx], wz);
          cache.set(key, v);
        }
        return v;
      };

      for (let iz = iFar; iz <= iNear; iz += step) {
        const rowZ = ter.length - iz * cellZ;
        // where the left and right frustum edges cross this row's plane
        let xa, xb;
        if (Math.abs(cL) < 1e-3 && Math.abs(cR) < 1e-3) continue;
        const sA = Math.abs(cL) > 1e-3 ? (rowZ - cam.z) / cL : 1e9;
        const sB = Math.abs(cR) > 1e-3 ? (rowZ - cam.z) / cR : 1e9;
        if (sA <= 0 && sB <= 0) continue;                    // row is behind the camera
        xa = cam.x + sA * sL; xb = cam.x + sB * sR;
        let x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
        x0 = Math.max(x0, -ter.width / 2 - cellX * 3);
        x1 = Math.min(x1, ter.width / 2 + cellX * 3);
        if (x1 - x0 < cellX) continue;
        let ix0 = clamp(Math.floor((x0 + ter.width / 2) / cellX), 0, W - 1);
        let ix1 = clamp(Math.ceil((x1 + ter.width / 2) / cellX) + 1, 0, W - 1);
        if (ix1 - ix0 < 1) continue;

        let runStart = ix0, runKey = -1, runShade = 0, runN = 0;
        const flush = (end) => {
          if (end <= runStart) return;
          const pStart = px(runStart, iz), pEnd = px(end, iz);
          if (!pStart && !pEnd) return;
          this._rowPath(px, iz, runStart, end, step);
          const dist = Math.max(1, Math.abs(ter.length - iz * cellZ - cam.z));
          const f = clamp(1 - Math.exp(-dist / 460), 0, 0.85);
          const base = GROUND[runKey] || GROUND[T.ROUGH];
          const lit = clamp(this.ambient * runShade, -24, 30);
          const col = mixRGB([
            clamp(base[0] * 1 + lit, 0, 255),
            clamp(base[1] * 1 + lit, 0, 255),
            clamp(base[2] * 1 + lit, 0, 255)], fogRGB, f);
          ctx.fillStyle = rgb(col);
          ctx.fill();
          tris += (end - runStart) / step;
        };
        for (let ix = ix0; ix < ix1; ix += step) {
          const ci = clamp(iz, 0, H - 1) * W + clamp(ix, 0, W - 1);
          const key = ter.types[ci];
          const e1 = ter.elevs[ci];
          const e2 = ter.elevs[clamp(iz, 0, H - 1) * W + clamp(ix + 3, 0, W - 1)];
          const e3 = ter.elevs[clamp(iz + 3, 0, H - 1) * W + clamp(ix, 0, W - 1)];
          // fake sun from the front-left: downhill faces away from the camera catch the light
          let shade = clamp(1.9 + (e3 - e1) * 3.4 - (e2 - e1) * 2.2, -3.2, 6.4);
          // mower stripes across the fairway / green
          if (key === T.FAIRWAY || key === T.GREEN) {
            const rowZ = ter.length - iz * cellZ;
            shade += (Math.floor(rowZ / 8.5) % 2) ? 3.1 : -1.5;
          }
          const tint = ((Math.imul(ix * 7919 + iz * 104729, 2654435761) >>> 20) % 9) - 4;
          const sv = shade + tint * 0.5;
          if (key !== runKey || Math.abs(sv - runShade) > 3.0) {
            flush(ix);
            runStart = ix; runKey = key; runShade = sv; runN = 1;
          } else { runShade = (runShade * runN + sv) / (runN + 1); runN++; }
        }
        flush(ix1);
      }
      this.lastStats.tris = Math.round(tris);
    },

    // build a quad strip path for one row between two columns
    _rowPath(px, iz, ix0, ix1, rowStep) {
      const ctx = this.ctx;
      const step = Math.max(rowStep, 2);
      ctx.beginPath();
      let started = false;
      for (let ix = ix0; ix <= ix1; ix += step) {
        const p = px(ix, iz);
        if (!p) { started = false; continue; }
        if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
      }
      for (let ix = ix1; ix >= ix0; ix -= step) {
        const p = px(ix, iz + step);
        if (!p) continue;
        ctx.lineTo(p.x, p.y);
      }
      const p0 = px(ix0, iz + step), pe = px(ix1, iz + step);
      if (started && p0 && pe) ctx.closePath();
      else ctx.closePath();
    },

    /* ---------- trees ---------- */
    paintTrees(ter, S, cull) {
      const trees = ter.trees;
      if (!trees || !trees.length) return;
      const ctx = this.ctx;
      const camz = this.cam.z;
      const list = [];
      for (let i = 0; i < trees.length; i++) {
        const tr = trees[i];
        const dz = tr.z - camz;
        if (dz < 16 || dz > cull) continue;                    // nothing right on top of the lens
        if (Math.abs(tr.x - this.cam.x) > 70 + dz) continue;   // rough sideways cull
        const p = this.project(tr.x, ter.elev(tr.x, tr.z), tr.z);
        if (!p || p.x < -120 || p.x > this.w + 120) continue;
        list.push([p.z, p, tr]);
      }
      if (list.length > this.quality.trees) {
        list.sort((a, b) => a[0] - b[0]);
        list.length = this.quality.trees;
      }
      list.sort((a, b) => b[0] - a[0]);        // far → near
      const dark = S.amb < 0.7;
      for (let i = 0; i < list.length; i++) {
        const p = list[i][1], tr = list[i][2], d = list[i][0];
        const s = p.s;                          // px per world yard
        let hh = tr.h * s, ww = tr.w * s;
        if (hh < 1.4) continue;
        const maxH = this.h * 0.52;             // never let a nearby tree swallow the screen
        if (hh > maxH) { const k = maxH / hh; hh *= k; ww *= k; }
        const fog = clamp(1 - Math.exp(-d / 520), 0, 0.85);
        const shade = 0.72 + tr.hue * 0.4;
        const c1 = mixRGB([Math.round(28 * shade), Math.round(78 * shade), Math.round(40 * shade)], hexToRGB(S.fog), fog);
        const c2 = mixRGB([Math.round(52 * shade), Math.round(112 * shade), Math.round(56 * shade)], hexToRGB(S.fog), fog);
        const c3 = mixRGB([Math.round(74 * shade), Math.round(142 * shade), Math.round(70 * shade)], hexToRGB(S.fog), fog);
        // trunk
        ctx.fillStyle = rgb(c1);
        ctx.fillRect(p.x - ww * 0.07, p.y - hh * 0.34, Math.max(1, ww * 0.14), hh * 0.34);
        // canopy
        ctx.fillStyle = rgb(c2);
        ctx.beginPath(); ctx.ellipse(p.x, p.y - hh * 0.62, ww * 0.52, hh * 0.42, 0, 0, 7); ctx.fill();
        ctx.fillStyle = rgb(c3);
        ctx.beginPath(); ctx.ellipse(p.x - ww * 0.16, p.y - hh * 0.74, ww * 0.36, hh * 0.30, 0, 0, 7); ctx.fill();
        if (dark) { ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(p.x + ww * 0.2, p.y - hh * 0.5, ww * 0.4, hh * 0.3, 0, 0, 7); ctx.fill(); }
      }
      this.lastStats.trees = list.length;
    },

    /* ---------- flags, targets, splash ---------- */
    paintObjects(frame, S) {
      const ctx = this.ctx;
      const items = [];
      (frame.flags || []).forEach(f => {
        const gy = this.ter ? this.ter.elev(f.x, f.z) : 0;
        const p = this.project(f.x, gy, f.z);
        if (p) items.push({ z: p.z, kind: 'flag', p, f });
      });
      (frame.targets || []).forEach(tg => {
        const gy = this.ter ? this.ter.elev(tg.x, tg.z) : 0;
        const p = this.project(tg.x, gy + 0.05, tg.z);
        if (p) items.push({ z: p.z, kind: 'target', p, tg });
      });
      items.sort((a, b) => b.z - a.z);
      const usedLabels = [];
      items.forEach(it => {
        if (it.kind === 'flag') { this._flag(it.p, it.f, S); return; }
        const canLabel = it.tg.label && !usedLabels.some(u => Math.abs(u.y - it.p.y) < this.h * 0.05 && Math.abs(u.x - it.p.x) < 60);
        if (canLabel) usedLabels.push({ x: it.p.x, y: it.p.y });
        this._target(it.p, it.tg, S, canLabel);
      });
      (frame.splashes || []).forEach(sp => {
        const gy = this.ter ? this.ter.elev(sp.x, sp.z) : 0;
        const p = this.project(sp.x, gy, sp.z);
        if (!p) return;
        const age = clamp(sp.t, 0, 1);
        ctx.save();
        ctx.strokeStyle = 'rgba(235,250,255,' + (0.85 * (1 - age)).toFixed(2) + ')';
        ctx.lineWidth = Math.max(1, 2.2 * (1 - age) * p.s * 0.4);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 0.6 * p.s * (0.4 + age * 3), 0.25 * p.s * (0.4 + age * 3), 0, 0, 7); ctx.stroke();
        ctx.restore();
      });
    },
    _flag(p, f, S) {
      const ctx = this.ctx;
      const s = p.s;                       // px per yard
      const H = 2.4 * s;
      ctx.save();
      // shadow / cup
      ctx.fillStyle = 'rgba(12,24,18,.55)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 0.02 * s, 0.55 * s, 0.22 * s, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#0d1a14';
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 0.14 * s, 0.06 * s, 0, 0, 7); ctx.fill();
      // pole
      ctx.strokeStyle = 'rgba(240,248,244,.92)';
      ctx.lineWidth = Math.max(1, 0.055 * s);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - H); ctx.stroke();
      // flag
      const col = f.color || '#ff4d4d';
      const wave = Math.sin(this.t * 2.2) * 0.12;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - H);
      ctx.quadraticCurveTo(p.x + 0.7 * s, p.y - H + (0.35 + wave) * s, p.x + 1.15 * s, p.y - H + (0.75 + wave * 1.5) * s);
      ctx.quadraticCurveTo(p.x + 0.6 * s, p.y - H + (0.9 + wave) * s, p.x, p.y - H + 1.0 * s);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      this._label(p.x, p.y - H - 0.4 * s, (f.label || 'PIN'), s);
    },
    _target(p, tg, S, canLabel) {
      const ctx = this.ctx, s = p.s;
      const rx = tg.r * s, ry = tg.r * s * Math.max(0.12, Math.abs(this.fwd.y) + 0.16);
      ctx.save();
      ctx.fillStyle = 'rgba(126,231,135,.16)';
      ctx.strokeStyle = 'rgba(200,255,215,.65)';
      ctx.lineWidth = Math.max(1, 0.05 * s);
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rx, ry, 0, 0, 7); ctx.fill(); ctx.stroke();
      if (tg.flagH) { /* little sticks */ }
      ctx.restore();
      if (canLabel && tg.label && rx > 18) this._label(p.x, p.y - ry - 4, tg.label, s);
    },
    _label(x, y, text, s) {
      const ctx = this.ctx;
      const size = clamp(11 + s * 0.2, 10, 15);
      ctx.save();
      ctx.font = '600 ' + size.toFixed(0) + 'px system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      const wtx = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(6,18,12,.55)';
      const pad = 5;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - wtx / 2 - pad, y - size - 2, wtx + pad * 2, size + 6, 5);
      else ctx.rect(x - wtx / 2 - pad, y - size - 2, wtx + pad * 2, size + 6);
      ctx.fill();
      ctx.fillStyle = '#e9fff2';
      ctx.fillText(text, x, y + 2);
      ctx.restore();
    },

    /* ---------- ball(s) ---------- */
    paintBall(frame, S) {
      const ctx = this.ctx;
      const balls = frame.balls || [];
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        const p = this.project(b.x, b.y, b.z);
        if (!p) continue;
        const r = Math.max(2.2, 0.0245 * p.s * (b.r || 1));   // ball radius 21.3mm
        // ground shadow
        const gy = this.ter ? this.ter.elev(b.x, b.z) : 0;
        const sp = this.project(b.x, gy, b.z);
        if (sp) {
          const dh = clamp(1 - (b.y - gy) / 30, 0.25, 1);
          ctx.fillStyle = 'rgba(8,20,14,' + (0.34 * dh).toFixed(2) + ')';
          ctx.beginPath(); ctx.ellipse(sp.x, sp.y, r * 1.5 * dh, r * 0.5 * dh, 0, 0, 7); ctx.fill();
        }
        const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.15, p.x, p.y, r);
        g.addColorStop(0, b.color || '#ffffff');
        g.addColorStop(1, b.color2 || '#c9d6cf');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
        if (r > 4) { ctx.strokeStyle = 'rgba(20,40,30,.35)'; ctx.lineWidth = 1; ctx.stroke(); }
        if (b.ring) {
          ctx.strokeStyle = b.ring; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 5 + Math.sin(this.t * 5) * 1.6, 0, 7); ctx.stroke();
        }
      }
    },

    /* ---------- overlay: traces, aim, landing, distance arcs ---------- */
    paintOverlay(frame, S) {
      const ctx = this.ctx;
      // shot traces
      (frame.traces || []).forEach(tr => {
        if (!tr || tr.length < 2) return;
        ctx.save();
        ctx.strokeStyle = tr.color || 'rgba(255,240,140,.85)';
        ctx.lineWidth = Math.max(1.4, this.h / 520);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < tr.length; i++) {
          const p = this.project(tr[i].x, tr[i].y, tr[i].z);
          if (!p) { started = false; continue; }
          if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.restore();
      });

      // yardage ladder: screen-space ticks + spaced labels
      const aim = frame.aim;
      if (aim && aim.marks && aim.marks.length) {
        const rad = aim.azimuth * D2R;
        const dir = { x: Math.sin(rad), z: Math.cos(rad) };
        let lastY = -1e9, lastX = 1e9, drawn = 0;
        const cxp = this.w * 0.5;
        aim.marks.forEach(m => {
          const d = m.d;
          const cx = aim.x + dir.x * d, cz = aim.z + dir.z * d;
          const y = (this.ter ? this.ter.elev(cx, cz) : 0) + 0.06;
          const c = this.project(cx, y, cz);
          if (!c) return;
          const ahead = this.project(cx + dir.x, (this.ter ? this.ter.elev(cx + dir.x, cz + dir.z) : 0) + 0.06, cz + dir.z);
          if (!ahead) return;
          let dxs = ahead.x - c.x, dys = ahead.y - c.y;
          const L = Math.hypot(dxs, dys);
          if (L < 0.4) return;
          dxs /= L; dys /= L;
          const half = clamp(7 + 700 / Math.max(6, c.z), 7, 46);
          ctx.save();
          ctx.strokeStyle = m.color || 'rgba(255,255,255,.45)';
          ctx.lineWidth = Math.max(1.1, this.h / 1100);
          ctx.beginPath();
          ctx.moveTo(c.x + dys * half, c.y - dxs * half);
          ctx.lineTo(c.x - dys * half, c.y + dxs * half);
          ctx.stroke();
          ctx.restore();
          if (drawn >= 4) return;                       // a handful of labels is plenty
          if (!m.label) return;
          if (Math.abs(c.y - lastY) < this.h * 0.055 && Math.abs(c.x - lastX) < 26) return;
          ctx.save();
          ctx.font = '600 ' + clamp(this.h / 135, 10, 14).toFixed(0) + 'px system-ui,sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const tw = ctx.measureText(m.label).width;
          const off = c.x > cxp ? -1 : 1;
          const lx = c.x + off * (tw / 2 + 12);
          ctx.fillStyle = 'rgba(6,18,12,.55)';
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(lx - tw / 2 - 5, c.y - 9, tw + 10, 18, 6); else ctx.rect(lx - tw / 2 - 5, c.y - 9, tw + 10, 18);
          ctx.fill();
          ctx.fillStyle = '#eafff2';
          ctx.fillText(m.label, lx, c.y + 1);
          ctx.restore();
          lastY = c.y; lastX = c.x; drawn++;
        });
      }

      // aim line + target ring
      if (frame.aim) {
        const aim = frame.aim;
        const pts = [];
        for (let d = 0; d <= aim.length; d += 6) {
          const rad = aim.azimuth * D2R;
          const x = aim.x + Math.sin(rad) * d, z = aim.z + Math.cos(rad) * d;
          const y = (this.ter ? this.ter.elev(x, z) : 0) + 0.05;
          const p = this.project(x, y, z);
          if (p) pts.push(p);
        }
        ctx.save();
        ctx.setLineDash([9, 9]);
        ctx.strokeStyle = 'rgba(120,240,170,.75)';
        ctx.lineWidth = Math.max(1.2, this.h / 700);
        ctx.beginPath();
        pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.stroke();
        ctx.restore();
        const end = pts[pts.length - 1];
        if (end) {
          ctx.save();
          ctx.strokeStyle = 'rgba(160,255,200,.9)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(end.x, end.y, 14, 6, 0, 0, 7); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(end.x - 20, end.y); ctx.lineTo(end.x - 8, end.y);
          ctx.moveTo(end.x + 8, end.y); ctx.lineTo(end.x + 20, end.y); ctx.stroke();
          ctx.restore();
        }
      }

      // landing marker
      if (frame.landing) {
        const l = frame.landing;
        const y = (this.ter ? this.ter.elev(l.x, l.z) : 0) + 0.05;
        const p = this.project(l.x, y, l.z);
        if (p) {
          const pulse = 0.6 + 0.4 * Math.sin(this.t * 6);
          ctx.save();
          ctx.strokeStyle = l.color || 'rgba(255,214,102,' + pulse.toFixed(2) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(p.x, p.y, 16 * pulse + 6, 7 * pulse + 3, 0, 0, 7); ctx.stroke();
          ctx.restore();
          if (l.label) this._label(p.x, p.y - 16, l.label, p.s);
        }
      }

      // wind banner (top-left in canvas space, subtle)
      if (frame.wind) {
        const w = frame.wind;
        const x = this.w - 92, y = this.h * 0.20;
        ctx.save();
        ctx.translate(x, y);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = 'rgba(6,18,12,.45)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-9, -9, 74, 40, 9); else ctx.rect(-9, -9, 74, 40);
        ctx.fill();
        ctx.fillStyle = '#dff5e8';
        ctx.font = '700 ' + clamp(this.h / 60, 10, 15).toFixed(0) + 'px system-ui,sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(w.label, -2, -4);
        // arrow
        ctx.save();
        ctx.translate(58, 13);
        ctx.rotate(w.rot * D2R);
        ctx.strokeStyle = '#7ee787'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(0, -8);
        ctx.moveTo(-5, -2); ctx.lineTo(0, -8); ctx.lineTo(5, -2); ctx.stroke();
        ctx.restore();
        ctx.restore();
      }
    },

    /* ---------- minimap ---------- */
    minimap(cv, frame) {
      const ctx = cv.getContext('2d');
      const ter = this.ter;
      if (!ter) return;
      const w = cv.width, h = cv.height;
      ctx.clearRect(0, 0, w, h);
      if (ter.art) {
        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.drawImage(ter.art, 0, 0, w, h);
        ctx.restore();
      } else {
        // procedural schematic: paint cell colours
        const cw = w / ter.W, chh = h / ter.H;
        for (let iz = 0; iz < ter.H; iz++) for (let ix = 0; ix < ter.W; ix++) {
          const k = ter.types[iz * ter.W + ix];
          const c = GROUND[k];
          ctx.fillStyle = rgb(c);
          ctx.fillRect(w - (ix + 1) * cw, iz * chh, cw + 0.6, chh + 0.6);
        }
      }
      const toMap = (x, z) => [w - ((x + ter.width / 2) / ter.width) * w, ((ter.length - z) / ter.length) * h];
      // aim
      if (frame && frame.aim) {
        const [ax, ay] = toMap(frame.aim.x, frame.aim.z);
        const rad = frame.aim.azimuth * D2R;
        const [tx, ty] = toMap(frame.aim.x + Math.sin(rad) * frame.aim.length, frame.aim.z + Math.cos(rad) * frame.aim.length);
        ctx.strokeStyle = 'rgba(126,231,135,.9)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(tx, ty); ctx.stroke();
      }
      // pin
      const [gx, gy] = toMap(ter.pin.x, ter.pin.z);
      ctx.fillStyle = '#ff5d5d';
      ctx.beginPath(); ctx.moveTo(gx, gy - 6); ctx.lineTo(gx + 5, gy - 2.5); ctx.lineTo(gx, gy + 1); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(gx, gy - 7); ctx.lineTo(gx, gy + 4); ctx.stroke();
      // ball + trail
      if (frame && frame.balls) {
        frame.balls.forEach(b => {
          const [bx, by] = toMap(b.x, b.z);
          ctx.fillStyle = '#ffffff';
          ctx.beginPath(); ctx.arc(bx, by, 3, 0, 7); ctx.fill();
        });
      }
      if (frame && frame.landing) {
        const [lx, ly] = toMap(frame.landing.x, frame.landing.z);
        ctx.strokeStyle = '#ffd666'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(lx, ly, 3.4, 0, 7); ctx.stroke();
      }
      // tee marker
      const [sx, sy] = toMap(0, 0);
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.fillRect(sx - 3, sy - 1, 6, 2);
    },

    /* ---------- cinematic camera helpers ---------- */
    followCamera(ball, opts) {
      const o = Object.assign({ dist: 9.5, height: 4.5, lookAhead: 16, lag: 0.16, drop: 0.5, groundY: 0 }, opts);
      const g = o.groundY + 2.4;
      const camz = ball.z - o.dist;
      const camy = Math.max(g, ball.y * 0.30 + o.height);
      this.cam.x += (ball.x * 0.6 - this.cam.x) * o.lag;
      this.cam.z += (camz - this.cam.z) * o.lag;
      this.cam.y += (camy - this.cam.y) * o.lag;
      // aim a little under the ball so the fairway stays in shot
      const ty = ball.y * o.drop;
      const tx = ball.x, tz = ball.z + o.lookAhead;
      this.cam.yaw = Math.atan2(tx - this.cam.x, tz - this.cam.z);
      const dh = Math.hypot(tx - this.cam.x, tz - this.cam.z);
      this.cam.pitch = clamp(Math.atan2(ty - this.cam.y, dh), -0.55, 0.10);
    },
    flyover(ter, t) {
      const z = clamp(t, -10, ter.length + 40);
      this.cam.x = Math.sin(z * 0.02) * 6;
      this.cam.z = z;
      this.cam.y = ter.elev(this.cam.x, z) + 14;
      const look = ter.pin;
      this.cam.yaw = Math.atan2(look.x - this.cam.x, look.z - this.cam.z);
      this.cam.pitch = -0.22;
    }
  };

  global.Engine = Engine;
  global.SKIES = SKIES;
})(window);
