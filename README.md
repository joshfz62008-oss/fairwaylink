# FairwayLink — Golf Simulator & Launch Monitor

A self-contained web app that turns a phone's **rear camera into a golf launch monitor** and
uses it to play **14 courses duplicated from the OGC Open course library**
([ogcopen.com](https://www.ogcopen.com/OgcGolfCourse.php?lang=en)), plus a **driving range**,
a **putting green** and a **club-gapping** session.

Everything runs on the phone. Camera frames are analysed in the browser and never uploaded.

---

## 1. Quick start

The app must be served over `http://` or `https://` (browsers only give camera access on a
secure origin — `localhost` counts as secure). Copy the `www` folder to any web server, or use
the tiny launcher that ships with it:

```bash
cd golf-sim
python3 serve.py            # prints two URLs, then open one on the phone
python3 serve.py 8080       # optional: choose the port
```

Then on the Galaxy A25:

1. Open the printed `http://<your-lan-ip>:8080/` address in **Chrome**.
2. Tap **Start launch monitor** and **Allow** the camera prompt (choose *While using the app*).
3. Optional: tap **⋮ → Add to Home screen** so it opens fullscreen like an app (the app ships a
   PWA manifest + service worker, so it also works offline afterwards).

> Chrome only exposes camera access on `localhost` or HTTPS. If you need HTTPS on the LAN, put
> the folder behind any certificate-terminating proxy (Caddy, nginx, `ngrok`, `caddy file-server
> --tls internal`), or run `chrome --unsafely-treat-insecure-origin-as-secure`.

## 2. Setting up the launch monitor (ball alignment)

Put the phone on the ground **behind and slightly to the side** of the ball line, rear camera
pointing down the target line:

```
        target line  ▲
   ball ●────────────┊────────►  net / screen
                     ┊
        ┌────────────┴─────────┐
        │  phone (landscape),  │   ← rear camera, propped so the lens is
        │  screen flat, ~4 in  │     ~4 in above the mat, 12° off the ball line
        └──────────────────────┘
```

Open **📷 Camera** and:

| Control | What it does |
|---|---|
| **Detection** | Motion threshold. Lower = more sensitive (dim light), higher = ignores grass sway / shadows. |
| **Frame rate** | Requests 60/120/240 fps from the sensor. 60 fps measures club speed; 110 fps+ measures the ball itself. |
| **Tee distance** | Ball-to-lens distance (default 7 ft). This is the **scale** for every yard of the physics — measure it once and keep it. |
| **Camera height** | Lens height above the mat (default 4 in). |
| **Auto-calibrate scene** | Re-learns the background (run it after you move the phone or the net). |
| **Lock ball position** | Records the ball's pixel position as the tee spot. |
| **Arm launch monitor** | Returns to the shot view and waits for a ball. |
| **Simulated camera (dry run)** | Draws a synthetic down-the-line scene and streams it through the *real* analysis pipeline — use it to test the whole chain, or when the camera is unavailable. **Demo swing** fires a synthetic ball. |

**Ball alignment** is drawn live: a red circle tracks the detected white ball, a dashed green
cross is the locked tee spot, and a line connects them. When the ball sits on its spot the
status pill turns green — **READY**. Move the ball off its spot and the highlight goes amber
until it is back, which is what gates the next shot.

## 3. Playing

* **Home → a course → Play** tees off, or use **Range / Putting / Card** in the bottom bar.
* **Swing** (button or `Space`) fires the shot. With the camera armed the shot is taken from a
  real detection; without a camera the built-in **player model** produces a realistic amateur
  pattern so the sim is always playable.
* **◀ ▶ Aim** nudges the aim bias ±1° (the dashed line and the minimap follow). Tap the
  **minimap** to aim straight at any point on the hole.
* Drag the view to look around, pinch (or wheel) to zoom, tap to re-centre behind the ball.
* After each shot the app auto-selects the next club for the distance and, when you reach the
  green, switches to the putter with a green-reading view.
* **Clubs** lists the full bag with loft, ball speed, spin and computed carry. **★ Menu** has the
  hole flyover, tree toggle, quality control, sky change and shot history.

### Reading the numbers

| Tile | Meaning |
|---|---|
| **Ball** | Ball speed (mph) — measured directly when the monitor can track the ball, otherwise club speed × smash factor |
| **Launch** | Launch angle (degrees) |
| **Spin** | Backspin (rpm). A `~` prefix means **modelled** — a single rolling-shutter phone camera cannot measure spin |
| **Carry / Offline** | Live while the ball is in the air; final at rest. Offline is cross-track from the aim line (+ right) |
| **Measured by** | `player model`, `club · 62%`, `ball · 78%` … shows exactly which source produced the shot and its confidence |

### What the camera really measures (and what it doesn't)

| Quantity | Ball-tracking mode (110 fps+) | Club-streak mode (60 fps) |
|---|---|---|
| Ball speed | ✅ measured | ➖ derived: club speed × smash |
| Club speed | ➖ derived | ✅ measured |
| Launch angle | ✅ measured | ➖ from loft + model |
| Start direction | ✅ measured | ➖ modelled |
| Spin / curve | ➖ modelled | ➖ modelled |

That split is honest and deliberate: at 60 fps a driver's ball crosses the field of view in a
single frame, so club-head tracking is the only stable signal. This is the same trade-off
budget commercial monitors make. Buy nothing, expect a good estimate, not a Trackman.

## 4. Screen share, casting and Picture-in-Picture

* **Full screen (⛶)** — tap it before casting; on Android Chrome this hides the browser bars
  and, if *Lock landscape on play* is enabled, locks the orientation to landscape. Portrait and
  landscape both work; the scene re-renders on rotation and casting resize events.
* **Clean mode (📺)** — hides the top bar, the tab bar and the ROUND/SD score tiles, leaving just
  the 3D view plus the shot tiles. Enable it (or *Settings → Hide UI when screen sharing*) for a
  broadcast-quality picture on the TV. The camera PiP window stays on the phone.
* **Google Home / Chromecast** — Google Home app → your TV → *Cast my screen* → *Cast screen*.
* **Samsung Smart View** — notification shade → **Smart View** → pick the TV, set the TV to
  *full screen* if it shows a box.
* **Picture-in-Picture** — the in-app **BALL VIEW** window floats over the sim (tap ▣ to show or
  hide, ⊖ to collapse to the header, 🔍 to cycle zoom for near/far tees). It carries the live
  camera with the same alignment overlay, so you can see the ball while watching the shot view.
  On browsers that support the real OS PiP API there is also a composited system PiP stream.

Casting adds 100–400 ms of latency: watch the **phone** for swing feedback, the **TV** for the
shot view. Keep the phone plugged in — analysis + casting is power hungry.

## 5. Readiness notification

Turn it on in **Settings → Notify when ready to swing** (plus **Vibrate when ready**). When the
app is in the foreground you get a toast + a short vibration + a **READY** pill in the header the
moment the ball is detected back on its spot. If you grant notification permission (the app asks
when you enable the switch) it also posts a system notification — Android shows it in the shade,
and it is what a wearable mirroring the phone's notifications will surface. The pill and PiP
status ("ready / swinging / waiting for the next ball") are always live regardless.

## 6. Courses (duplicated from OGC Open)

Hole routing, hole counts, layout artwork and hole maps come from the public OGC Open course
pages; the artwork is processed at load time into a playable surface grid
(fairway / rough / trees / bunkers / water / green) plus an elevation field — that is what the
renderer paints and the physics resists.

| Region | Courses | Holes each |
|---|---|---|
| Europe | Helsingborg Public Course, San Marino Golf Club, Perthshire Country Club, Berlin White Lake, Sevilla Golf Resort | 3, 6, 9, 6, 9 |
| Asia | Saigon City Cycle, Phuket Golf Resort, Hongkong Royal Golf Club, Borneo Wildlife Resort | 7, 10, 7, 9 |
| North America | Quebec City Course, Manitoba Country Club, Vancouver City Cycle, Wood Buffalo Wildlife Club | 6, 9, 6, **18** |
| USA Desert | Las Vegas City Cycle | 6 |

OGC does not publish per-hole yardage, so par/yardage are reconstructed estimates tuned for
simulator play (`www/data/courses.json` — edit freely). Wood Buffalo is a full par-72 round.
Course names and layout art remain the property of more dots media UG.

## 7. Project layout

```
golf-sim/
├─ README.md
├─ serve.py                 # tiny static server that binds 0.0.0.0 so the phone can reach it
└─ www/
   ├─ index.html            # all screens: home, course, sim, camera, scorecard, settings, cast
   ├─ manifest.webmanifest  # PWA: fullscreen, installable, works offline
   ├─ sw.js                 # service worker (app shell + course art cached)
   ├─ css/style.css
   ├─ data/courses.json     # the OGC course library + par/yardage
   ├─ assets/icon.svg
   ├─ assets/courses/id*/   # hole maps + course crests (from ogcopen.com)
   └─ js/
      ├─ physics.js         # ball flight (aero + Magnus), bounce/roll per surface, stimp putting
      ├─ terrain.js         # OGC art → surface grid + elevation, procedural range/green/cage
      ├─ engine.js          # canvas 3D renderer: painted terrain, billboards, minimap, traces
      ├─ track.js           # the launch monitor: camera, blob tracking, alignment, shot measurement
      └─ app.js             # game loop, round/range/putting modes, HUD, casting, settings
```

## 8. Settings worth knowing

* **Ball flight model** — *Realistic* (limited-flight ball), *Range ball* (reduced lift/spin),
  *Tour ball* (higher lift).
* **Elevation profile** — *Flat lie* or *Gentle roll* (uses the height field derived from the map).
* **Wind** — 0–25 mph; the direction is drawn from the hole so each tee has its own wind, shown in
  the wind banner (L→R, in, out…). Wind affects the flight in the integration, not just the picture.
* **Units** — yards or metres everywhere (HUD, ladder, club table).
* **Handedness** — left/right (mirrors the strike model).
* **Camera** — rear/main (default) or front, 720p/1080p/4K capture, preferred 60/120/240 fps.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Camera never starts | Serve over `http://<LAN-ip>` or HTTPS, not `file://`. Check Chrome's permission (⋮ → Settings → Site settings → Camera). |
| "Tracking" but no ball found | Raise **Detection**, lay a white/cream mat under the ball, avoid strong sun stripes across the mat, re-run **Auto-calibrate scene**, then **Lock ball position**. |
| Every shot is flagged modelled | That is normal in club-streak mode (60 fps). Ask for **120/240 fps** in Settings → High frame rate; if the sensor grants it, the app switches to ball tracking automatically. |
| Distances look wrong | Re-measure **Tee distance** — it is the calibration scale. Also lower the **camera height** value if the phone is propped on a block. |
| Numbers feel too strong/weak | Settings → **Ball flight model**, or edit the player's club data in `js/physics.js` (`ball`, `launch`, `spin`, `smash` per club). |
| Casting is choppy | Enable **Clean mode**, keep the phone plugged in; the renderer auto-scales resolution to protect frame rate. |
| Score got weird | **Card** → the guard blocks swings during the hole-out celebration; use *Menu → Mulligan* to replay a shot. |

## 10. Accuracy notes

* Physics is integrated at 240–360 Hz with a spin-dependent drag/lift model, and calibrated so the
  bag carries match published amateur launch-monitor data (driver 208 yd carry / 233 yd total,
  7-iron 150/168, PW 114/130 — see the tables produced by `js/physics.js`).
* Green speed is Stimp-based; a 30 ft putt on 2% side slope breaks ~19 in, matching golf's
  rule-of-thumb (19 in for 2% at 30 ft), and putts lip out above ~11 yd/s.
* The putting green's stimp comes from Settings → putting session; the range and course use 10.
* Confidence percentages are a self-report of frame-rate and sample count — treat anything under
  ~50% as a practice guess.
