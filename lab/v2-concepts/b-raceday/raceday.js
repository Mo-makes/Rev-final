// REV v2 concept B: Race Day.
// A fixed WebGL stage (Carrera on a daylight track) behind crawlable HTML panels,
// with a broadcast HUD driven by a SIMULATED telemetry model. Nothing here is real car data.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// "?still" previews the reduced-motion version.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches || new URLSearchParams(location.search).has("still");
const compact = () => innerWidth <= 760;

/* ------------------------------------------------------------------ */
/* Illustrative elevation profile (same formula as the inline SVG).    */
/* ------------------------------------------------------------------ */
const prof = (x) =>
  0.3 * Math.sin(2 * Math.PI * x + 0.4) + 0.16 * Math.sin(4 * Math.PI * x + 2.1) +
  0.08 * Math.sin(6 * Math.PI * x + 0.9) + 0.035 * Math.sin(14 * Math.PI * x + 1.7);
let pMin = Infinity, pMax = -Infinity;
for (let i = 0; i <= 1000; i++) { const v = prof(i / 1000); pMin = Math.min(pMin, v); pMax = Math.max(pMax, v); }
const elev = (x) => (prof(x) - pMin) / (pMax - pMin);
const slope = (x) => (elev(x + 0.002) - elev(x - 0.002)) / 0.004;

/* ------------------------------------------------------------------ */
/* Scroll state: t runs 0..3 across the four beats.                    */
/* ------------------------------------------------------------------ */
const beats = [...document.querySelectorAll(".beat")];
let scrollT = 0;
function readScroll() {
  const vh = innerHeight;
  let raw = 0;
  for (const b of beats) {
    const r = b.getBoundingClientRect();
    raw += clamp((vh * 0.5 - r.top) / r.height, 0, 1);
  }
  scrollT = clamp(raw - 0.5, 0, beats.length - 1);
}
addEventListener("scroll", readScroll, { passive: true });
addEventListener("resize", readScroll);
readScroll();

/* ------------------------------------------------------------------ */
/* Simulated telemetry. Ranges follow the published design figures:   */
/* array <= 1000 W, top speed 75+ mph (simulated), 5.18 kWh pack.      */
/* ------------------------------------------------------------------ */
const tel = { speed: 33, temp: 41, array: 955, batt: 96.4, clock: 2 * 3600 + 14 * 60 + 7, drain: 0 };
const lapPos = (t) => clamp(t - 1.5, 0, 1);

function targetSpeed(t) {
  if (t < 0.55) return 33;                                        // chase cam: race pace on sunlight
  if (t < 1.5) return lerp(33, 76, smooth(0.5, 1.12, t));        // trackside: flat out
  if (t < 2.5) return clamp(61 - slope(lapPos(t)) * 3.2, 44, 75); // climbs slow it, descents speed it up
  return lerp(60, 42, smooth(2.5, 2.9, t));                       // settle to an endurance pace
}

const hud = {
  speed: $("#v-speed"), array: $("#v-array"), batt: $("#v-batt"), temp: $("#v-temp"),
  clock: $("#hud-clock"), sector: $("#hud-sector"), cam: $("#hud-cam"),
  shift: [...document.querySelectorAll("#hud-shift i")],
  arrayCell: $(".ob-array"), battCell: $(".ob-batt"), tempCell: $(".ob-temp"),
  marker: $("#profile-marker"),
};
let hudTimer = 0, clockTimer = 0, simTime = 0, lastBeat = -1;

