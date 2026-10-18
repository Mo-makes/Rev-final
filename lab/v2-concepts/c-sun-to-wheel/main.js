// Concept C, "Sun to Wheel". Scroll drives time of day (dawn to noon) and the energy path.
// All copy lives in index.html; this file only draws the stage behind it.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const MODEL_URL = "/rev-site/assets/models/carrera.glb";
const root = document.documentElement;
const canvas = document.getElementById("scene");
const leadersSvg = document.querySelector(".leaders");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobile = () => window.innerWidth <= 760;

// ---------- helpers ----------
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a)); return x * x * (3 - 2 * x); };
const band = (a, b, c, d, v) => smooth(a, b, v) * (1 - smooth(c, d, v));
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent = leadersSvg) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  parent.appendChild(el);
  return el;
};
// piecewise keyframe interpolation for numbers, arrays and colours
function keyed(frames, t, ease = true) {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 0; i < frames.length - 1; i++) {
    const [t0, v0] = frames[i];
    const [t1, v1] = frames[i + 1];
    if (t <= t1) {
      let f = (t - t0) / (t1 - t0);
      if (ease) f = f * f * (3 - 2 * f);
      if (typeof v0 === "number") return lerp(v0, v1, f);
      if (v0 instanceof THREE.Color) return v0.clone().lerp(v1, f);
      return v0.map((x, j) => lerp(x, v1[j], f));
    }
  }
  return frames[frames.length - 1][1];
}
const C = (hex) => new THREE.Color(hex);

function fail(message) {
  document.body.classList.add("no-webgl");
  const status = document.querySelector(".loading");
  if (status) status.remove();
  if (message) console.warn(message);
}

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch { return false; }
}

// ---------- scroll position as a continuous beat index t (0 = drawing, 5 = noon) ----------
const sections = [...document.querySelectorAll(".beat")];
let sectionTops = [];
function measureSections() {
  sectionTops = sections.map((s) => s.getBoundingClientRect().top + window.scrollY);
}
function scrollT() {
  const y = window.scrollY;
  const last = sections.length - 1;
  for (let i = last; i >= 0; i--) {
    if (y >= sectionTops[i] - 1) {
      if (i === last) return last;
      const span = Math.max(1, sectionTops[i + 1] - sectionTops[i]);
      return Math.min(last, i + (y - sectionTops[i]) / span);
    }
  }
  return 0;
}

// ---------- page-level (non-3D) state that should work even without WebGL ----------
const sky = [
  [0.0, [C("#082544"), C("#0b2f55"), C("#0e3762")]],
  [0.85, [C("#0c2a50"), C("#4d5a8c"), C("#e9a27f")]],
  [2.0, [C("#24609f"), C("#79a6d2"), C("#f1d0a2")]],
  [3.4, [C("#4b8ccd"), C("#9ac6ea"), C("#e4eff6")]],
  [5.0, [C("#6aa8e0"), C("#b9daf3"), C("#f3f8fc")]],
];
function skyAt(t) {
  for (let i = 0; i < sky.length - 1; i++) {
    const [t0, a] = sky[i];
    const [t1, b] = sky[i + 1];
    if (t <= t1 || i === sky.length - 2) {
      const f = smooth(t0, t1, t);
      return a.map((c, j) => c.clone().lerp(b[j], f));
    }
  }
  return sky[0][1];
}
const sheetNames = ["General arrangement", "Collect", "Store", "Drive", "Optimize", "Carrera at noon"];
const tbN = document.querySelector(".tb-n");
const tbName = document.querySelector(".tb-name");
const sdDot = document.querySelector(".sundial .dot");
const sdLabel = document.querySelector(".sd-label");
const sundial = document.querySelector(".sundial");
const sparkLine = document.querySelector(".spark-line");
if (sparkLine) sparkLine.setAttribute("pathLength", "1");
let lastSheet = -1;
const annotDark = C("#0b2a4c");
const annotLight = C("#b9e6ff");

