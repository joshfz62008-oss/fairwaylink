/* ============================================================
   physics.js — golf ball flight & green physics
   Units: yards, mph, degrees, seconds.
   World: x = lateral (right +), y = up, z = downrange toward the pin.
   ============================================================ */
(function (global) {
  'use strict';

  const G = 10.73;                 // yd/s^2  (9.81 m/s^2)
  const MPS_PER_MPH = 0.44704, YD = 0.9144;
  const RHO = 1.225, R = 0.0213, AREA = Math.PI * R * R, MASS = 0.0459;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  /* ---- club set: typical mid-handicap bag, measured ball data ---- */
  const CLUBS = [
    { id: 'dr', name: 'Driver', short: 'DR', loft: 10.5, ball: 138, launch: 13.0, spin: 2600, smash: 1.46, runBias: 1.00 },
    { id: '3w', name: '3 Wood', short: '3W', loft: 15.0, ball: 130, launch: 14.5, spin: 3250, smash: 1.45, runBias: 0.85 },
    { id: '5w', name: '5 Wood', short: '5W', loft: 18.0, ball: 125, launch: 16.0, spin: 3750, smash: 1.44, runBias: 0.78 },
    { id: '4h', name: '4 Hybrid', short: '4H', loft: 22.0, ball: 121, launch: 17.5, spin: 4150, smash: 1.42, runBias: 0.70 },
    { id: '5i', name: '5 Iron', short: '5i', loft: 26.0, ball: 117, launch: 19.0, spin: 4650, smash: 1.41, runBias: 0.62 },
    { id: '6i', name: '6 Iron', short: '6i', loft: 30.0, ball: 112, launch: 21.0, spin: 5250, smash: 1.4, runBias: 0.55 },
    { id: '7i', name: '7 Iron', short: '7i', loft: 34.0, ball: 107, launch: 23.0, spin: 6050, smash: 1.38, runBias: 0.48 },
    { id: '8i', name: '8 Iron', short: '8i', loft: 38.0, ball: 102, launch: 25.5, spin: 6850, smash: 1.37, runBias: 0.40 },
    { id: '9i', name: '9 Iron', short: '9i', loft: 42.0, ball: 96, launch: 28.0, spin: 7550, smash: 1.35, runBias: 0.32 },
    { id: 'pw', name: 'Pitching Wedge', short: 'PW', loft: 46.0, ball: 90, launch: 29.5, spin: 8250, smash: 1.34, runBias: 0.26 },
    { id: 'gw', name: 'Gap Wedge', short: 'GW', loft: 50.0, ball: 84, launch: 31.0, spin: 8750, smash: 1.32, runBias: 0.20 },
    { id: 'sw', name: 'Sand Wedge', short: 'SW', loft: 56.0, ball: 76, launch: 32.5, spin: 9200, smash: 1.3, runBias: 0.14 },
    { id: 'lw', name: 'Lob Wedge', short: 'LW', loft: 60.0, ball: 64, launch: 35.5, spin: 9500, smash: 1.29, runBias: 0.10 },
    { id: 'pt', name: 'Putter', short: 'PT', loft: 3.0, ball: 12, launch: 0.4, spin: 0, smash: 1.49, runBias: 0, putter: true }
  ];

  /* ---- aerodynamics ---- */
  function aero(v, spinRpm) {
    const omega = Math.abs(spinRpm) * Math.PI / 30;
    const S = Math.min(0.55, omega * R / Math.max(3, v));   // spin ratio
    return { S, cl: 0.50 * S / (0.14 + S), cd: 0.250 + 0.26 * S };
  }

  /* ---- ground behaviour per surface ---- */
  const SURF = {
    GREEN:   { base: 0.62, curve: 0.16, rampV: 9.0, rampK: 1.5, rest: 0.34, scrub: 0.74, name: 'Green' },
    FAIRWAY: { base: 2.30, curve: 0.15, rampV: 6.0, rampK: 2.0, rest: 0.30, scrub: 0.72, name: 'Fairway' },
    ROUGH:   { base: 6.40, curve: 0.12, rampV: 5.0, rampK: 1.6, rest: 0.15, scrub: 0.50, name: 'Rough' },
    SAND:    { base: 18.0, curve: 0.06, rampV: 4.0, rampK: 1.0, rest: 0.06, scrub: 0.42, name: 'Bunker' },
    TREE:    { base: 8.50, curve: 0.10, rampV: 5.0, rampK: 1.2, rest: 0.12, scrub: 0.45, name: 'Trees' },
    WATER:   { base: 60.0, curve: 0.05, rampV: 4.0, rampK: 1.0, rest: 0.00, scrub: 0.20, name: 'Water' }
  };
  const SURF_KEY = ['WATER', 'SAND', 'GREEN', 'FAIRWAY', 'ROUGH', 'TREE'];

  class Ball {
    constructor(ter, opt) {
      const o = Object.assign({
        speed: 138, launch: 13, azimuth: 0, spin: 2600, sideSpin: 0, spinAxis: 0,
        start: { x: 0, y: 0, z: 0 }, wind: { x: 0, z: 0 },
        lift: 1, dragMul: 1, damping: 1, stimp: 10, club: '', rollBias: 1
      }, opt);
      this.o = o; this.ter = ter;
      this.p = { x: o.start.x, y: ter.elev(o.start.x, o.start.z) + 0.05, z: o.start.z };
      const s = o.speed * MPS_PER_MPH / YD;                    // yd/s
      const la = o.launch * D2R, az = o.azimuth * D2R;
      this.v = { x: s * Math.sin(az) * Math.cos(la), y: s * Math.sin(la), z: s * Math.cos(az) * Math.cos(la) };
      this.spin = o.spin; this.side = o.sideSpin; this.tilt = o.spinAxis;
      this.state = 'flight'; this.t = 0; this.carry = 0; this.total = 0; this.apex = 0;
      this.start = { x: this.p.x, z: this.p.z };
      this.rollTime = 0; this.bounces = 0; this.rollStart = 0;
      this.trace = [{ x: this.p.x, y: this.p.y, z: this.p.z }];
      this.events = [];
      // launch reference frame: downrange along the aim line, cross-track = offline
      const azR = o.azimuth * D2R;
      this.dir = { x: Math.sin(azR), z: Math.cos(azR) };
    }
    surfKey() { return SURF_KEY[this.ter.typeAt(this.p.x, this.p.z)] || 'ROUGH'; }
    /* distance travelled from the strike point, and the cross-track (offline) offset */
    travelled() { return Math.hypot(this.p.x - this.start.x, this.p.z - this.start.z); }
    offline() {
      const dx = this.p.x - this.start.x, dz = this.p.z - this.start.z;
      // cross product with the aim direction: + = right of the aim line
      return dx * this.dir.z - dz * this.dir.x;
    }
    groundY() { return this.ter.elev(this.p.x, this.p.z); }

    step(dt) {
      if (this.state === 'stopped' || this.state === 'holed') return;
      this.t += dt;
      if (this.state === 'flight') this.stepFlight(dt); else this.stepRoll(dt);
      if (this.trace.length === 0 ||
        Math.hypot(this.p.x - this.trace[this.trace.length - 1].x, this.p.z - this.trace[this.trace.length - 1].z) > 3.0)
        this.trace.push({ x: this.p.x, y: this.p.y, z: this.p.z });
    }

    stepFlight(dt) {
      const v = this.v, o = this.o;
      const spd = Math.hypot(v.x, v.y, v.z);
      const decay = Math.exp(-dt / 10.0);
      this.spin *= decay; this.side *= decay;

      const vms = spd * YD;
      const { cl, cd } = aero(vms, this.spin);
      // relative wind (wind blows toward +x/+z when positive)
      const rx = v.x * YD - o.wind.x * MPS_PER_MPH;
      const ry = v.y * YD;
      const rz = v.z * YD - o.wind.z * MPS_PER_MPH;
      const rel = Math.max(0.5, Math.hypot(rx, ry, rz));
      const q = 0.5 * RHO * AREA * rel * rel / MASS;           // m/s^2 per unit coefficient

      const ux = rx / rel, uy = ry / rel, uz = rz / rel;
      // spin axis: backspin about -x for a right hander, tilted by side spin
      const tilt = (this.tilt + Math.atan2(this.side, Math.max(400, this.spin)) * 2) * D2R;
      const wx = -Math.cos(tilt), wy = Math.sin(tilt), wz = 0;
      // Magnus direction = omega_hat x v_hat
      let mx = wy * uz - wz * uy, my = wz * ux - wx * uz, mz = wx * uy - wy * ux;
      const ml = Math.hypot(mx, my, mz);
      if (ml > 1e-6) { mx /= ml; my /= ml; mz /= ml; } else { mx = my = mz = 0; }

      const aLift = q * cl * this.o.lift;
      const aDrag = q * cd * this.o.dragMul;
      const ax = (-aDrag * ux + aLift * mx) / YD;
      const ay = (-aDrag * uy + aLift * my) / YD - G;
      const az = (-aDrag * uz + aLift * mz) / YD;

      v.x += ax * dt; v.y += ay * dt; v.z += az * dt;
      this.p.x += v.x * dt; this.p.y += v.y * dt; this.p.z += v.z * dt;
      this.apex = Math.max(this.apex, this.p.y - this.groundY());

      const g = this.groundY(), key = this.surfKey(), S = SURF[key];
      if (this.p.y <= g) {
        this.p.y = g;
        if (key === 'WATER') {
          this.state = 'stopped'; this.total = this.travelled();
          this.events.push('water'); return;
        }
        if (this.bounces === 0) this.carry = this.travelled();
        this.bounces++;
        if (v.y < -2.2) {
          this.events.push('bounce');
          // steep descent (irons / wedges) kills far more forward speed than a flat driver bounce
          const impact = Math.atan2(-v.y, Math.max(1, Math.hypot(v.x, v.z)));
          const steep = Math.sin(Math.max(0, Math.min(1.4, impact)));
          const scrub = S.scrub * (1 - 0.34 * steep);
          v.y = -v.y * S.rest * (key === 'GREEN' ? 0.85 : 1);
          v.x *= scrub; v.z *= scrub;
          const bite = key === 'GREEN' ? 0.55 : 0.75;
          this.spin *= bite; this.side *= bite * 0.9;
          if (key === 'GREEN' && this.spin > 4200) { v.z *= 0.70; v.x *= 0.80; }   // tour-style bite
          if (key === 'GREEN' && this.bounces > 1 && Math.hypot(v.x, v.z) < 14 && this.spin > 3000) { v.z *= 0.8; v.x *= 0.85; }
          return;
        }
        this.state = 'roll'; this.rollStart = this.travelled();
      }
    }

    stepRoll(dt) {
      const v = this.v, p = this.p, ter = this.ter;
      const key = this.surfKey(), S = SURF[key];
      p.y = ter.elev(p.x, p.z);
      const spd = Math.hypot(v.x, v.z);

      // slope gravity: only a fraction of g·gradient actually bends a rolling ball
      const dz = ter.slopeAt(p.x, p.z), dx = ter.crossSlopeAt(p.x, p.z);
      let ax = -dx * G * S.curve * 0.9;
      let az = -dz * G * S.curve * 0.9;

      // friction: green speed (stimp) sets the flat-green deceleration,
      // fast-moving balls lose energy quickly (skid / bouncing), so ramp with speed^2
      const aFlat = (6 / Math.max(6, this.o.stimp)) * S.base * this.o.damping;
      const ramp = 1 + Math.pow(spd / S.rampV, 2) * S.rampK;
      const fr = aFlat * ramp;
      if (spd > 1e-3) { ax -= (v.x / spd) * fr; az -= (v.z / spd) * fr; }

      v.x += ax * dt; v.z += az * dt;
      this.rollTime += dt;
      p.x += v.x * dt; p.z += v.z * dt;

      /* hole capture — the cup is 4.25", we give a little forgiveness */
      const pin = ter.pin;
      const dxp = p.x - pin.x, dzp = p.z - pin.z;
      const cupDist = Math.hypot(dxp, dzp);
      const CUP = 0.17;
      if (this.rollTime > 0.04 && cupDist < CUP) {
        const s = Math.hypot(v.x, v.z);
        const centre = 1 - cupDist / CUP;                     // 0 = edge, 1 = dead centre
        if (s < 1.85 + 2.6 * centre) {
          this.state = 'holed'; this.total = this.travelled();
          p.x = pin.x; p.z = pin.z; this.events.push('holed'); return;
        }
        if (!this.lipDone) {                                   // horseshoe: deflect off the lip
          this.lipDone = true;
          const nx = cupDist > 1e-3 ? dxp / cupDist : 1, nz = cupDist > 1e-3 ? dzp / cupDist : 0;
          const kick = Math.min(3.2, s * 0.42);
          v.x = v.x * 0.66 - nx * kick; v.z = v.z * 0.66 - nz * kick;
          this.events.push('lipout');
        }
      }
      const spd2 = Math.hypot(v.x, v.z);
      if (spd2 < 0.22 || this.rollTime > 25) {
        v.x = v.z = 0; this.state = 'stopped'; this.total = this.travelled();
      }
    }

    run(maxT) {
      const lim = maxT || 40;
      while (this.state !== 'stopped' && this.state !== 'holed' && this.t < lim) this.step(1 / 300);
      return this;
    }
    summary() {
      const o = this.o;
      return {
        club: o.club, clubName: o.clubName || '', speed: o.speed, launch: o.launch, spin: o.spin,
        side: o.sideSpin, azimuth: o.azimuth,
        carry: Math.round(this.carry), total: Math.round(this.total),
        offline: Math.round(this.offline()), apexYd: Math.round(this.apex * 3),
        rest: this.state, surface: SURF[this.surfKey()].name, events: this.events.slice(),
        trace: this.trace, x: this.p.x, z: this.p.z, bounces: this.bounces,
        from: { x: this.start.x, z: this.start.z }, dir: this.dir
      };
    }
  }

  /* ---- 1D roll model (mirrors stepRoll) used to solve putting pace ---- */
  function rollDistance(v0, stimp, surfKey, damping, slopeAcc) {
    const S = SURF[surfKey || 'GREEN'];
    const aFlat = (6 / Math.max(6, stimp)) * S.base * (damping || 1);
    const sa = slopeAcc || 0;
    let v = v0, d = 0, t = 0;
    const dt = 0.01;
    while (v > 0.22 && t < 40) {
      const ramp = 1 + Math.pow(v / S.rampV, 2) * S.rampK;
      const a = aFlat * ramp + sa;
      v -= a * dt;
      if (v < 0) { v = 0; }
      if (a < 0 && t > 25) break;                 // runaway downhill, no more useful travel
      d += v * dt; t += dt;
    }
    return d;
  }
  /* launch speed (yd/s) that rolls exactly `target` yards over the given surface */
  function paceFor(target, stimp, surfKey, damping, slopeAcc) {
    let lo = 0.3, hi = 36;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (rollDistance(mid, stimp, surfKey, damping, slopeAcc) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* ---- putting helper: launch a putt with the right pace ---- */
  function puttBall(ter, from, opts) {
    const o = Object.assign({ stimp: 10, aimDeg: 0, pace: 1.0, speedYdS: null, damping: 1 }, opts);
    const dx = ter.pin.x - from.x, dz = ter.pin.z - from.z;
    const dist = Math.max(0.4, Math.hypot(dx, dz));
    // slope along the putt line (positive = uphill toward the hole)
    const dzd = ter.slopeAt(from.x, from.z), dxd = ter.crossSlopeAt(from.x, from.z);
    const along = (dxd * dx + dzd * dz) / dist;
    const slopeAcc = along * G * SURF.GREEN.curve * 0.9;
    const v0 = o.speedYdS !== null ? o.speedYdS
      : paceFor(dist, o.stimp, 'GREEN', o.damping, slopeAcc) * o.pace;
    const az = Math.atan2(dx, dz) + o.aimDeg * D2R;
    return new Ball(ter, {
      speed: (v0 / YD) / MPS_PER_MPH, launch: 0.35, spin: 40, sideSpin: 0,
      azimuth: az * R2D, start: { x: from.x, y: 0, z: from.z },
      stimp: o.stimp, club: 'pt', clubName: 'Putter', damping: o.damping
    });
  }

  /* ---- club distance table (cached, terrain independent) ---- */
  const carryCache = {};
  function carryOf(club) {
    if (carryCache[club.id] !== undefined) return carryCache[club.id];
    const t = global.Terrain.procedural({ length: 700, width: 400, relief: 0, treeLine: false, fairway: true });
    const b = new Ball(t, { speed: club.ball, launch: club.launch, spin: club.spin });
    const s = b.run(40).summary();
    carryCache[club.id] = s;                                     // keep the whole summary
    return s;
  }
  function clubForDistance(yards, bag) {
    const clubs = (bag || CLUBS).filter(c => !c.putter);
    let best = clubs[0], bd = 1e9;
    clubs.forEach(c => { const d = Math.abs(carryOf(c).carry - yards); if (d < bd) { bd = d; best = c; } });
    return best;
  }

  global.Physics = {
    G, CLUBS, Ball, SURF, SURF_KEY, aero, puttBall, carryOf, clubForDistance,
    rollDistance, paceFor,
    D2R, R2D, MPS_PER_MPH, YD,
    clubById(id) { return CLUBS.find(c => c.id === id) || CLUBS[0]; },
    /* club head speed a player needs for this club's stock ball speed */
    stockClubSpeed(c) { return Math.round((c.smash ? c.ball / c.smash : c.ball / 1.42)); },
    smashFor(c) { return c.smash || (1.50 - 0.0035 * c.loft); },
    liftForBall(kind) { return kind === 'range' ? 0.88 : kind === 'pro' ? 1.07 : 1.0; }
  };
})(window);