function updateTelemetry(dt) {
  simTime += dt;
  const t = scrollT;
  const target = targetSpeed(t);
  if (reduceMotion) tel.speed = target;
  else {
    const rate = target > tel.speed ? 11 : 16; // mph per second
    tel.speed += clamp(target - tel.speed, -rate * dt, rate * dt);
  }
  const tempTarget = 33 + 0.42 * tel.speed;
  tel.temp = reduceMotion ? tempTarget : tel.temp + (tempTarget - tel.temp) * Math.min(1, dt / 5);
  const wobble = reduceMotion ? 0 : 14 * Math.sin(simTime * 0.7) + 7 * Math.sin(simTime * 2.3 + 1) + (Math.random() - 0.5) * 6;
  tel.array = Math.min(996, 958 + wobble);
  tel.drain += reduceMotion ? 0 : dt * 0.0009 * (tel.speed / 40);
  tel.batt = clamp(96.4 - (t / 3) * 1.8 - tel.drain, 85, 100);

  clockTimer += dt;
  if (clockTimer >= 1 && !reduceMotion) { clockTimer -= 1; tel.clock += 1; }

  hudTimer += dt;
  if (hudTimer < 1 / 12 && lastBeat !== -1) return;
  hudTimer = 0;
  const shown = tel.speed + (reduceMotion ? 0 : (Math.random() - 0.5) * 0.6);
  hud.speed.textContent = Math.round(shown);
  hud.array.textContent = Math.round(tel.array);
  hud.batt.textContent = tel.batt.toFixed(1);
  hud.temp.textContent = Math.round(tel.temp);
  hud.arrayCell.style.setProperty("--v", (tel.array / 1000).toFixed(3));
  hud.battCell.style.setProperty("--v", (tel.batt / 100).toFixed(3));
  hud.tempCell.style.setProperty("--v", clamp((tel.temp - 20) / 80, 0, 1).toFixed(3));
  const lit = Math.round((tel.speed / 78) * hud.shift.length);
  hud.shift.forEach((el, i) => {
    el.classList.toggle("on", i < lit);
    el.classList.toggle("hot", i >= 8);
    el.classList.toggle("max", i >= 10);
  });
  const c = tel.clock;
  hud.clock.textContent = `${Math.floor(c / 3600)}:${String(Math.floor(c / 60) % 60).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;

  const beat = Math.round(t);
  if (beat !== lastBeat) {
    lastBeat = beat;
    hud.cam.textContent = beats[beat].dataset.cam;
    hud.sector.textContent = beats[beat].dataset.sector;
  }
  if (hud.marker) {
    const x = lapPos(t);
    hud.marker.setAttribute("transform", `translate(${(56 + 528 * x).toFixed(1)} ${(176 - 148 * elev(x)).toFixed(1)})`);
  }
}

/* ------------------------------------------------------------------ */
/* Procedural textures                                                 */
/* ------------------------------------------------------------------ */
const TRACK_W = 24;  // metres across the track texture: 12 m tarmac, kerbs, turf run-off
const TILE = 24;     // metres along one texture repeat
const rnd = (a, b) => a + Math.random() * (b - a);

function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = opts.wrapS ?? THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (opts.wrapS === undefined && opts.repeatS) tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function drawTrack(ctx, W, H) {
  const s = W / TRACK_W;              // px per metre
  const X = (m) => (m + TRACK_W / 2) * s;
  // turf run-off
  ctx.fillStyle = "#4f8a3c"; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) { ctx.fillStyle = `rgba(${Math.random() < 0.5 ? "20,50,15" : "140,190,90"},0.12)`; ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
  // tarmac
  ctx.fillStyle = "#4a4d52"; ctx.fillRect(X(-6), 0, X(6) - X(-6), H);
  // low-frequency patches (drawn wrapped so the tile repeats cleanly)
  for (let i = 0; i < 70; i++) {
    const x = rnd(X(-6), X(6)), y = rnd(0, H), r = rnd(1.5, 6) * s;
    const light = Math.random() < 0.45;
    for (const oy of [-H, 0, H]) {
      const g = ctx.createRadialGradient(x, y + oy, 0, x, y + oy, r);
      g.addColorStop(0, light ? "rgba(120,124,130,0.10)" : "rgba(20,22,26,0.12)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(Math.max(X(-6), x - r), y + oy - r, 2 * r, 2 * r);
    }
  }
  // rubbered-in racing line
  for (let y = 0; y < H; y += 4) {
    const cx = X(-0.6 + 2.0 * Math.sin((2 * Math.PI * y) / H));
    const half = 1.3 * s;
    const g = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
    g.addColorStop(0, "rgba(18,18,20,0)"); g.addColorStop(0.5, "rgba(18,18,20,0.2)"); g.addColorStop(1, "rgba(18,18,20,0)");
    ctx.fillStyle = g; ctx.fillRect(cx - half, y, half * 2, 4);
  }
  // grain + aggregate
  const x0 = Math.floor(X(-6)), x1 = Math.ceil(X(6));
  const img = ctx.getImageData(x0, 0, x1 - x0, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let n = (Math.random() - 0.5) * 30;
    if (Math.random() < 0.025) n += 46;
    if (Math.random() < 0.02) n -= 30;
    d[i] += n; d[i + 1] += n; d[i + 2] += n * 1.05;
  }
  ctx.putImageData(img, x0, 0);
  // skid marks
  ctx.lineCap = "round";
  for (let k = 0; k < 7; k++) {
    const x = rnd(-4, 3), y = rnd(0, H), len = rnd(4, 9) * s, bend = rnd(-0.6, 0.6) * s;
    for (const oy of [-H, 0, H]) for (const w of [0, 1.45]) {
      ctx.strokeStyle = `rgba(12,12,14,${rnd(0.12, 0.22)})`; ctx.lineWidth = 0.2 * s;
      ctx.beginPath(); ctx.moveTo(X(x + w), y + oy); ctx.quadraticCurveTo(X(x + w) + bend, y + oy + len / 2, X(x + w) + bend * 0.3, y + oy + len); ctx.stroke();
    }
  }
  // white track-limit lines
  ctx.fillStyle = "#efeee8";
  ctx.fillRect(X(-6.0), 0, 0.16 * s, H);
  ctx.fillRect(X(5.84), 0, 0.16 * s, H);
  // kerbs: 1 m red/white blocks with a slanted joint
  const blocks = TILE; // 24 blocks, even, so colours alternate across the repeat
  for (const side of [-1, 1]) {
    const a = side < 0 ? X(-7.3) : X(6.0), b = side < 0 ? X(-6.0) : X(7.3);
    for (let i = -1; i <= blocks; i++) {
      const y = (i * H) / blocks, h = H / blocks, sk = 0.35 * s;
      ctx.fillStyle = i % 2 === 0 ? "#cf2229" : "#f2f1ec";
      ctx.beginPath();
      ctx.moveTo(a, y + (side < 0 ? 0 : sk)); ctx.lineTo(b, y + (side < 0 ? sk : 0));
      ctx.lineTo(b, y + h + (side < 0 ? sk : 0)); ctx.lineTo(a, y + h + (side < 0 ? 0 : sk));
      ctx.closePath(); ctx.fill();
    }
    // raised profile shading
    const g = ctx.createLinearGradient(a, 0, b, 0);
    if (side < 0) { g.addColorStop(0, "rgba(0,0,0,0.28)"); g.addColorStop(0.6, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(255,255,255,0.08)"); }
    else { g.addColorStop(0, "rgba(255,255,255,0.08)"); g.addColorStop(0.4, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.28)"); }
    ctx.fillStyle = g; ctx.fillRect(a, 0, b - a, H);
  }
  // run-off edge line
  ctx.fillStyle = "rgba(240,240,232,0.85)";
  ctx.fillRect(X(-10.4), 0, 0.12 * s, H);
  ctx.fillRect(X(10.28), 0, 0.12 * s, H);
}

function drawGrass(ctx, W, H) {
  const stripes = 8;
  for (let i = 0; i < stripes; i++) { ctx.fillStyle = i % 2 ? "#5d9844" : "#6aa54f"; ctx.fillRect(0, (i * H) / stripes, W, H / stripes); }
  for (let i = 0; i < 14000; i++) { ctx.fillStyle = `rgba(${Math.random() < 0.5 ? "30,60,20" : "150,200,100"},0.18)`; ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5); }
}

function drawWall(ctx, W, H) {
  // 8 m of concrete wall, painted in 2 m REV blue / white panels
  const panels = 4;
  for (let i = 0; i < panels; i++) { ctx.fillStyle = i % 2 ? "#f1f3f5" : "#1467aa"; ctx.fillRect((i * W) / panels, 0, W / panels, H); }
  ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, 0, W, H * 0.06);
  const g = ctx.createLinearGradient(0, H * 0.7, 0, H); g.addColorStop(0, "rgba(40,30,20,0)"); g.addColorStop(1, "rgba(40,30,20,0.35)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < panels; i++) { ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect((i * W) / panels, 0, 2, H); }
}

function drawFence(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(70,78,86,0.9)"; ctx.lineWidth = 2;
  const step = W / 6;
  for (let i = -6; i <= 12; i++) {
    ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step + H, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i * step + H, 0); ctx.lineTo(i * step, H); ctx.stroke();
  }
}

function drawTreeline(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  const base = H * 0.72;
  ctx.fillStyle = "#7f978c";
  ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 6) {
    const y = base - 30 - 26 * Math.abs(Math.sin(x * 0.013)) - 18 * Math.abs(Math.sin(x * 0.047 + 1)) - 10 * Math.random() - 50 * Math.max(0, Math.sin(x * 0.0021));
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#97aaa0";
  ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 10) ctx.lineTo(x, base - 70 - 40 * Math.sin(x * 0.0017 + 2) - 10 * Math.sin(x * 0.02));
  ctx.lineTo(W, H); ctx.closePath();
  ctx.globalCompositeOperation = "destination-over"; ctx.fill(); ctx.globalCompositeOperation = "source-over";
}

// Directional motion blur on scrolling surfaces: average N taps along the travel axis.
function addMotionBlur(mat, axis) {
  const uBlur = { value: 0 };
  mat.userData.uBlur = uBlur;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBlur = uBlur;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uBlur;")
      .replace("#include <map_fragment>", `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = vec4(0.0);
  for (int i = 0; i < 9; i++) {
    float o = (float(i) / 8.0 - 0.5) * uBlur;
    sampledDiffuseColor += texture2D(map, vMapUv + vec2(${axis}) * o);
  }
  sampledDiffuseColor /= 9.0;
  diffuseColor *= sampledDiffuseColor;
#endif`);
  };
  return uBlur;
}

