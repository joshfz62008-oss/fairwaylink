/* ============================================================
   app.js — FairwayLink sim: navigation, game loop, modes
   ============================================================ */
(function () {
  'use strict';
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const DEF = {
    units: 'yd', hand: 'right', fov: 55, ball: 'real', elev: 'gentle', wind: 4,
    aimLine: true, camera: 'environment', res: '1920', hfr: '60', notify: true, vib: true,
    pip: true, autofs: false, autoland: false, clean: false, tee: 'blue', tolY: 'sweet'
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('fl_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('fl_' + k, JSON.stringify(v)); } catch (e) { } }
  };

  const App = {
    S: Object.assign({}, DEF),                 // settings
    screen: 'home', mode: 'home',
    courses: [], course: null, hole: null, holeIndex: 0, teeOrder: [],
    ter: null, terCache: {},
    ballPos: { x: 0, z: 0 }, ballY: 0,
    club: null, aim: 0, aimBias: 0,
    ball: null, flying: false, landing: null, traces: [], balls: [],
    strokes: 0, card: [], putts: 0, lieNote: '',
    cam: { x: 0, y: 3, z: -8, yaw: 0, pitch: -0.06 },
    camMode: 'behind', puttingView: false, flyT: 0,
    ready: false, lastShot: null, shotHistory: [],
    range: { hits: [], club: 'dr' }, gap: { club: 'dr', hits: [] }, green: { hits: [], dist: 5, stimp: 10 },
    drag: null, pinch: null,

    /* ============================================================
       boot
       ============================================================ */
    async init() {
      this.S = Object.assign({}, DEF);
      Object.keys(DEF).forEach(k => { this.S[k] = store.get(k, DEF[k]); });
      this.engine = new Engine($('#view'));
      this.mm = $('#minimap');
      this.track = new Track({ sensitivity: 26, frameRate: +this.S.hfr, facing: this.S.camera, width: +this.S.res });
      this.bindTrack();
      this.bindUI();
      this.applySettingsToUI();
      this.watchLayout();
      await this.loadCourses();
      this.updateReady(false);
      this.loop();
      if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      }
      this.notify('FairwayLink ready', 'Turn on the rear camera to start the launch monitor', 2600);
    },

    async loadCourses() {
      try {
        const r = await fetch('data/courses.json');
        const j = await r.json();
        this.courses = j.courses;
        $('#ogccredit').textContent = j.note + ' ' + j.source;
        this.renderCourses();
        $('#courseCount').textContent = '· ' + this.courses.length;
      } catch (e) {
        // Opened straight from the file system, or a blocked fetch: fall back to the same
        // course list with procedurally generated terrain so the app is still fully playable.
        this.courses = FALLBACK_COURSES();
        this.offlineArt = true;
        $('#ogccredit').textContent = 'data/courses.json could not be read, so the courses below use generated terrain. '
          + 'Serve the www folder (python3 serve.py) to get the OGC hole maps and full course art.';
        this.renderCourses();
        $('#courseCount').textContent = '· ' + this.courses.length;
      }
    },

    /* ============================================================
       UI helpers
       ============================================================ */
    go(screen) {
      $$('.screen').forEach(s => s.classList.remove('active'));
      const el = $('#scr-' + screen);
      if (el) el.classList.add('active');
      this.screen = screen;
      $('#modeLabel').textContent = {
        home: 'Home', course: 'Course', sim: this.mode === 'range' ? 'Driving range'
          : this.mode === 'green' ? 'Putting green' : this.mode === 'cage' ? 'Club gapping' : 'Round', cam: 'Launch monitor',
        card: 'Scorecard', set: 'Settings', cast: 'Casting'
      }[screen] || '';
      $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.nav === screen || (b.dataset.nav === 'home' && screen === 'course')));
      document.body.classList.toggle('playing', screen === 'sim');
      if (screen === 'sim') { this.engine.resize(); this.engine.render(this.frame(0)); }
      if (screen === 'cam') this.refreshCamScreen();
      if (screen === 'card') this.renderCard();
    },
    toast(msg, ms) {
      const t = $('#toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(this._tt);
      this._tt = setTimeout(() => t.classList.remove('show'), ms || 2000);
    },
    banner(msg, sub, ms) {
      const b = $('#banner');
      b.innerHTML = msg + (sub ? '<small>' + sub + '</small>' : '');
      b.classList.add('show');
      clearTimeout(this._bt);
      if (ms !== 0) this._bt = setTimeout(() => b.classList.remove('show'), ms || 2200);
    },
    hideBanner() { $('#banner').classList.remove('show'); },
    async notify(title, body, ms) {
      this.toast(title + (body ? ' — ' + body : ''), ms || 2200);
      if (this.S.vib && navigator.vibrate) { try { navigator.vibrate(24); } catch (e) { } }
      if (this.S.notify && 'Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(title, { body: body || '', tag: 'fairwaylink', silent: true, icon: 'assets/icon.svg' });
        } catch (e) { }
      }
    },
    async askNotify() {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { } }
    },

    /* ============================================================
       course list
       ============================================================ */
    renderCourses() {
      const region = this._region || 'all';
      const list = this.courses.filter(c => region === 'all' || c.region === region);
      $('#courselist').innerHTML = list.map(c => `
        <button class="coursecard" data-course="${c.id}">
          <div class="thumb" style="background-image:url('${this.offlineArt ? '' : c.layout[0].art}')"></div>
          <div class="cc-main">
            <span class="cc-region">${c.region}</span>
            <b>${c.name}</b>
            <div class="cc-meta"><span>${c.holes} holes</span><span>Par ${c.par}</span><span>${c.yards} yd</span></div>
            <div class="cc-par">${c.layout.map(h => `<span class="hp p${h.par}">${h.par}</span>`).join('')}</div>
          </div>
        </button>`).join('');
      $$('#courselist .coursecard').forEach(b => b.onclick = () => this.openCourse(+b.dataset.course));
    },
    openCourse(id) {
      const c = this.courses.find(x => x.id === id);
      this.course = c;
      const f = { blue: 1, white: 0.94, red: 0.86 }[this.S.tee] || 1;
      const lab = $('#cdLabel');
      if (c.label && !this.offlineArt) { lab.style.display = ''; lab.src = c.label; }
      else lab.style.display = 'none';
      $('#cdHoles').dataset.art = this.offlineArt ? 'none' : 'yes';
      $('#cdName').textContent = c.name;
      $('#cdMeta').textContent = `${c.region} · ${c.holes} holes · Par ${c.par} · ${Math.round(c.yards * f)} yd off the ${this.S.tee} tees`;
      $('#cdHoles').innerHTML = c.layout.map(h => this.offlineArt
        ? `<figure><div class="holeart gen">${h.n}</div><figcaption><b>${h.n}</b><br>P${h.par}<br>${h.yards}</figcaption></figure>`
        : `<figure><img src="${h.art}" alt="Hole ${h.n}"><figcaption><b>${h.n}</b><br>P${h.par}<br>${h.yards}</figcaption></figure>`).join('');
      $('#cdPlay').textContent = c.holes >= 18 ? 'Play 18 · full round' : 'Play ' + c.holes + ' · full round';
      $('#cdFront').textContent = c.holes > 9 ? 'Front 9' : 'First 3';
      $('#cdFront').onclick = () => this.startRound(c.layout.slice(0, Math.min(9, c.holes)).map(h => h.n));
      $$('#cdTees button').forEach(b => b.classList.toggle('on', b.dataset.tee === this.S.tee));
      this.go('course');
    },

    /* ============================================================
       round play
       ============================================================ */
    async startRound(holes) {
      if (!this.course) return;
      this.teeOrder = holes;
      this.card = [];
      this.mode = 'round';
      this.puttingView = false;
      this.teeOffsetPct = { blue: 0, white: 0.07, red: 0.16 }[this.S.tee] || 0;
      await this.loadHole(0);
      this.go('sim');
      this.enterImmersive();
    },
    async loadHole(i) {
      this.holeIndex = i;
      const n = this.teeOrder[i];
      const meta = this.course.layout[n - 1];
      const art = await this.loadArt(meta.art);
      const yards = meta.yards * ({ blue: 1, white: 1, red: 1 }[this.S.tee] || 1);
      const key = this.course.id + '-' + n + '-' + this.S.tee;
      let ter = this.terCache[key];
      if (!ter) {
        ter = Terrain.create(art, yards * ({ blue: 1, white: 0.96, red: 0.88 }[this.S.tee] || 1), meta.par, meta.n * 13 + this.course.id);
        this.terCache[key] = ter;
      }
      this.ter = ter;
      this.hole = { n, par: meta.par, yards: Math.round(meta.yards * ({ blue: 1, white: 0.96, red: 0.88 }[this.S.tee] || 1)) };
      this.engine.setScene({ terrain: ter, sky: this.skyFor(n) });
      this.S.windDir = this.windBearingFor(n);
      this.resetHoleState();
      this.updateHUD();
      this.toast(`Hole ${n} · Par ${meta.par} · ${this.hole.yards} yd`);
    },
    windBearingFor(n) { return ((this.course ? this.course.id : 7) * 13 + n * 47) % 360; },
    skyFor(n) {
      const opts = ['morning', 'day', 'day', 'overcast', 'dusk'];
      return opts[(this.course.id + n) % opts.length];
    },
    resetHoleState() {
      const ter = this.ter;
      const startZ = ter.length * this.teeOffsetPct;
      // tee box: prefer the mapped tee if it is behind the ball
      const tx = Math.abs(ter.tee.x) < ter.width * 0.2 ? ter.tee.x : 0;
      this.ballPos = { x: tx, z: Math.max(startZ, 2) };
      this.ballY = ter.elev(this.ballPos.x, this.ballPos.z);
      this.strokes = 0; this.putts = 0; this.traces = []; this.balls = []; this.landing = null;
      this.holeComplete = false;
      this.aimBias = 0;
      this.puttingView = Math.hypot(ter.pin.x - this.ballPos.x, ter.pin.z - this.ballPos.z) < ter.greenR * 1.05;
      this.setClub(this.suggestClub());
      this.camMode = 'behind'; this.updateCam();
      this.frameLanding = null;
    },
    suggestClub() {
      const d = this.distToPin();
      if (d < 28 && this.puttingView) return Physics.clubById('pt');
      if (d < this.ter.greenR * 1.2) return Physics.clubById('gw');
      return Physics.clubForDistance(d);
    },
    distToPin() { return Math.hypot(this.ter.pin.x - this.ballPos.x, this.ter.pin.z - this.ballPos.z); },
    loadArt(src) {
      if (!src) return Promise.resolve(null);
      this._artCache = this._artCache || {};
      if (this._artCache[src]) return this._artCache[src];
      return new Promise(res => {
        const im = new Image();
        im.onload = () => { this._artCache[src] = im; res(im); };
        im.onerror = () => res(null);
        im.src = src;
      });
    },

    /* ---- clubs ---- */
    setClub(c) {
      this.club = c;
      if (this.track) this.track.opt.club = c.id;
      $('#siClub').textContent = c.short;
      this.updateClubBar();
      this.puttingView = c.putter;
      if (this.screen === 'sim') this.updateHUD();
    },
    updateClubBar() {
      const c = this.club || Physics.clubs ? (this.club || Physics.CLUBS[0]) : Physics.CLUBS[0];
      const cr = Physics.carryOf(c);
      $('#clubPick') && ($('#clubPick').innerHTML =
        `<button id="clubPrev">◀</button>
         <div class="clubname"><b>${c.name}</b><i>${cr.carry} yd carry · ${Math.round(cr.carry + cr.total - cr.carry)} yd total</i></div>
         <button id="clubNext">▶</button>
         <button id="clubList" title="All clubs">▤</button>`);
      const p = $('#clubPrev'), nx = $('#clubNext'), l = $('#clubList');
      if (p) p.onclick = () => this.cycleClub(-1);
      if (nx) nx.onclick = () => this.cycleClub(1);
      if (l) l.onclick = () => this.openClubPicker();
    },
    cycleClub(d) {
      const i = Physics.CLUBS.indexOf(this.club);
      this.setClub(Physics.CLUBS[(i + d + Physics.CLUBS.length) % Physics.CLUBS.length]);
    },
    openClubPicker() {
      const box = $('#modalbox');
      box.innerHTML = `<h3>Choose a club</h3><div class="clubgrid">${Physics.CLUBS.map(c => {
        const cr = Physics.carryOf(c);
        return `<button class="clubcard ${c === this.club ? 'on' : ''}" data-club="${c.id}">
          <b>${c.name}</b><i>${c.loft}° · ${cr.carry} yd carry<br>${c.ball} mph · ${c.spin} rpm</i></button>`;
      }).join('')}</div><div class="btnrow" style="margin-top:12px"><button class="btn" id="modalClose">Close</button></div>`;
      $('#modal').classList.add('show');
      box.querySelectorAll('[data-club]').forEach(b => b.onclick = () => {
        this.setClub(Physics.clubById(b.dataset.club)); $('#modal').classList.remove('show');
      });
      $('#modalClose').onclick = () => $('#modal').classList.remove('show');
    },

    /* ============================================================
       camera / view
       ============================================================ */
    updateCam() {
      const ter = this.ter; if (!ter) return;
      const b = this.ballPos, y = ter.elev(b.x, b.z);
      const target = ter.pin;
      const aimAz = Math.atan2(target.x - b.x, target.z - b.z) * R2D + this.aimBias;
      if (this.camMode === 'behind') {
        const d = this.puttingView ? 3.2 : 7.5;
        const h = this.puttingView ? 1.6 : 3.2;
        this.cam.x = b.x - Math.sin((aimAz) * D2R) * d;
        this.cam.z = b.z - Math.cos((aimAz) * D2R) * d;
        this.cam.y = y + h;
        this.cam.yaw = aimAz * D2R;
        this.cam.pitch = this.puttingView ? -0.22 : -0.12;
      }
      this.engine.cam.x = this.cam.x; this.engine.cam.y = this.cam.y; this.engine.cam.z = this.cam.z;
      this.engine.cam.yaw = this.cam.yaw; this.engine.cam.pitch = this.cam.pitch;
      this.engine.cam.fov = this.S.fov;
    },

    /* ============================================================
       frame assembly
       ============================================================ */
    frame(dt) {
      const ter = this.ter;
      const b = this.ballPos;
      const y = ter ? ter.elev(b.x, b.z) : 0;
      const balls = [];
      if (this.ball && this.flying) {
        balls.push({ x: this.ball.p.x, y: this.ball.p.y, z: this.ball.p.z, ring: 'rgba(255,255,255,.75)' });
      }
      balls.push({ x: b.x, y: y + 0.05, z: b.z, color: this.flying ? '#e8f6ee' : '#ffffff' });
      this.balls.forEach(o => balls.push(o));

      const marks = [];
      if (this.S.aimLine) {
        const step = this.S.units === 'm' ? 50 : 50;
        for (let d = step; d <= 500; d += step) marks.push({ d: this.unit(d), label: this.unitLabel(d) });
      }
      const traces = this.traces.slice();
      if (this.flying && this.ball && this.ball.trace.length > 1)
        traces.push(this.ball.trace.concat().map(p => ({ x: p.x, y: p.y, z: p.z })));
      const frame = {
        balls,
        traces,
        aim: { x: b.x, z: b.z, azimuth: this.aimAz(), length: Math.min(560, this.distToPin() + 30), marks: this.S.aimLine ? marks : [] },
        landing: this.landing,
        wind: this.windInfo(),
        splashes: this.splashes || [],
        flags: ter ? [{ x: ter.pin.x, z: ter.pin.z, color: '#ff4d4d', label: this.puttingView ? '' : this.unitLabel(Math.round(this.distToPin())) }] : [],
        targets: this.rangeTargets || []
      };
      return frame;
    },
    aimAz() {
      const b = this.ballPos, t = this.ter.pin;
      return Math.atan2(t.x - b.x, t.z - b.z) * R2D + this.aimBias;
    },
    /* wind blows toward `windBearing` (degrees clockwise from the aim line) */
    windInfo() {
      const w = this.S.wind;
      if (!w) return { label: 'calm', rot: 0, speed: 0 };
      const rel = this.windBearing();                 // 0 = straight down the aim line (tailwind)
      const names = [
        [22, 'out'], [67, 'out·R'], [112, 'R'], [157, 'R·in'], [180, 'in'],
        [203, 'in·L'], [248, 'L'], [293, 'L·out'], [338, 'out']
      ];
      let name = 'out';
      let best = 1e9;
      [0, 45, 90, 135, 180, 225, 270, 315, 360].forEach((deg, i) => {
        const d = Math.abs(((rel - deg + 540) % 360) - 180);
        if (d < best) { best = d; name = ['out', 'out R', 'R→L', 'in R', 'in', 'in L', 'L→R', 'out L', 'out'][i]; }
      });
      return { label: w + ' mph ' + name, rot: rel, speed: w };
    },
    windBearing() { return ((this.S.windDir || 25) + this.aimBias) % 360; },
    windVector() {
      const w = this.S.wind;
      if (!w) return { x: 0, z: 0 };
      // convert "toward bearing relative to the aim line" into world x/z (wind vector)
      const rad = (this.aimAz() + this.windBearing()) * D2R;
      return { x: Math.sin(rad) * w, z: Math.cos(rad) * w };
    },
    unit(yd) { return this.S.units === 'm' ? yd * 0.9144 : yd; },
    unitLabel(yd) { return this.S.units === 'm' ? Math.round(yd * 0.9144) + ' m' : yd + ' yd'; },

    /* ============================================================
       swing → shot
       ============================================================ */
    onSwingInput(shotData) {
      if (this.flying || this.screen !== 'sim') return;
      if (this.holeComplete) { this.toast('Hole complete — loading the next tee'); return; }
      const club = this.club;
      if (this.track) { this.track.opt.club = club.id; this.track.opt.fovV = 42; }
      let d = shotData;
      if (!d) {
        d = this.track.simulatedShot(club, this.playerModel());
      }
      // spin: measured if the monitor can see it, otherwise the player model supplies it
      const modelled = d.source === 'vision' && d.modelled;
      let spin = d.spin !== undefined ? d.spin : club.spin * (1 + (d.launch - club.launch) * 0.012);
      let sideSpin = d.sideSpin !== undefined ? d.sideSpin : (d.azimuth * 26 + (d.curve || 0));
      if (d.source === 'vision' && !d.clubSpeed) d.clubSpeed = Math.round(d.ballSpeed / (club.smash || 1.42));
      this._modelled = !!(modelled && modelled.length);
      const spinTag = this._modelled ? '~' : '';
      $('#siSpin').textContent = spinTag + Math.round(spin);
      const quality = d.smashQuality !== undefined ? d.smashQuality : 1;
      spin *= (0.94 + 0.12 * quality);
      const wind = this.windVec();
      const ball = new Physics.Ball(this.ter, {
        speed: d.ballSpeed, launch: d.launch, azimuth: d.azimuth,
        spin: spin, sideSpin: sideSpin, spinAxis: d.spinAxis || 0,
        start: { x: this.ballPos.x, z: this.ballPos.z },
        wind: wind, lift: Physics.liftForBall(this.S.ball),
        stimp: this.green.stimp, club: club.id, clubName: club.name
      });
      this.ball = ball; this.flying = true;
      this.camMode = 'follow';
      this.hideBanner();
      this.lastShot = { d, club };
      this.lastD = d;
      this.shotClub = club;
      $('#siBall').textContent = Math.round(d.ballSpeed);
      $('#siLaunch').textContent = d.launch.toFixed(1);
      this.shotHistory.push({ club: club.id, ...d });
      if (d.source === 'vision' || d.source === 'demo') {
        const mod = d.modelled && d.modelled.length ? ' · spin modelled' : '';
        const how = d.method === 'ball' ? 'ball tracked' : 'club streak';
        this.toast(how + ' · ' + Math.round((d.confidence || 0.7) * 100) + '% confidence' + mod, 2400);
      }
    },
    windVec() {
      if (!this.S.wind) return { x: 0, z: 0 };
      // wind blows from 8 o'clock as a default (into and across from the left) — the
      // direction is randomised per hole so it feels alive
      const base = (this.hole ? (this.hole.n * 37) % 360 : 40);
      const rad = (base + 180) * D2R;      // direction the wind is going toward
      const mph = this.S.wind;
      return { x: Math.sin(rad) * mph, z: Math.cos(rad) * mph };
    },
    playerModel() {
      return { consistency: 0.55, missDir: 0, power: 1.0 };
    },

    updateFlight(dt) {
      if (!this.ball) return;
      const steps = Math.min(14, Math.max(1, Math.round(dt * 240)));
      for (let i = 0; i < steps; i++) this.ball.step(dt / steps);
      this.engine.followCamera(this.ball.p, {
        dist: this.puttingView ? 3.2 : 10.5, height: this.puttingView ? 1.3 : 4.6,
        lookAhead: this.puttingView ? 4 : 17, drop: this.puttingView ? 0.2 : 0.5,
        groundY: this.ter.elev(this.ball.p.x, this.ball.p.z)
      });
      this.frameLanding = { x: this.ball.p.x, z: this.ball.p.z, t: 0 };
      // live read-out while the ball is in the air
      $('#siCarry').textContent = Math.round(this.unit(this.ball.travelled()));
      const off = this.ball.offline();
      $('#siOff').textContent = (off >= 0 ? '+' : '') + Math.round(this.unit(off));
      if (this.ball.state === 'stopped' || this.ball.state === 'holed') {
        this.flying = false;
        this.landing = {
          x: this.ball.p.x, z: this.ball.p.z,
          color: this.ball.state === 'holed' ? 'rgba(126,231,135,1)' : 'rgba(255,214,102,1)',
          label: (this.ball.state === 'holed' ? 'HOLED' : Math.round(Math.hypot(this.ball.p.x, this.ball.p.z)) + ' yd')
        };
        if (this.ball.splash) this.splashes = (this.splashes || []).concat([{ x: this.ball.splash.x, z: this.ball.splash.z, t: 0 }]);
        this.finishShot();
      }
    },
    finishShot() {
      const s = this.ball.summary();
      this.traces.push(this.ball.trace.map(p => ({ x: p.x, y: p.y, z: p.z })).concat([]));
      if (this.traces.length > 6) this.traces.shift();
      const holed = s.rest === 'holed';
      const water = s.events.indexOf('water') >= 0;
      this.strokes += 1 + (water ? 1 : 0);
      if (this.club.putter) this.putts++;
      $('#siCarry').textContent = s.carry;
      $('#siOff').textContent = (s.offline >= 0 ? '+' : '') + s.offline;
      const ld = this.lastD || {};
      $('#sMag').textContent = !this.track.active ? 'player model'
        : (ld.method === 'ball' ? 'ball · ' + Math.round((ld.confidence || 0) * 100) + '%'
          : ld.method === 'club' ? 'club · ' + Math.round((ld.confidence || 0) * 100) + '%'
            : 'simulated');

      if (this.mode === 'round') {
        if (holed) {
          this.ballPos = { x: this.ter.pin.x, z: this.ter.pin.z };
          this.updateHUD();
          const name = this.scoreName(this.strokes, this.hole.par);
          this.notify('Hole ' + this.hole.n + ' — ' + name + '!', 'Score: ' + this.strokes + ' (par ' + this.hole.par + ')');
          this.banner('&#9971; ' + name.toUpperCase() + '!', 'Hole ' + this.hole.n + ' · ' + this.strokes + ' shot' + (this.strokes > 1 ? 's' : '') + (this.putts ? ' · ' + this.putts + ' putt' + (this.putts > 1 ? 's' : '') : ''), 2600);
          this.saveHoleScore();
          this.holeComplete = true;
          clearTimeout(this._nextT);
          this._nextT = setTimeout(() => this.nextHole(), 2800);
          return;
        }
        // penalty drop
        if (water) {
          const dropZ = Math.max(2, this.ball.p.z - 6);
          const dropX = this.ball.p.x * 0.85;
          this.ballPos = { x: dropX, z: dropZ };
          this.toast('Water — one shot penalty, dropping back');
        } else {
          this.ballPos = { x: this.ball.p.x, z: this.ball.p.z };
        }
        this.landing = { x: this.ballPos.x, z: this.ballPos.z, color: 'rgba(126,231,135,.9)', label: this.surfaceName() };
        this.camMode = 'behind';
        const onGreen = this.ter.isGreen(this.ballPos.x, this.ballPos.z);
        this.puttingView = onGreen || Physics.clubById('pt') === this.club;
        if (onGreen) {
          if (!this.club.putter) this.setClub(Physics.clubById('pt'));
          if (!this._greenNoted) { this.toast('On the green — putter selected'); this._greenNoted = true; }
        } else {
          const sug = this.suggestClub();
          const prev = this.club;
          if (sug !== prev) {
            this.setClub(sug);
            this.toast('Next: ' + sug.name + ' for ' + Math.round(this.unit(this.distToPin())) + ' ' + (this.S.units === 'm' ? 'm' : 'yd'), 2400);
          }
        }
        this.updateHUD();
        this.updateCam();
      } else {
        // range / green / gap modes
        this.balls.push({ x: this.ball.p.x, y: this.ball.p.y, z: this.ball.p.z, color: '#dff5e8' });
        if (this.balls.length > 12) this.balls.shift();
        const sc = this.shotClub || this.club;
        const rec = { ...s, club: sc.id, clubName: sc.name, az: (this.lastD && this.lastD.azimuth) || 0, conf: (this.lastD && this.lastD.confidence) || 0, method: (this.lastD && this.lastD.method) || 'sim' };
        if (this.mode === 'range') this.range.hits.push(rec);
        if (this.mode === 'green') this.green.hits.push(rec);
        if (this.mode === 'cage') this.gap.hits.push(rec);
        this.ballPos = { x: this.ter.tee.x, z: this.ter.tee.z };
        this.camMode = 'behind'; this.updateCam();
        this.reportPractice();
      }
      this.updateReady(true);
    },
    surfaceName() {
      const k = this.ter.surfKeyAt ? this.ter.surfKeyAt(this.ballPos.x, this.ballPos.z) : '';
      const t = this.ter.typeAt(this.ballPos.x, this.ballPos.z);
      return ['Water', 'Bunker', 'Green', 'Fairway', 'Rough', 'Trees'][t] || '';
    },
    scoreName(strokes, par) {
      const d = strokes - par;
      if (strokes === 1) return 'Hole in one';
      if (d <= -3) return 'Albatross';
      if (d === -2) return 'Eagle';
      if (d === -1) return 'Birdie';
      if (d === 0) return 'Par';
      if (d === 1) return 'Bogey';
      if (d === 2) return 'Double bogey';
      return '+' + d;
    },
    saveHoleScore() {
      this.card[this.holeIndex] = { n: this.hole.n, par: this.hole.par, yards: this.hole.yards, strokes: this.strokes, putts: this.putts };
    },
    async nextHole() {
      this.holeComplete = false;
      if (this.holeIndex + 1 >= this.teeOrder.length) { this.finishRound(); return; }
      this._greenNoted = false;
      await this.loadHole(this.holeIndex + 1);
    },
    finishRound() {
      const played = this.card.filter(Boolean);
      const tot = played.reduce((a, h) => a + h.strokes, 0);
      const par = played.reduce((a, h) => a + h.par, 0);
      const putts = played.reduce((a, h) => a + (h.putts || 0), 0);
      this.mode = 'home';
      this.banner('Round complete', `${played.length} holes · ${tot} strokes (${tot - par >= 0 ? '+' : ''}${tot - par} to par) · ${putts} putts`, 6000);
      this.renderCard();
      this.go('card');
      this.notify('Round complete', `${tot} strokes, ${tot - par} to par`);
    },

    /* ============================================================
       HUD
       ============================================================ */
    hudLabels(mode) {
      const L = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
      if (mode === 'green') {
        L('hPinLabel', 'To hole'); L('hPinUnit', 'ft');
        L('hElevLabel', 'Slope'); L('hElevUnit', '%');
        L('hHole', '—'); L('hParLabel', '');
      } else {
        L('hPinLabel', 'To pin'); L('hPinUnit', this.S.units === 'm' ? 'm' : 'yd');
        L('hElevLabel', 'Elev'); L('hElevUnit', this.S.units === 'm' ? 'm' : 'yd');
      }
    },
    updateHUD() {
      if (!this.ter || !this.hole) return;
      this.hudLabels(this.mode);
      $('#hHole').textContent = this.hole.n;
      $('#hPar').textContent = this.hole.par;
      $('#hPin').textContent = Math.round(this.unit(this.distToPin()));
      $('#hElev').textContent = (this.ter.elev(this.ballPos.x, this.ballPos.z) * (this.S.units === 'm' ? 0.9144 : 1)).toFixed(0);
      $('#hStrokes').textContent = this.strokes;
      const played = this.card.filter(Boolean);
      const rel = played.reduce((a, h) => a + (h.strokes - h.par), 0);
      $('#hScore').textContent = played.length ? (rel === 0 ? 'E' : (rel > 0 ? '+' + rel : rel)) : 'E';
      const dEl = $('#hElev'); if (dEl.nextElementSibling) dEl.nextElementSibling.textContent = this.S.units === 'm' ? 'm' : 'yd';
    },
    updateReady(force) {
      const r = this.track.isReadyToSwing();
      this.ready = r;
      const pill = $('#btnReady');
      pill.classList.toggle('ready', r);
      pill.classList.toggle('armed', !r && this.track.state !== 'idle');
      pill.classList.toggle('busy', this.flying);
      $('#readyText').textContent = this.flying ? 'IN FLIGHT' : r ? 'READY' : (this.track.state === 'learning' ? 'LEARNING' : this.track.active ? 'ARMING' : 'IDLE');
      $('#pipStatus').textContent = { idle: 'camera off', streaming: 'streaming', learning: 'learning scene', aligned: 'ball not set', ready: 'ready', swing: 'swing!', analyzing: 'analysing' }[this.track.state] || this.track.state;
      $('#pipFps').textContent = this.track.fps ? this.track.fps + ' fps' : '-- fps';
      const tset = this.track.trackSettings || {};
      $('#badgeCam').textContent = 'Camera: ' + (this.track.active ? (this.track.demo ? 'demo (simulated)' : (tset.facingMode === 'user' ? 'front' : 'rear')) : 'off');
      $('#badgeCam').className = 'badge' + (this.track.active ? ' ok' : '');
      $('#badgeTrack').textContent = 'Tracker: ' + this.track.state;
      $('#badgeTrack').className = 'badge' + (this.track.state === 'ready' ? ' ok' : '');
      if (r && !this._wasReady && this.track.active && this.track.mode === 'vision') {
        this.notify('Ready to swing', 'Ball detected on the tee — you are good to go');
      }
      this._wasReady = r;
    },
    reportPractice() {
      const store_ = this.mode === 'range' ? this.range : this.mode === 'green' ? this.green : this.gap;
      const hits = store_.hits;
      if (!hits.length) return;
      const last = hits[hits.length - 1];
      const avg = hits.reduce((a, h) => a + h.carry, 0) / hits.length;
      const sd = Math.sqrt(hits.reduce((a, h) => a + Math.pow(h.carry - avg, 2), 0) / hits.length);
      const off = hits.reduce((a, h) => a + h.offline, 0) / hits.length;
      if (this.mode === 'green') this.banner(`${last.rest === 'holed' ? '&#9971; HOLED' : Math.round(Math.abs(last.total - this.green.dist)) + ' yd ' + (last.total > this.green.dist ? 'past' : 'short')}`, `${hits.filter(h => h.rest === 'holed').length} / ${hits.length} made · stimp ${this.green.stimp}`, 1800);
      else if (this.mode === 'cage') this.banner(`${last.clubName}`, `carry ${last.carry} yd · total ${last.total} · ${last.offline > 0 ? '+' : ''}${last.offline} off line`, 1500);
      else this.banner(`${last.carry} yd carry · ${last.total} yd total`, `${last.clubName || (this.club && this.club.name)} · avg carry ${avg.toFixed(0)} yd · spread ±${sd.toFixed(1)} yd · avg ${off > 0 ? '+' : ''}${off.toFixed(1)} off line`, 1700);
    },
    renderCard() {
      const played = this.card.length ? this.card : [];
      const rows = played.map((h, i) => h ? h : null).filter(Boolean);
      if (!rows.length) { $('#cardTable').innerHTML = '<tr><td>No holes played yet — start a round from the Courses screen.</td></tr>'; return; }
      const totS = rows.reduce((a, h) => a + h.strokes, 0), totP = rows.reduce((a, h) => a + h.par, 0), totPu = rows.reduce((a, h) => a + (h.putts || 0), 0);
      $('#cardTable').innerHTML =
        `<tr><th class="name">Hole</th>${rows.map(h => `<th>${h.n}</th>`).join('')}<th>Total</th></tr>` +
        `<tr><td class="name">Par</td>${rows.map(h => `<td>${h.par}</td>`).join('')}<td>${totP}</td></tr>` +
        `<tr><td class="name">Yards</td>${rows.map(h => `<td>${h.yards}</td>`).join('')}<td>${rows.reduce((a, h) => a + h.yards, 0)}</td></tr>` +
        `<tr><td class="name">Strokes</td>${rows.map(h => `<td class="${h.strokes < h.par ? 'u' : h.strokes > h.par ? 'u2' : ''}">${h.strokes}</td>`).join('')}<td>${totS}</td></tr>` +
        `<tr><td class="name">Putts</td>${rows.map(h => `<td>${h.putts || 0}</td>`).join('')}<td>${totPu}</td></tr>` +
        `<tr class="total"><td class="name">Score</td>${rows.map(h => { const d = h.strokes - h.par; return `<td>${d === 0 ? 'E' : (d > 0 ? '+' + d : d)}</td>`; }).join('')}<td>${totS - totP >= 0 ? '+' : ''}${totS - totP} (${totS})</td></tr>`;
    },

    /* ============================================================
       practice modes
       ============================================================ */
    startRange() {
      this.mode = 'range';
      this.ter = Terrain.procedural({
        length: 340, width: 130, par: 4, seed: 991, fairway: true, fairwayHalf: 34,
        green: true, greenZ: 300, greenR: 20, relief: 2.4,
        water: [{ x: 46, z: 120, rx: 22, rz: 16 }],
        bunkers: [{ x: -34, z: 205, r: 11 }, { x: 26, z: 262, r: 9 }],
        treeLine: true
      });
      this.ter.pin = { x: 0, z: 300 };
      this.ter.tee = { x: 0, z: 6 };
      this.ter.greenR = 20;
      this.engine.setScene({ terrain: this.ter, sky: 'day' });
      this.hole = null; this.traces = []; this.balls = []; this.landing = null;
      this.ballPos = { x: 0, z: 6 }; this.aimBias = 0;
      this.range = { hits: [], club: 'dr' };
      this.rangeTargets = [
        { x: 0, z: 60, r: 9, label: '60' }, { x: 0, z: 100, r: 11, label: '100' },
        { x: 0, z: 150, r: 13, label: '150' }, { x: 0, z: 200, r: 13, label: '200' },
        { x: 0, z: 250, r: 15, label: '250' }, { x: 0, z: 300, r: 20, label: '300 · green' }
      ];
      this.setClub(Physics.clubById(this.range.club));
      this.innerHTMLHUD();
      this.go('sim');
      this.enterImmersive();
      this.toast('Driving range — pick a target, swing away');
    },
    startGreen() {
      this.mode = 'green';
      this.ter = Terrain.procedural({
        length: 60, width: 60, par: 3, seed: 5150, fairway: false,
        green: true, greenZ: 30, greenR: 22, relief: 0.5, treeLine: false,
        slope: 0.012, tilt: 0.008
      });
      this.ter.tee = { x: 0, z: 8 };
      this.engine.setScene({ terrain: this.ter, sky: 'morning' });
      this.hole = null; this.traces = []; this.balls = []; this.landing = null;
      this.rangeTargets = [];
      this.green = { hits: [], dist: 5, stimp: this.green ? this.green.stimp : 10 };
      this.newPutt();
      this.innerHTMLHUD();
      this.go('sim');
      this.enterImmersive();
      this.toast('Putting green — read the break, then swing');
    },
    newPutt() {
      const d = 3 + Math.random() * 12;                     // 3–15 yd
      const ang = (Math.random() - 0.5) * 1.5;
      const pz = 30 - d * Math.cos(ang), px = Math.sin(ang) * d;
      this.ballPos = { x: px, z: Math.max(2, pz) };
      this.green.dist = d;
      this.setClub(Physics.clubById('pt'));
      this.aimBias = 0;
      this.updateCam();
      this.updateHUDGreen();
    },
    updateHUDGreen() {
      if (!this.ter) return;
      this.hudLabels('green');
      const d = this.distToPin();
      const slope = this.ter.crossSlopeAt(this.ballPos.x, this.ballPos.z);
      $('#hHole').textContent = '—'; $('#hPar').textContent = '—';
      $('#hPin').textContent = (d * 3).toFixed(0);
      $('#hElev').textContent = (this.ter.crossSlopeAt(this.ballPos.x, this.ballPos.z) * 100).toFixed(1);
      $('#hStrokes').textContent = this.green.hits.length;
      $('#hScore').textContent = this.green.hits.filter(h => h.rest === 'holed').length;
    },
    startCage() {
      this.mode = 'cage';
      this.startRange();
      this.mode = 'cage';
      this.rangeTargets = [];
      this.gap = { club: 'dr', hits: [] };
      this.hole = null;
      this.updateHUDRange();
      this.toast('Club gapping — hit 3 balls with each club');
    },
    innerHTMLHUD() {
      this.hudLabels(this.mode);
      if (this.mode === 'range' || this.mode === 'cage') {
        $('#hHole').textContent = this.mode === 'cage' ? 'Gap' : 'Range';
        $('#hPar').textContent = '—';
      }
    },
    updateHUDRange() { },

    /* ============================================================
       launch monitor wiring
       ============================================================ */
    bindTrack() {
      const t = this.track;
      t.on('state', s => {
        this.updateReady();
        if (this.screen === 'cam') this.refreshCamScreen();
      });
      t.on('fps', () => this.updateReady());
      t.on('frame', f => {
        if (this.screen === 'cam') this.drawCamFrame(f);
        else this.drawPipFrame(f);
        this._frameTick = (this._frameTick || 0) + 1;
        if (this._frameTick % 15 === 0) this.updateReady();
      });
      t.on('shot', shot => {
        this.notify('Shot captured', `${Math.round(shot.ballSpeed)} mph · ${shot.launch.toFixed(0)}° launch`, 1800);
        this.onSwingInput(shot);
      });
      t.on('note', n => { if (n) this.toast(n, 1600); });
    },

    drawPipFrame(f) {
      const cv = $('#camfx'); if (!cv) return;
      const pip = cv.parentElement.getBoundingClientRect();
      const w = Math.max(60, pip.width), h = Math.max(45, pip.height);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.track.drawOverlay(ctx, w, h, 'pip');
    },
    drawCamFrame(f) {
      const cv = $('#camBigFx'), g = $('#camBigGuides'); if (!cv) return;
      const r = cv.parentElement.getBoundingClientRect();
      const w = Math.max(120, r.width), h = Math.max(90, r.height);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr)) {
        cv.width = g.width = Math.round(w * dpr); cv.height = g.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.track.drawOverlay(ctx, w, h, 'setup');
    },
    refreshCamScreen() {
      const t = this.track;
      const lines = [
        'Scene: ' + (t.bg ? 'learned (' + t.bgWarm + ' frames)' : 'learning…'),
        'Ball: ' + (t.ball ? 'detected at ' + t.ball.x.toFixed(0) + ',' + t.ball.y.toFixed(0) : 'not found'),
        'Alignment: ' + (t.home ? (t.isReadyToSwing() ? 'ball on its spot ✓' : 'ball off its spot — ' + Math.round(Math.hypot(t.ball ? t.ball.x - t.home.x : 0, t.ball ? t.ball.y - t.home.y : 0)) + 'px') : 'not locked'),
        'Camera: ' + (t.active ? `${t.trackSettings.width || '?'}×${t.trackSettings.height || '?'} @ ${t.trackSettings.frameRate || '?'} fps, measured ${t.fps} fps` : 'off')
      ];
      const el = $('#calStatus');
      if (!el) return;
      el.innerHTML = lines.join('<br>');
      el.className = 'calstatus ' + (t.isReadyToSwing() ? 'ok' : t.ball ? 'warn' : '');
    },
    /* convenience: spin up the simulated camera and arm it */
    async startCam_demo() {
      await this.track.startDemo({ teeDistanceFt: 7 });
      [$('#cam'), $('#camBig'), $('#heroVideo')].forEach(v => { if (v) this.track.attach(v); });
      $('#camPlaceholder').classList.add('hide');
      this.track.watchAll = true;
      setTimeout(() => this.track.lockBall(), 2400);
      this.updateReady();
    },
    async startCam(opts) {
      await this.askNotify();
      try {
        const set = await this.track.start(Object.assign({
          facing: this.S.camera, width: +this.S.res, frameRate: +this.S.hfr, sensitivity: 26
        }, opts || {}));
        const rear = (set.facingMode === 'environment') || this.S.camera === 'environment';
        this.toast(`Camera on — ${set.width || '?'}×${set.height || '?'} @ ${set.frameRate ? Math.round(set.frameRate) : '?'} fps` + (rear ? ' (rear)' : ''));
        $('#camPlaceholder').classList.add('hide');
        const binds = [$('#cam'), $('#camBig'), $('#heroVideo')];
        binds.forEach(v => { if (v) this.track.attach(v); });
        this.updateReady();
        setTimeout(() => this.track.calibrateScene(), 400);
      } catch (e) {
        $('#calStatus') && ($('#calStatus').textContent = 'Camera error: ' + (e && e.message ? e.message : e));
        this.notify('Camera unavailable', 'Check the browser camera permission, or keep playing with simulated swings', 3000);
      }
    },

    /* ============================================================
       input
       ============================================================ */
    bindUI() {
      // navigation
      document.addEventListener('click', e => {
        const nav = e.target.closest('[data-nav]');
        if (nav) {
          const n = nav.dataset.nav;
          if (n === 'back') this.go(this._back || 'home');
          else if (n === 'range') { if (this.mode !== 'range') this.startRange(); else this.go('sim'); }
          else if (n === 'green') { if (this.mode !== 'green') this.startGreen(); else this.go('sim'); }
          else if (n === 'cam') { this._back = this.screen === 'sim' ? 'sim' : 'home'; this.go('cam'); this.startCam(); }
          else if (n === 'card') this.go('card');
          else this.go(n);
          return;
        }
      });
      $$('.modecard').forEach(b => b.onclick = () => {
        const m = b.dataset.mode;
        if (m === 'round') { this.go('home'); this.toast('Pick a course below to tee off'); document.getElementById('courselist').scrollIntoView({ behavior: 'smooth' }); }
        if (m === 'range') this.startRange();
        if (m === 'green') this.startGreen();
        if (m === 'cage') this.startCage();
      });
      $$('#regionFilter button').forEach(b => b.onclick = () => {
        this._region = b.dataset.region;
        $$('#regionFilter button').forEach(x => x.classList.toggle('on', x === b));
        this.renderCourses();
      });
      $$('#cdTees button').forEach(b => b.onclick = () => {
        this.S.tee = b.dataset.tee; store.set('tee', this.S.tee);
        this.openCourse(this.course.id);
      });
      $('#cdPlay').onclick = () => this.startRound(this.course.layout.map(h => h.n));
      $('#cdFront').onclick = () => this.startRound(this.course.layout.slice(0, Math.min(9, this.course.holes)).map(h => h.n));
      $('#cdQuick').onclick = () => this.startRound(this.course.layout.slice(0, Math.min(3, this.course.holes)).map(h => h.n));

      // top bar
      $('#btnCam').onclick = () => { this._back = this.screen === 'sim' ? 'sim' : 'home'; this.go('cam'); this.startCam(); };
      $('#btnFull').onclick = () => this.toggleFullscreen();
      $('#btnClean').classList.toggle('on', this.S.clean);
      $('#btnSet').onclick = () => { this._back = this.screen === 'sim' ? 'sim' : 'home'; this.go('set'); };
      $('#btnPip').onclick = () => {
        const p = $('#pip');
        p.classList.toggle('hidden');
        $('#btnPip').classList.toggle('on', !p.classList.contains('hidden'));
        this.S.pip = !p.classList.contains('hidden'); store.set('pip', this.S.pip);
      };
      $('#btnReady').onclick = () => {
        if (this.track.state === 'idle') { this.startCam(); return; }
        if (!this.track.home && this.track.ball) this.track.lockBall();
        else if (this.ready) this.onSwingInput(null);
        else this.track.calibrateScene();
      };
      $('#hud') && $('#hud').addEventListener('click', e => { });
      $('#btnStartCamHero').onclick = () => this.startCam();

      // sim controls
      $('#btnSwing').onclick = () => {
        if (this.flying || this.holeComplete) return;
        if (this.track.active && !this.ready && this.track.mode === 'vision') { this.toast('Waiting for the ball / scene'); }
        this.onSwingInput(null);
      };
      $('#btnRight').onclick = () => this.nudgeAim(1);
      $('#btnAimL').onclick = () => this.nudgeAim(-1);
      $('#btnClubs').onclick = () => this.openClubPicker();
      $('#btnClean').onclick = () => {
        this.S.clean = !this.S.clean; store.set('clean', this.S.clean);
        document.getElementById('app').classList.toggle('clean', this.S.clean);
        $('#btnClean').classList.toggle('on', this.S.clean);
        this.toast(this.S.clean ? 'Clean mode — UI hidden for casting' : 'UI shown');
      };
      $('#btnSit').onclick = () => this.openSitMenu();

      // PIP buttons
      $('#pipMin').onclick = () => $('#pip').classList.toggle('min');
      $('#pipZoom').onclick = () => {
        const p = $('#pip'); p.classList.toggle('zoomed');
        const z = p.classList.contains('zoomed');
        this.track.roi = z ? { x: 0.30, y: 0.42, w: 0.40, h: 0.42 } : { x: 0.18, y: 0.30, w: 0.64, h: 0.55 };
      };
      $('#pipAlign').onclick = () => { this._back = 'sim'; this.go('cam'); this.startCam(); };

      // camera screen
      $('#btnAutoCal').onclick = () => this.track.calibrateScene();
      $('#btnLockBall').onclick = () => { if (!this.track.lockBall()) this.toast('No ball detected — place one on the mat'); else this.notify('Ball locked', 'Ready to accept a swing'); };
      $('#btnSwapCam').onclick = () => {
        this.S.camera = this.S.camera === 'environment' ? 'user' : 'environment';
        store.set('camera', this.S.camera); this.applySettingsToUI(); this.startCam({ facing: this.S.camera });
      };
      $('#btnDemo').onclick = async () => {
        try {
          await this.track.startDemo({});
          [$('#cam'), $('#camBig'), $('#heroVideo')].forEach(v => { if (v) this.track.attach(v); });
          $('#camPlaceholder').classList.add('hide');
          this.toast('Simulated camera running — press “Demo swing” to test the chain');
          this.track.calibrateScene();
          setTimeout(() => this.track.lockBall(), 2600);
        } catch (e) { this.toast('Could not start the simulated camera'); }
        this.updateReady();
      };
      $('#btnDemoSwing').onclick = () => {
        if (!this.track.demo) { this.toast('Start the simulated camera first'); return; }
        this.track.demoSwing();
      };
      $('#btnArm').onclick = () => {
        this.track.mode = 'vision';
        this.track.calibrateScene();
        setTimeout(() => { if (this.track.arm) this.track.arm(); this.track.setState('ready'); this.notify('Launch monitor armed', 'Waiting for your ball'); }, 2300);
        this._back = 'sim'; setTimeout(() => this.go('sim'), 2400);
      };
      $('#setThresh').oninput = e => { this.track.opt.sensitivity = +e.target.value; $('#outThresh').textContent = e.target.value; };
      $('#setFps').oninput = e => { this.track.opt.frameRate = +e.target.value; $('#outFps').textContent = e.target.value; };
      $('#setTee').oninput = e => { this.track.opt.teeDistanceFt = +e.target.value; $('#outTee').textContent = e.target.value + ' ft'; };
      $('#setCamH').oninput = e => { this.track.opt.cameraHeightIn = +e.target.value; $('#outCamH').textContent = e.target.value + ' in'; };

      // scorecard
      $('#btnNextHole').onclick = () => { this.saveHoleScore(); this.nextHole(); this.go('sim'); };
      $('#btnFinishRound').onclick = () => this.finishRound();

      // settings
      this.bindSettings();
      $('#btnCastHelp').onclick = () => { this._back = 'set'; this.go('cast'); };
      $('#btnResetStats').onclick = () => { this.range.hits = []; this.shotHistory = []; this.green.hits = []; this.gap.hits = []; this.toast('Shot history cleared'); };

      // canvas gestures
      this.bindGestures();

      // layout
      window.addEventListener('resize', () => { this.engine.resize(); });
      window.addEventListener('orientationchange', () => setTimeout(() => { this.applyOrientation(); this.engine.resize(); }, 260));
      document.addEventListener('fullscreenchange', () => { $('#btnFull').classList.toggle('on', !!document.fullscreenElement); setTimeout(() => this.engine.resize(), 260); });
      $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.remove('show'); };
      window.addEventListener('keydown', e => {
        if (e.key === ' ' && this.screen === 'sim') { e.preventDefault(); this.onSwingInput(null); }
        if (e.key === 'ArrowLeft') this.nudgeAim(-1);
        if (e.key === 'ArrowRight') this.nudgeAim(1);
        if (e.key === 'c') this.openClubPicker();
        if (e.key === 'f') this.toggleFullscreen();
      });
    },
    nudgeAim(d) {
      this.aimBias += d;
      $('#hAim') && ($('#hAim').textContent = (this.aimBias > 0 ? '+' : '') + this.aimBias.toFixed(0) + '°');
      this.updateCam();
      this.toast('Aim ' + (this.aimBias > 0 ? 'right' : 'left') + ' ' + Math.abs(this.aimBias).toFixed(0) + '°', 900);
    },
    openSitMenu() {
      const box = $('#modalbox');
      const ter = this.ter;
      box.innerHTML = `<h3>${this.mode === 'round' ? 'Hole ' + this.hole.n : this.mode === 'range' ? 'Driving range' : this.mode === 'green' ? 'Putting green' : 'Club gapping'}</h3>
        <div class="btnrow wrap">
          <button class="btn" id="mFly">Hole flyover</button>
          <button class="btn" id="mTrees">Toggle trees (perf)</button>
          <button class="btn" id="mQuality">Quality: auto (${this.engine.quality.scale.toFixed(2)}×, step ${this.engine.quality.step})</button>
          ${this.mode === 'round' ? '<button class="btn" id="mMull">Mulligan (replay last shot)</button>' : ''}
          <button class="btn" id="mSky">Sky: ${this.engine.sky}</button>
          <button class="btn" id="mStats">Shot history</button>
          <button class="btn primary" id="mClose">Close</button>
        </div>`;
      $('#modal').classList.add('show');
      $('#mFly').onclick = () => { this.camMode = 'fly'; this._flyFrom = this.ter.length * 0.2; $('#modal').classList.remove('show'); };
      $('#mTrees').onclick = () => { this.engine.quality.trees = this.engine.quality.trees > 0 ? 0 : 140; this.toast('Trees ' + (this.engine.quality.trees ? 'on' : 'off')); };
      $('#mQuality').onclick = () => { const q = this.engine.quality; q.auto = !q.auto; this.toast('Quality mode: ' + (q.auto ? 'auto' : 'fixed')); };
      const sky = $('#mSky'); sky.onclick = () => {
        const keys = Object.keys(SKIES); const i = keys.indexOf(this.engine.sky);
        this.engine.sky = keys[(i + 1) % keys.length]; sky.textContent = 'Sky: ' + this.engine.sky;
      };
      const mm = $('#mMull'); if (mm) mm.onclick = () => { $('#modal').classList.remove('show'); this.toast('Mulligan — hit another'); };
      $('#mStats').onclick = () => {
        const h = this.shotHistory.slice(-12).reverse();
        box.innerHTML = `<h3>Shot history</h3><div class="cardwrap"><table>
          <tr><th class="name">Club</th><th>Ball</th><th>Launch</th><th>Az</th></tr>
          ${h.map(s => `<tr><td class="name">${s.club}</td><td>${Math.round(s.ballSpeed)}</td><td>${(+s.launch).toFixed(1)}°</td><td>${(+s.azimuth).toFixed(1)}°</td></tr>`).join('') || '<tr><td>No shots yet</td></tr>'}
        </table></div><div class="btnrow" style="margin-top:10px"><button class="btn primary" id="mClose">Close</button></div>`;
        $('#mClose').onclick = () => $('#modal').classList.remove('show');
      };
      $('#mClose').onclick = () => $('#modal').classList.remove('show');
    },

    /* ---------- gestures on the sim canvas ---------- */
    bindGestures() {
      const cv = $('#view');
      const rect = () => cv.getBoundingClientRect();
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: this.cam.yaw, pitch: this.cam.pitch, t: performance.now(), moved: 0 };
      });
      cv.addEventListener('pointermove', e => {
        if (!this.drag || e.pointerId !== this.drag.id) return;
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        this.drag.moved = Math.max(this.drag.moved, Math.hypot(dx, dy));
        if (this.camMode !== 'free') { this.camMode = 'free'; this.cam.yaw = this.drag.yaw; this.cam.pitch = this.drag.pitch; }
        this.cam.yaw = this.drag.yaw - dx * 0.0045;
        this.cam.pitch = Math.max(-0.9, Math.min(0.6, this.drag.pitch - dy * 0.0035));
        this.engine.cam.yaw = this.cam.yaw; this.engine.cam.pitch = this.cam.pitch;
      });
      const up = e => {
        if (this.drag && e.pointerId === this.drag.id) {
          if (this.drag.moved < 8) this.recentre();
        }
        this.drag = null;
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        this.engine.cam.fov = Math.max(24, Math.min(95, this.engine.cam.fov + Math.sign(e.deltaY) * 2));
        this.S.fov = Math.round(this.engine.cam.fov); store.set('fov', this.S.fov);
      }, { passive: false });
      // pinch zoom
      let pd = 0;
      cv.addEventListener('touchstart', e => { if (e.touches.length === 2) pd = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); });
      cv.addEventListener('touchmove', e => {
        if (e.touches.length === 2 && pd) {
          const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
          this.engine.cam.fov = Math.max(24, Math.min(95, this.engine.cam.fov * (pd / d)));
          pd = d; e.preventDefault();
        }
      }, { passive: false });
      // minimap tap → aim
      const mm = $('#minimap');
      const mmAim = e => {
        if (!this.ter) return;
        const r = mm.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        const wx = (0.5 - px) * this.ter.width;
        const wz = this.ter.length * (1 - py);
        const d = Math.hypot(wx - this.ballPos.x, wz - this.ballPos.z);
        this.aimBias = Math.atan2(wx - this.ballPos.x, wz - this.ballPos.z) * R2D - Math.atan2(this.ter.pin.x - this.ballPos.x, this.ter.pin.z - this.ballPos.z) * R2D;
        this.updateCam();
        this.toast('Aimed at ' + Math.round(d) + ' yd point', 900);
      };
      mm.addEventListener('pointerdown', mmAim);
      mm.addEventListener('pointermove', e => { if (e.buttons) mmAim(e); });
    },
    recentre() {
      this.camMode = 'behind';
      this.updateCam();
    },

    /* ---------- fullscreen / orientation / casting ---------- */
    async toggleFullscreen() {
      const el = document.documentElement;
      try {
        if (!document.fullscreenElement) {
          await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : null);
          if (this.S.autoland && screen.orientation && screen.orientation.lock) {
            try { await screen.orientation.lock('landscape'); } catch (e) { }
          }
        } else {
          if (screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch (e) { } }
          await document.exitFullscreen();
        }
      } catch (e) { this.toast('Full screen not available in this browser'); }
    },
    enterImmersive() {
      if (this.S.autofs && !document.fullscreenElement) this.toggleFullscreen();
      if (this.S.clean) document.getElementById('app').classList.add('clean');
      else document.getElementById('app').classList.remove('clean');
      this.applyOrientation();
    },
    applyOrientation() {
      const app = document.getElementById('app');
      const land = window.innerWidth > window.innerHeight;
      app.classList.toggle('landscape', land);
      app.classList.toggle('portrait', !land);
      this.engine.resize();
    },
    watchLayout() {
      this.applyOrientation();
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => this.engine.resize());
        ro.observe($('#scr-sim'));
      }
      // casting usually reports a size change; keep the canvas sharp
      window.addEventListener('resize', () => setTimeout(() => this.engine.resize(), 200));
    },
    async startFloatingPip() {
      // Real OS Picture-in-Picture: compose video + guides on a canvas and PiP that stream
      if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
        this.toast('System PiP not supported — using the in-app camera window'); return;
      }
      try {
        const cv = document.createElement('canvas'); cv.width = 480; cv.height = 270;
        const ctx = cv.getContext('2d');
        const v = document.createElement('video'); v.playsInline = true; v.muted = true;
        v.srcObject = cv.captureStream(30);
        await v.play();
        await v.requestPictureInPicture();
        this._float = { cv, ctx, v };
        this.toast('Camera is now in a floating window');
      } catch (e) { this.toast('Could not open the floating window'); }
    },

    /* ---------- settings ---------- */
    bindSettings() {
      const map = { sUnits: 'units', sHand: 'hand', sFov: 'fov', sBall: 'ball', sElev: 'elev', sWind: 'wind', sAim: 'aimLine', sCamera: 'camera', sRes: 'res', sHfr: 'hfr', sNotify: 'notify', sVib: 'vib', sPip: 'pip', sAutoFs: 'autofs', sAutoLand: 'autoland', sClean: 'clean' };
      Object.keys(map).forEach(id => {
        const el = document.getElementById(id); if (!el) return;
        el.oninput = el.onchange = () => {
          const key = map[id];
          this.S[key] = el.type === 'checkbox' ? el.checked : (el.type === 'range' ? +el.value : el.value);
          store.set(key, this.S[key]);
          this.applySetting(key);
          this.applySettingsToUI();
        };
      });
      $('#sNotify').onchange = () => { if (this.S.notify) this.askNotify(); };
    },
    applySetting(key) {
      if (key === 'fov') this.engine.cam.fov = this.S.fov;
      if (key === 'pip') { $('#pip').classList.toggle('hidden', !this.S.pip); $('#btnPip').classList.toggle('on', this.S.pip); }
      if (key === 'clean') document.getElementById('app').classList.toggle('clean', this.S.clean);
      if (key === 'camera' || key === 'res' || key === 'hfr') { if (this.track.active) this.startCam(); }
      if (key === 'units' && this.ter) this.updateHUD();

      if (key === 'notify' && this.S.notify) this.askNotify();
    },
    applySettingsToUI() {
      const setv = (id, v) => { const el = document.getElementById(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
      setv('sUnits', this.S.units); setv('sHand', this.S.hand); setv('sFov', this.S.fov);
      setv('sBall', this.S.ball); setv('sElev', this.S.elev); setv('sWind', this.S.wind);
      setv('sAim', this.S.aimLine); setv('sCamera', this.S.camera); setv('sRes', this.S.res);
      setv('sHfr', this.S.hfr); setv('sNotify', this.S.notify); setv('sVib', this.S.vib);
      setv('sPip', this.S.pip); setv('sAutoFs', this.S.autofs); setv('sAutoLand', this.S.autoland);
      setv('sClean', this.S.clean);
      $('#oFov').textContent = this.S.fov + '°'; $('#oWind').textContent = this.S.wind + ' mph';
      $('#pip').classList.toggle('hidden', !this.S.pip);
      $('#btnPip').classList.toggle('on', this.S.pip);
      $('#badgeDevice').textContent = (navigator.userAgent.match(/SM-A25\w*/) ? 'Galaxy A25' : /Android/.test(navigator.userAgent) ? 'Android' : 'Device') +
        ' · ' + (this.track.capabilities && this.track.capabilities.frameRate ? 'cam ' + this.track.capabilities.frameRate.min + '–' + this.track.capabilities.frameRate.max + ' fps' : 'cam ?');
    },

    /* ============================================================
       main loop
       ============================================================ */
    loop() {
      let last = performance.now();
      const tick = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        if (this.flying) this.updateFlight(dt);
        if (this.camMode === 'fly' && this.ter) {
          this._flyT = (this._flyT || 0) + dt * 28;
          this.engine.flyover(this.ter, this._flyT);
          if (this._flyT > this.ter.length + 20) { this._flyT = 0; this.camMode = 'behind'; this.updateCam(); }
        }
        (this.splashes || []).forEach(s => s.t += dt * 1.3);
        this.splashes = (this.splashes || []).filter(s => s.t < 1.2);
        if (this.screen === 'sim') {
          if (this.mode === 'green') this.updateHUDGreen();
          this.engine.render(this.frame(dt), dt);
          if ((this._mmTick = (this._mmTick || 0) + 1) % 3 === 0) this.engine.minimap(this.mm, this.frame(dt));
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  };

  /* ---- offline course list: same routing, generated terrain ---- */
  function FALLBACK_COURSES() {
    const src = [
      [1000, 'Helsingborg Public Course', 'Europe', [4, 3, 3]],
      [1006, 'San Marino Golf Club', 'Europe', [4, 3, 4, 4, 5, 4]],
      [1002, 'Perthshire Country Club', 'Europe', [4, 4, 4, 5, 4, 4, 4, 4, 3]],
      [1036, 'Berlin White Lake', 'Europe', [5, 4, 3, 4, 4, 3]],
      [1004, 'Sevilla Golf Resort', 'Europe', [3, 3, 3, 5, 4, 4, 4, 4, 4]],
      [2001, 'Saigon City Cycle', 'Asia', [4, 4, 5, 5, 4, 3, 4]],
      [2002, 'Phuket Golf Resort', 'Asia', [4, 4, 5, 4, 4, 3, 4, 4, 3, 3]],
      [2003, 'Hongkong Royal Golf Club', 'Asia', [4, 4, 4, 4, 3, 5, 4]],
      [2004, 'Borneo Wildlife Resort', 'Asia', [5, 4, 4, 4, 4, 5, 3, 3, 4]],
      [3001, 'Quebec City Course', 'North America', [5, 3, 4, 4, 4, 4]],
      [3002, 'Manitoba Country Club', 'North America', [5, 5, 4, 4, 4, 4, 4, 3, 4]],
      [3003, 'Vancouver City Cycle', 'North America', [4, 4, 4, 3, 5, 4]],
      [3004, 'Wood Buffalo Wildlife Club', 'North America', [4, 5, 4, 4, 5, 3, 4, 4, 4, 4, 4, 4, 3, 5, 4, 5, 3, 3]],
      [4001, 'Las Vegas City Cycle', 'USA Desert', [4, 4, 4, 3, 5, 4]]
    ];
    const range = { 3: [108, 178], 4: [262, 412], 5: [452, 556] };
    return src.map(([id, name, region, pars]) => {
      let seed = id * 7919 + pars.length, rnd = () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
      const layout = pars.map((par, i) => {
        const [lo, hi] = range[par] || range[4];
        return { n: i + 1, par, yards: Math.round((lo + (hi - lo) * rnd()) / 2) * 2, art: null };
      });
      return {
        id, name, region, holes: pars.length, label: null, layout,
        par: layout.reduce((a, h) => a + h.par, 0),
        yards: layout.reduce((a, h) => a + h.yards, 0)
      };
    });
  }
  window.App = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})();
