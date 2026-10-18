// Concept A, Night Studio: Carrera on a dark glossy floor under a softbox rig,
// revealed by a moving strip light, then walked around by a scroll-scrubbed camera.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";

const MODEL_URL = "/rev-site/assets/models/carrera.glb";
const root = document.documentElement;
const stage = document.querySelector(".stage");
const canvas = stage.querySelector(".stage-canvas");
const loaderBar = stage.querySelector(".stage-loader");
const callout = stage.querySelector(".callout");
const beats = [...document.querySelectorAll(".beat")];
const viewLinks = [...document.querySelectorAll(".views a")];
const story = document.querySelector(".story");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const compactQuery = window.matchMedia("(max-width: 760px)");

const revealText = () => {
  clearTimeout(window.__revIntroTimer);
  root.classList.remove("intro-pending");
  root.classList.add("intro-done");
};
const fail = (err) => {
  if (err) console.warn("[studio] falling back to still image:", err);
  stage.classList.add("has-error");
  revealText();
};

// ---------- Renderer ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
} catch (err) {
  fail(err);
}

if (renderer) start().catch(fail);

async function start() {
  const compact = () => compactQuery.matches;
  const dprCap = () => Math.min(window.devicePixelRatio || 1, compact() ? 1.25 : 1.5);
  renderer.setPixelRatio(dprCap());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  RectAreaLightUniformsLib.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);

  // ---------- Studio environment: RoomEnvironment, darkened, plus light strips ----------
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  room.traverse((o) => {
    if (o.isMesh && o.material.isMeshStandardMaterial) o.material.color.setScalar(0.015);
    else if (o.isMesh && o.material.isMeshBasicMaterial) o.material.color.multiplyScalar(0.22);
    if (o.isPointLight) o.intensity = 60;
  });
  const envBox = new THREE.BoxGeometry();
  const envStrip = (intensity, pos, scale) => {
    const m = new THREE.Mesh(envBox, new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(intensity) }));
    m.position.set(...pos);
    m.scale.set(...scale);
    room.add(m);
  };
  envStrip(36, [0, 15, -2.6], [22, 0.1, 0.7]); // twin overhead strips
  envStrip(36, [0, 15, 2.6], [22, 0.1, 0.7]);
  envStrip(70, [0, 2.6, 13], [26, 0.18, 0.1]); // long flank strips for the profile highlight
  envStrip(40, [0, 2.6, -13], [26, 0.18, 0.1]);
  envStrip(18, [13.5, 4, 0], [0.1, 0.5, 9]); // nose and tail kickers
  envStrip(12, [-13.5, 4, 0], [0.1, 0.5, 9]);
  scene.environment = pmrem.fromScene(room, 0.035).texture;
  scene.environmentIntensity = reduceMotion ? 1 : 0;
  room.dispose();

  // ---------- Light sweep (shared by body materials) ----------
  const sweep = { uSweepX: { value: 99 }, uSweepAmt: { value: 0 } };
  const addSweep = (material) => {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uSweepX = sweep.uSweepX;
      shader.uniforms.uSweepAmt = sweep.uSweepAmt;
      shader.vertexShader = "varying vec3 vSweepPos;\n" + shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  vSweepPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
      shader.fragmentShader = "uniform float uSweepX;\nuniform float uSweepAmt;\nvarying vec3 vSweepPos;\n" + shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          float dx = vSweepPos.x - uSweepX;
          float band = exp(-dx * dx / 0.035) + 0.35 * exp(-dx * dx / 0.6);
          vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float up = clamp(dot(normal, upView), 0.0, 1.0);
          totalEmissiveRadiance += vec3(0.95, 0.97, 1.0) * band * uSweepAmt * (0.06 + 1.6 * pow(up, 2.5));
        }`,
      );
    };
    material.customProgramCacheKey = () => "rev-sweep";
  };

  // ---------- Lights ----------
  const softbox = new THREE.RectAreaLight(0xffffff, reduceMotion ? 5 : 0, 6.5, 1.6);
  softbox.position.set(0, 3.4, 0);
  softbox.rotation.x = -Math.PI / 2;
  scene.add(softbox);

  const sweepLight = new THREE.RectAreaLight(0xffffff, 0, 0.45, 3.6);
  sweepLight.position.set(6, 2.3, 0);
  sweepLight.rotation.x = -Math.PI / 2;
  scene.add(sweepLight);

  const rim = new THREE.DirectionalLight(0xdfe8ff, reduceMotion ? 0.6 : 0);
  rim.position.set(-6, 3, -6);
  scene.add(rim);

  // ---------- Visible rig (two softbox tubes) and the sweep bar ----------
  const rig = new THREE.Group();
  const tubeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: reduceMotion ? 1 : 0, toneMapped: false });
  for (const z of [-0.62, 0.62]) {
    const tube = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.025, 0.09), tubeMat);
    tube.position.set(0, 3.4, z);
    rig.add(tube);
  }
  // The rig is only seen as its reflection in the floor, never cropped at the frame edge.
  rig.traverse((o) => o.layers.set(1));
  scene.add(rig);

  const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 3.6), barMat);
  bar.position.set(6, 2.3, 0);
  scene.add(bar);

  // ---------- Glossy floor: Reflector with a blurred, faded, darkened shader ----------
  const FloorShader = {
    name: "StudioFloor",
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uStrength: { value: 0.2 },
      uGlow: { value: reduceMotion ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      uniform mat4 textureMatrix;
      varying vec4 vUv;
      varying vec2 vLocal;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vUv = textureMatrix * vec4(position, 1.0);
        vLocal = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform sampler2D tDiffuse;
      uniform vec2 uTexel;
      uniform float uStrength;
      uniform float uGlow;
      varying vec4 vUv;
      varying vec2 vLocal;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 uv = vUv.xy / vUv.w;
        float d = length(vLocal);
        float spread = 1.6 + 1.1 * d;
        vec3 acc = vec3(0.0);
        float total = 0.0;
        for (int i = -2; i <= 2; i++) {
          for (int j = -2; j <= 2; j++) {
            vec2 o = vec2(float(i), float(j));
            float w = exp(-dot(o, o) / 3.0);
            acc += texture2D(tDiffuse, uv + o * uTexel * spread).rgb * w;
            total += w;
          }
        }
        vec3 refl = acc / total;
        float fade = 1.0 - smoothstep(0.8, 7.0, d);
        float glow = exp(-pow(d / 4.2, 2.0)) * 0.018 * uGlow;
        float footprint = length(vec2(vLocal.x / 2.55, vLocal.y / 1.0));
        float contact = smoothstep(0.62, 1.18, footprint);
        vec3 col = color + vec3(glow) * mix(0.08, 1.0, contact) + refl * uStrength * fade * mix(0.55, 1.0, contact);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  };
  const floor = new Reflector(new THREE.PlaneGeometry(60, 60), {
    shader: FloorShader,
    color: 0x000000,
    textureWidth: 512,
    textureHeight: 512,
    multisample: compact() ? 0 : 4,
  });
  floor.rotation.x = -Math.PI / 2;
  floor.camera.layers.enable(1);
  scene.add(floor);

  // ---------- Model ----------
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(
      MODEL_URL,
      resolve,
      (e) => {
        if (e.total) loaderBar.style.setProperty("--p", (e.loaded / e.total).toFixed(3));
      },
      reject,
    );
  });
  const car = gltf.scene;
  let lightStripMat = null;
  car.traverse((child) => {
    if (!child.isMesh) return;
    const src = child.material;
    const name = src.name || "";
    let mat;
    if (/body/i.test(name)) {
      mat = new THREE.MeshPhysicalMaterial({
        name, color: 0xd4d7dc, roughness: 0.34, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
      });
      addSweep(mat);
    } else if (/solar/i.test(name)) {
      mat = new THREE.MeshPhysicalMaterial({
        name, map: src.map, color: 0x1a2a3e, roughness: 0.32, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.02,
      });
      addSweep(mat);
    } else if (/glass|window/i.test(name)) {
      mat = new THREE.MeshPhysicalMaterial({ name, color: 0x040506, roughness: 0.04, metalness: 0.1, clearcoat: 1 });
    } else if (/tire/i.test(name)) {
      mat = new THREE.MeshStandardMaterial({ name, color: 0x070708, roughness: 0.82, metalness: 0 });
    } else if (/light/i.test(name)) {
      mat = new THREE.MeshStandardMaterial({ name, color: 0x050608, emissive: 0xdde8ff, emissiveIntensity: reduceMotion ? 2.2 : 0 });
      lightStripMat = mat;
    } else {
      mat = src;
    }
    child.material = mat;
  });
  const box = new THREE.Box3().setFromObject(car);
  const center = box.getCenter(new THREE.Vector3());
  car.position.set(-center.x, -box.min.y, -center.z);
  scene.add(car);

  // ---------- Camera path ----------
  // Front of the car is +X (light strip). Beats: front 3/4, top, side profile, rear 3/4.
  const desktopKeys = [
    { pos: [7.3, 1.75, 5.8], tgt: [0.15, 0.5, 0], fov: 28, sx: 0, sy: 0.17, up: [0, 1, 0] },
    { pos: [0.6, 12.0, 4.8], tgt: [0.1, 0.4, 0], fov: 30, sx: -0.14, sy: 0, up: [0, 1, 0] },
    { pos: [0.1, 0.55, 11.5], tgt: [0.1, 0.62, 0], fov: 24, sx: 0, sy: 0.02, up: [0, 1, 0] },
    { pos: [-9.6, 1.6, 7.7], tgt: [-0.2, 0.5, 0], fov: 28, sx: 0.2, sy: 0.04, up: [0, 1, 0] },
  ];
  const compactKeys = [
    { pos: [12.6, 3.0, 12.2], tgt: [0.1, 0.5, 0], fov: 34, sx: 0, sy: 0.08, up: [0, 1, 0] },
    { pos: [0.5, 16.5, 5.2], tgt: [0.2, 0.4, 0], fov: 34, sx: 0, sy: 0.2, up: [1, 0, 0] },
    { pos: [0.1, 1.0, 25], tgt: [0.1, 0.62, 0], fov: 26, sx: 0, sy: 0.2, up: [0, 1, 0] },
    { pos: [-12.2, 2.2, 10.0], tgt: [-0.2, 0.55, 0], fov: 34, sx: 0, sy: 0.2, up: [0, 1, 0] },
  ];
  const v3 = (a) => new THREE.Vector3(...a);
  let keys, curve;
  const buildPath = () => {
    const src = compact() ? compactKeys : desktopKeys;
    // Wider than the reference aspect: pull back so the 4.8 m car still fits.
    const aspect = window.innerWidth / window.innerHeight;
    const ref = compact() ? 0.5 : 1.55;
    const pull = Math.max(1, Math.pow(ref / aspect, 0.85));
    keys = src.map((k) => {
      const tgt = v3(k.tgt);
      return { ...k, tgt, pos: v3(k.pos).sub(tgt).multiplyScalar(pull).add(tgt), up: v3(k.up) };
    });
    curve = new THREE.CatmullRomCurve3(keys.map((k) => k.pos), false, "centripetal");
  };

  // ---------- Sizing ----------
  let width = 0;
  let height = 0;
  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setPixelRatio(dprCap());
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const pr = renderer.getPixelRatio();
    const rw = Math.round(w * pr * 0.5);
    const rh = Math.round(h * pr * 0.5);
    floor.getRenderTarget().setSize(rw, rh);
    floor.material.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    buildPath();
    measure();
    wake();
  };

  // ---------- Scroll mapping ----------
  let beatTops = [];
  const measure = () => {
    beatTops = beats.map((b) => b.getBoundingClientRect().top + window.scrollY);
  };
  const scrollBeat = () => {
    const y = window.scrollY;
    const n = beatTops.length;
    if (y <= beatTops[0]) return 0;
    for (let i = 0; i < n - 1; i++) {
      if (y < beatTops[i + 1]) return i + (y - beatTops[i]) / (beatTops[i + 1] - beatTops[i]);
    }
    return n - 1;
  };
  const smooth = (a, b, x) => {
    const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  // Holds the camera while a panel is being read, moves while the next one scrolls in.
  const shapeBeat = (b) => {
    const i = Math.min(Math.floor(b), keys.length - 2);
    return i + smooth(0.18, 0.92, b - i);
  };

  let targetBeat = reduceMotion ? 0 : scrollBeat();
  let currentBeat = targetBeat;

  const tmpTgt = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();
  const anchor = new THREE.Vector3(0.35, 0.9, 0);
  const projected = new THREE.Vector3();

  const placeCamera = (beat) => {
    const u = THREE.MathUtils.clamp(shapeBeat(beat), 0, keys.length - 1);
    const i = Math.min(Math.floor(u), keys.length - 2);
    const f = u - i;
    const a = keys[i];
    const b = keys[i + 1];
    camera.position.copy(curve.getPoint(u / (keys.length - 1)));
    tmpTgt.lerpVectors(a.tgt, b.tgt, f);
    tmpUp.lerpVectors(a.up, b.up, f).normalize();
    camera.up.copy(tmpUp);
    camera.fov = THREE.MathUtils.lerp(a.fov, b.fov, f);
    const sx = THREE.MathUtils.lerp(a.sx, b.sx, f);
    const sy = THREE.MathUtils.lerp(a.sy, b.sy, f);
    camera.setViewOffset(width, height, sx * width, sy * height, width, height);
    camera.lookAt(tmpTgt);
    camera.updateProjectionMatrix();
    // Hide the overhead rig as the camera rises through it.
    const rigFade = 1 - THREE.MathUtils.smoothstep(camera.position.y, 2.2, 3.2);
    tubeMat.opacity = rigLevel * rigFade;
    rig.visible = tubeMat.opacity > 0.01;
    return u;
  };

  const updateOverlay = (u) => {
    const near = 1 - THREE.MathUtils.clamp(Math.abs(u - 1) * 3.2, 0, 1);
    if (near <= 0.001) {
      callout.style.opacity = "0";
    } else {
      projected.copy(anchor).project(camera);
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      callout.style.setProperty("--x", `${x.toFixed(1)}px`);
      callout.style.setProperty("--y", `${y.toFixed(1)}px`);
      callout.style.opacity = near.toFixed(3);
    }
    const active = Math.round(u);
    viewLinks.forEach((link, idx) => {
      const on = idx === active;
      link.classList.toggle("is-active", on);
      if (on) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  };

  // ---------- Intro: black, strip light sweeps nose to tail, studio comes up ----------
  let rigLevel = reduceMotion ? 1 : 0;
  const playIntro = !reduceMotion && window.scrollY < 40;
  const intro = { active: playIntro, t0: 0, revealed: !playIntro };
  if (!playIntro) {
    scene.environmentIntensity = 1;
    softbox.intensity = 5;
    rim.intensity = 0.6;
    floor.material.uniforms.uGlow.value = 1;
    if (lightStripMat) lightStripMat.emissiveIntensity = 2.2;
    rigLevel = 1;
  }
  const ease = (x) => 1 - Math.pow(1 - THREE.MathUtils.clamp(x, 0, 1), 3);
  const runIntro = (now) => {
    if (!intro.t0) intro.t0 = now;
    const t = (now - intro.t0) / 1000;
    // Sweep from in front of the nose (+X) to past the tail over 2.6 s, starting at 0.5 s.
    const s = THREE.MathUtils.clamp((t - 0.5) / 2.6, 0, 1);
    const sx = THREE.MathUtils.lerp(4.2, -4.2, THREE.MathUtils.smootherstep(s, 0, 1));
    const live = s > 0 && s < 1 ? 1 : 0;
    const barIn = THREE.MathUtils.smoothstep(t, 0.4, 0.9) * (1 - THREE.MathUtils.smoothstep(s, 0.85, 1));
    sweep.uSweepX.value = sx;
    sweep.uSweepAmt.value = barIn;
    bar.position.x = sx;
    sweepLight.position.x = sx;
    sweepLight.intensity = 30 * barIn;
    barMat.opacity = barIn;
    bar.visible = camera.position.y < 1.9;
    // Studio comes up behind the sweep.
    const up = ease((t - 1.6) / 2.2);
    scene.environmentIntensity = up;
    softbox.intensity = 5 * up;
    rim.intensity = 0.6 * up;
    rigLevel = up;
    floor.material.uniforms.uGlow.value = up;
    if (lightStripMat) lightStripMat.emissiveIntensity = 2.2 * ease((t - 3.0) / 0.6);
    if (!intro.revealed && t > 2.2) {
      intro.revealed = true;
      revealText();
    }
    if (t > 4.2 && !live) {
      intro.active = false;
      sweep.uSweepAmt.value = 0;
      sweepLight.intensity = 0;
      bar.visible = false;
    }
  };

  // ---------- Loop ----------
  let frame = 0;
  let last = 0;
  let inView = true;
  const tick = (now) => {
    frame = 0;
    const dt = Math.min((now - (last || now)) / 1000, 0.1);
    last = now;
    if (!reduceMotion) targetBeat = scrollBeat();
    currentBeat += (targetBeat - currentBeat) * (1 - Math.exp(-dt * 4.2));
    if (Math.abs(targetBeat - currentBeat) < 0.0005) currentBeat = targetBeat;
    // Someone scrolling away mid-intro skips to the lit studio instead of a dark car.
    if (intro.active && intro.t0 && currentBeat > 0.25 && now - intro.t0 < 3300) intro.t0 = now - 3300;
    if (intro.active) runIntro(now);
    const u = placeCamera(currentBeat);
    renderer.render(scene, camera);
    updateOverlay(u);
    if (inView && (intro.active || currentBeat !== targetBeat)) frame = requestAnimationFrame(tick);
    else last = 0;
  };
  function wake() {
    if (!frame && inView) frame = requestAnimationFrame(tick);
  }

  window.addEventListener("scroll", () => {
    if (!reduceMotion) wake();
    document.querySelector(".views")?.classList.toggle("is-hidden", story.getBoundingClientRect().bottom < window.innerHeight * 0.5);
  }, { passive: true });
  window.addEventListener("resize", resize);
  compactQuery.addEventListener("change", () => { width = 0; resize(); });
  new ResizeObserver(() => { measure(); resize(); }).observe(story);
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView) wake();
  }).observe(stage);

  resize();
  // Compile shaders before revealing so the first frame of the sweep is smooth.
  placeCamera(currentBeat);
  // Background tabs can stall shader compile polling; never let it block the reveal.
  if (renderer.compileAsync) {
    await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 1500))]);
  }
  stage.classList.add("is-ready");
  if (!playIntro) revealText();
  wake();
}
