/* ============================================================
   track.js — the launch monitor.
   Uses the phone's rear camera, background subtraction and blob
   tracking to measure ball speed, launch direction and (via the
   clubhead streak) club speed.  A player model fills in the
   quantities a single rolling-shutter camera genuinely cannot see
   (spin) and every estimate carries a confidence flag.
   ============================================================ */
(function (global) {
  'use strict';

  const AW = 320, AH = 180;                 // analysis resolution

  function Track(opts) {
    this.opt = Object.assign({
      sensitivity: 26,          // threshold on the difference image
      minBlob: 6,               // min pixels for a candidate
      frameRate: 60,
      facing: 'environment',
      width: 1920, height: 1080,
      whiteMin: 178,            // brightness gate for the white ball
      watchAll: false,          // detect swings in any state
      teeDistanceFt: 7,         // ball to camera
      cameraHeightIn: 4,
      angleDeg: 12              // camera sits 12° off the ball line
    }, opts);
    this.video = null; this.stream = null;
    this.state = 'idle';
    this.listeners = {};
    this.fps = 0; this.frames = 0; this.fpsT = 0;
    this.bg = null; this.bgWarm = 0;
    this.ball = null;             // {x,y,r,area} in analysis space
    this.home = null;             // locked alignment position
    this.aligned = false;
    this.track = [];              // recent ball samples {t,x,y,r}
    this.roi = { x: 0.18, y: 0.30, w: 0.64, h: 0.55 };
    this.lastShot = null;
    this.armTime = 0;
    this.busy = false;
    this.capabilities = {};
    this.mode = 'vision';         // vision | simulated | manual
    this.session = { shots: 0, best: 0 };
    this._initBuffers();
  }

  Track.prototype = {
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; },
    emit(ev, data) { (this.listeners[ev] || []).forEach(f => { try { f(data); } catch (e) { console.warn(e); } }); },
    setState(s, note) {
      if (this.state === s) { this.emit('note', note); return; }
      this.state = s; this.emit('state', { state: s, note: note || '' });
    },

    _initBuffers() {
      this.cv = document.createElement('canvas'); this.cv.width = AW; this.cv.height = AH;
      this.cx = this.cv.getContext('2d', { willReadFrequently: true });
      this.gray = new Uint8ClampedArray(AW * AH);
      this.diff = new Uint8ClampedArray(AW * AH);
      this.mask = new Uint8Array(AW * AH);        // motion
      this.bmask = new Uint8Array(AW * AH);       // bright / white pixels (the ball)
      this.vis = new Uint8ClampedArray(AW * AH * 4);
    },

    /* ---------------- camera ---------------- */
    async start(o) {
      Object.assign(this.opt, o || {});
      if (this.stream) this.stop();
      const video = {
        facingMode: { ideal: this.opt.facing },
        width: { ideal: this.opt.width },
        height: { ideal: this.opt.height },
        frameRate: { ideal: this.opt.frameRate, min: 24 },
        aspectRatio: { ideal: 16 / 9 }
      };
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        // fall back to the simplest possible request (older / restricted devices)
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: this.opt.facing } });
      }
      const track = this.stream.getVideoTracks()[0];
      this.trackSettings = track.getSettings ? track.getSettings() : {};
      this.capabilities = track.getCapabilities ? track.getCapabilities() : {};
      try {
        // ask for the highest frame rate the device admits to
        if (this.capabilities.frameRate && this.opt.frameRate) {
          await track.applyConstraints({ advanced: [{ frameRate: Math.min(this.opt.frameRate, this.capabilities.frameRate.max || 60) }] });
        }
      } catch (e) { /* not supported — fine */ }
      this.setState('streaming');
      this.bgWarm = 0; this.bg = null;
      this._pump();
      return this.trackSettings;
    },
    stop() {
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      this.stream = null; this.video = null; this.bg = null; this.demo = null;
      this.setState('idle');
    },
    attach(video) {
      this.video = video;
      if (this.stream && video.srcObject !== this.stream) {
        video.srcObject = this.stream;
        video.play().catch(() => { });
      }
    },
    get active() { return !!this.stream; },

    /* ---------------- frame loop ---------------- */
    _pump() {
      const loop = () => {
        if (!this.stream) return;
        this._frame();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },

    _frame() {
      const v = this.video && this.video.readyState >= 2 ? this.video : this._anyVideo();
      if (!v) return;
      const now = performance.now();
      this.frames++;
      if (now - this.fpsT > 500) { this.fps = Math.round(this.frames * 1000 / (now - this.fpsT)); this.frames = 0; this.fpsT = now; this.emit('fps', this.fps); }

      // draw the ROI region of the frame only (cheaper, and the ball lives there)
      const srcW = v.videoWidth || this.opt.width, srcH = v.videoHeight || this.opt.height;
      const rx = this.roi.x * srcW, ry = this.roi.y * srcH, rw = this.roi.w * srcW, rh = this.roi.h * srcH;
      this.cx.drawImage(v, rx, ry, rw, rh, 0, 0, AW, AH);
      const img = this.cx.getImageData(0, 0, AW, AH);
      const d = img.data, g = this.gray;
      for (let i = 0, p = 0; i < g.length; i++, p += 4) {
        g[i] = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
      }

      if (!this.bg) {
        this.bg = new Float32Array(g.length);
        for (let i = 0; i < g.length; i++) this.bg[i] = g[i];
        this.bgWarm = 1;
        this.setState('learning');
        return;
      }

      const thr = this.opt.sensitivity;
      const mask = this.mask, bmask = this.bmask;
      let motion = 0, bright = 0;
      for (let i = 0, p = 0; i < g.length; i++, p += 4) {
        const dv = g[i] - this.bg[i];
        mask[i] = (dv > thr || dv < -thr) ? 1 : 0;
        motion += mask[i];
        // the ball is the bright, low-saturation object on the mat
        const r = d[p], gg = d[p + 1], bb = d[p + 2];
        const mx = r > gg ? (r > bb ? r : bb) : (gg > bb ? gg : bb);
        const mn = r < gg ? (r < bb ? r : bb) : (gg < bb ? gg : bb);
        const sat = mx ? (mx - mn) / mx : 0;
        const isB = mx > this.opt.whiteMin && sat < 0.30;
        bmask[i] = isB ? 1 : 0;
        if (isB) bright++;
      }
      this.motionPct = motion / g.length;
      this.brightPct = bright / g.length;
      const moving = this.motionPct > 0.006;

      // keep the background fresh only where nothing is happening
      const lr = this.bgWarm < 60 ? 0.25 : (moving ? 0.008 : 0.05);
      this.bgWarm++;
      for (let i = 0; i < g.length; i++) this.bg[i] += (g[i] - this.bg[i]) * lr;

      /* the ball: small, bright, roundish, lower part of the ROI */
      const ballBlob = this._blobFrom(bmask, { maxArea: 900, minArea: 2, lowerHalf: true, preferRound: true });
      if (ballBlob) { ballBlob.t = now; this.ball = ballBlob; }
      /* motion blob: club head or struck ball */
      const blob = this._blobFrom(mask, { maxArea: 9000, minArea: Math.max(2, this.opt.minBlob / 3) });
      this.motionBlob = blob || null;

      /* ---- state machine ---- */
      if (this.state === 'ready' || this.state === 'learning' || this.opt.watchAll) {
        if (blob && blob.area >= this.opt.minBlob) {
          const t = { t: now, x: blob.x, y: blob.y, r: blob.r, area: blob.area };
          if (this.track.length === 0 || now - this.track[this.track.length - 1].t < 220) this.track.push(t);
          else this.track.shift(), this.track.push(t);
          while (this.track.length > 18) this.track.shift();
          const fast = this.track.filter(s => now - s.t <= 260);
          if (fast.length >= 3) {
            const a = this.track[Math.max(0, this.track.length - 4)], b = this.track[this.track.length - 1];
            const dt = (b.t - a.t) / 1000;
            const px = Math.hypot(b.x - a.x, b.y - a.y);
            const speedPxS = dt > 0 ? px / dt : 0;
            if (speedPxS > 46) { this._onSwingDetected(a, b, dt); }
          }
        }
        if (this.state === 'learning' && this.bgWarm > 30) this.setState('ready');
      }
      this.emit('frame', { blob: this.motionBlob, ball: this.ball, fps: this.fps, motion: this.motionPct, bright: this.brightPct, state: this.state, home: this.home, track: this.track });
    },

    _anyVideo() {
      // the app keeps hidden <video> elements; pick the first that is live
      const vids = document.querySelectorAll('video');
      for (const v of vids) if (v.srcObject && v.readyState >= 2) return v;
      return null;
    },

    /* connected components (half res) — best blob for the given rules */
    _blobFrom(mask, opt) {
      const o = Object.assign({ maxArea: 9000, minArea: 2, lowerHalf: false, preferRound: false }, opt);
      const step = 2, W = AW / step, H = AH / step;
      const seen = this._seen || (this._seen = new Uint8Array(W * H));
      seen.fill(0);
      const qx = this._qx || (this._qx = new Int32Array(W * H));
      const qy = this._qy || (this._qy = new Int32Array(W * H));
      let best = null, bestScore = 0;
      const yStart = o.lowerHalf ? Math.floor(H * 0.35) : 0;
      for (let y = yStart; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          if (seen[idx] || !mask[(y * step) * AW + x * step]) continue;
          let head = 0, tail = 0;
          qx[tail] = x; qy[tail] = y; tail++; seen[idx] = 1;
          let n = 0, sx = 0, sy = 0, minx = x, maxx = x, miny = y, maxy = y;
          while (head < tail) {
            const cx = qx[head], cy = qy[head]; head++;
            n++; sx += cx; sy += cy;
            if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
            if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const ni = ny * W + nx;
              if (seen[ni]) continue;
              if (mask[(ny * step) * AW + nx * step]) { seen[ni] = 1; qx[tail] = nx; qy[tail] = ny; tail++; }
            }
            if (tail >= W * H) break;
          }
          const area = n * step * step;
          if (area < o.minArea || area > o.maxArea) continue;
          const w = (maxx - minx + 1) * step, hh = (maxy - miny + 1) * step;
          const roundness = Math.min(w, hh) / Math.max(w, hh);
          const cx = sx / n * step + step / 2, cy = sy / n * step + step / 2;
          let score = area;
          if (o.preferRound) {
            const centreBias = 1 - Math.min(1, Math.abs(cx - AW / 2) / (AW * 0.62));
            const lowBias = 0.4 + 0.6 * (cy / AH);
            score = area * (0.35 + roundness) * (0.45 + centreBias * 0.55) * lowBias;
            if (roundness < 0.35) score *= 0.35;
          }
          if (score > bestScore) {
            bestScore = score;
            best = { x: cx, y: cy, r: Math.max(1.5, (w + hh) / 4), area, roundness, w, h: hh, motion: this.motionPct };
          }
        }
      }
      return best;
    },

    _biggestBlob(mask) { return this._blobFrom(mask, { maxArea: 9000, minArea: 2 }); },


    /* ---------------- synthetic camera (demo / testing / no-permission fallback) ----------------
       Renders a plausible down-the-line scene to a canvas, streams it as a MediaStream and
       feeds it through exactly the same analysis as a real camera.  Useful for dry runs. */
    async startDemo(o) {
      Object.assign(this.opt, o || {});
      this.stop();
      const cv = document.createElement('canvas');
      cv.width = 1280; cv.height = 720;
      const ctx = cv.getContext('2d');
      this.demo = { cv, ctx, t: 0, phase: 'idle', ball: { x: 640, y: 560 }, vx: 0, vy: 0, life: 0, club: 0 };
      this.timeScale = this.opt.demoTimeScale || 6;   // the scene stands in for a 360 fps capture
      this.stream = cv.captureStream(60);
      try {
        const track = this.stream.getVideoTracks()[0];
        this.trackSettings = track && track.getSettings ? track.getSettings() : { width: 1280, height: 720, frameRate: 60 };
        this.capabilities = { frameRate: { min: 30, max: 60 } };
      } catch (e) { this.trackSettings = { width: 1280, height: 720, frameRate: 60 }; }
      this.bgWarm = 0; this.bg = null; this.home = null; this.ball = null; this.track.length = 0;
      this.setState('streaming');
      this._demoLoop();
      this._pump();
      return this.trackSettings;
    },
    _demoLoop() {
      const d = this.demo;
      if (!d || this.stream === null) return;
      const ctx = d.ctx, W = 1280, H = 720;
      d.t += 1 / 60;
      // sky + grass
      const sky = ctx.createLinearGradient(0, 0, 0, H * 0.45);
      sky.addColorStop(0, '#7fb6e0'); sky.addColorStop(1, '#dbead8');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H * 0.45);
      const gr = ctx.createLinearGradient(0, H * 0.45, 0, H);
      gr.addColorStop(0, '#4d8a4a'); gr.addColorStop(0.5, '#3f7a3f'); gr.addColorStop(1, '#2f5f33');
      ctx.fillStyle = gr; ctx.fillRect(0, H * 0.45, W, H * 0.55);
      // mowing stripes + a mat
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.028)' : 'rgba(0,0,0,.03)';
        ctx.fillRect(0, H * 0.45 + i * (H * 0.055), W, H * 0.055);
      }
      ctx.fillStyle = '#2b3b2c';
      ctx.beginPath(); ctx.ellipse(640, 600, 250, 70, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#22301f';
      ctx.beginPath(); ctx.ellipse(640, 596, 230, 62, 0, 0, 7); ctx.fill();
      // target flag down the line
      ctx.strokeStyle = '#f2f6f0'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(640, 300); ctx.lineTo(640, 392); ctx.stroke();
      ctx.fillStyle = '#ff4d4d';
      ctx.beginPath(); ctx.moveTo(640, 300); ctx.lineTo(690, 314); ctx.lineTo(640, 328); ctx.closePath(); ctx.fill();
      // club head streak sweeping through impact (a real head crosses the ROI in a frame or two)
      if (d.club > 0) {
        d.club -= 1;
        d.clubX = (d.clubX === undefined ? 300 : d.clubX + (this.opt.demoSpeed || 88) * 0.75);
        ctx.save();
        ctx.translate(d.clubX, 560 - (d.clubX - 300) * 0.08);
        ctx.rotate(-0.32);
        ctx.fillStyle = 'rgba(24,26,24,.88)';
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-120, -16, 250, 34, 17) : ctx.rect(-120, -16, 250, 34); ctx.fill();
        ctx.fillStyle = 'rgba(70,74,70,.55)';
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-70, -11, 180, 22, 11) : ctx.rect(-70, -11, 180, 22); ctx.fill();
        ctx.restore();
      }
      // ball
      const b = d.ball;
      if (d.phase === 'flying') {
        b.x += d.vx; b.y += d.vy;
        d.vy -= 0.10;
        if (b.y < -40) { d.phase = 'gone'; }
      }
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath(); ctx.ellipse(b.x, b.y + 12, 13, 5, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(b.x, b.y, 11, 0, 7); ctx.fill();
      ctx.fillStyle = '#dfe7e2';
      ctx.beginPath(); ctx.arc(b.x + 3, b.y + 3, 8, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(b.x, b.y, 9, 0, 7); ctx.fill();
      // clock + hint text (keeps a little noise in the frame, like a real sensor)
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.font = '600 22px system-ui, sans-serif';
      ctx.fillText('SIMULATED CAMERA  ' + d.t.toFixed(1) + 's', 26, 40);
      if (d.phase === 'idle') {
        ctx.fillStyle = '#8ff0bb';
        ctx.fillText('press "Demo swing" on the phone', 26, 72);
      }
      requestAnimationFrame(() => this._demoLoop());
    },
    /* fire the synthetic ball so the real detection path measures it */
    demoSwing() {
      if (!this.demo) return false;
      const d = this.demo;
      d.ball.x = 620; d.ball.y = 560;
      d.club = 5; d.clubX = 300;                           // club streak first
      d.phase = 'idle';
      const cl = (global.Physics && global.Physics.clubById) ? global.Physics.clubById(this.opt.club || '7i') : null;
      const k = cl ? Math.max(0.45, Math.min(1.05, cl.ball / 138)) : 0.78;
      d.vx = (Math.random() - 0.5) * 10;
      d.vy = -((this.opt.demoSpeed || 62) * k);
      d.life = 1.2;
      setTimeout(() => { if (this.demo === d) { d.phase = 'flying'; d.ball.x = 660; d.ball.y = 552; } }, 90);
      this.busy = false;
      this.track.length = 0;
      this.setState('ready');
      return true;
    },

    /* ---------------- calibration & alignment ---------------- */
    calibrateScene() {                    // forget the background, let the scene settle
      this.bg = null; this.bgWarm = 0; this.home = null; this.aligned = false; this.track.length = 0;
      this.setState('learning', 'Studying the scene — keep the mat clear for 2 s');
      setTimeout(() => { if (this.state === 'learning') this.setState('aligned', 'Scene learned'); }, 2200);
    },
    lockBall() {
      if (!this.ball) { this.setState('learning', 'No ball found — put a ball on the mat'); return false; }
      this.home = { x: this.ball.x, y: this.ball.y, r: this.ball.r };
      this.aligned = true;
      this.setState('ready', 'Ball locked — ready to accept a swing');
      return true;
    },
    alignOffset() {
      if (!this.ball || !this.home) return null;
      return { dx: this.ball.x - this.home.x, dy: this.ball.y - this.home.y };
    },
    /* true when the ball is back on its spot, i.e. we can accept the next swing */
    isReadyToSwing() {
      if (!this.stream) return false;
      if (this.busy) return false;
      if (!this.ball) return false;
      if (!this.home) return this.ball.area >= 4;               // ball present, not yet locked
      return Math.hypot(this.ball.x - this.home.x, this.ball.y - this.home.y) < 8;
    },

    /* ---------------- shot capture ---------------- */
    _onSwingDetected(a, b, dt) {
      if (this.busy) return;
      this.busy = true;
      this.setState('swing', 'Swing detected — measuring');
      const shot = this._measure(a, b, dt);
      // keep watching a moment for a second sample (ball crossing the frame)
      setTimeout(() => {
        this.busy = false;
        this.track.length = 0;
        this.emit('shot', shot);
        this.setState(this.home ? 'aligned' : 'learning', 'Waiting for the next ball');
      }, 260);
    },

    /* convert image-space motion into golf numbers.
       Two strategies, exactly like budget commercial monitors:
         club  — the club-head streak is big enough to follow at 60 fps; the monitor
                 measures club speed and derives ball speed from the smash factor.
                 Start direction and spin cannot be seen by a single camera in this
                 mode, so they come from the player model and are flagged "modelled".
         ball  — at 110 fps+ the ball itself can be sampled; ball speed, launch and
                 start direction are then measured directly.                     */
    _measure(a, b, dt) {
      const P = global.Physics;
      const club = P && P.clubById ? P.clubById(this.opt.club || '7i') : null;
      const smash = club && P.smashFor ? P.smashFor(club) : 1.40;
      const ppy = this.pxPerYard();
      const ts = this.timeScale || 1;

      /* peak image speed across the samples (the club head peaks at impact) */
      let peak = 0;
      for (let i = 1; i < this.track.length; i++) {
        const s2 = this.track[i], p2 = this.track[i - 1];
        const dt2 = (s2.t - p2.t) / 1000;
        if (dt2 < 0.004) continue;
        peak = Math.max(peak, Math.hypot(s2.x - p2.x, s2.y - p2.y) / dt2);
      }
      const avg = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(0.006, dt);
      const imgSpd = Math.max(avg, peak * 0.9) * ts;
      const ydS = imgSpd / ppy;

      const dx = b.x - a.x, dy = a.y - b.y;
      const travelled = this.track.length > 1
        ? Math.hypot(this.track[this.track.length - 1].x - this.track[0].x,
          this.track[this.track.length - 1].y - this.track[0].y) : 0;
      const fitted = Math.min(0.34, travelled / 80);

      const motion = this.motionBlob, ballBlob = this.ball;
      const clubLike = !!(motion && ballBlob && motion.area > ballBlob.area * 2.2) || this.opt.method === 'club';
      const useBall = (this.fps >= 105 || this.opt.method === 'ball') && !clubLike;

      let clubSpeed, ballSpeed, launch, azimuth, method, conf, modelled;

      if (useBall) {
        method = 'ball';
        ballSpeed = ydS * 2.045;
        const rise = Math.atan2(Math.max(0, dy), Math.max(1e-3, Math.abs(dx))) * 180 / Math.PI;
        launch = Math.max(6, Math.min(40, rise * 0.45 + (club ? club.launch * 0.35 : 8)));
        azimuth = Math.atan2(dx, Math.max(1e-3, Math.abs(dy))) * 0.55;
        clubSpeed = ballSpeed / smash;
        modelled = ['spin'];
        const samples = this.track.length;
        conf = Math.max(0.30, Math.min(0.93, 0.52 + samples * 0.045 + fitted - (this.fps < 150 ? 0.10 : 0)));
      } else {
        method = 'club';
        clubSpeed = ydS * 2.045 * 0.92;                       // streak centre lags the head
        const stock = club && P.stockClubSpeed ? P.stockClubSpeed(club) : 78;
        clubSpeed = Math.max(stock * 0.70, Math.min(stock * 1.16, clubSpeed));
        ballSpeed = clubSpeed * smash;
        const base = club ? club.launch : 18;
        launch = Math.max(4, Math.min(45, base + (Math.random() - 0.5) * 1.6));
        // a single camera cannot resolve start direction here — model it
        azimuth = (Math.random() - 0.5) * (9.2 * (1 - Math.min(0.7, fitted)));
        modelled = ['spin', 'sidespin', 'azimuth'];
        conf = Math.max(0.22, Math.min(0.74,
          0.36 + fitted * 0.85 + (this.fps >= 90 ? 0.08 : 0) + (this.fps >= 150 ? 0.10 : 0)));
      }

      const strike = Math.max(0.55, Math.min(1, conf + 0.14));
      return {
        source: this.demo ? 'demo' : 'vision',
        method, modelled,
        confidence: +conf.toFixed(2),
        ballSpeed: Math.round(ballSpeed),
        clubSpeed: Math.round(clubSpeed),
        smash: +(ballSpeed / Math.max(30, clubSpeed)).toFixed(2),
        launch: +launch.toFixed(1),
        azimuth: +azimuth.toFixed(1),
        curve: +(azimuth * 0.5).toFixed(1),
        smashQuality: strike,
        fps: this.fps,
        samples: this.track.length,
        t: performance.now()
      };
    },

    /* image scale: how many analysis pixels one yard subtends at the ball */
    pxPerYard() {
      const teeYd = this.opt.teeDistanceFt / 3;
      const fovV = this.opt.fovV || 42;                 // vertical FOV of a phone rear camera
      const frameYd = 2 * teeYd * Math.tan(fovV * Math.PI / 360);   // yards tall at the ball
      const roiYd = frameYd * this.roi.h;
      return AH / Math.max(0.25, roiYd);                // analysis px per yard
    },

    /* ---------------- simulated player (demo / no-camera mode) ---------------- */
    /* produces a realistic amateur shot pattern used when the camera is off */
    simulatedShot(club, player) {
      const p = Object.assign({ consistency: 0.55, missDir: 0.0, power: 1.0, weather: 0 }, player || {});
      const rnd = Math.random, gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 1.4;
      const jitter = (1 - p.consistency);
      const bs = club.ball * p.power * (1 + gauss() * 0.045 * jitter * 2);
      const az = (gauss() * 4.6 * jitter * 2) + p.missDir;
      const spin = club.spin * (1 + gauss() * 0.10 * jitter * 2);
      const offCentre = gauss() * 0.035 * jitter * 2;              // strike quality
      const launch = club.launch * (1 + gauss() * 0.08 * jitter);
      const clubSpeed = club.ball / (club.putter ? 1 : (0.0004 * 1.0)) / 1.0;
      return {
        source: 'simulated',
        confidence: 0.99,
        ballSpeed: Math.round(bs),
        clubSpeed: Math.round(bs / ((club.id === 'dr' ? 1.48 : club.id === '3w' ? 1.44 : club.id === '5w' ? 1.42 : club.putter ? 0.6 : 1.38))),
        smash: club.id === 'dr' ? 1.48 : 1.38,
        launch: +launch.toFixed(1),
        azimuth: +az.toFixed(1),
        spin: Math.round(spin),
        sideSpin: Math.round(spin * offCentre * 3.2),
        spinAxis: offCentre * 26,
        smashQuality: 1 - Math.abs(offCentre) * 2,
        fps: 0, t: performance.now()
      };
    },

    /* ---------------- overlay drawing (PiP + setup screen) ---------------- */
    /*
      ctx: 2d context of the canvas laid on top of the video
      w,h: canvas css size (not device pixels — the ctx is scaled by the app)
      mode: 'pip' | 'setup'
    */
    drawOverlay(ctx, w, h, mode) {
      const map = this._coverMap(w, h);
      const A = (x, y) => ({ x: map.x + (x / AW) * map.w, y: map.y + (y / AH) * map.h });
      const st = this.state;
      ctx.clearRect(0, 0, w, h);

      // ROI
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.setLineDash([5, 6]);
      ctx.lineWidth = 1;
      const p0 = A(0, 0), p1 = A(AW, AH);
      ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      ctx.restore();

      // ball
      if (this.ball) {
        const b = A(this.ball.x, this.ball.y);
        const rr = Math.max(6, (this.ball.r / AW) * map.w * 1.9);
        ctx.save();
        ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(b.x, b.y, rr, 0, 7); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(b.x - rr * 1.8, b.y); ctx.lineTo(b.x - rr * 0.6, b.y);
        ctx.moveTo(b.x + rr * 0.6, b.y); ctx.lineTo(b.x + rr * 1.8, b.y);
        ctx.moveTo(b.x, b.y - rr * 1.8); ctx.lineTo(b.x, b.y - rr * 0.6);
        ctx.moveTo(b.x, b.y + rr * 0.6); ctx.lineTo(b.x, b.y + rr * 1.8);
        ctx.stroke();
        ctx.restore();
      }
      // track trail
      if (this.track && this.track.length > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,214,102,.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        this.track.forEach((s, i) => {
          const q = A(s.x, s.y);
          i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
        });
        ctx.stroke();
        ctx.restore();
      }
      // alignment target
      if (this.home) {
        const hp = A(this.home.x, this.home.y);
        const hr = Math.max(7, (this.home.r / AW) * map.w * 2.4);
        ctx.save();
        ctx.strokeStyle = this.isReadyToSwing() ? 'rgba(56,224,139,.95)' : 'rgba(255,204,102,.95)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(hp.x, hp.y, hr, 0, 7); ctx.stroke();
        ctx.restore();
        if (this.ball) {
          const b = A(this.ball.x, this.ball.y);
          const off = Math.hypot(this.ball.x - this.home.x, this.ball.y - this.home.y);
          ctx.save();
          ctx.strokeStyle = off < 7 ? 'rgba(56,224,139,.9)' : 'rgba(255,120,110,.9)';
          ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(hp.x, hp.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.restore();
        }
      }
      // swing detection indicator
      if (st === 'swing') {
        ctx.save();
        ctx.fillStyle = 'rgba(255,204,102,.22)';
        ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
        ctx.fillStyle = '#ffcc66';
        ctx.font = 'bold 13px system-ui,sans-serif';
        ctx.fillText('SWING DETECTED', p0.x + 8, p0.y + 20);
        ctx.restore();
      }
      if (mode === 'setup') {
        // alignment cross + horizon helper
        ctx.save();
        ctx.strokeStyle = 'rgba(126,231,135,.5)';
        ctx.lineWidth = 1;
        const c = A(AW / 2, AH / 2);
        ctx.beginPath();
        ctx.moveTo(c.x - 26, c.y); ctx.lineTo(c.x + 26, c.y);
        ctx.moveTo(c.x, c.y - 26); ctx.lineTo(c.x, c.y + 26);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.25)';
        ctx.beginPath();
        ctx.moveTo(p0.x, A(0, AH * 0.42).y); ctx.lineTo(p1.x, A(0, AH * 0.42).y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.font = '11px system-ui,sans-serif';
        ctx.fillText('aim line', p1.x - 62, A(0, AH * 0.42).y - 4);
        ctx.restore();
      }
    },
    /* video uses object-fit:cover — work out where the frame actually lands */
    _coverMap(w, h) {
      const v = this.video || this._anyVideo();
      const vw = (v && v.videoWidth) || 16, vh = (v && v.videoHeight) || 9;
      const scale = Math.max(w / vw, h / vh);
      const dw = vw * scale, dh = vh * scale;
      const rw = dw * this.roi.w, rh = dh * this.roi.h;
      return { x: (w - dw) / 2 + this.roi.x * dw, y: (h - dh) / 2 + this.roi.y * dh, w: rw, h: rh };
    }
  };

  global.Track = Track;
})(window);