function updatePage(t) {
  const [top, mid, bot] = skyAt(t);
  root.style.setProperty("--sky-top", "#" + top.getHexString());
  root.style.setProperty("--sky-mid", "#" + mid.getHexString());
  root.style.setProperty("--sky-bot", "#" + bot.getHexString());
  root.style.setProperty("--paper-a", keyed([[0, 1], [1.2, 0.38], [3, 0.14], [5, 0.07]], t).toFixed(3));
  const dark = smooth(1.85, 2.2, t);
  root.style.setProperty("--annot", "#" + annotLight.clone().lerp(annotDark, dark).getHexString());
  root.style.setProperty("--annot-halo", dark > 0.5 ? `rgba(243,248,252,${0.85 * dark})` : `rgba(8,37,68,${0.85 * (1 - dark)})`);

  const sheet = clamp(Math.round(t), 0, 5);
  if (sheet !== lastSheet && tbN) {
    lastSheet = sheet;
    tbN.textContent = String(sheet + 1);
    tbName.textContent = sheetNames[sheet];
  }
  const theta = lerp(Math.PI, Math.PI / 2, smooth(0.15, 5, t));
  sdDot?.setAttribute("cx", (60 + 52 * Math.cos(theta)).toFixed(2));
  sdDot?.setAttribute("cy", (58 - 52 * Math.sin(theta)).toFixed(2));
  if (sundial) sundial.style.opacity = isMobile() ? (1 - smooth(4.4, 4.85, t)).toFixed(3) : "1";
  if (sdLabel) sdLabel.textContent = t < 0.3 ? "Before sunrise" : t < 1.7 ? "Dawn" : t < 4.5 ? "Morning" : "Noon";
  if (sparkLine) sparkLine.style.setProperty("--spark-off", reduceMotion ? "0" : (1 - smooth(3.8, 4.45, t)).toFixed(3));
}

measureSections();
updatePage(scrollT());
window.addEventListener("resize", measureSections);

if (!hasWebGL()) {
  fail("WebGL unavailable; showing fallback image.");
} else {
  init().catch((err) => fail(err?.message || String(err)));
}

