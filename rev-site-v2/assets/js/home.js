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
const compactQuery = window.matchMedia("(max-width: 760px)");

// Camera keys per beat. Car axes: nose +Z, car-left (canopy side) +X, metres.
// sx/sy shift the framing (fractions of the viewport) to make room for the text panel.
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

  // ---------- Camera path ----------
  let keys;
  let curve;
  const buildPath = () => {
    const compact = compactQuery.matches;
    const src = compact ? COMPACT : DESKTOP;
    // Narrower than the reference aspect: pull back so the 4.8 m car still fits.
    const aspect = studio.width / Math.max(studio.height, 1);
    const pull = Math.max(1, Math.pow((compact ? 0.5 : 1.55) / aspect, 0.85));
    keys = src.map((k) => {
      const tgt = v3(k.tgt);
      return { ...k, tgt, pos: v3(k.pos).sub(tgt).multiplyScalar(pull).add(tgt), up: v3(k.up) };
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

  // ---------- Intro: dark, a strip light sweeps nose to tail, the studio comes up ----------
  const playIntro = window.scrollY < 40;
  const intro = { active: playIntro, t0: 0 };
  studio.setStudioLevel(playIntro ? 0 : 1);
  studio.setLight(playIntro ? 0 : 1);
  const ease = (x) => 1 - Math.pow(1 - THREE.MathUtils.clamp(x, 0, 1), 3);
  const runIntro = (now) => {
    if (!intro.t0) intro.t0 = now;
    const t = (now - intro.t0) / 1000;
    const s = THREE.MathUtils.clamp((t - 0.3) / 2.4, 0, 1);
    const z = THREE.MathUtils.lerp(4, -4, THREE.MathUtils.smootherstep(s, 0, 1));
    const amount = THREE.MathUtils.smoothstep(t, 0.2, 0.7) * (1 - THREE.MathUtils.smoothstep(s, 0.85, 1));
    studio.setSweep(z, amount);
    studio.setStudioLevel(ease((t - 1.2) / 2));
    studio.setLight(ease((t - 2.6) / 0.5));
    if (t > 3.6) {
      intro.active = false;
      studio.setSweep(99, 0);
      studio.setStudioLevel(1);
      studio.setLight(1);
    }
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
    if (intro.active && intro.t0 && currentBeat > 0.25) intro.t0 = now - 3400;
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
  new ResizeObserver(() => { measure(); studio.wake(); }).observe(document.querySelector(".story"));
  window.addEventListener("scroll", () => studio.wake(), { passive: true });

  relayout();
  placeCamera(currentBeat);
  await studio.compile();
  stage.classList.remove("is-loading");
  stage.classList.add("is-ready");
  studio.wake();
  // Build the schematic layer and compile its shaders while idle, so the x-ray beat
  // doesn't stall the first time someone scrolls into it.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 600));
  idle(async () => {
    void studio.schematic;
    studio.setXray(0.001, 0);
    await studio.compile();
    studio.renderer.render(studio.scene, studio.camera);
    studio.setXray(0, 0);
    studio.wake();
  }, { timeout: 2500 });
}

// The profile beat's heading and specs are pinned (CSS sticky). Fade them in as the beat
// arrives and out before the pin releases, so the text never scrolls across the car.
const profileBeat = document.querySelector(".beat-bottom");
if (profileBeat && !reduceMotion) {
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  let queued = false;
  const fadeProfile = () => {
    queued = false;
    const r = profileBeat.getBoundingClientRect();
    const vh = window.innerHeight;
    const fadeIn = clamp01(1 - r.top / (vh * 0.45));
    const fadeOut = clamp01((r.bottom - vh) / (vh * 0.35));
    profileBeat.style.setProperty("--show", (fadeIn * fadeOut).toFixed(3));
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(fadeProfile); } };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue);
  fadeProfile();
}

if (reduceMotion) {
  stage.classList.add("is-static");
} else {
  // Start after first paint so text, fonts and images win the bandwidth race.
  const start = () => boot().catch(fail);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  if (document.readyState === "complete") idle(start, { timeout: 1500 });
  else window.addEventListener("load", () => idle(start, { timeout: 1500 }), { once: true });
}
