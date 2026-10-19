// REV v2 studio engine: Carrera in a night showroom, shared by Home, Carrera and Livery Lab.
// Loaded lazily by each page after first paint. Pages own the camera and the story; this module
// owns the scene, materials, quality tier, the x-ray/schematic view and the render loop.
//
// The showroom: a photographed studio environment for reflections (Poly Haven, CC0), a polished
// epoxy floor with uneven gloss, overhead softbox panels seen in the floor, a dark cyclorama wall,
// a baked contact shadow and, on the high tier, a camera finish (MSAA, bloom, grain, vignette).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";

export { THREE };

export const MODEL_URL = new URL("../models/carrera-v2.glb", import.meta.url).href;
export const HOTSPOTS_URL = new URL("../models/carrera-v2-hotspots.json", import.meta.url).href;
// Reflection environment: "Monochrome Studio 02" from Poly Haven (polyhaven.com, CC0), downloaded at
// 1k from dl.polyhaven.org, graded darker, white-balanced and stored as a 30 KB WebP whose channels
// hold log2(radiance) (tools/encode-env.mjs; see rev-site-v2/README.md).
export const ENV_URL = new URL("../env/showroom-env.webp", import.meta.url).href;
const ENV_LOG2_RANGE = [-10, 9]; // must match the encoder

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const params = new URLSearchParams(location.search);