async function init() {
  const mobile = isMobile();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;

  const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 200);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x1a2f4f, 0.4);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 0.5, far: 40 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xcfe4ff, 0.4);
  scene.add(fill);

  // ---- ground: drafting grid + shadow catcher ----
  const gridMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uColor: { value: C("#b9e6ff") }, uOpacity: { value: 0.6 }, uOffset: { value: 0 } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; uniform float uOffset; varying vec3 vW;
      float gl(vec2 p, float s){ vec2 q = p/s; vec2 g = abs(fract(q-0.5)-0.5)/fwidth(q); return 1.0-min(min(g.x,g.y),1.0); }
      void main(){ vec2 p = vW.xz + vec2(uOffset,0.0);
        float a = max(gl(p,0.25)*0.32, gl(p,1.0));
        float fade = 1.0 - smoothstep(3.5, 13.0, length(vW.xz));
        gl_FragColor = vec4(uColor, a*fade*uOpacity); }`,
  });
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), gridMat);
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = 0.002;
  grid.renderOrder = -1;
  scene.add(grid);
  const shadowMat = new THREE.ShadowMaterial({ color: 0x0a2440, opacity: 0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), shadowMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- load model ----
  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Loading the 3D model";
  document.querySelector(".stage").appendChild(status);
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL, (e) => {
    if (e.total) status.textContent = `Loading the 3D model, ${Math.round((e.loaded / e.total) * 100)}%`;
  });
  status.remove();

  const car = gltf.scene;
  scene.add(car);
  const clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -3);
  const parts = {};
  car.traverse((o) => {
    if (!o.isMesh) return;
    const n = (o.material?.name || o.name || "").toLowerCase();
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    let mat;
    if (n.includes("body")) {
      mat = new THREE.MeshPhysicalMaterial({ color: "#f1f4f8", roughness: 0.3, metalness: 0.03, clearcoat: 0.75, clearcoatRoughness: 0.18 });
      parts.body = o;
    } else if (n.includes("solar")) {
      const map = o.material.map || null;
      mat = new THREE.MeshStandardMaterial({ color: "#2a4a6e", map, roughness: 0.36, metalness: 0.1, emissive: "#ffc861", emissiveMap: map, emissiveIntensity: 0 });
      parts.solar = o;
    } else if (n.includes("glass") || n.includes("window")) {
      mat = new THREE.MeshPhysicalMaterial({ color: "#46515c", roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.82 });
      parts.glass = o;
    } else if (n.includes("tire")) {
      mat = new THREE.MeshStandardMaterial({ color: "#080b11", roughness: 0.9 });
      parts.tires = o;
    } else {
      mat = new THREE.MeshStandardMaterial({ color: "#0a0d12", emissive: "#dbe9ff", emissiveIntensity: 1.6 });
      parts.light = o;
    }
    mat.clippingPlanes = [clipPlane];
    mat.userData.baseOpacity = mat.opacity;
    o.material = mat;
    o.castShadow = !n.includes("glass");
    o.receiveShadow = n.includes("body");
  });
  const solidMats = Object.values(parts).map((p) => p.material);

  // ---- blueprint layer: feature edges + lines plan (stations, waterlines, buttocks) ----
  const lineMat = new THREE.LineBasicMaterial({ color: 0xc4ecff, transparent: true, opacity: 0.9, depthWrite: false });
  const planMat = new THREE.LineBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.5, depthWrite: false });
  const blueprint = new THREE.Group();
  scene.add(blueprint);
  const edgeAngles = { body: 32, solar: 25, glass: 30, tires: 40, light: 40 };
  for (const [key, mesh] of Object.entries(parts)) {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, edgeAngles[key] || 30), lineMat);
    blueprint.add(e);
  }
  const range = (a, b, step) => { const r = []; for (let v = a; v <= b + 1e-6; v += step) r.push(+v.toFixed(4)); return r; };
  const bodyGeo = parts.body.geometry;
  const planSegs = [
    ...sliceGeometry(bodyGeo, 0, range(-2.25, 2.25, 0.3)).flat(),
    ...sliceGeometry(bodyGeo, 1, [0.3, 0.55]).flat(),
    ...sliceGeometry(bodyGeo, 2, [-0.6, -0.3, 0, 0.3, 0.6]).flat(),
  ];
  const planGeo = new THREE.BufferGeometry();
  planGeo.setAttribute("position", new THREE.Float32BufferAttribute(planSegs, 3));
  blueprint.add(new THREE.LineSegments(planGeo, planMat));

  // gold scan contour that sweeps the body as it "solidifies"
  const scanStations = range(-2.4, 2.4, 0.05);
  const scanSlices = sliceGeometry(bodyGeo, 0, scanStations);
  const scanStarts = [];
  const scanAll = [];
  for (const s of scanSlices) { scanStarts.push(scanAll.length / 3); scanAll.push(...s); }
  const scanGeo = new THREE.BufferGeometry();
  scanGeo.setAttribute("position", new THREE.Float32BufferAttribute(scanAll, 3));
  const scanMat = new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, depthTest: false, blending: THREE.AdditiveBlending });
  const scan = new THREE.LineSegments(scanGeo, scanMat);
  scan.renderOrder = 12;
  scene.add(scan);

  // ---- fresnel shell: cyan glow at dawn, x-ray at Drive ----
  const shellMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: C("#8fd8ff") }, uOpacity: { value: 0.5 }, uPower: { value: 2.4 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; uniform float uPower; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(1.0-abs(dot(normalize(vN),normalize(vV))), uPower); gl_FragColor = vec4(uColor, (f*0.9+0.03)*uOpacity); }`,
  });
  const shell = new THREE.Mesh(bodyGeo, shellMat);
  shell.renderOrder = 4;
  scene.add(shell);

  // ---- energy path ----
  const GOLD = C("#f2c15b");
  const pathPts = [
    [1.25, 0.88, 0.05], [0.65, 0.88, 0.1], [0.2, 0.66, 0.12], [-0.12, 0.42, 0.1], [-0.3, 0.29, 0.02],
    [-0.7, 0.29, 0.2], [-1.12, 0.31, 0.5], [-1.385, 0.313, 0.7],
  ].map((p) => new THREE.Vector3(...p));
  const curve = new THREE.CatmullRomCurve3(pathPts, false, "centripetal");
  // arc-length fraction where the path reaches the battery
  let uBattery = 0.5;
  { let best = 1e9; for (let i = 0; i <= 400; i++) { const d = curve.getPointAt(i / 400).distanceTo(pathPts[4]); if (d < best) { best = d; uBattery = i / 400; } } }
  const pulseMat = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uHead: { value: 0 }, uOpacity: { value: 0 }, uTime: { value: 0 }, uColor: { value: GOLD } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform float uHead; uniform float uOpacity; uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main(){ float u = vUv.x; float behind = 1.0 - step(uHead, u);
        float trail = smoothstep(uHead-0.2, uHead, u) * (1.0 - step(uHead+0.004, u));
        float flow = behind * (0.5 + 0.5*sin(u*70.0 - uTime*7.0));
        float a = clamp(trail*1.1 + behind*0.45 + flow*0.3, 0.0, 1.0) * uOpacity;
        vec3 col = mix(uColor, vec3(1.0,0.97,0.88), trail*0.6);
        gl_FragColor = vec4(col, a); }`,
  });
  const pulse = new THREE.Mesh(new THREE.TubeGeometry(curve, 240, mobile ? 0.03 : 0.024, 8, false), pulseMat);
  pulse.renderOrder = 10;
  scene.add(pulse);

  const glowTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d"); const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,250,230,1)"); r.addColorStop(0.18, "rgba(255,214,130,0.85)"); r.addColorStop(0.5, "rgba(242,193,91,0.25)"); r.addColorStop(1, "rgba(242,193,91,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
  })();
  const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  head.renderOrder = 11;
  head.scale.setScalar(0.42);
  scene.add(head);

  // battery block (position illustrative), drawn as x-ray modules
  const battery = new THREE.Group();
  const modules = [];
  const NX = 6, NZ = 4, bx0 = -0.75, bx1 = 0.15, bz0 = -0.32, bz1 = 0.32, by0 = 0.19, by1 = 0.35;
  const mdx = (bx1 - bx0) / NX, mdz = (bz1 - bz0) / NZ;
  const moduleGeo = new THREE.BoxGeometry(mdx * 0.86, by1 - by0, mdz * 0.86);
  const moduleEdges = new THREE.EdgesGeometry(moduleGeo);
  const batEdgeMat = new THREE.LineBasicMaterial({ color: 0xe0a53a, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
    const fillMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    const m = new THREE.Mesh(moduleGeo, fillMat);
    m.position.set(bx0 + mdx * (i + 0.5), (by0 + by1) / 2, bz0 + mdz * (k + 0.5));
    m.renderOrder = 6;
    const e = new THREE.LineSegments(moduleEdges, batEdgeMat);
    e.position.copy(m.position);
    e.renderOrder = 7;
    battery.add(m, e);
    modules.push({ m, order: (NX - 1 - i) * NZ + k });
  }
  scene.add(battery);

  // hub motor in the rear wheel (near side), x-ray rings
  const motor = new THREE.Group();
  motor.position.set(-1.385, 0.313, 0.72);
  const motorMat = new THREE.MeshBasicMaterial({ color: C("#eaa93a"), transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  motor.add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.011, 8, 64), motorMat));
  motor.add(new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.008, 8, 48), motorMat));
  const spokes = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.008, 0.004), motorMat);
    const a = (i / 6) * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0);
    s.rotation.z = a;
    spokes.add(s);
  }
  motor.add(spokes);
  motor.children.forEach((c) => (c.renderOrder = 9));
  scene.add(motor);

  // sun rays falling onto the array
  const RAYS = mobile ? 26 : 44;
  const rayStarts = [];
  {
    const pos = parts.solar.geometry.attributes.position;
    const nor = parts.solar.geometry.attributes.normal;
    let guard = 0;
    while (rayStarts.length < RAYS && guard++ < 20000) {
      const i = Math.floor(Math.random() * pos.count);
      if (nor.getY(i) > 0.85 && pos.getX(i) > -1.9 && pos.getX(i) < 2.1) rayStarts.push(new THREE.Vector3(pos.getX(i), pos.getY(i) + 0.01, pos.getZ(i)));
    }
  }
  const rayPos = new Float32Array(rayStarts.length * 6);
  const rayT = new Float32Array(rayStarts.length * 2);
  const rayP = new Float32Array(rayStarts.length * 2);
  rayStarts.forEach((_, i) => { rayT[i * 2] = 0; rayT[i * 2 + 1] = 1; rayP[i * 2] = rayP[i * 2 + 1] = Math.random(); });
  const rayGeo = new THREE.BufferGeometry();
  rayGeo.setAttribute("position", new THREE.BufferAttribute(rayPos, 3));
  rayGeo.setAttribute("aT", new THREE.BufferAttribute(rayT, 1));
  rayGeo.setAttribute("aP", new THREE.BufferAttribute(rayP, 1));
  const rayMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: C("#ffd98a") } },
    vertexShader: `attribute float aT; attribute float aP; varying float vT; varying float vP; void main(){ vT = aT; vP = aP; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime; uniform float uOpacity; uniform vec3 uColor; varying float vT; varying float vP;
      void main(){ float d = fract(vT*2.2 + uTime*0.9 + vP); float dash = smoothstep(0.0,0.12,d)*(1.0-smoothstep(0.12,0.45,d));
        gl_FragColor = vec4(uColor, dash*(1.0-vT)*uOpacity); }`,
  });
  const rays = new THREE.LineSegments(rayGeo, rayMat);
  rays.renderOrder = 8;
  scene.add(rays);

  // ---------- keyframes ----------
  // camera: azimuth around Y from +Z (canopy side), elevation, distance, target, fov, screen shift, world width to fit
  const camKeys = () => {
    const m = isMobile();
    return [
      { t: 0.0, az: 0.0, el: 0.035, dist: 11.5, tgt: [0, 1.15, 0], fov: 24, sx: m ? 0 : 0.05, sy: m ? -0.17 : 0.035, fit: m ? 6.4 : 6.6 },
      { t: 1.3, az: 0.62, el: 0.62, dist: 8.8, tgt: [0.1, 0.5, 0], fov: 30, sx: m ? 0 : 0.17, sy: m ? 0.17 : 0, fit: m ? 5.0 : 5.4 },
      { t: 2.3, az: 0.42, el: 0.3, dist: 6.8, tgt: [-0.3, 0.45, 0], fov: 30, sx: m ? 0 : 0.17, sy: m ? 0.17 : 0, fit: m ? 4.2 : 4.4 },
      { t: 3.3, az: -0.62, el: 0.14, dist: 5.8, tgt: [-0.95, 0.42, 0.25], fov: 32, sx: m ? 0 : 0.17, sy: m ? 0.17 : 0, fit: m ? 3.6 : 3.8 },
      { t: 4.3, az: 1.12, el: 0.34, dist: 9.0, tgt: [0, 0.6, 0], fov: 28, sx: m ? 0 : 0.17, sy: m ? 0.17 : 0, fit: m ? 5.0 : 5.4 },
      { t: 5.0, az: 0.8, el: 0.1, dist: 9.4, tgt: [0, 0.95, 0], fov: 26, sx: m ? 0 : -0.04, sy: m ? -0.2 : -0.12, fit: m ? 5.4 : 6.2 },
    ];
  };
  let keys = camKeys();
  const HOLD = 0.22;
  function camAt(t) {
    let a = keys[0], b = keys[0], f = 0;
    if (t >= keys[keys.length - 1].t) { a = b = keys[keys.length - 1]; }
    else for (let i = 0; i < keys.length - 1; i++) {
      if (t <= keys[i + 1].t) {
        a = keys[i]; b = keys[i + 1];
        const s0 = a.t + (i === 0 ? 0 : HOLD);
        const s1 = b.t - (i + 1 === keys.length - 1 ? 0 : HOLD);
        f = smooth(s0, s1, t);
        break;
      }
    }
    const L = (k) => lerp(a[k], b[k], f);
    return { az: L("az"), el: L("el"), dist: L("dist"), fov: L("fov"), sx: L("sx"), sy: L("sy"), fit: L("fit"), tgt: a.tgt.map((v, j) => lerp(v, b.tgt[j], f)) };
  }
  const sunDirKeys = [
    [0.0, [-0.85, -0.04, -0.5]], [0.5, [-0.82, 0.1, -0.55]], [1.3, [-0.62, 0.36, -0.58]], [2.3, [-0.38, 0.62, -0.5]],
    [3.3, [-0.12, 0.8, -0.32]], [4.3, [0.12, 0.9, -0.12]], [5.0, [0.32, 0.92, 0.16]],
  ];
  const sunColKeys = [[0, C("#ff8a4c")], [0.9, C("#ffb07a")], [2.0, C("#ffe1bb")], [3.4, C("#fff6ea")], [5, C("#ffffff")]];

  // ---------- resize ----------
  let W = 0, H = 0;
  const labelSize = new Map();
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (w === W && h === H) return;
    const crossed = isMobile() !== (W <= 760);
    W = w; H = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (crossed || true) keys = camKeys();
    measureSections();
    calloutEls.forEach((c) => labelSize.set(c.el, [c.el.offsetWidth, c.el.offsetHeight]));
    dims.forEach((d) => labelSize.set(d, [d.offsetWidth, d.offsetHeight]));
  }

  // ---------- annotations ----------
  const calloutEls = [...document.querySelectorAll(".callout")].map((el) => {
    const [x, y, z] = el.dataset.anchor.split(",").map(Number);
    const [dx, dy] = el.dataset.off.split(",").map(Number);
    const [a, b] = el.dataset.beat.split(",").map(Number);
    const g = svgEl("g");
    return { el, p: new THREE.Vector3(x, y, z), dx, dy, a, b, path: svgEl("path", {}, g), dot: svgEl("circle", { r: 2.5 }, g), g };
  });
  const dims = [...document.querySelectorAll(".dimension span")];
  const dimG = svgEl("g", { class: "dim" });
  const dimParts = {
    l1: svgEl("line", { class: "dimline" }, dimG), l2: svgEl("line", { class: "dimline" }, dimG),
    e1: svgEl("line", {}, dimG), e2: svgEl("line", {}, dimG),
    a1: svgEl("path", { class: "arrow" }, dimG), a2: svgEl("path", { class: "arrow" }, dimG),
    w1: svgEl("line", {}, dimG), w2: svgEl("line", {}, dimG),
    c1: svgEl("path", {}, dimG), c2: svgEl("path", {}, dimG),
  };
  const v = new THREE.Vector3();
  const toScreen = (p) => { v.copy(p).project(camera); return [(v.x + 1) * 0.5 * W, (1 - v.y) * 0.5 * H, v.z]; };
  const P = (x, y, z) => new THREE.Vector3(x, y, z);
  const dimPts = { a: P(-2.41, 0, 0.93), b: P(2.404, 0, 0.93), fa: P(0.383, 0, 0.7), ra: P(-1.385, 0, 0.7) };
  const setLine = (el, x1, y1, x2, y2) => { el.setAttribute("x1", x1.toFixed(1)); el.setAttribute("y1", y1.toFixed(1)); el.setAttribute("x2", x2.toFixed(1)); el.setAttribute("y2", y2.toFixed(1)); };
  const place = (el, x, y, o) => { el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`; el.style.opacity = o.toFixed(3); };

  function updateAnnotations(t, ready) {
    const m = isMobile();
    const k = m ? 0.62 : 1;
    for (const c of calloutEls) {
      if (m && c.el.classList.contains("desk")) { c.g.setAttribute("opacity", "0"); continue; }
      const fade = c.a < 0 ? 1 - smooth(c.b - 0.15, c.b, t) : band(c.a - 0.15, c.a, c.b - 0.15, c.b, t);
      const o = ready ? fade : 0;
      if (o < 0.01) { c.el.style.opacity = "0"; c.g.setAttribute("opacity", "0"); continue; }
      const [ax, ay, az] = toScreen(c.p);
      if (az > 1) { c.el.style.opacity = "0"; c.g.setAttribute("opacity", "0"); continue; }
      const [lw, lh] = labelSize.get(c.el) || [120, 20];
      const sy = ay + c.dy * k;
      let lx = c.dx >= 0 ? ax + c.dx * k : ax + c.dx * k - lw;
      lx = clamp(lx, 14, W - 14 - lw);
      const shoulder = c.dx >= 0 ? lx : lx + lw;
      place(c.el, lx, sy - lh, o);
      c.path.setAttribute("d", `M${ax.toFixed(1)} ${ay.toFixed(1)} L${shoulder.toFixed(1)} ${sy.toFixed(1)}`);
      c.dot.setAttribute("cx", ax.toFixed(1)); c.dot.setAttribute("cy", ay.toFixed(1));
      c.g.setAttribute("opacity", o.toFixed(3));
    }
    // overall length dimension + axle load split (hero only)
    const dO = ready ? 1 - smooth(0.22, 0.5, t) : 0;
    dimG.setAttribute("opacity", dO.toFixed(3));
    if (dO < 0.01) { dims.forEach((d) => (d.style.opacity = "0")); return; }
    const [x1, y1] = toScreen(dimPts.a), [x2, y2] = toScreen(dimPts.b);
    const [fx] = toScreen(dimPts.fa), [rx] = toScreen(dimPts.ra);
    const yD = Math.max(y1, y2) + (m ? 26 : 38);
    setLine(dimParts.e1, x1, y1 + 6, x1, yD + 8);
    setLine(dimParts.e2, x2, y2 + 6, x2, yD + 8);
    const [tw, th] = labelSize.get(dims[0]) || [150, 20];
    const mid = (x1 + x2) / 2;
    setLine(dimParts.l1, x1, yD, mid - tw / 2 - 6, yD);
    setLine(dimParts.l2, mid + tw / 2 + 6, yD, x2, yD);
    const ah = 9, aw = 3.2;
    dimParts.a1.setAttribute("d", `M${x1} ${yD} l${ah} ${-aw} l0 ${aw * 2} z`);
    dimParts.a2.setAttribute("d", `M${x2} ${yD} l${-ah} ${-aw} l0 ${aw * 2} z`);
    place(dims[0], mid - tw / 2, yD - th / 2, dO);
    // axle marks
    const yW = yD + (m ? 24 : 30);
    setLine(dimParts.w1, fx, yD + 4, fx, yW);
    setLine(dimParts.w2, rx, yD + 4, rx, yW);
    dimParts.c1.setAttribute("d", `M${fx - 4} ${yD - 4} l8 8 M${fx + 4} ${yD - 4} l-8 8`);
    dimParts.c2.setAttribute("d", `M${rx - 4} ${yD - 4} l8 8 M${rx + 4} ${yD - 4} l-8 8`);
    const [fw] = labelSize.get(dims[1]) || [60, 18];
    const [rw] = labelSize.get(dims[2]) || [60, 18];
    place(dims[1], fx - fw / 2, yW + 2, dO);
    place(dims[2], rx - rw / 2, yW + 2, dO);
  }

  // ---------- per-frame scene state ----------
  const sunDir = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let wasTransparent = false;
  function applyState(t, time) {
    // camera
    const k = reduceMotion ? { ...camAt(4.3), ...(isMobile() ? {} : {}) } : camAt(t);
    const aspect = W / H;
    const fitDist = k.fit / (2 * Math.tan(THREE.MathUtils.degToRad(k.fov / 2)) * aspect);
    const d = Math.max(k.dist, fitDist);
    const tg = tmp.set(...k.tgt);
    camera.fov = k.fov;
    camera.position.set(tg.x + Math.sin(k.az) * Math.cos(k.el) * d, tg.y + Math.sin(k.el) * d, tg.z + Math.cos(k.az) * Math.cos(k.el) * d);
    camera.lookAt(tg);
    camera.setViewOffset(W, H, -k.sx * W, k.sy * H, W, H);
    camera.updateProjectionMatrix();

    // sun
    sunDir.set(...keyed(sunDirKeys, t)).normalize();
    sun.position.copy(sunDir).multiplyScalar(14);
    sun.target.position.set(0, 0, 0);
    sun.color.copy(keyed(sunColKeys, t));
    sun.intensity = keyed([[0, 0], [0.5, 0.9], [1.3, 2.2], [2.5, 3.2], [5, 3.8]], t);
    hemi.intensity = keyed([[0, 0.35], [1.2, 0.9], [3, 1.4], [5, 1.7]], t);
    hemi.color.copy(keyed([[0, C("#7fa6e0")], [1.2, C("#c8b6d6")], [3, C("#dbeaff")], [5, C("#ffffff")]], t));
    scene.environmentIntensity = keyed([[0, 0.15], [2, 0.45], [5, 0.75]], t);
    fill.position.copy(camera.position).add(tmp.set(0, 3, 0));
    fill.intensity = keyed([[0, 0.2], [5, 0.55]], t);
    shadowMat.opacity = keyed([[0.3, 0], [1.0, 0.42], [3, 0.38], [5, 0.32]], t);

    // CSS sun disc follows the light
    v.copy(sunDir).multiplyScalar(80).add(camera.position).project(camera);
    root.style.setProperty("--sun-x", ((v.x + 1) * 50).toFixed(2) + "vw");
    root.style.setProperty("--sun-y", ((1 - v.y) * 50).toFixed(2) + "vh");
    root.style.setProperty("--sun-a", (v.z < 1 ? smooth(0.15, 0.6, t) : 0).toFixed(3));

    // solidify: clip plane sweeps from nose to tail
    const sweep = reduceMotion ? 1 : smooth(0.28, 1.2, t);
    const sx = lerp(2.55, -2.55, sweep);
    clipPlane.constant = -sx;
    const scanIdx = clamp(Math.round((sx - scanStations[0]) / 0.05), 0, scanStations.length - 1);
    const s0 = scanStarts[scanIdx];
    const s1 = scanIdx + 1 < scanStarts.length ? scanStarts[scanIdx + 1] : scanAll.length / 3;
    scanGeo.setDrawRange(s0, s1 - s0);
    scanMat.opacity = sweep > 0.002 && sweep < 0.998 ? 0.95 : 0;

    // x-ray: partial in Store, full in Drive
    const xr = reduceMotion ? (Math.round(t) === 3 ? 1 : Math.round(t) === 2 ? 0.4 : 0) : Math.max(0.4 * band(1.6, 1.95, 2.55, 2.75, t), band(2.55, 2.95, 3.75, 4.15, t));
    const transparent = xr > 0.002;
    if (transparent !== wasTransparent) {
      wasTransparent = transparent;
      for (const mat of solidMats) { if (mat !== parts.glass.material) { mat.transparent = transparent; mat.needsUpdate = true; } }
    }
    parts.body.material.opacity = 1 - 0.9 * xr;
    parts.solar.material.opacity = 1 - 0.7 * xr;
    parts.tires.material.opacity = 1 - 0.55 * xr;
    parts.glass.material.opacity = 0.82 * (1 - 0.7 * xr);
    if (parts.light) parts.light.material.opacity = 1 - 0.5 * xr;
    parts.body.castShadow = xr < 0.5;

    // blueprint layers
    const draft = reduceMotion ? 0 : 1 - smooth(0.32, 1.45, t);
    lineMat.opacity = 0.92 * draft + 0.42 * xr;
    planMat.opacity = 0.5 * draft + 0.16 * xr;
    blueprint.visible = lineMat.opacity > 0.005;
    shellMat.uniforms.uOpacity.value = 0.55 * draft + 0.9 * xr;
    shellMat.uniforms.uColor.value.copy(C("#8fd8ff")).lerp(C("#cdeeff"), xr);
    shell.visible = shellMat.uniforms.uOpacity.value > 0.005;
    gridMat.uniforms.uOpacity.value = keyed([[0, 0.75], [1.3, 0.38], [3, 0.24], [5, 0.12]], t);
    gridMat.uniforms.uColor.value.copy(C("#b9e6ff")).lerp(C("#2a5d8f"), smooth(2.4, 3.6, t));

    // collect: cells glow, rays fall
    const collect = reduceMotion ? (Math.round(t) === 1 ? 1 : 0) : band(0.55, 1.05, 1.75, 2.2, t);
    parts.solar.material.emissiveIntensity = collect * (0.55 + 0.12 * Math.sin(time * 2.2)) + 0.04;
    rayMat.uniforms.uOpacity.value = collect * 0.9;
    rayMat.uniforms.uTime.value = time;
    rays.visible = collect > 0.01;
    if (rays.visible) {
      rayStarts.forEach((s, i) => {
        rayPos.set([s.x, s.y, s.z, s.x + sunDir.x * 3.2, s.y + sunDir.y * 3.2, s.z + sunDir.z * 3.2], i * 6);
      });
      rayGeo.attributes.position.needsUpdate = true;
    }

    // store + drive: pulse travels array -> battery -> rear wheel
    const h = reduceMotion
      ? (Math.round(t) === 2 ? uBattery : Math.round(t) >= 3 ? 1 : 0)
      : smooth(1.35, 2.25, t) * uBattery + smooth(2.65, 3.25, t) * (1 - uBattery);
    const pulseO = reduceMotion ? (Math.round(t) === 2 || Math.round(t) === 3 ? 1 : 0) : band(1.3, 1.5, 3.85, 4.3, t);
    pulseMat.uniforms.uHead.value = h;
    pulseMat.uniforms.uOpacity.value = pulseO;
    pulseMat.uniforms.uTime.value = reduceMotion ? 0 : time;
    pulse.visible = pulseO > 0.01;
    head.material.opacity = pulseO * (h < 0.995 ? 1 : 0.4);
    head.position.copy(curve.getPointAt(clamp(h, 0, 1)));
    head.visible = pulse.visible;

    const batO = reduceMotion ? (Math.round(t) === 2 || Math.round(t) === 3 ? 1 : 0) : band(1.55, 1.85, 3.8, 4.25, t);
    const charge = reduceMotion ? 1 : smooth(uBattery - 0.08, uBattery, h) * smooth(1.9, 2.5, t) + (t > 2.5 ? 1 : 0) * (1 - smooth(1.9, 2.5, t));
    battery.visible = batO > 0.01;
    batEdgeMat.opacity = batO * 0.9;
    for (const mod of modules) {
      const lit = mod.order / modules.length < charge ? 1 : 0;
      mod.m.material.opacity = batO * (0.04 + 0.2 * lit);
    }

    const motorO = reduceMotion ? (Math.round(t) === 3 ? 1 : 0) : band(2.55, 2.85, 3.85, 4.3, t);
    motor.visible = motorO > 0.01;
    motorMat.opacity = motorO * (0.45 + 0.55 * smooth(0.95, 1, h));
    if (!reduceMotion) spokes.rotation.z = -time * 3.2 * smooth(0.97, 1, h);

    // drive: the drafting grid slides under the car to suggest motion (wheels are not separable yet)
    const driving = reduceMotion ? 0 : band(2.9, 3.2, 3.7, 4.0, t) * smooth(0.97, 1, h);
    gridMat.uniforms.uOffset.value += driving * 0.035;
  }

  // ---------- loop ----------
  let target = scrollT();
  let current = target;
  let last = performance.now();
  let time = 0;
  const onScroll = () => { target = scrollT(); };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => { measureSections(); onScroll(); });
  resize();
  document.body.classList.add("is-ready");

  function frame(now) {
    const raw = Math.max(0, (now - last) / 1000);
    const dt = Math.min(0.05, raw);
    last = now;
    time += dt;
    resize();
    current = reduceMotion ? target : current + (target - current) * Math.min(1, Math.min(0.25, raw) * 7);
    if (Math.abs(target - current) < 0.0005) current = target;
    updatePage(current);
    applyState(current, time);
    renderer.render(scene, camera);
    updateAnnotations(current, true);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__rev = { get t() { return current; }, renderer, scene, camera };
}

