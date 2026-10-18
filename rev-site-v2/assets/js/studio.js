// REV v2 studio engine: Carrera on a dark studio floor, shared by Home, Carrera and Livery Lab.
// Loaded lazily by each page after first paint. Pages own the camera and the story; this module
// owns the scene, materials, quality tier, the x-ray/schematic view and the render loop.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";

export { THREE };

export const MODEL_URL = new URL("../models/carrera-v2.glb", import.meta.url).href;
export const HOTSPOTS_URL = new URL("../models/carrera-v2-hotspots.json", import.meta.url).href;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// "high": live floor reflection, MSAA, DPR up to 1.5. "low": painted floor, no MSAA, DPR up to 1.25.
// ?quality=low|high overrides, which is handy when checking either tier.
export function pickQuality() {
  const forced = new URLSearchParams(location.search).get("quality");
  if (forced === "low" || forced === "high") return forced;
  const compact = window.matchMedia("(max-width: 760px)").matches;
  const cores = navigator.hardwareConcurrency || 8;
  const memory = navigator.deviceMemory || 8;
  const saveData = navigator.connection?.saveData;
  return compact || cores <= 4 || memory <= 4 || saveData || softwareGL() ? "low" : "high";
}

// Browsers without usable GPU acceleration fall back to a CPU rasteriser (SwiftShader, llvmpipe).
// Every frame is expensive there, so those visitors get the light tier.
function softwareGL() {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(String(name));
  } catch {
    return false;
  }
}

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGL2RenderingContext && c.getContext("webgl2")) || !!c.getContext("webgl");
  } catch {
    return false;
  }
}

const SCHEMATIC = new THREE.Color(0x8fd0ff);
const GOLD = new THREE.Color(0xf2c15b);