// "high": live floor reflection, camera finish (MSAA, bloom, grain), DPR up to 1.5.
// "low": analytic floor gloss, no post-processing, no MSAA, DPR up to 1.25.
// ?quality=low|high overrides, which is handy when checking either tier.
export function pickQuality() {
  const forced = params.get("quality");
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
const CANOPY_OPACITY = 0.6;
const GOLD = new THREE.Color(0xf2c15b);
const TONE_MAPPINGS = { neutral: THREE.NeutralToneMapping, agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping };

// Overhead softbox panels, seen only as reflections in the floor: [x, y, z, halfX, halfZ, radiance].
// The centre one matches the RectAreaLight above the car.
const PANELS = [
  [0, 3.4, 0, 0.8, 3.25, 1],
  [-3.6, 3.9, 0, 0.42, 4.2, 0.3],
  [3.6, 3.9, 0, 0.42, 4.2, 0.3],
  [0, 4.1, 7.2, 2.6, 0.32, 0.18],
  [0, 4.1, -7.2, 2.6, 0.32, 0.18],
];

const NOISE_GLSL = /* glsl */ `
  float srHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float srNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(srHash(i), srHash(i + vec2(1.0, 0.0)), u.x), mix(srHash(i + vec2(0.0, 1.0)), srHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }`;

export async function createStudio({ stage, canvas, quality = pickQuality(), onProgress, background = 0x000000 } = {}) {
  const high = quality === "high";
  // The camera finish (MSAA happens in its render target, so the canvas itself skips it).
  const wantPost = high && params.get("post") !== "off";
  const postModules = wantPost
    ? Promise.all([import("three/addons/postprocessing/UnrealBloomPass.js"), import("three/addons/postprocessing/Pass.js")]).catch(() => null)
    : null;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: high && !wantPost, powerPreference: "high-performance" });
  const dprCap = () => Math.min(window.devicePixelRatio || 1, high ? 1.5 : 1.25);
  renderer.setPixelRatio(dprCap());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral keeps livery colours true and gives a soft film-like shoulder on highlights.
  renderer.toneMapping = TONE_MAPPINGS[params.get("tonemap")] ?? THREE.NeutralToneMapping;
  renderer.toneMappingExposure = Number(params.get("exposure")) || 0.92;
  RectAreaLightUniformsLib.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);

  // ---------- Reflection environment ----------
  // A photographed studio (lazy-loaded after the model) plus a few crisp strips that put long
  // softbox highlights in the clearcoat. Until the photo arrives, a darkened RoomEnvironment stands in.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envBox = new THREE.BoxGeometry();
  let envTarget = null;
  const addStrips = (group, gain = 1) => {
    const strip = (level, pos, scale) => {
      const m = new THREE.Mesh(envBox, new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(level * gain) }));
      m.position.set(...pos);
      m.scale.set(...scale);
      group.add(m);
    };
    // Car length runs along Z (nose +Z), so the long flank strips run along Z too.
    strip(36, [-2.6, 15, 0], [0.7, 0.1, 22]);
    strip(36, [2.6, 15, 0], [0.7, 0.1, 22]);
    strip(70, [13, 2.6, 0], [0.1, 0.18, 26]);
    strip(40, [-13, 2.6, 0], [0.1, 0.18, 26]);
    strip(18, [0, 4, 13.5], [9, 0.5, 0.1]);
    strip(12, [0, 4, -13.5], [9, 0.5, 0.1]);
  };
  const disposeScene = (root) => root.traverse((o) => {
    if (o.isMesh && o.geometry !== envBox) o.geometry.dispose();
    if (o.isMesh) o.material.dispose();
  });
  const applyEnv = (photo) => {
    let envScene;
    let sigma;
    if (photo) {
      envScene = new THREE.Scene();
      const sky = new THREE.Mesh(
        new THREE.SphereGeometry(60, 64, 32),
        new THREE.ShaderMaterial({
          uniforms: {
            tEnv: { value: photo },
            uRange: { value: new THREE.Vector2(...ENV_LOG2_RANGE) },
            uGain: { value: 0.32 }, // night-showroom level
            uRot: { value: 1.9 }, // puts the strip softboxes along the flanks
          },
          vertexShader: "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
          fragmentShader: /* glsl */ `
            uniform sampler2D tEnv; uniform vec2 uRange; uniform float uGain; uniform float uRot;
            varying vec3 vDir;
            void main() {
              vec3 d = normalize(vDir);
              float c = cos(uRot), s = sin(uRot);
              d.xz = mat2(c, -s, s, c) * d.xz;
              vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
              vec3 t = textureLod(tEnv, uv, 0.0).rgb;
              gl_FragColor = vec4(exp2(mix(vec3(uRange.x), vec3(uRange.y), t)) * uGain, 1.0);
            }`,
          side: THREE.BackSide,
          depthWrite: false,
        }),
      );
      envScene.add(sky);
      addStrips(envScene, 0.35);
      sigma = 0;
    } else {
      envScene = new RoomEnvironment();
      envScene.traverse((o) => {
        if (o.isMesh && o.material.isMeshStandardMaterial) o.material.color.setScalar(0.015);
        else if (o.isMesh && o.material.isMeshBasicMaterial) o.material.color.multiplyScalar(0.22);
        if (o.isPointLight) o.intensity = 60;
      });
      addStrips(envScene, 1);
      sigma = 0.035;
    }
    const next = pmrem.fromScene(envScene, sigma);
    disposeScene(envScene);
    scene.environment = next.texture;
    envTarget?.dispose();
    envTarget = next;
    if (photo) {
      // The photo is baked into the PMREM now and nothing replaces it later.
      photo.dispose();
      pmrem.dispose();
    }
  };
  const loadEnvPhoto = () => new THREE.TextureLoader().loadAsync(ENV_URL).then((tex) => {
    tex.colorSpace = THREE.NoColorSpace; // log-encoded data, not colour
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    return tex;
  }).catch((err) => {
    console.warn("[v2] studio environment unavailable, using the procedural one:", err);
    return null;
  });

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

  // ---------- Room: a dark cyclorama wall, so the car sits in a space rather than a void ----------
  const ROOM_BASE = 0.0018; // floor and wall meet at this level, so the cove has no seam
  const roomUniforms = { uRoom: { value: 1 }, uBase: { value: ROOM_BASE } };
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(34, 34, 26, 96, 1, true),
    new THREE.ShaderMaterial({
      uniforms: roomUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: "varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
      fragmentShader: /* glsl */ `
        uniform float uRoom; uniform float uBase;
        varying vec3 vWorld;
        ${NOISE_GLSL}
        void main() {
          float y = vWorld.y;
          float a = atan(vWorld.z, vWorld.x);
          // Spill from the ceiling panels: a soft band low on the wall that falls off upward,
          // brighter along the car's flanks (where the long panels point), with faint pilasters.
          float band = smoothstep(-0.2, 1.6, y) * (1.0 - smoothstep(1.5, 10.0, y));
          float flank = 0.55 + 0.45 * abs(cos(a));
          float pilaster = 0.82 + 0.18 * smoothstep(0.55, 1.0, abs(cos(a * 9.0)));
          vec3 col = vec3(uBase) + vec3(0.92, 0.95, 1.0) * 0.016 * band * flank * pilaster * uRoom;
          col *= 1.0 - 0.6 * smoothstep(6.0, 13.0, y);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #ifdef SR_DITHER
          gl_FragColor.rgb += (srHash(gl_FragCoord.xy) - 0.5) / 255.0;
          #endif
        }`,
      defines: high ? {} : { SR_DITHER: "" },
    }),
  );
  wall.position.y = 13 - 0.02;
  scene.add(wall);

  // ---------- Floor: polished epoxy with uneven gloss, softbox reflections and a contact shadow ----------
  const floorGeo = new THREE.PlaneGeometry(80, 80);
  let floor;
  let floorUniforms;
  const SHADOW_SIZE = 7.2; // metres covered by the baked contact shadow
  const panelGLSL = PANELS.map(([x, y, z, hx, hz, k]) => `panels += ${k.toFixed(3)} * srPanel(P, R, vec3(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}), vec2(${hx.toFixed(2)}, ${hz.toFixed(2)}), blur);`).join("\n      ");
  const floorFrag = (withReflection) => /* glsl */ `
    ${withReflection ? "uniform sampler2D tDiffuse; uniform vec2 uTexel; varying vec4 vUv;" : ""}
    uniform sampler2D tShadow;
    uniform float uShadowSize;
    uniform vec2 uShadowOffset;
    uniform float uStrength;
    uniform float uGlow;
    uniform float uGrid;
    uniform float uRig;
    uniform float uPanel;
    uniform float uBase;
    varying vec2 vLocal;
    ${NOISE_GLSL}
    // Soft rectangle hit by the reflected ray: a ceiling softbox as seen in the floor.
    float srPanel(vec3 P, vec3 R, vec3 c, vec2 hs, float blur) {
      float t = min((c.y - P.y) / R.y, 60.0);
      vec2 h = P.xz + R.xz * t - c.xz;
      vec2 q = abs(h) - hs;
      float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      float s = 0.02 + blur * t;
      return 1.0 - smoothstep(-s, s, dist);
    }
    void main() {
      // Plane local X maps to world X, local Y to world -Z: the car is long along local Y.
      vec3 P = vec3(vLocal.x, 0.0, -vLocal.y);
      float d = length(vLocal);
      vec3 V = normalize(P - cameraPosition);
      vec3 R = vec3(V.x, max(abs(V.y), 0.02), V.z); // grazing rays near the horizon would divide by ~0
      float cosT = clamp(-V.y, 0.0, 1.0);
      float fres = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);

      // Gloss varies in large soft patches (trowel marks, wear) plus a fine grain.
      float patches = smoothstep(0.3, 0.75, 0.6 * srNoise(P.xz * 0.42 + 3.1) + 0.4 * srNoise(P.xz * 1.1 - 7.3));
      float fine = srNoise(P.xz * 9.0);
      float rough = clamp(0.25 + 0.6 * patches + 0.15 * fine, 0.0, 1.0);
      float gloss = 1.0 - 0.55 * rough;

      // Baked contact shadow: r = tight contact, g = wide soft occlusion.
      vec2 suv = (vec2(P.x, P.z) - uShadowOffset) / uShadowSize + 0.5;
      vec2 sh = (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) ? texture2D(tShadow, suv).rg : vec2(0.0);
      float occ = (1.0 - 0.92 * sh.r) * (1.0 - 0.7 * sh.g);

      // Diffuse: a pool of light under the softboxes on a dark, faintly mottled floor.
      float pool = exp(-pow(d / 4.4, 2.0)) + 0.3 * exp(-pow(d / 10.0, 2.0));
      float albedo = 0.9 + 0.2 * srNoise(P.xz * 0.8 + 11.0);
      vec3 col = vec3(uBase) + vec3(0.062) * pool * albedo * uGlow * occ;

      // Softbox panels reflected in the floor; blur grows with distance and roughness.
      float blur = 0.012 + 0.07 * rough;
      float panels = 0.0;
      float near = 1.0 - smoothstep(3.0, 7.5, d); // the showroom lighting is concentrated on the car
      if (near > 0.0) {
      ${panelGLSL}
      }
      col += vec3(0.95, 0.97, 1.0) * panels * uPanel * uRig * fres * gloss * near * mix(0.4, 1.0, occ);
      ${withReflection ? `
      // Live reflection: a blurred, slightly vertically streaked read of the mirrored scene.
      // The blur radius follows the gloss map, and the kernel is rotated per pixel to hide sampling.
      vec2 uv = vUv.xy / vUv.w;
      float spread = (1.5 + 0.9 * d) * mix(0.7, 2.6, rough);
      float lod = log2(1.0 + spread * 0.6);
      float ang = 6.2831853 * srHash(gl_FragCoord.xy * 0.731 + 0.17);
      vec3 refl = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        float a = ang + float(i) * 1.5707963;
        vec2 o = vec2(cos(a), sin(a) * 2.2) * spread * 0.55 * uTexel;
        refl += textureLod(tDiffuse, uv + o, lod).rgb;
      }
      refl *= 0.25;
      float fade = 1.0 - smoothstep(1.0, 11.0, d);
      col += refl * uStrength * (0.35 + 1.7 * fres) * gloss * fade * mix(0.5, 1.0, occ);` : ""}
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
      #ifdef SR_DITHER
      gl_FragColor.rgb += (srHash(gl_FragCoord.xy) - 0.5) / 255.0;
      #endif
    }`;
  const floorCommon = () => ({
    tShadow: { value: null },
    uShadowSize: { value: SHADOW_SIZE },
    uShadowOffset: { value: new THREE.Vector2() },
    uStrength: { value: 0.2 },
    uGlow: { value: 1 },
    uGrid: { value: 0 },
    uRig: { value: 1 },
    uPanel: { value: 1.1 },
    uBase: { value: ROOM_BASE },
  });
  if (high) {
    floor = new Reflector(floorGeo, {
      shader: {
        name: "StudioFloor",
        uniforms: {
          color: { value: null },
          tDiffuse: { value: null },
          textureMatrix: { value: null },
          uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
          ...floorCommon(),
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
    // Mipmaps on the mirror image give the blur its wide, smooth falloff for four taps a pixel.
    const reflTex = floor.getRenderTarget().texture;
    reflTex.generateMipmaps = true;
    reflTex.minFilter = THREE.LinearMipmapLinearFilter;
    floorUniforms = floor.material.uniforms; // Reflector clones the uniforms: use its copies
  } else {
    floorUniforms = floorCommon();
    floor = new THREE.Mesh(floorGeo, new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: "varying vec2 vLocal; void main(){ vLocal = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: floorFrag(false),
      defines: { SR_DITHER: "" },
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
  // The environment photo is small; fetch it now that the model no longer needs the bandwidth.
  const envPhoto = loadEnvPhoto();

  // Carry texture detail from the exported material onto the studio material: baked AO (which
  // may sit on the second UV set; the texture keeps its channel), normal, roughness, metalness and
  // emissive maps. A roughness or metalness map brings its authored factor with it, since the two
  // were made together. `map` is only carried where asked: the body's stays free for the Livery Lab.
  const carry = (dst, src, { map = false } = {}) => {
    if (map && src.map) dst.map = src.map;
    if (src.aoMap) {
      dst.aoMap = src.aoMap;
      dst.aoMapIntensity = src.aoMapIntensity ?? 1;
    }
    if (src.normalMap) {
      dst.normalMap = src.normalMap;
      dst.normalMapType = src.normalMapType;
      dst.normalScale.copy(src.normalScale);
    }
    if (src.roughnessMap) {
      dst.roughnessMap = src.roughnessMap;
      dst.roughness = src.roughness;
    }
    if (src.metalnessMap) {
      dst.metalnessMap = src.metalnessMap;
      dst.metalness = src.metalness;
    }
    if (src.emissiveMap) {
      dst.emissiveMap = src.emissiveMap;
      if (dst.emissive.getHex() === 0) dst.emissive.copy(src.emissive);
    }
    if (dst.isMeshPhysicalMaterial && src.isMeshPhysicalMaterial) {
      if (src.clearcoatNormalMap) {
        dst.clearcoatNormalMap = src.clearcoatNormalMap;
        dst.clearcoatNormalScale.copy(src.clearcoatNormalScale);
      }
      if (src.clearcoatRoughnessMap) dst.clearcoatRoughnessMap = src.clearcoatRoughnessMap;
    }
    for (const key of ["aoMap", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "map"]) {
      if (dst[key] && dst[key] === src[key]) dst[key].anisotropy = Math.max(dst[key].anisotropy, high ? 8 : 2);
    }
    return dst;
  };

  const car = gltf.scene;
  const parts = { body: null, array: null, canopy: null, light: null, tires: [], wheels: [], interior: [] };
  const mats = {};
  car.traverse((child) => {
    if (!child.isMesh) return;
    const src = child.material;
    const name = src.name || "";
    let mat;
    if (/^interior/i.test(name)) {
      // Cockpit parts keep their exported look; the scene environment lights them like the rest.
      mat = src;
      if (mat.isMeshStandardMaterial) mat.envMapIntensity = 1;
      // In the schematic the cockpit shell (liner, dash, wheel housings) fades out, otherwise its dark
      // liner fills the see-through body; the seat, roll hoop and wheel stay as illustrative detail.
      if (/shell|liner|housing/i.test(name) && !parts.interior.includes(mat)) {
        mat.userData.exported = { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite };
        parts.interior.push(mat);
      }
    } else if (/body/i.test(name)) {
      mat = carry(new THREE.MeshPhysicalMaterial({
        name, color: 0xd4d7dc, roughness: 0.34, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
        side: THREE.DoubleSide, transparent: true, opacity: 1,
      }), src);
      patchBody(mat, { sweep: true, xray: true });
      parts.body = child;
      mats.body = mat;
    } else if (/solar/i.test(name)) {
      mat = carry(new THREE.MeshPhysicalMaterial({
        name, color: 0x6f86a6, roughness: 0.42, metalness: 0.2, clearcoat: 0.55, clearcoatRoughness: 0.12, envMapIntensity: 0.75,
        emissive: 0x000000, transparent: true,
      }), src, { map: true });
      if (mat.map) mat.map.anisotropy = high ? 8 : 2;
      patchBody(mat, { sweep: true, xray: true });
      parts.array = child;
      mats.array = mat;
    } else if (/glass|canopy|window/i.test(name)) {
      // Tinted, but clear enough to show the illustrative cockpit behind it.
      mat = carry(new THREE.MeshPhysicalMaterial({ name, color: 0x040506, roughness: 0.04, metalness: 0.1, clearcoat: 1, transparent: true, opacity: CANOPY_OPACITY }), src);
      parts.canopy = child;
      mats.canopy = mat;
    } else if (/light/i.test(name)) {
      // The strip sits on the trailing edge: a tail light.
      mat = carry(new THREE.MeshStandardMaterial({ name, color: 0x120204, emissive: 0xff2436, emissiveIntensity: 2.2 }), src);
      parts.light = child;
      mats.light = mat;
    } else if (/tire|tyre/i.test(name)) {
      mat = carry(new THREE.MeshStandardMaterial({ name, color: 0x0a0a0c, roughness: 0.82, metalness: 0 }), src);
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

  // Drive the car along its length (intro). The baked contact shadow follows it.
  const carBaseZ = car.position.z;
  const setCarOffset = (dz) => {
    car.position.z = carBaseZ + dz;
    car.updateMatrixWorld(true);
    if (floorUniforms?.uShadowOffset) floorUniforms.uShadowOffset.value.set(0, dz);
  };

  // Hotspot anchors exported as empties.
  const hotspots = {};
  car.traverse((o) => {
    if (o.name.startsWith("Hotspot_")) hotspots[o.name.slice(8)] = o.getWorldPosition(new THREE.Vector3());
  });

  // ---------- Contact shadow, baked once ----------
  // An orthographic camera on the floor looks up at the car and records how close each part is to
  // the ground (r: within a few centimetres, g: within a metre). Two blurs turn that into a tight
  // contact shadow and a wide soft occlusion, which the floor shader reads. The car never moves,
  // so this costs one small render at load instead of a shadow map every frame.
  const bakeContactShadow = () => {
    const RES = 512;
    const rtOpts = { type: THREE.UnsignedByteType, depthBuffer: true };
    const raw = new THREE.WebGLRenderTarget(RES, RES, rtOpts);
    const tmp = new THREE.WebGLRenderTarget(RES, RES, { depthBuffer: false });
    const wideA = new THREE.WebGLRenderTarget(128, 128, { depthBuffer: false });
    const wideB = new THREE.WebGLRenderTarget(128, 128, { depthBuffer: false });
    const out = new THREE.WebGLRenderTarget(RES, RES, { depthBuffer: false });
    const half = SHADOW_SIZE / 2;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0, 1.4);
    cam.rotation.x = Math.PI / 2; // looking up; screen right = +X, screen up = +Z
    cam.layers.set(2);
    car.traverse((o) => { if (o.isMesh) o.layers.enable(2); });
    const heightMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: "varying float vY; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }",
      fragmentShader: "varying float vY; void main() { gl_FragColor = vec4(1.0 - smoothstep(0.0, 0.07, vY), pow(1.0 - smoothstep(0.0, 1.1, vY), 1.5), 0.0, 1.0); }",
    });
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const blurMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
        void main() {
          vec4 s = texture2D(tSrc, vUv) * 0.2270270;
          s += (texture2D(tSrc, vUv + uDir * 1.3846154) + texture2D(tSrc, vUv - uDir * 1.3846154)) * 0.3162162;
          s += (texture2D(tSrc, vUv + uDir * 3.2307692) + texture2D(tSrc, vUv - uDir * 3.2307692)) * 0.0702703;
          gl_FragColor = s;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const combineMat = new THREE.ShaderMaterial({
      uniforms: { tTight: { value: null }, tWide: { value: null } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: "uniform sampler2D tTight; uniform sampler2D tWide; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tTight, vUv).r, texture2D(tWide, vUv).g, 0.0, 1.0); }",
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
    quad.frustumCulled = false;
    const pass = (material, target) => {
      quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(quad, quadCam);
    };
    const blur = (src, dst, via, texel, radius) => {
      blurMat.uniforms.tSrc.value = src.texture;
      blurMat.uniforms.uDir.value.set(texel * radius, 0);
      pass(blurMat, via);
      blurMat.uniforms.tSrc.value = via.texture;
      blurMat.uniforms.uDir.value.set(0, texel * radius);
      pass(blurMat, dst);
    };

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevBg = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevEnv = scene.environment;
    scene.background = null;
    scene.environment = null;
    scene.overrideMaterial = heightMat;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(raw);
    renderer.clear();
    renderer.render(scene, cam);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    scene.environment = prevEnv;

    // Tight: ~2 cm blur at full resolution. Wide: downsample, then three broad passes.
    blur(raw, raw, tmp, 1 / RES, 0.9);
    blurMat.uniforms.tSrc.value = raw.texture;
    blurMat.uniforms.uDir.value.set(0, 0);
    pass(blurMat, wideA);
    for (let i = 0; i < 3; i++) blur(wideA, wideA, wideB, 1 / 128, 1.2 + i);
    combineMat.uniforms.tTight.value = raw.texture;
    combineMat.uniforms.tWide.value = wideA.texture;
    pass(combineMat, out);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    [raw, tmp, wideA, wideB].forEach((t) => t.dispose());
    [heightMat, blurMat, combineMat].forEach((m) => m.dispose());
    quad.geometry.dispose();
    return out;
  };
  const contactShadow = bakeContactShadow();
  floorUniforms.tShadow.value = contactShadow.texture;

  // ---------- Camera finish (high tier): MSAA, gentle bloom, grain and vignette ----------
  let post = null;
  const setupPost = async () => {
    const modules = await postModules;
    if (!modules || !renderer.extensions.has("EXT_color_buffer_float")) return null;
    const [{ UnrealBloomPass }, { FullScreenQuad }] = modules;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.16, 0.4, 1.5);
    bloom.highPassUniforms.smoothWidth.value = 0.6;
    // Clamp what feeds the bloom: a single grazing clearcoat sample can be in the thousands, and
    // the blur would spread it into a glowing block. Clamping keeps highlights round and modest.
    bloom.materialHighPassFilter.fragmentShader = bloom.materialHighPassFilter.fragmentShader.replace(
      "vec4 texel = texture2D( tDiffuse, vUv );",
      "vec4 texel = min( texture2D( tDiffuse, vUv ), vec4( 4.0 ) );",
    );
    const finishMat = new THREE.RawShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        toneMappingExposure: { value: 1 },
        tBloom: { value: bloom.renderTargetsHorizontal[0].texture },
        uTime: { value: 0 },
        uGrain: { value: 0.022 },
        uVignette: { value: 0.32 },
        uAspect: { value: 1 },
      },
      vertexShader: /* glsl */ `
        precision highp float;
        uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
        attribute vec3 position; attribute vec2 uv;
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom;
        uniform float uTime; uniform float uGrain; uniform float uVignette; uniform float uAspect;
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        varying vec2 vUv;
        float grainHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          #ifdef SR_BLOOM
          c.rgb += texture2D(tBloom, vUv).rgb;
          #endif
          // Lens falloff: darken the corners a little, before the tone curve, as a lens would.
          vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
          c.rgb *= 1.0 - uVignette * smoothstep(0.35, 1.25, dot(q, q) * 1.6);
          #ifdef NEUTRAL_TONE_MAPPING
            c.rgb = NeutralToneMapping(c.rgb);
          #elif defined( AGX_TONE_MAPPING )
            c.rgb = AgXToneMapping(c.rgb);
          #elif defined( ACES_FILMIC_TONE_MAPPING )
            c.rgb = ACESFilmicToneMapping(c.rgb);
          #endif
          c = sRGBTransferOETF(c);
          // Film grain in display space, strongest in the mid-tones, which also dithers the dark gradients.
          float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          float n = grainHash(gl_FragCoord.xy + fract(uTime * 7.31) * 913.0) + grainHash(gl_FragCoord.xy * 1.7 + 41.0 + fract(uTime * 3.17) * 577.0) - 1.0;
          c.rgb += n * uGrain * (0.35 + luma * (1.0 - luma) * 2.6);
          gl_FragColor = vec4(c.rgb, 1.0);
        }`,
    });
    finishMat.defines = { SR_BLOOM: "" };
    if (renderer.toneMapping === THREE.NeutralToneMapping) finishMat.defines.NEUTRAL_TONE_MAPPING = "";
    else if (renderer.toneMapping === THREE.AgXToneMapping) finishMat.defines.AGX_TONE_MAPPING = "";
    else if (renderer.toneMapping === THREE.ACESFilmicToneMapping) finishMat.defines.ACES_FILMIC_TONE_MAPPING = "";
    const finish = new FullScreenQuad(finishMat);
    // UnrealBloomPass's own render() blends back into its input, which would be the multisampled
    // target here (its samples are discarded once resolved). Run its stages and let the finish
    // pass add the result instead, which also saves a full-resolution pass.
    const clearKeep = new THREE.Color();
    const runBloom = (input) => {
      const autoClear = renderer.autoClear;
      const clearAlpha = renderer.getClearAlpha();
      renderer.getClearColor(clearKeep);
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);
      const step = (material, target) => {
        bloom.fsQuad.material = material;
        renderer.setRenderTarget(target);
        renderer.clear();
        bloom.fsQuad.render(renderer);
      };
      bloom.highPassUniforms.tDiffuse.value = input;
      bloom.highPassUniforms.luminosityThreshold.value = bloom.threshold;
      step(bloom.materialHighPassFilter, bloom.renderTargetBright);
      let src = bloom.renderTargetBright;
      for (let i = 0; i < bloom.nMips; i++) {
        const m = bloom.separableBlurMaterials[i];
        m.uniforms.colorTexture.value = src.texture;
        m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
        step(m, bloom.renderTargetsHorizontal[i]);
        m.uniforms.colorTexture.value = bloom.renderTargetsHorizontal[i].texture;
        m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
        step(m, bloom.renderTargetsVertical[i]);
        src = bloom.renderTargetsVertical[i];
      }
      bloom.compositeMaterial.uniforms.bloomStrength.value = bloom.strength;
      bloom.compositeMaterial.uniforms.bloomRadius.value = bloom.radius;
      step(bloom.compositeMaterial, bloom.renderTargetsHorizontal[0]);
      renderer.setClearColor(clearKeep, clearAlpha);
      renderer.autoClear = autoClear;
    };
    return {
      rt, bloom, finish, finishMat, runBloom, bloomOn: true,
      setBloom(on) {
        this.bloomOn = on;
        finishMat.defines = { ...finishMat.defines };
        if (on) finishMat.defines.SR_BLOOM = "";
        else delete finishMat.defines.SR_BLOOM;
        finishMat.needsUpdate = true;
      },
      setSize(w, h) {
        rt.setSize(w, h);
        bloom.setSize(w, h);
        finishMat.uniforms.uAspect.value = w / Math.max(h, 1);
      },
    };
  };
  post = wantPost ? await setupPost() : null;
  // With the camera finish the tail light reads as a bright LED that blooms; without it, as before.
  const lightGain = post ? 3.2 : 2.2;
  if (mats.light) mats.light.emissiveIntensity = lightGain;

  let frames = 0;
  const renderFrame = () => {
    frames += 1;
    if (!post) {
      renderer.render(scene, camera);
      return;
    }
    renderer.setRenderTarget(post.rt);
    renderer.render(scene, camera);
    if (post.bloomOn) post.runBloom(post.rt.texture);
    post.finishMat.uniforms.tDiffuse.value = post.rt.texture;
    post.finishMat.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    post.finishMat.uniforms.uTime.value = (frames % 997) / 97;
    renderer.setRenderTarget(null);
    post.finish.render(renderer);
  };

  // The photographed environment: use it for the first frame if it arrives quickly, otherwise
  // start with the procedural one and swap when it lands (the intro starts dark, so it's unseen).
  const quickPhoto = await Promise.race([envPhoto, new Promise((r) => setTimeout(() => r(undefined), 1200))]);
  applyEnv(quickPhoto || null);
  if (quickPhoto === undefined) {
    envPhoto.then((photo) => {
      if (!photo) return;
      applyEnv(photo);
      wake();
    });
  }

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
  let rigFade = 1;
  const setStudioLevel = (t) => {
    studioLevel = t;
    scene.environmentIntensity = t * (1 - 0.6 * uniforms.uXray.value);
    softbox.intensity = 5 * t;
    rim.intensity = 0.6 * t;
    floorUniforms.uRig.value = t * rigFade;
    floorUniforms.uGlow.value = t * (1 - 0.65 * uniforms.uXray.value);
    roomUniforms.uRoom.value = t * (1 - 0.7 * uniforms.uXray.value);
  };
  const setLight = (t) => { if (mats.light) mats.light.emissiveIntensity = lightGain * t; };
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
    if (mats.canopy) mats.canopy.opacity = CANOPY_OPACITY * (1 - 0.6 * x);
    for (const tire of parts.tires) tire.material.color.setScalar(0.04 + 0.1 * x);
    for (const m of parts.interior) {
      const e = m.userData.exported;
      m.transparent = x > 0.001 || e.transparent;
      m.opacity = e.opacity * (1 - THREE.MathUtils.smoothstep(x, 0, 0.6));
      m.depthWrite = x < 0.2 && e.depthWrite;
      m.visible = m.opacity > 0.005;
    }
    scene.environmentIntensity = studioLevel * (1 - 0.6 * x);
    roomUniforms.uRoom.value = studioLevel * (1 - 0.7 * x);
    floorUniforms.uGlow.value = studioLevel * (1 - 0.65 * x); // a darker floor lets the blueprint grid read
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
  // Drawing-buffer size for the canvas and the post-processing targets (also used for stills).
  const setRenderSize = (w, h, pixelRatio) => {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, false);
    if (post) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      post.setSize(size.x, size.y);
    }
  };
  const resize = (force = false) => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!force && w === width && h === height) return false;
    width = w;
    height = h;
    setRenderSize(w, h, dprCap());
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (high && floor.getRenderTarget) {
      const pr = renderer.getPixelRatio();
      const rw = Math.max(64, Math.round(w * pr * 0.5));
      const rh = Math.max(64, Math.round(h * pr * 0.5));
      floor.getRenderTarget().setSize(rw, rh);
      floorUniforms.uTexel.value.set(1 / rw, 1 / rh);
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
    // Adaptive safety net: if the high tier struggles, drop the bloom and the reflection pass.
    if (high && last && sampled < 90) {
      sampled += 1;
      if (now - last > 40) slowFrames += 1;
      if (sampled === 90 && slowFrames > 30) {
        if (post?.bloomOn) post.setBloom(false);
        if (floorUniforms.uStrength) {
          floorUniforms.uStrength.value = 0;
          floor.onBeforeRender = () => {};
        }
      }
    }
    last = now;
    if (schematic) schematic.pulseUniforms.uTime.value = now / 1000;
    const keepGoing = update ? update(dt, now) : false;
    renderFrame();
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
  // Leaving for another page: stop rendering at once so the navigation and the page slide get the
  // main thread and GPU. Coming back from the back/forward cache resumes.
  window.addEventListener("pageswap", () => {
    pageVisible = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    pageVisible = !document.hidden;
    wake();
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
    get frames() { return frames; },
    get post() { return !!post; },
    get inView() { return inView && pageVisible; },
    setLoop(fn) { update = fn; wake(); },
    wake,
    resize,
    onResize(fn) { resizeListeners.add(fn); },
    compile,
    toScreen,
    rollWheels,
    setCarOffset,
    setStudioLevel,
    setLight,
    setSweep,
    setXray,
    setBodyColor,
    setBodyMap,
    // Render one frame now, through the camera finish when there is one (Livery Lab stills).
    render: renderFrame,
    // Resize the drawing buffer (and post targets) for an offscreen still; resize(true) restores.
    setRenderSize,
    get schematic() { return schematic || buildSchematic(); },
    // Fade the overhead softboxes as the camera rises through the rig.
    fadeRig(cameraY) {
      rigFade = 1 - THREE.MathUtils.smoothstep(cameraY, 2.2, 3.2);
      floorUniforms.uRig.value = studioLevel * rigFade;
    },
  };
}