// Cut a mesh with axis-aligned planes; returns one flat [x,y,z,...] segment list per plane value.
function sliceGeometry(geo, axis, values) {
  const pos = geo.attributes.position.array;
  const idx = geo.index ? geo.index.array : null;
  const tris = idx ? idx.length / 3 : pos.length / 9;
  const out = values.map(() => []);
  const p = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t < tris; t++) {
    for (let j = 0; j < 3; j++) {
      const vi = idx ? idx[t * 3 + j] : t * 3 + j;
      p[j][0] = pos[vi * 3]; p[j][1] = pos[vi * 3 + 1]; p[j][2] = pos[vi * 3 + 2];
    }
    const a0 = p[0][axis], a1 = p[1][axis], a2 = p[2][axis];
    const mn = Math.min(a0, a1, a2), mx = Math.max(a0, a1, a2);
    for (let s = 0; s < values.length; s++) {
      const val = values[s];
      if (val < mn || val > mx) continue;
      const hits = [];
      for (let e = 0; e < 3; e++) {
        const A = p[e], B = p[(e + 1) % 3];
        const da = A[axis] - val, db = B[axis] - val;
        if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
          const f = da / (da - db);
          hits.push(A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f);
        }
      }
      if (hits.length === 6) out[s].push(...hits);
    }
  }
  return out;
}