export async function createStudio({ stage, canvas, quality = pickQuality(), onProgress, background = 0x000000 } = {}) {
  const high = quality === "high";
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: high, powerPreference: "high-performance" });
  const dprCap = () => Math.min(window.devicePixelRatio || 1, high ? 1.5 : 1.25);
  renderer.setPixelRatio(dprCap());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  RectAreaLightUniformsLib.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);

  // ---------- Studio environment: a darkened RoomEnvironment plus long light strips ----------
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  room.traverse((o) => {
    if (o.isMesh && o.material.isMeshStandardMaterial) o.material.color.setScalar(0.015);
    else if (o.isMesh && o.material.isMeshBasicMaterial) o.material.color.multiplyScalar(0.22);
    if (o.isPointLight) o.intensity = 60;
  });
  const envBox = new THREE.BoxGeometry();
  const strip = (level, pos, scale) => {
    const m = new THREE.Mesh(envBox, new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(level) }));
    m.position.set(...pos);
    m.scale.set(...scale);
    room.add(m);
  };
  // Car length runs along Z (nose +Z), so the long flank strips run along Z too.
  strip(36, [-2.6, 15, 0], [0.7, 0.1, 22]);
  strip(36, [2.6, 15, 0], [0.7, 0.1, 22]);
  strip(70, [13, 2.6, 0], [0.1, 0.18, 26]);
  strip(40, [-13, 2.6, 0], [0.1, 0.18, 26]);
  strip(18, [0, 4, 13.5], [9, 0.5, 0.1]);
  strip(12, [0, 4, -13.5], [9, 0.5, 0.1]);
  scene.environment = pmrem.fromScene(room, 0.035).texture;
  room.dispose();
  envBox.dispose();
  pmrem.dispose();

  // ---------- Lights ----------
  const softbox = new THREE.RectAreaLight(0xffffff, 5, 1.6, 6.5);
  softbox.position.set(0, 3.4, 0);
  softbox.rotation.x = -Math.PI / 2;
  scene.add(softbox);
  const sweepLight = new THREE.RectAreaLight(0xffffff, 0, 3.6, 0.45);
  sweepLight.position.set(0, 2.3, 6);
  sweepLight.rotation.x = -Math.PI / 2;
  scene.add(sweepLight);
  const rim = new THREE.DirectionalLight(0xdfe8ff, 0.6);
  rim.position.set(-6, 3, -6);
  scene.add(rim);

  // Overhead tubes, seen only as reflections in the floor (layer 1) so they never crop at the frame edge.
  const rig = new THREE.Group();
  const tubeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, toneMapped: false });
  for (const x of [-0.62, 0.62]) {
    const tube = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.025, 6.6), tubeMat);
    tube.position.set(x, 3.4, 0);
    tube.layers.set(1);
    rig.add(tube);
  }
  scene.add(rig);
  const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.02, 0.06), barMat);
  bar.position.set(0, 2.3, 6);
  bar.visible = false;
  scene.add(bar);

  // ---------- Shared shader uniforms (light sweep along Z, x-ray fresnel) ----------
  const uniforms = {
    uSweepZ: { value: 99 },
    uSweepAmt: { value: 0 },
    uXray: { value: 0 },
    uXrayColor: { value: SCHEMATIC.clone() },
  };
  const patchBody = (material, { sweep = true, xray = false } = {}) => {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = "varying vec3 vStudioPos;\n" + shader.vertexShader.replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  vStudioPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
      shader.fragmentShader = "uniform float uSweepZ;\nuniform float uSweepAmt;\nuniform float uXray;\nuniform vec3 uXrayColor;\nvarying vec3 vStudioPos;\n" + shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        ${sweep ? `{
          float dz = vStudioPos.z - uSweepZ;
          float band = exp(-dz * dz / 0.035) + 0.35 * exp(-dz * dz / 0.6);
          vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float up = clamp(dot(normal, upView), 0.0, 1.0);
          totalEmissiveRadiance += vec3(0.95, 0.97, 1.0) * band * uSweepAmt * (0.06 + 1.6 * pow(up, 2.5));
        }` : ""}
        ${xray ? `{
          float fres = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.2);
          totalEmissiveRadiance += uXrayColor * fres * uXray * 0.9;
        }` : ""}`,
      );
      if (xray) {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
          {
            float fresA = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 1.6);
            gl_FragColor.a *= mix(1.0, 0.05 + 0.55 * fresA, uXray);
          }`,
        );
      }
    };
    material.customProgramCacheKey = () => `rev-${sweep ? "s" : ""}${xray ? "x" : ""}`;
  };

  // ---------- Floor ----------
  const floorGeo = new THREE.PlaneGeometry(60, 60);
  let floor;
  let floorUniforms;
  const floorTexel = new THREE.Vector2(1 / 512, 1 / 512);
  const floorFrag = (withReflection) => /* glsl */ `
    uniform vec3 color;
    ${withReflection ? "uniform sampler2D tDiffuse; uniform vec2 uTexel; varying vec4 vUv;" : ""}
    uniform float uStrength;
    uniform float uGlow;
    uniform float uGrid;
    varying vec2 vLocal;
    void main() {
      float d = length(vLocal);
      vec3 refl = vec3(0.0);
      ${withReflection ? `
      vec2 uv = vUv.xy / vUv.w;
      float spread = 1.6 + 1.1 * d;
      float total = 0.0;
      for (int i = -2; i <= 2; i++) {
        for (int j = -2; j <= 2; j++) {
          vec2 o = vec2(float(i), float(j));
          float w = exp(-dot(o, o) / 3.0);
          refl += texture2D(tDiffuse, uv + o * uTexel * spread).rgb * w;
          total += w;
        }
      }
      refl /= total;` : ""}
      float fade = 1.0 - smoothstep(0.8, 7.0, d);
      float glow = exp(-pow(d / 4.2, 2.0)) * 0.02 * uGlow;
      // Plane local X maps to world X, local Y to world -Z: the car is long along local Y.
      float footprint = length(vec2(vLocal.x / 1.05, vLocal.y / 2.6));
      float contact = smoothstep(0.55, 1.2, footprint);
      vec3 col = color + vec3(glow) * mix(0.05, 1.0, contact) + refl * uStrength * fade * mix(0.55, 1.0, contact);
      // Blueprint grid for the schematic view.
      vec2 g = abs(fract(vLocal / 0.5 - 0.5) - 0.5) / fwidth(vLocal / 0.5);
      float line = 1.0 - min(min(g.x, g.y), 1.0);
      vec2 g2 = abs(fract(vLocal / 2.5 - 0.5) - 0.5) / fwidth(vLocal / 2.5);
      float major = 1.0 - min(min(g2.x, g2.y), 1.0);
      float gridFade = 1.0 - smoothstep(2.0, 9.0, d);
      col += vec3(0.56, 0.82, 1.0) * (line * 0.05 + major * 0.12) * uGrid * gridFade;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  if (high) {
    floor = new Reflector(floorGeo, {
      shader: {
        name: "StudioFloor",
        uniforms: {
          color: { value: null },
          tDiffuse: { value: null },
          textureMatrix: { value: null },
          uTexel: { value: floorTexel },
          uStrength: { value: 0.2 },
          uGlow: { value: 1 },
          uGrid: { value: 0 },
        },
        vertexShader: /* glsl */ `
          uniform mat4 textureMatrix;
          varying vec4 vUv;
          varying vec2 vLocal;
          void main() {
            vUv = textureMatrix * vec4(position, 1.0);
            vLocal = position.xy;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: floorFrag(true),
      },
      color: 0x000000,
      textureWidth: 512,
      textureHeight: 512,
      multisample: 4,
    });
    floor.camera.layers.enable(1);
    floorUniforms = floor.material.uniforms;
  } else {
    floorUniforms = {
      color: { value: new THREE.Color(0x000000) },
      uStrength: { value: 0 },
      uGlow: { value: 1 },
      uGrid: { value: 0 },
    };
    floor = new THREE.Mesh(floorGeo, new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: "varying vec2 vLocal; void main(){ vLocal = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: floorFrag(false),
      extensions: { derivatives: true },
    }));
  }
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // ---------- Model ----------
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((resolve, reject) => {
    loader.load(MODEL_URL, resolve, (e) => {
      if (e.total && onProgress) onProgress(e.loaded / e.total);
    }, reject);
  });
  const car = gltf.scene;
  const parts = { body: null, array: null, canopy: null, light: null, tires: [], wheels: [] };
  const mats = {};
  car.traverse((child) => {
    if (!child.isMesh) return;
    const src = child.material;
    const name = src.name || "";
    let mat;
    if (/body/i.test(name)) {
      mat = new THREE.MeshPhysicalMaterial({
        name, color: 0xd4d7dc, roughness: 0.34, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
        side: THREE.DoubleSide, transparent: true, opacity: 1,
      });
      patchBody(mat, { sweep: true, xray: true });
      parts.body = child;
      mats.body = mat;
    } else if (/solar/i.test(name)) {
      mat = new THREE.MeshPhysicalMaterial({
        name, map: src.map, color: 0x6f86a6, roughness: 0.42, metalness: 0.2, clearcoat: 0.55, clearcoatRoughness: 0.12, envMapIntensity: 0.75,
        emissive: 0x000000, transparent: true,
      });
      if (mat.map) mat.map.anisotropy = high ? 8 : 2;
      patchBody(mat, { sweep: true, xray: true });
      parts.array = child;
      mats.array = mat;
    } else if (/glass|canopy|window/i.test(name)) {
      mat = new THREE.MeshPhysicalMaterial({ name, color: 0x040506, roughness: 0.04, metalness: 0.1, clearcoat: 1, transparent: true, opacity: 0.92 });
      parts.canopy = child;
      mats.canopy = mat;
    } else if (/light/i.test(name)) {
      // The strip sits on the trailing edge: a tail light.
      mat = new THREE.MeshStandardMaterial({ name, color: 0x120204, emissive: 0xff2436, emissiveIntensity: 2.2 });
      parts.light = child;
      mats.light = mat;
    } else if (/tire|tyre/i.test(name)) {
      mat = new THREE.MeshStandardMaterial({ name, color: 0x0a0a0c, roughness: 0.82, metalness: 0 });
      parts.tires.push(child);
    } else {
      // Rims/hubs and anything new keep the exported PBR values.
      mat = src;
      if (mat.isMeshStandardMaterial) mat.envMapIntensity = 1;
    }
    child.material = mat;
  });

  // Ground the car and centre it, whatever pivot the file has.
  const box = new THREE.Box3().setFromObject(car);
  const center = box.getCenter(new THREE.Vector3());
  car.position.set(-center.x, -box.min.y, -center.z);
  scene.add(car);
  car.updateMatrixWorld(true);
  const size = box.getSize(new THREE.Vector3());

  // Wheels: rotate each Wheel_* node about its local X axle.
  car.traverse((o) => {
    if (/^Wheel_(FL|FR|RL|RR)$/.test(o.name)) {
      const wb = new THREE.Box3().setFromObject(o);
      parts.wheels.push({ node: o, base: o.quaternion.clone(), angle: 0, radius: Math.max(0.05, (wb.max.y - wb.min.y) / 2) });
    }
  });
  const axleX = new THREE.Vector3(1, 0, 0);
  const spinQ = new THREE.Quaternion();
  const rollWheels = (metres) => {
    for (const w of parts.wheels) {
      w.angle += metres / w.radius;
      spinQ.setFromAxisAngle(axleX, w.angle);
      w.node.quaternion.copy(w.base).multiply(spinQ);
    }
  };

  // Hotspot anchors exported as empties.
  const hotspots = {};
  car.traverse((o) => {
    if (o.name.startsWith("Hotspot_")) hotspots[o.name.slice(8)] = o.getWorldPosition(new THREE.Vector3());
  });

  // ---------- Schematic layer (built on first use) ----------
  let schematic = null;
  const buildSchematic = () => {
    const group = new THREE.Group();
    group.renderOrder = 10;
    // Feature edges of the body, drawn as cyan hairlines.
    if (parts.body) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(parts.body.geometry, 28),
        new THREE.LineBasicMaterial({ color: SCHEMATIC, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
      );
      parts.body.add(edges);
      group.userData.edges = edges;
    }
    // Battery block (placement is an estimate; the label says so).
    const bat = hotspots.BatteryPack || new THREE.Vector3(-0.6, 0.2, 0.5);
    const battery = new THREE.Group();
    const cellGeo = new THREE.BoxGeometry(0.085, 0.09, 0.13);
    const cellMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const cellEdge = new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const cellEdges = new THREE.EdgesGeometry(cellGeo);
    const cells = [];
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 2; j++) {
        const m = new THREE.Mesh(cellGeo, cellMat.clone());
        m.position.set((j - 0.5) * 0.1, 0, (i - 2.5) * 0.145);
        m.add(new THREE.LineSegments(cellEdges, cellEdge));
        battery.add(m);
        cells.push(m);
      }
    }
    battery.position.copy(bat);
    group.add(battery);
    // Hub motor rings on the driven rear wheel.
    const driven = parts.wheels.find((w) => /RL/.test(w.node.name)) || parts.wheels[0];
    const motorPos = driven ? driven.node.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0.66, 0.31, -0.38);
    const motor = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    for (const [r, t] of [[0.2, 0.006], [0.13, 0.004], [0.26, 0.003]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 64), ringMat);
      ring.rotation.y = Math.PI / 2;
      motor.add(ring);
    }
    motor.position.copy(motorPos);
    group.add(motor);
    // Energy path: array -> battery -> inverter -> hub motor.
    const arr = hotspots.SolarArray || new THREE.Vector3(0, 0.86, 0);
    const path = new THREE.CatmullRomCurve3([
      arr.clone().add(new THREE.Vector3(0, 0.02, 0)),
      new THREE.Vector3(arr.x, 0.55, arr.z + 0.15),
      new THREE.Vector3((arr.x + bat.x) / 2, 0.32, (arr.z + bat.z) / 2 + 0.1),
      bat.clone().add(new THREE.Vector3(0, 0.08, -0.3)),
      new THREE.Vector3(bat.x * 0.4, 0.2, bat.z - 0.55),
      new THREE.Vector3(motorPos.x * 0.6, 0.25, motorPos.z + 0.12),
      motorPos.clone(),
    ], false, "centripetal");
    const pulseUniforms = { uDraw: { value: 0 }, uTime: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: GOLD.clone() } };
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(path, 160, 0.011, 8, false),
      new THREE.ShaderMaterial({
        uniforms: pulseUniforms,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: /* glsl */ `
          uniform float uDraw; uniform float uTime; uniform float uOpacity; uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            float s = vUv.x;
            if (s > uDraw) discard;
            float dash = smoothstep(0.35, 0.5, fract(s * 22.0 - uTime * 1.6)) * smoothstep(0.85, 0.6, fract(s * 22.0 - uTime * 1.6));
            float head = exp(-pow((uDraw - s) * 24.0, 2.0));
            float a = (0.35 + 0.65 * dash) * uOpacity + head * 1.5 * uOpacity;
            gl_FragColor = vec4(uColor * (0.9 + head), a);
          }`,
      }),
    );
    tube.renderOrder = 20;
    group.add(tube);
    scene.add(group);
    schematic = { group, edges: group.userData.edges, cells, cellEdge, ringMat, pulseUniforms, path, motorPos, batteryPos: bat.clone() };
    return schematic;
  };

  // ---------- State setters ----------
  let studioLevel = 1;
  const setStudioLevel = (t) => {
    studioLevel = t;
    scene.environmentIntensity = t * (1 - 0.6 * uniforms.uXray.value);
    softbox.intensity = 5 * t;
    rim.intensity = 0.6 * t;
    tubeMat.opacity = t;
    floorUniforms.uGlow.value = t;
  };
  const setLight = (t) => { if (mats.light) mats.light.emissiveIntensity = 2.2 * t; };
  const setSweep = (z, amount) => {
    uniforms.uSweepZ.value = z;
    uniforms.uSweepAmt.value = amount;
    bar.position.z = z;
    sweepLight.position.z = z;
    sweepLight.intensity = 30 * amount;
    barMat.opacity = amount;
    bar.visible = amount > 0.01 && camera.position.y < 1.9;
  };
  // 0 = studio car, 1 = see-through body with schematic internals. energy 0..1 draws the power path.
  const setXray = (t, energy = t) => {
    const x = THREE.MathUtils.clamp(t, 0, 1);
    if (x > 0 && !schematic) buildSchematic();
    uniforms.uXray.value = x;
    if (mats.body) mats.body.depthWrite = x < 0.35;
    if (mats.array) mats.array.opacity = 1 - 0.55 * x;
    if (mats.canopy) mats.canopy.opacity = 0.92 * (1 - 0.7 * x);
    for (const tire of parts.tires) tire.material.color.setScalar(0.04 + 0.1 * x);
    scene.environmentIntensity = studioLevel * (1 - 0.6 * x);
    floorUniforms.uGrid.value = x;
    if (schematic) {
      schematic.group.visible = x > 0.001;
      if (schematic.edges) {
        schematic.edges.visible = x > 0.001;
        schematic.edges.material.opacity = 0.55 * x;
      }
      const e = THREE.MathUtils.clamp(energy, 0, 1);
      schematic.pulseUniforms.uDraw.value = e;
      schematic.pulseUniforms.uOpacity.value = x;
      const charge = THREE.MathUtils.smoothstep(e, 0.35, 0.7);
      schematic.cells.forEach((c, i) => { c.material.opacity = x * (0.08 + 0.5 * THREE.MathUtils.clamp(charge * 12 - i, 0, 1)); });
      schematic.cellEdge.opacity = 0.8 * x;
      schematic.ringMat.opacity = x * (0.3 + 0.7 * THREE.MathUtils.smoothstep(e, 0.8, 1));
    }
  };
  const setBodyColor = (hex) => mats.body?.color.set(hex);
  const setBodyMap = (texture) => {
    if (!mats.body) return;
    mats.body.map = texture;
    if (texture) mats.body.color.set(0xffffff);
    mats.body.needsUpdate = true;
  };

  // ---------- Projection helper for HTML callouts ----------
  const projected = new THREE.Vector3();
  const toScreen = (v) => {
    projected.copy(v).project(camera);
    return { x: (projected.x * 0.5 + 0.5) * width, y: (-projected.y * 0.5 + 0.5) * height, behind: projected.z > 1 };
  };

  // ---------- Sizing ----------
  let width = 0;
  let height = 0;
  const resizeListeners = new Set();
  const resize = (force = false) => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!force && w === width && h === height) return false;
    width = w;
    height = h;
    renderer.setPixelRatio(dprCap());
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (high && floor.getRenderTarget) {
      const pr = renderer.getPixelRatio();
      const rw = Math.max(64, Math.round(w * pr * 0.5));
      const rh = Math.max(64, Math.round(h * pr * 0.5));
      floor.getRenderTarget().setSize(rw, rh);
      floorTexel.set(1 / rw, 1 / rh);
    }
    resizeListeners.forEach((fn) => fn(w, h));
    wake();
    return true;
  };

  // ---------- Render loop: renders only while something is moving and the stage is visible ----------
  let update = null;
  let frame = 0;
  let last = 0;
  let inView = true;
  let pageVisible = !document.hidden;
  let slowFrames = 0;
  let sampled = 0;
  const tick = (now) => {
    frame = 0;
    const dt = Math.min((now - (last || now)) / 1000, 0.1);
    // Adaptive safety net: if the high tier struggles, stop rendering the reflection pass.
    if (high && last && floor.visible !== false && sampled < 90) {
      sampled += 1;
      if (now - last > 40) slowFrames += 1;
      if (sampled === 90 && slowFrames > 30 && floorUniforms.uStrength) {
        floorUniforms.uStrength.value = 0;
        floor.onBeforeRender = () => {};
      }
    }
    last = now;
    if (schematic) schematic.pulseUniforms.uTime.value = now / 1000;
    const keepGoing = update ? update(dt, now) : false;
    renderer.render(scene, camera);
    const animating = keepGoing || (schematic && uniforms.uXray.value > 0.001 && !reduceMotion);
    // update() may already have queued the next frame (controls fire "change" -> wake()).
    // Queue at most one, or frames multiply.
    if (inView && pageVisible && animating) {
      if (!frame) frame = requestAnimationFrame(tick);
    } else if (!frame) {
      last = 0;
    }
  };
  function wake() {
    if (!frame && inView && pageVisible) frame = requestAnimationFrame(tick);
  }
  const io = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView) wake();
  });
  io.observe(stage);
  document.addEventListener("visibilitychange", () => {
    pageVisible = !document.hidden;
    if (pageVisible) wake();
  });
  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);

  resize(true);

  const compile = async () => {
    if (!renderer.compileAsync) return;
    await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 1500))]);
  };

  return {
    THREE, renderer, scene, camera, car, parts, hotspots, size, quality, reduceMotion,
    get width() { return width; },
    get height() { return height; },
    setLoop(fn) { update = fn; wake(); },
    wake,
    resize,
    onResize(fn) { resizeListeners.add(fn); },
    compile,
    toScreen,
    rollWheels,
    setStudioLevel,
    setLight,
    setSweep,
    setXray,
    setBodyColor,
    setBodyMap,
    get schematic() { return schematic || buildSchematic(); },
    // Fade the overhead tubes as the camera rises through the rig.
    fadeRig(cameraY) {
      const fade = 1 - THREE.MathUtils.smoothstep(cameraY, 2.2, 3.2);
      tubeMat.opacity = studioLevel * fade;
      rig.visible = tubeMat.opacity > 0.01;
    },
  };
}