/* ------------------------------------------------------------------ */
/* Camera keyframes, in car space (car faces +Z, wheels on y = 0).    */
/* ------------------------------------------------------------------ */
const KEYS = [
  { pos: [0, 2.05, -8.8], look: [0, 0.6, 3.2], fov: 40, sx: 0.16, msy: 0.26 },   // chase cam
  { pos: [9.8, 0.5, 7.4], look: [0, 0.62, -0.3], fov: 27, sx: -0.17, msy: 0.22 }, // trackside, low
  { pos: [-7.8, 8.6, -9.2], look: [0.4, 0, 2.6], fov: 38, sx: 0.27, msy: 0.26 },   // crane
  { pos: [-4.6, 1.15, 7.4], look: [0, 0.55, 0.2], fov: 31, sx: -0.18, msy: 0.22 }, // front quarter
].map((k) => ({ ...k, r: Math.hypot(k.pos[0], k.pos[2]), az: Math.atan2(k.pos[0], k.pos[2]), y: k.pos[1] }));
const STATIC_KEY = { r: Math.hypot(6.8, 8.6), az: Math.atan2(6.8, 8.6), y: 1.5, look: [0, 0.5, 0], fov: 32, sx: 0, msy: 0.22 };

function camAt(te) {
  const k = Math.min(Math.floor(te), KEYS.length - 1);
  const f = smooth(0.18, 0.82, te - k);
  const A = KEYS[k], B = KEYS[Math.min(k + 1, KEYS.length - 1)];
  let dAz = B.az - A.az;
  dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
  return {
    r: lerp(A.r, B.r, f), az: A.az + dAz * f, y: lerp(A.y, B.y, f),
    look: A.look.map((v, i) => lerp(v, B.look[i], f)),
    fov: lerp(A.fov, B.fov, f), sx: lerp(A.sx, B.sx, f), msy: lerp(A.msy, B.msy, f),
  };
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */
function fail(err) {
  if (err) console.warn("Race Day: WebGL unavailable, showing the still render.", err);
  document.documentElement.classList.add("no-webgl");
}

function initScene() {
  const canvas = $("#track");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch (e) { fail(e); return null; }

  const small = compact();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.25 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const HAZE = new THREE.Color("#cddbe6");
  scene.fog = new THREE.Fog(HAZE, 70, 460);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1500);

  // Sun
  const sunDir = new THREE.Vector3(0.55, 0.78, -0.3).normalize();
  const sun = new THREE.DirectionalLight(0xfff3df, 3.9);
  sun.position.copy(sunDir).multiplyScalar(20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 2, far: 45 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xd6e8ff, 0x6b6456, 0.6));

  // Sky dome with sun glow
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      zenith: { value: new THREE.Color("#2f74c4") }, horizon: { value: new THREE.Color("#d3e1ec") },
      ground: { value: new THREE.Color("#8a8a80") }, sunDir: { value: sunDir }, sunCol: { value: new THREE.Color("#fff6e2") },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 zenith, horizon, ground, sunDir, sunCol; varying vec3 vDir;
      void main(){ float h = vDir.y; vec3 c = mix(horizon, zenith, pow(smoothstep(0.0, 1.0, h), 0.55));
        c = mix(c, ground, smoothstep(0.0, -0.25, h));
        float d = max(dot(normalize(vDir), sunDir), 0.0);
        c += sunCol * (pow(d, 900.0) * 6.0 + pow(d, 14.0) * 0.28);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), skyMat);
  sky.renderOrder = -1;
  scene.add(sky);

  // Environment reflections from the same sky
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.6;

  // Track surface
  const texSize = small ? 1024 : 2048;
  const trackTex = canvasTex(texSize, texSize, drawTrack);
  trackTex.anisotropy = aniso;
  const ROAD_LEN = 560, ROAD_Z0 = -140;
  trackTex.repeat.set(1, ROAD_LEN / TILE);
  const trackMat = new THREE.MeshStandardMaterial({ map: trackTex, roughness: 0.88, metalness: 0 });
  const trackBlur = addMotionBlur(trackMat, "0.0, 1.0");
  const track = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, ROAD_LEN), trackMat);
  track.rotation.x = -Math.PI / 2;
  track.position.z = ROAD_Z0 + ROAD_LEN / 2;
  track.receiveShadow = true;
  scene.add(track);

  const GRASS_TILE = 32, GRASS = 1100;
  const grassTex = canvasTex(512, 512, drawGrass, { wrapS: THREE.RepeatWrapping });
  grassTex.anisotropy = aniso;
  grassTex.repeat.set(GRASS / GRASS_TILE, GRASS / GRASS_TILE);
  const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 });
  const grassBlur = addMotionBlur(grassMat, "0.0, 1.0");
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(GRASS, GRASS), grassMat);
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(0, -0.02, 200);
  scene.add(grass);

  // Walls, catch fence, posts
  const WALL_LEN = 560, WALL_TILE = 8, WALL_X = 14, WALL_H = 0.95;
  const wallTex = canvasTex(512, 64, drawWall, { wrapS: THREE.RepeatWrapping });
  wallTex.wrapS = THREE.RepeatWrapping; wallTex.anisotropy = aniso;
  wallTex.repeat.set(WALL_LEN / WALL_TILE, 1);
  const fenceTex = canvasTex(256, 128, drawFence, { wrapS: THREE.RepeatWrapping });
  fenceTex.wrapS = THREE.RepeatWrapping;
  fenceTex.repeat.set(WALL_LEN / 2, 2.6);
  const scrollers = [];
  for (const side of [-1, 1]) {
    const tex = wallTex.clone(); tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
    const blur = addMotionBlur(mat, "1.0, 0.0");
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(WALL_LEN, WALL_H), mat);
    wall.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    wall.position.set(side * WALL_X, WALL_H / 2, ROAD_Z0 + WALL_LEN / 2);
    scene.add(wall);
    scrollers.push({ tex, blur, tile: WALL_TILE, dir: side < 0 ? -1 : 1, axis: "x" });

    const ftex = fenceTex.clone(); ftex.needsUpdate = true;
    const fmat = new THREE.MeshStandardMaterial({ map: ftex, transparent: true, depthWrite: false, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
    const fblur = addMotionBlur(fmat, "1.0, 0.0");
    const fence = new THREE.Mesh(new THREE.PlaneGeometry(WALL_LEN, 3), fmat);
    fence.rotation.y = wall.rotation.y;
    fence.position.set(side * (WALL_X + 0.15), WALL_H + 1.5, wall.position.z);
    scene.add(fence);
    scrollers.push({ tex: ftex, blur: fblur, tile: 2, dir: side < 0 ? -1 : 1, axis: "x" });
  }
  const POST_GAP = 6, POST_N = 70, POST_SPAN = POST_GAP * POST_N;
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 6), new THREE.MeshStandardMaterial({ color: 0x8a939c, roughness: 0.5, metalness: 0.6 }), POST_N * 2);
  scene.add(posts);
  const m4 = new THREE.Matrix4();

  // Distant treeline (static: far enough that motion would be negligible)
  const treeTex = canvasTex(4096, 256, drawTreeline, { wrapS: THREE.RepeatWrapping });
  treeTex.wrapS = THREE.RepeatWrapping;
  treeTex.repeat.set(3, 1);
  const trees = new THREE.Mesh(
    new THREE.CylinderGeometry(620, 620, 70, 96, 1, true),
    new THREE.MeshBasicMaterial({ map: treeTex, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  trees.position.y = 14;
  trees.renderOrder = 0;
  scene.add(trees);

  // Speed streaks: thin instanced rods that stretch with speed (WebGL lines are 1px, too faint in daylight)
  const STREAKS = 160;
  const streaks = [];
  const spawnStreak = (s) => {
    s.x = rnd(-9, 9); if (Math.abs(s.x) < 1.4) s.x = Math.sign(s.x || 1) * rnd(1.4, 2.6);
    s.y = Math.random() < 0.6 ? rnd(0.04, 0.5) : rnd(0.5, 2.8);
    return s;
  };
  for (let i = 0; i < STREAKS; i++) streaks.push(Object.assign(spawnStreak({}), { z: rnd(-30, 60) }));
  const streakMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const streakMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.022, 0.022, 1), streakMat, STREAKS);
  streakMesh.frustumCulled = false;
  scene.add(streakMesh);
  const sm4 = new THREE.Matrix4(), sq = new THREE.Quaternion(), sv = new THREE.Vector3(), ss = new THREE.Vector3();

  // Car
  const car = new THREE.Group();
  scene.add(car);
  new GLTFLoader().loadAsync("/rev-site/assets/models/carrera.glb").then((gltf) => {
    const model = gltf.scene;
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => {
        const mat = m.clone();
        const n = mat.name || "";
        if (/body/i.test(n)) {
          mat.color?.set("#f3f5f8"); mat.metalness = 0.02; mat.roughness = 0.28;
          if ("clearcoat" in mat) { mat.clearcoat = 0.8; mat.clearcoatRoughness = 0.12; }
        } else if (/solar/i.test(n)) {
          mat.color?.set("#24497a"); mat.metalness = 0.15; mat.roughness = 0.22;
        } else if (/glass|window/i.test(n)) {
          mat.color?.set("#1b2530"); mat.transparent = true; mat.opacity = 0.88; mat.metalness = 0.1; mat.roughness = 0.04;
        } else if (/tire/i.test(n)) {
          mat.color?.set("#0b0d10"); mat.roughness = 0.92; mat.metalness = 0;
        } else if (/light/i.test(n)) {
          mat.color?.set("#ffffff"); if (mat.emissive) { mat.emissive.set("#fff4dc"); mat.emissiveIntensity = 2.2; }
        }
        mat.needsUpdate = true;
        return mat;
      });
      o.material = Array.isArray(o.material) ? mats : mats[0];
    });
    // The model's length runs along X with the nose (light strip) at +X. Turn it to face +Z.
    model.rotation.y = -Math.PI / 2;
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    model.position.set(-c.x, -box.min.y, -c.z);
    car.add(model);
    document.documentElement.classList.add("is-loaded");
    needsRender = true;
  }).catch((e) => {
    console.warn("Race Day: model failed to load", e);
    fail();
  });

  // Sizing
  let W = 0, H = 0;
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === W && h === H) return;
    W = w; H = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    needsRender = true;
  }

  let needsRender = true, travel = 0, camT = scrollT, time = 0;
  const look = new THREE.Vector3();

  function placeCamera(k, shake) {
    const portrait = camera.aspect < 1;
    camera.position.set(Math.sin(k.az) * k.r, k.y, Math.cos(k.az) * k.r);
    if (portrait) camera.position.multiplyScalar(1.12);
    camera.position.x += shake.x; camera.position.y += shake.y;
    look.set(k.look[0], k.look[1], k.look[2]);
    camera.lookAt(look);
    // Keep the horizontal field roughly stable on narrow screens.
    const widen = Math.pow(Math.max(1, 1.3 / camera.aspect), 0.72);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(k.fov / 2)) * widen));
    const sx = compact() ? 0 : k.sx, sy = compact() ? k.msy : 0;
    camera.setViewOffset(W, H, -sx * W, sy * H, W, H);
    camera.updateProjectionMatrix();
  }

  function setScroll(ds, blurM) {
    trackTex.offset.y = (trackTex.offset.y - ds / TILE) % 1;
    grassTex.offset.y = (grassTex.offset.y - ds / GRASS_TILE) % 1;
    trackBlur.value = blurM / TILE;
    grassBlur.value = blurM / GRASS_TILE;
    for (const s of scrollers) {
      s.tex.offset.x = (s.tex.offset.x + (s.dir * ds) / s.tile) % 1;
      s.blur.value = blurM / s.tile;
    }
  }

  function updatePosts() {
    let i = 0;
    for (const side of [-1, 1]) {
      for (let n = 0; n < POST_N; n++) {
        let z = n * POST_GAP - travel;
        z = ((z % POST_SPAN) + POST_SPAN) % POST_SPAN + ROAD_Z0 + 20;
        m4.makeTranslation(side * (WALL_X + 0.2), 2, z);
        posts.setMatrixAt(i++, m4);
      }
    }
    posts.instanceMatrix.needsUpdate = true;
  }

  function updateStreaks(ds, mps, mph) {
    const len = Math.max(0.01, mps * 0.22);
    for (let i = 0; i < STREAKS; i++) {
      const st = streaks[i];
      st.z -= ds * 1.15;
      if (st.z < -30) { spawnStreak(st); st.z += 90; }
      sv.set(st.x, st.y, st.z); ss.set(1, 1, len);
      streakMesh.setMatrixAt(i, sm4.compose(sv, sq, ss));
    }
    streakMesh.instanceMatrix.needsUpdate = true;
    // Fainter from the high crane, where they read as rain rather than rush.
    streakMat.opacity = smooth(50, 74, mph) * 0.7 * (1 - 0.7 * smooth(1.5, 7, camera.position.y));
    streakMesh.visible = streakMat.opacity > 0.01;
  }

  function frame(dt) {
    resize();
    time += dt;
    if (reduceMotion) {
      if (!needsRender) return;
      placeCamera(STATIC_KEY, { x: 0, y: 0 });
      setScroll(0, 0);
      updatePosts();
      streakMesh.visible = false;
      renderer.render(scene, camera);
      needsRender = false;
      return;
    }
    const mph = tel.speed, mps = mph * 0.44704;
    const ds = mps * dt;
    travel += ds;
    setScroll(ds, mps * (1 / 60) * 1.7);
    updatePosts();
    updateStreaks(ds, mps, mph);

    camT += (scrollT - camT) * (1 - Math.exp(-dt * 5));
    const k = camAt(camT);
    const amp = smooth(40, 76, mph);
    const shake = { x: Math.sin(time * 31) * 0.006 * amp + Math.sin(time * 17.3) * 0.004 * amp, y: Math.sin(time * 27.7) * 0.005 * amp };
    placeCamera(k, shake);
    car.position.y = Math.sin(time * 41) * 0.0025 * amp;
    sky.position.copy(camera.position);
    trees.position.x = camera.position.x; trees.position.z = camera.position.z;
    renderer.render(scene, camera);
  }

  addEventListener("resize", () => { needsRender = true; });
  return { frame };
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */
let stage = null;
try {
  const probe = document.createElement("canvas");
  if (probe.getContext("webgl2") || probe.getContext("webgl")) stage = initScene();
  else fail();
} catch (e) { fail(e); }

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (document.visibilityState === "visible") {
    updateTelemetry(dt);
    if (stage) {
      try { stage.frame(dt); } catch (e) { stage = null; fail(e); }
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
