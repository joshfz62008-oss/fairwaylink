/* ============================================================
   terrain.js — turns an OGC hole map (170x370 px overview art)
   into a playable surface grid: fairway / rough / trees / sand / water / green,
   plus an elevation field, pin, corridor and tree instances.
   ============================================================ */
(function (global) {
  'use strict';

  const T = { WATER: 0, SAND: 1, GREEN: 2, FAIRWAY: 3, ROUGH: 4, TREE: 5 };
  const TYPE_NAME = ['Water', 'Bunker', 'Green', 'Fairway', 'Rough', 'Trees'];

  // ---- helpers -------------------------------------------------
  function hash(x, y, s) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s | 1, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  // smooth value noise (2 octaves) in grid space
  function noise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s);
    const c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  function fbm(x, y, s) { return noise(x, y, s) * 0.65 + noise(x * 2.7, y * 2.7, s + 91) * 0.35; }

  // ---- classification of the OGC map colours -------------------
  // Every OGC course uses its own palette (Phuket is bright, Wood Buffalo is dark),
  // so thresholds are derived per image from the luminance distribution.
  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  function classify(r, g, b, th) {
    // water: clearly blue
    if (b > g + 8 && b > 52) return T.WATER;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const delta = mx - mn;
    const sat = mx ? delta / mx : 0;
    // hue in degrees (0 red, 60 yellow, 120 green, 240 blue)
    let hue = 0;
    if (delta > 0) {
      if (mx === r) hue = 60 * (((g - b) / delta) % 6);
      else if (mx === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;
    }
    const L = lum(r, g, b);
    // sand / bunkers: washed out, yellow-cream, at least as bright as the mown grass
    if (sat < 0.38 && (g - b) < 34 && hue < 62 && L > th.fairMin * 0.80) return T.SAND;
    if (mx > th.bright && sat < 0.20) return T.SAND;
    if (L >= th.fairMin) return T.FAIRWAY;     // mown ribbon
    if (L <= th.treeMax) return T.TREE;        // forest / tree belt
    return T.ROUGH;
  }

  function thresholdsFrom(pixels, n) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[pixels[i] | 0]++;
    const at = (q) => {
      let acc = 0, target = q * n;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
      return 255;
    };
    const p42 = at(0.42), p80 = at(0.80), p92 = at(0.92), p97 = at(0.97);
    return {
      treeMax: p42 + 4, fairMin: Math.max(p80, p42 + 12),
      sandMin: Math.max(p92 + 8, p80 + 26), bright: p97
    };
  }

  function Terrain(opts) { Object.assign(this, opts); }

  Terrain.prototype = {
    /* world -> grid cell (cell centres) */
    cellAt(x, z) {
      const ix = Math.round((x + this.width / 2) / this.cellX);
      const iz = Math.round((this.length - z) / this.cellZ);
      return [Math.max(0, Math.min(this.W - 1, ix)), Math.max(0, Math.min(this.H - 1, iz))];
    },
    typeAt(x, z) {
      const c = this.cellAt(x, z);
      return this.types[c[1] * this.W + c[0]];
    },
    isGreen(x, z) {
      const c = this.cellAt(x, z);
      const i = c[1] * this.W + c[0];
      if (this.types[i] === T.GREEN) return true;
      // a little roll onto the fringe
      return this.types[i] === T.FAIRWAY && Math.hypot(x - this.pin.x, z - this.pin.z) < this.greenR * 1.25;
    },
    /* elevation in yards, bilinear */
    elev(x, z) {
      const gx = (x + this.width / 2) / this.cellX - 0.5;
      const gz = (this.length - z) / this.cellZ - 0.5;
      const x0 = Math.floor(gx), z0 = Math.floor(gz);
      const tx = gx - x0, tz = gz - z0;
      const E = this.elevs, W = this.W, H = this.H;
      const ci = (a, b) => E[Math.max(0, Math.min(H - 1, b)) * W + Math.max(0, Math.min(W - 1, a))];
      const e00 = ci(x0, z0), e10 = ci(x0 + 1, z0), e01 = ci(x0, z0 + 1), e11 = ci(x0 + 1, z0 + 1);
      return (e00 * (1 - tx) + e10 * tx) * (1 - tz) + (e01 * (1 - tx) + e11 * tx) * tz;
    },
    slopeAt(x, z) { // dElev/dz  (positive = uphill toward green)
      const d = this.cellZ;
      return (this.elev(x, z + d) - this.elev(x, z - d)) / (2 * d);
    },
    crossSlopeAt(x, z) {
      const d = this.cellX;
      return (this.elev(x + d, z) - this.elev(x - d, z)) / (2 * d);
    },
    nameOf(t) { return TYPE_NAME[t]; },

    /* how the surface reacts to a rolling ball (0..1 speed retention per second-ish) */
    rollFactor(t) {
      switch (t) {
        case T.GREEN: return 1.00;
        case T.FAIRWAY: return 0.80;
        case T.ROUGH: return 0.42;
        case T.SAND: return 0.10;
        case T.TREE: return 0.22;
        default: return 0.06; // water
      }
    }
  };

  /* -------------------------------------------------------------
     Build terrain from the OGC overview art.
     art → Image object (same-origin!). holeYards → length in yards.
     ------------------------------------------------------------- */
  function fromImage(img, holeYards, holePar, seed) {
    const AW = 85, AH = 185;                      // analysis grid (2 art px per cell)
    const cvs = document.createElement('canvas');
    cvs.width = AW; cvs.height = AH;
    const cx = cvs.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, AW, AH);
    let px;
    try { px = cx.getImageData(0, 0, AW, AH).data; }
    catch (e) { return procedural({ length: holeYards, par: holePar, seed: seed, silent: true }); }

    const lumBuf = new Uint8Array(AW * AH);
    for (let i = 0, p = 0; i < AW * AH; i++, p += 4) lumBuf[i] = lum(px[p], px[p + 1], px[p + 2]);
    const th = thresholdsFrom(lumBuf, AW * AH);
    const types = new Uint8Array(AW * AH);
    for (let i = 0, p = 0; i < AW * AH; i++, p += 4) types[i] = classify(px[p], px[p + 1], px[p + 2], th);

    /* majority filter twice — removes speckle from jpeg noise */
    for (let pass = 0; pass < 2; pass++) {
      const out = types.slice();
      for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) {
        const c = new Uint8Array(6);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
          c[types[(y + dy) * AW + (x + dx)]]++;
        let best = 0;
        // keep rare-but-important features (water, sand, green) sticky
        const self = types[y * AW + x];
        if (c[self] >= 3) { best = self; }
        else { for (let t = 0; t < 6; t++) if (c[t] > c[best]) best = t; }
        out[y * AW + x] = best;
      }
      types.set(out);
    }

    /* world size: corridor gets tighter on short holes */
    const width = holePar <= 3 ? 72 : holePar === 4 ? 92 : 112;
    const length = holeYards * 1.14;               // a little room behind the green
    const cellX = width / AW, cellZ = length / AH;

    const ter = new Terrain({
      W: AW, H: AH, width, length, cellX, cellZ, types, th,
      seed: seed || 7, holePar, holeYards, art: img
    });

    /* ---- locate pin: the mown green blob in the top quarter of the map ---- */
    let sx = 0, sy = 0, n = 0;
    const topBand = Math.max(12, Math.floor(AH * 0.20));
    for (let y = 0; y < topBand; y++) for (let x = 0; x < AW; x++) {
      const i = y * AW + x;
      if (types[i] === T.FAIRWAY && lumBuf[i] >= th.fairMin) { sx += x; sy += y; n++; }
    }
    if (n < 6) {
      // fall back: brightest mown cells anywhere in the top half
      let best = -1;
      for (let y = 0; y < AH * 0.5; y++) for (let x = 0; x < AW; x++) {
        const i = y * AW + x;
        if (types[i] === T.WATER) continue;
        if (lumBuf[i] > best) { best = lumBuf[i]; gx0 = x; gy0 = y; }
      }
      for (let y = 0; y < AH * 0.5; y++) for (let x = 0; x < AW; x++) {
        const i = y * AW + x;
        if (types[i] === T.WATER) continue;
        if (lumBuf[i] >= best - 8) { sx += x; sy += y; n++; }
      }
    }
    var gx0 = 0, gy0 = 0;
    let gx = n ? sx / n : AW / 2, gy = n ? sy / n : 12;
    /* ---- tee: bottom centre, on mown grass if possible ---- */
    let tx = AW / 2, ty = AH - 6;
    for (let y = AH - 1; y > AH - 30; y--) {
      let ok = false;
      for (let d = 0; d < AW / 2; d++) for (const s of [1, -1]) {
        const x = Math.round(AW / 2 + s * d);
        if (x < 0 || x >= AW) continue;
        if (types[y * AW + x] === T.FAIRWAY) { tx = x; ty = y; ok = true; break; }
      }
      if (ok) break;
    }

    const worldX = (i) => (i + 0.5) * cellX - width / 2;
    const worldZ = (j) => length - (j + 0.5) * cellZ;

    ter.pin = { x: worldX(gx), z: worldZ(gy) };
    ter.tee = { x: worldX(tx), z: worldZ(ty) };
    ter.greenR = Math.max(8, Math.min(19, holeYards / 28));

    /* the putting surface is a solid blob around the pin (the overlap art is coarse) */
    for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
      const i = y * AW + x;
      if (types[i] === T.WATER) continue;
      const d = Math.hypot(worldX(x) - ter.pin.x, worldZ(y) - ter.pin.z);
      const wobble = 1 + (fbm(x * 0.32, y * 0.32, 21) - 0.5) * 0.30;
      if (d < ter.greenR * wobble) types[i] = T.GREEN;
    }

    /* trees: leave the big tree belt alone (bunkers never live in the forest) */
    // (bunkers stay bunkers, water stays water)

    /* ---- elevation field ---- */
    const elevs = new Float32Array(AW * AH);
    for (let y = 0; y < AH; y++) {
      const z = worldZ(y);
      const rise = (length - z) / length;                     // 0 at tee → 1 at green
      for (let x = 0; x < AW; x++) {
        const t = types[y * AW + x];
        let e = (fbm(x * 0.13, y * 0.13, seed) - 0.5) * 5.2;   // rolling ground ±2.6 yd
        e += rise * rise * 3.4;                                // green sits uphill
        if (t === T.GREEN) e += 0.6;
        if (t === T.WATER) e = Math.min(e, -1.6);
        if (t === T.SAND) e -= 0.3;
        if (t === T.TREE) e -= 0.5;
        elevs[y * AW + x] = e;
      }
    }
    /* smooth the field a touch so the mesh looks sculpted, not noisy */
    for (let pass = 0; pass < 2; pass++) {
      const out = elevs.slice();
      for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += elevs[(y + dy) * AW + (x + dx)];
        out[y * AW + x] = s / 9;
      }
      elevs.set(out);
    }
    ter.elevs = elevs;

    ter.trees = collectTrees(ter, worldX, worldZ);
    return ter;
  }

  /* scatter tree instances where the map shows forest */
  function collectTrees(ter, worldX, worldZ) {
    const out = [];
    const { W, H, types, cellX, cellZ } = ter;
    for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) {
      let tree = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
        if (types[(y + dy) * W + (x + dx)] === T.TREE) tree++;
      if (tree < 3) continue;
      if (hash(x, y, 31) > 0.62) continue;                 // thin them out a bit
      const jx = (hash(x, y, 11) - 0.5) * cellX * 2.2;
      const jz = (hash(x, y, 12) - 0.5) * cellZ * 2.2;
      out.push({
        x: worldX(x) + jx, z: worldZ(y) + jz,
        h: 7 + hash(x, y, 13) * 8,                        // canopy height (yd)
        w: 5.5 + hash(x, y, 14) * 4.5,
        hue: hash(x, y, 15)
      });
    }
    return out;
  }

  /* -------------------------------------------------------------
     Procedural terrain for the range, putting green and practice cage
     ------------------------------------------------------------- */
  function procedural(o) {
    const opt = Object.assign({
      length: 400, width: 200, par: 4, seed: 4242,
      fairway: true, water: [], bunkers: [], green: true, treeLine: true
    }, o);
    const AW = 60, AH = 120;
    const cellX = opt.width / AW, cellZ = opt.length / AH;
    const types = new Uint8Array(AW * AH).fill(T.ROUGH);
    const worldX = (i) => (i + 0.5) * cellX - opt.width / 2;
    const worldZ = (j) => opt.length - (j + 0.5) * cellZ;

    const ter = new Terrain({
      W: AW, H: AH, width: opt.width, length: opt.length, cellX, cellZ, types,
      seed: opt.seed, holePar: opt.par, holeYards: opt.length, art: null
    });

    /* fairway ribbon that narrows with distance */
    if (opt.fairway) {
      for (let y = 0; y < AH; y++) {
        const z = worldZ(y);
        const t = z / opt.length;
        const halfW = (opt.fairwayHalf || 22) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.6);
        for (let x = 0; x < AW; x++) {
          if (Math.abs(worldX(x)) < halfW + (fbm(x * 0.2, y * 0.2, opt.seed) - 0.5) * 8)
            types[y * AW + x] = T.FAIRWAY;
        }
      }
    }
    /* green */
    const pinZ = opt.greenZ !== undefined ? opt.greenZ : opt.length * 0.86;
    const greenR = opt.greenR || 16;
    ter.pin = { x: opt.greenX || 0, z: pinZ };
    ter.tee = { x: 0, z: opt.teeZ !== undefined ? opt.teeZ : 4 };
    ter.greenR = greenR;
    if (opt.green) {
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
        const d = Math.hypot(worldX(x) - ter.pin.x, worldZ(y) - ter.pin.z);
        if (d < greenR * (1 + (fbm(x * 0.3, y * 0.3, 3) - 0.5) * 0.25)) types[y * AW + x] = T.GREEN;
      }
    }
    /* hazards */
    (opt.water || []).forEach(w => {
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
        const d = Math.hypot((worldX(x) - w.x) / (w.rx || w.r), (worldZ(y) - w.z) / (w.rz || w.r));
        if (d + (fbm(x * 0.4, y * 0.4, 9) - 0.5) * 0.35 < 1) types[y * AW + x] = T.WATER;
      }
    });
    (opt.bunkers || []).forEach(w => {
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
        const d = Math.hypot((worldX(x) - w.x) / (w.rx || w.r), (worldZ(y) - w.z) / (w.rz || w.r));
        if (d + (fbm(x * 0.5, y * 0.5, 17) - 0.5) * 0.4 < 1) types[y * AW + x] = T.SAND;
      }
    });
    /* forest frame */
    if (opt.treeLine) {
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
        const edge = Math.min(Math.abs(worldX(x)) / (opt.width / 2), 1);
        const jitter = (fbm(x * 0.25, y * 0.25, 5) - 0.5) * 0.22;
        if (edge > 0.72 + jitter) types[y * AW + x] = T.TREE;
      }
      for (let x = 0; x < AW; x++) for (let y = 0; y < 4; y++) types[y * AW + x] = T.TREE;
    }

    /* elevation */
    const elevs = new Float32Array(AW * AH);
    for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
      const t = types[y * AW + x];
      let e = (fbm(x * 0.12, y * 0.12, opt.seed) - 0.5) * (opt.relief !== undefined ? opt.relief : 3.2);
      if (opt.slope) e += (worldX(x) / (opt.width / 2)) * opt.slope;
      if (opt.tilt) e += (worldZ(y) / opt.length) * opt.tilt;
      if (t === T.GREEN && opt.greenFlat) e *= 0.10;
      if (t === T.WATER) e = Math.min(e, -1.4);
      if (t === T.SAND) e -= 0.3;
      if (t === T.TREE) e -= 0.4;
      elevs[y * AW + x] = e;
    }
    for (let pass = 0; pass < 2; pass++) {
      const out = elevs.slice();
      for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += elevs[(y + dy) * AW + (x + dx)];
        out[y * AW + x] = s / 9;
      }
      elevs.set(out);
    }
    ter.elevs = elevs;
    ter.trees = collectTrees(ter, worldX, worldZ);
    return ter;
  }

  global.Terrain = {
    T, TYPE_NAME, fromImage, procedural,
    create(img, holeYards, par, seed) {
      return img ? fromImage(img, holeYards, par, seed) : procedural({ length: holeYards, par, seed });
    }
  };
})(window);
