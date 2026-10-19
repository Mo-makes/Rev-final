// Home: the studio reveal, then a scroll-scrubbed camera walk around Carrera.
// The page is complete without this script; the poster image stands in until the 3D is ready,
// and stays for reduced-motion visitors and browsers without WebGL.
const stage = document.querySelector(".stage");
const canvas = stage.querySelector(".stage-canvas");
const loaderBar = stage.querySelector(".stage-loader");
const beats = [...document.querySelectorAll(".beat")];
const callouts = [...stage.querySelectorAll(".callout")];
const railItems = [...stage.querySelectorAll(".stage-rail span")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Stacked layout (car above the text). Keep in sync with the media query in home.css.
const STACKED = "(max-width: 1099px), (max-aspect-ratio: 5/4)";
const compactQuery = window.matchMedia(STACKED);

// Camera keys per beat. Car axes: nose +Z, car-left (canopy side) +X, metres.
// Only the viewing direction, target, up and lens of each key are used as given: the distance and
// framing are fitted at runtime so the car fills the empty part of the screen beside or above that
// beat's text (see fitKeys). COMPACT directions are for portrait screens.
const DESKTOP = [
  { pos: [4.6, 1.55, 8.2], tgt: [0, 0.45, 0.1], fov: 28, sx: 0, sy: 0.16, up: [0, 1, 0] },
  { pos: [4.4, 12, 0.5], tgt: [0, 0.4, 0], fov: 30, sx: -0.15, sy: 0, up: [0, 1, 0] },
  { pos: [-5.4, 3.7, 5.6], tgt: [0, 0.35, 0.15], fov: 30, sx: 0.17, sy: 0.02, up: [0, 1, 0] },
  { pos: [-11.5, 0.6, 0.1], tgt: [0, 0.6, 0], fov: 24, sx: 0, sy: 0.04, up: [0, 1, 0] },
  { pos: [7.4, 1.6, -9.4], tgt: [0, 0.5, -0.2], fov: 28, sx: -0.18, sy: 0.04, up: [0, 1, 0] },
];
const COMPACT = [
  { pos: [11, 2.8, 13], tgt: [0, 0.5, 0.1], fov: 34, sx: 0, sy: 0.1, up: [0, 1, 0] },
  { pos: [5.2, 16.5, 0.5], tgt: [0, 0.4, 0], fov: 34, sx: 0, sy: 0.2, up: [0, 0, 1] },
  { pos: [-9, 6, 9.5], tgt: [0, 0.35, 0.15], fov: 34, sx: 0, sy: 0.22, up: [0, 1, 0] },
  { pos: [-25, 1, 0.1], tgt: [0, 0.6, 0], fov: 26, sx: 0, sy: 0.2, up: [0, 1, 0] },
  { pos: [10, 2.2, -12.2], tgt: [0, 0.55, -0.2], fov: 34, sx: 0, sy: 0.2, up: [0, 1, 0] },
];

const fail = (err) => {
  if (err) console.warn("[v2] 3D unavailable, keeping the poster:", err);
  stage.classList.remove("is-loading");
  stage.classList.add("has-error");
};

async function boot() {
  const { createStudio, webglAvailable, THREE } = await import("./studio.js");
  if (!webglAvailable()) return fail("no WebGL");
  stage.classList.add("is-loading");
  const studio = await createStudio({
    stage,
    canvas,
    onProgress: (p) => loaderBar.style.setProperty("--p", p.toFixed(3)),
  });
  window.__studio = studio; // for debugging and poster capture
  const { camera, hotspots } = studio;
  const v3 = (a) => new THREE.Vector3(...a);

  // ---------- Camera path: fit the car into the space each beat's text leaves free ----------
  const carBox = new THREE.Box3().setFromObject(studio.car);
  const corners = [];
  for (const x of [carBox.min.x, carBox.max.x]) for (const y of [carBox.min.y, carBox.max.y]) for (const z of [carBox.min.z, carBox.max.z]) corners.push(new THREE.Vector3(x, y, z));
  const fitCam = new THREE.PerspectiveCamera();
  const pTmp = new THREE.Vector3();
  const projectCar = (k, dir, D, aspect) => {
    fitCam.fov = k.fov;
    fitCam.aspect = aspect;
    fitCam.near = 0.05;
    fitCam.far = 400;
    fitCam.updateProjectionMatrix();
    fitCam.position.copy(k.tgt).addScaledVector(dir, D);
    fitCam.up.copy(k.up);
    fitCam.lookAt(k.tgt);
    fitCam.updateMatrixWorld();
    const e = { minx: Infinity, maxx: -Infinity, miny: Infinity, maxy: -Infinity };
    for (const c of corners) {
      pTmp.copy(c).project(fitCam);
      e.minx = Math.min(e.minx, pTmp.x); e.maxx = Math.max(e.maxx, pTmp.x);
      e.miny = Math.min(e.miny, pTmp.y); e.maxy = Math.max(e.maxy, pTmp.y);
    }
    return e;
  };
  // Distance and view offset that put the car inside an NDC rectangle.
  const fitInto = (k, dir, rect, aspect) => {
    let D = Math.max(3, k.dist);
    let e;
    for (let i = 0; i < 6; i++) {
      e = projectCar(k, dir, D, aspect);
      const s = Math.max((e.maxx - e.minx) / (rect.r - rect.l), (e.maxy - e.miny) / (rect.t - rect.b));
      D = Math.min(80, Math.max(2.5, D * (0.35 + 0.65 * s)));
    }
    e = projectCar(k, dir, D, aspect);
    const dx = (rect.l + rect.r) / 2 - (e.minx + e.maxx) / 2;
    const dy = (rect.t + rect.b) / 2 - (e.miny + e.maxy) / 2;
    return { D, sx: -dx / 2, sy: dy / 2 };
  };
  // Free rectangles (px) around a beat's text when its panel is pinned.
  const freeRects = (i) => {
    const vw = studio.width;
    const vh = studio.height;
    const g = Math.max(16, vw * 0.03);
    const pad = Math.max(20, vh * 0.04);
    const A = { l: g, r: vw - g, t: (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h")) || 68) + g * 0.5, b: vh - g };
    const inner = beats[i].querySelector(".beat-inner");
    const ir = inner.getBoundingClientRect();
    const kids = i === 0 ? [...inner.children] : [...inner.querySelectorAll(":scope > .panel, :scope > .profile-head, :scope > .specs")];
    const rects = kids.filter((el) => el.offsetHeight && getComputedStyle(el).display !== "none").map((el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - ir.left, r: r.right - ir.left, t: r.top - ir.top, b: r.bottom - ir.top };
    }).sort((a, b) => a.t - b.t);
    if (!rects.length) return [A];
    const U = rects.reduce((u, r) => ({ l: Math.min(u.l, r.l), r: Math.max(u.r, r.r), t: Math.min(u.t, r.t), b: Math.max(u.b, r.b) }));
    const out = [
      { l: A.l, r: A.r, t: A.t, b: U.t - pad },
      { l: A.l, r: A.r, t: U.b + pad, b: A.b },
      { l: A.l, r: U.l - pad, t: A.t, b: A.b },
      { l: U.r + pad, r: A.r, t: A.t, b: A.b },
    ];
    for (let j = 1; j < rects.length; j++) out.push({ l: A.l, r: A.r, t: rects[j - 1].b + pad, b: rects[j].t - pad });
    return out.filter((r) => r.r - r.l > 120 && r.b - r.t > 90);
  };
  let keys;
  let curve;
  const buildPath = () => {
    const aspect = studio.width / Math.max(studio.height, 1);
    const src = aspect < 0.85 ? COMPACT : DESKTOP;
    const toNdc = (r) => ({ l: (r.l / studio.width) * 2 - 1, r: (r.r / studio.width) * 2 - 1, t: 1 - (r.t / studio.height) * 2, b: 1 - (r.b / studio.height) * 2 });
    keys = src.map((raw, i) => {
      const k = { ...raw, tgt: v3(raw.tgt), up: v3(raw.up) };
      k.dist = v3(raw.pos).distanceTo(k.tgt);
      const dir = v3(raw.pos).sub(k.tgt).normalize();
      let best = null;
      for (const rect of freeRects(i)) {
        // Leave a little air inside the free area.
        const n = toNdc(rect);
        const mx = (n.r - n.l) * 0.04;
        const my = (n.t - n.b) * 0.06;
        const fit = fitInto(k, dir, { l: n.l + mx, r: n.r - mx, t: n.t - my, b: n.b + my }, aspect);
        if (!best || fit.D < best.D) best = fit;
      }
      if (!best) best = { D: k.dist, sx: 0, sy: 0 };
      return { ...k, pos: k.tgt.clone().addScaledVector(dir, best.D), sx: best.sx, sy: best.sy };
    });
    curve = new THREE.CatmullRomCurve3(keys.map((k) => k.pos), false, "centripetal");
  };

  // ---------- Scroll mapping ----------
  let beatTops = [];
  const measure = () => { beatTops = beats.map((b) => b.getBoundingClientRect().top + window.scrollY); };
  const scrollBeat = () => {
    const y = window.scrollY;
    if (y <= beatTops[0]) return 0;
    for (let i = 0; i < beatTops.length - 1; i++) {
      if (y < beatTops[i + 1]) return i + (y - beatTops[i]) / (beatTops[i + 1] - beatTops[i]);
    }
    return beatTops.length - 1;
  };
  const smooth = (a, b, x) => {
    const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  // Hold the camera while a panel is read; move while the next one scrolls in.
  const shapeBeat = (b) => {
    const i = Math.min(Math.floor(b), keys.length - 2);
    return i + smooth(0.2, 0.92, b - i);
  };

  const tmpTgt = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();
  const placeCamera = (beat) => {
    const u = THREE.MathUtils.clamp(shapeBeat(beat), 0, keys.length - 1);
    const i = Math.min(Math.floor(u), keys.length - 2);
    const f = u - i;
    const a = keys[i];
    const b = keys[i + 1];
    camera.position.copy(curve.getPoint(u / (keys.length - 1)));
    tmpTgt.lerpVectors(a.tgt, b.tgt, f);
    camera.up.copy(tmpUp.lerpVectors(a.up, b.up, f).normalize());
    camera.fov = THREE.MathUtils.lerp(a.fov, b.fov, f);
    const w = studio.width;
    const h = studio.height;
    camera.setViewOffset(w, h, THREE.MathUtils.lerp(a.sx, b.sx, f) * w, THREE.MathUtils.lerp(a.sy, b.sy, f) * h, w, h);
    camera.lookAt(tmpTgt);
    camera.updateProjectionMatrix();
    studio.fadeRig(camera.position.y);
    return u;
  };

  // ---------- Overlays ----------
  const updateOverlay = (u) => {
    for (const el of callouts) {
      const near = 1 - THREE.MathUtils.clamp(Math.abs(u - Number(el.dataset.beat)) * 3.2, 0, 1);
      const anchor = hotspots[el.dataset.anchor];
      if (near <= 0.001 || !anchor) {
        el.style.opacity = "0";
        continue;
      }
      const p = studio.toScreen(anchor);
      el.style.setProperty("--x", `${p.x.toFixed(1)}px`);
      el.style.setProperty("--y", `${p.y.toFixed(1)}px`);
      el.classList.toggle("flip", p.x > studio.width * 0.62);
      el.style.opacity = p.behind ? "0" : near.toFixed(3);
    }
    const active = Math.round(u);
    railItems.forEach((item, idx) => item.classList.toggle("is-active", idx === active));
  };

  // X-ray peaks on the "Inside" beat; the power path draws in as you arrive.
  const updateXray = (u) => {
    const x = smooth(0, 1, 1 - Math.abs(u - 2) * 1.5);
    studio.setXray(x, smooth(1.35, 2.0, u));
  };

  // Build the x-ray layer now, behind the poster and before the car moves for the intro: it is
  // placed from the car's resting position, and building it mid-scroll would stall a frame.
  void studio.schematic;
  studio.setXray(0.001, 0);
  await studio.compile();
  studio.setXray(0, 0);

  // ---------- Intro: Carrera drives in under a fixed overhead light, then the showroom comes up ----------
  // The light bar hangs still just behind the car's final spot. As the car rolls forward beneath it
  // the highlight travels along the body from nose to tail, and the car brakes to a stop on its mark.
  const DRIVE_FROM = -14; // metres behind the mark (the car approaches nose first, toward +Z)
  const LIGHT_Z = -2.9; // the overhead light, just behind where the tail comes to rest
  const DRIVE_START = 0.25;
  const DRIVE_TIME = 3.4;
  const INTRO_END = DRIVE_START + DRIVE_TIME + 1.1;
  const playIntro = window.scrollY < 40;
  const intro = { active: playIntro, t0: 0, z: playIntro ? DRIVE_FROM : 0 };
  studio.setStudioLevel(playIntro ? 0 : 1);
  studio.setLight(playIntro ? 0 : 1);
  studio.setCarOffset(intro.z);
  // The page head assumed a drive-in; if the page opened scrolled down instead, bring the poster back.
  if (!playIntro) document.documentElement.classList.remove("drive-intro");
  const ease = (x) => 1 - Math.pow(1 - THREE.MathUtils.clamp(x, 0, 1), 3);
  const finishIntro = () => {
    intro.active = false;
    studio.rollWheels(-intro.z);
    intro.z = 0;
    studio.setCarOffset(0);
    studio.setSweep(99, 0);
    studio.setStudioLevel(1);
    studio.setLight(1);
  };
  const runIntro = (now) => {
    if (!intro.t0) intro.t0 = now;
    const t = (now - intro.t0) / 1000;
    if (t >= INTRO_END) return finishIntro();
    // Ease-out: rolling in, then braking smoothly to a stop on the mark.
    const z = THREE.MathUtils.lerp(DRIVE_FROM, 0, ease((t - DRIVE_START) / DRIVE_TIME));
    studio.rollWheels(z - intro.z);
    intro.z = z;
    studio.setCarOffset(z);
    const settle = DRIVE_START + DRIVE_TIME;
    studio.setSweep(LIGHT_Z, THREE.MathUtils.smoothstep(t, 0.05, 0.5) * (1 - THREE.MathUtils.smoothstep(t, settle - 0.2, settle + 0.9)));
    studio.setLight(0.45 + 0.55 * ease((t - settle + 0.4) / 0.5));
    studio.setStudioLevel(ease((t - settle + 0.9) / 1.8));
  };

  // ---------- Handheld drift: a barely-there sway on the hero shot, so it reads as filmed ----------
  // High tier only. It runs while the hero frame is on screen (the loop only renders while the stage
  // is in view and the tab is visible), fades out after DRIFT_SECONDS without scrolling, and stops.
  const DRIFT_SECONDS = 25;
  const drift = { on: studio.quality === "high" && !reduceMotion, amount: 0, since: 0 };
  const swayed = new THREE.Euler();
  const swayQ = new THREE.Quaternion();
  const applyDrift = (dt, now, beat) => {
    if (!drift.on) return false;
    if (!drift.since) drift.since = now;
    const wanted = !intro.active && beat < 0.12 && now - drift.since < DRIFT_SECONDS * 1000 ? 1 : 0;
    drift.amount += (wanted - drift.amount) * (1 - Math.exp(-dt * (wanted ? 0.8 : 1.6)));
    if (!wanted && drift.amount < 0.002) drift.amount = 0;
    if (drift.amount === 0) return false;
    const t = now / 1000;
    const a = drift.amount;
    const wave = (f1, p1, f2, p2, f3, p3) => 0.62 * Math.sin(t * f1 + p1) + 0.28 * Math.sin(t * f2 + p2) + 0.1 * Math.sin(t * f3 + p3);
    swayed.set(
      0.0016 * a * wave(0.37, 0.4, 0.83, 2.1, 2.3, 0.7),
      0.0024 * a * wave(0.29, 1.3, 0.71, 0.2, 1.9, 2.6),
      0.0009 * a * wave(0.23, 2.2, 0.61, 1.1, 1.7, 0.3),
      "YXZ",
    );
    camera.position.y += 0.006 * a * wave(0.41, 0.9, 1.07, 2.4, 2.9, 1.5);
    camera.quaternion.multiply(swayQ.setFromEuler(swayed));
    return true;
  };
  window.addEventListener("scroll", () => { drift.since = performance.now(); }, { passive: true });

  // ---------- Loop ----------
  let targetBeat = scrollBeat();
  let currentBeat = targetBeat;
  let lastU = 0;
  studio.setLoop((dt, now) => {
    targetBeat = scrollBeat();
    currentBeat += (targetBeat - currentBeat) * (1 - Math.exp(-dt * 4.2));
    if (Math.abs(targetBeat - currentBeat) < 0.0005) currentBeat = targetBeat;
    // Scrolling away mid-intro jumps to the lit studio rather than leaving a dark car.
    if (intro.active && intro.t0 && currentBeat > 0.25) finishIntro();
    if (intro.active) runIntro(now);
    const u = placeCamera(currentBeat);
    const drifting = applyDrift(dt, now, currentBeat);
    // Roll the wheels while the camera tracks the profile, as if the car were rolling.
    if (u > 2.5 && u < 4) studio.rollWheels((u - lastU) * 6);
    lastU = u;
    updateXray(u);
    updateOverlay(u);
    return intro.active || currentBeat !== targetBeat || drifting;
  });

  const relayout = () => { measure(); buildPath(); studio.wake(); };
  studio.onResize(relayout);
  compactQuery.addEventListener("change", relayout);
  // Text reflows (fonts arriving, viewport changes) move the free space, so refit then too.
  new ResizeObserver(relayout).observe(document.querySelector(".story"));
  document.fonts?.ready.then(relayout);
  window.addEventListener("scroll", () => studio.wake(), { passive: true });

  relayout();
  placeCamera(currentBeat);
  await studio.compile();
  stage.classList.remove("is-loading");
  stage.classList.add("is-ready");
  studio.wake();

}

// Story panels are pinned (CSS sticky). Fade each in as its beat arrives and out before its pin
// releases, so text never scrolls across the car.
const storyBeats = [...document.querySelectorAll(".beat:not(.beat-hero)")];
if (storyBeats.length && !reduceMotion) {
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  let queued = false;
  const fadeBeats = () => {
    queued = false;
    const vh = window.innerHeight;
    for (const beat of storyBeats) {
      const r = beat.getBoundingClientRect();
      if (r.bottom < -vh || r.top > 2 * vh) continue;
      // Appear only once pinned (no sliding while visible), leave before the pin releases.
      const fadeIn = clamp01(-r.top / (vh * 0.25));
      const fadeOut = beat === storyBeats[storyBeats.length - 1] ? 1 : clamp01((r.bottom - vh) / (vh * 0.35));
      beat.style.setProperty("--show", (fadeIn * fadeOut).toFixed(3));
    }
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(fadeBeats); } };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  fadeBeats();
}

if (reduceMotion) {
  stage.classList.add("is-static");
} else {
  // Start after first paint so text, fonts and images win the bandwidth race.
  // Wait for the page slide to finish first; building the 3D mid-slide makes it stutter.
const start = () => (window.__pageTransition || Promise.resolve()).then(boot).catch(fail);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  if (document.readyState === "complete") idle(start, { timeout: 1500 });
  else window.addEventListener("load", () => idle(start, { timeout: 1500 }), { once: true });
}
