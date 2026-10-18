// Carrera page: orbit the car in the studio, open hotspots, switch to the schematic view.
// The systems text lives in the static articles below the viewer; panels reuse that markup.
const viewer = document.querySelector(".viewer");
const stage = viewer.querySelector(".viewer-stage");
const canvas = viewer.querySelector(".viewer-canvas");
const loaderBar = viewer.querySelector(".viewer-loader");
const pinsEl = viewer.querySelector(".pins");
const panel = viewer.querySelector(".viewer-panel");
const panelBody = panel.querySelector(".panel-body");
const startBtn = viewer.querySelector(".viewer-start");
const modeButtons = [...viewer.querySelectorAll("[data-mode]")];
const resetBtn = viewer.querySelector('[data-action="reset"]');
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const compactQuery = window.matchMedia("(max-width: 760px)");

const ILLUSTRATIVE = "Marker position is illustrative; the internal layout is not from CAD.";
// Car axes: nose +Z, car-left (canopy side) +X, metres.
const PINS = [
  { id: "chassis", anchor: "Nose", label: "Carbon monocoque", system: "sys-chassis", view: { pos: [2.6, 1.5, 5.4], tgt: [0, 0.55, 1.4] } },
  { id: "array", anchor: "SolarArray", label: "1000 W solar array", system: "sys-energy", view: { pos: [3.2, 5.2, 3.4], tgt: [0, 0.6, 0] } },
  { id: "software", anchor: "Canopy", label: "Driver dashboard", system: "sys-software", view: { pos: [3.6, 2.2, 1.6], tgt: [0.5, 1.0, -0.4] } },
  { id: "suspension", anchor: "WheelFront", label: "Front suspension", system: "sys-suspension", schematic: true, view: { pos: [-4, 1.3, 3.8], tgt: [-0.6, 0.35, 1.2] } },
  { id: "drivetrain", anchor: "Motor", label: "Hub motor", system: "sys-drivetrain", schematic: true, note: "Which rear wheel carries the hub motor is illustrative.", view: { pos: [4.4, 1.2, -2.6], tgt: [0.6, 0.35, -0.4] } },
  { id: "battery", anchor: "BatteryPack", label: "Battery pack", system: "sys-energy", schematic: true, internal: true, note: ILLUSTRATIVE, view: { pos: [-3.9, 2.7, 2.7], tgt: [-0.5, 0.3, 0.4] } },
  { id: "power", anchor: "Power", label: "Power distribution", system: "sys-power", schematic: true, internal: true, note: ILLUSTRATIVE, view: { pos: [-2.9, 3.7, -2.4], tgt: [0, 0.3, 0] } },
];
const HOME_VIEW = { pos: [5.2, 1.8, 6.8], tgt: [0, 0.5, 0.1] };

const fail = (err) => {
  if (err) console.warn("[v2] 3D unavailable, keeping the poster:", err);
  viewer.classList.remove("is-loading");
  viewer.classList.add("has-error");
};

async function boot() {
  startBtn.hidden = true;
  const [{ createStudio, webglAvailable, THREE, HOTSPOTS_URL }, { OrbitControls }] = await Promise.all([
    import("./studio.js"),
    import("three/addons/controls/OrbitControls.js"),
  ]);
  if (!webglAvailable()) return fail("no WebGL");
  viewer.classList.add("is-loading");
  const [studio, meta] = await Promise.all([
    createStudio({ stage, canvas, onProgress: (p) => loaderBar.style.setProperty("--p", p.toFixed(3)) }),
    fetch(HOTSPOTS_URL).then((r) => r.json()).catch(() => ({ hotspots: {} })),
  ]);
  window.__studio = studio;
  const { camera, hotspots } = studio;
  const v3 = (a) => new THREE.Vector3(...a);
  // The power electronics sit between the pack and the motor in the schematic.
  if (hotspots.BatteryPack && hotspots.Motor) {
    hotspots.Power = hotspots.BatteryPack.clone().lerp(hotspots.Motor, 0.5).setY(0.3);
  }
  const normals = {};
  for (const [name, h] of Object.entries(meta.hotspots || {})) {
    if (h.normal && h.kind !== "interior") normals[name.replace("Hotspot_", "")] = v3(h.normal);
  }

  // ---------- Controls ----------
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 3.2;
  controls.maxDistance = 15;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.rotateSpeed = 0.6;
  // A slow turntable on capable devices only, and only for a while: it renders every frame.
  controls.autoRotate = !reduceMotion && studio.quality === "high";
  controls.autoRotateSpeed = 0.5;
  const stopTurntable = setTimeout(() => { controls.autoRotate = false; }, 14000);

  const pullFor = () => {
    const aspect = studio.width / Math.max(studio.height, 1);
    return Math.max(1, Math.pow(1.45 / aspect, 0.7));
  };
  const resolveView = (view) => {
    const tgt = v3(view.tgt);
    return { tgt, pos: v3(view.pos).sub(tgt).multiplyScalar(pullFor()).add(tgt) };
  };
  const home = () => resolveView(HOME_VIEW);
  {
    const h = home();
    camera.position.copy(h.pos);
    controls.target.copy(h.tgt);
    camera.fov = 30;
    controls.update();
  }

  // Shift the framing so the car clears the copy (left) or the open panel (right).
  let offset = 0;
  let offsetTarget = 0;
  const desiredOffset = () => {
    if (compactQuery.matches) return 0;
    return panel.hidden ? -0.1 : 0.14;
  };
  const applyOffset = () => {
    const w = studio.width;
    const h = studio.height;
    camera.setViewOffset(w, h, offset * w, 0, w, h);
    camera.updateProjectionMatrix();
  };

  // ---------- Camera flights ----------
  let flight = null;
  const flyTo = (view) => {
    controls.autoRotate = false;
    if (reduceMotion) {
      camera.position.copy(view.pos);
      controls.target.copy(view.tgt);
      controls.update();
      studio.wake();
      return;
    }
    flight = { t: 0, fromPos: camera.position.clone(), fromTgt: controls.target.clone(), ...view };
    controls.enabled = false;
    studio.wake();
  };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // ---------- Schematic mode ----------
  let xray = 0;
  let xrayTarget = 0;
  let energy = 0;
  const setMode = (mode) => {
    xrayTarget = mode === "schematic" ? 1 : 0;
    modeButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    studio.wake();
  };
  modeButtons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  // ---------- Pins and panel ----------
  const pins = PINS.filter((p) => hotspots[p.anchor]).map((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pin${p.schematic ? " schematic" : ""}`;
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "viewer-panel");
    btn.innerHTML = `<span class="pin-dot" aria-hidden="true"></span><span class="pin-label">${p.label}</span>`;
    btn.addEventListener("click", () => (btn.getAttribute("aria-expanded") === "true" ? closePanel() : openPin(p, btn)));
    pinsEl.append(btn);
    return { ...p, btn, point: hotspots[p.anchor], normal: normals[p.anchor] };
  });
  panel.id = "viewer-panel";

  function openPin(pin, btn) {
    const article = document.getElementById(pin.system);
    panelBody.replaceChildren();
    if (article) {
      const media = article.querySelector(".system-media")?.cloneNode(true);
      const copy = article.querySelector(".system-copy")?.cloneNode(true);
      media?.querySelectorAll("img").forEach((img) => img.removeAttribute("loading"));
      if (media) panelBody.append(media);
      if (copy) {
        copy.querySelector("h3")?.setAttribute("id", "viewer-panel-title");
        panelBody.append(copy);
      }
    }
    if (pin.note) {
      const note = document.createElement("p");
      note.className = "panel-note";
      note.textContent = pin.note;
      panelBody.append(note);
    }
    const more = document.createElement("a");
    more.className = "link-arrow panel-more";
    more.href = `#${pin.system}`;
    more.textContent = "More on this system";
    panelBody.append(more);
    panel.setAttribute("aria-labelledby", "viewer-panel-title");
    panel.classList.toggle("schematic", !!pin.schematic);
    panel.hidden = false;
    pins.forEach((p) => p.btn.setAttribute("aria-expanded", String(p.btn === btn)));
    setMode(pin.schematic ? "schematic" : "studio");
    flyTo(resolveView(pin.view));
    offsetTarget = desiredOffset();
  }
  function closePanel() {
    panel.hidden = true;
    pins.forEach((p) => p.btn.setAttribute("aria-expanded", "false"));
    offsetTarget = desiredOffset();
    studio.wake();
  }
  panel.querySelector(".panel-close").addEventListener("click", closePanel);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) closePanel(); });
  resetBtn.addEventListener("click", () => {
    closePanel();
    setMode("studio");
    flyTo(home());
  });

  const toCam = new THREE.Vector3();
  const updatePins = () => {
    for (const p of pins) {
      const s = studio.toScreen(p.point);
      let visible = !s.behind && s.x > 0 && s.x < studio.width && s.y > 0 && s.y < studio.height;
      if (p.internal) visible = visible && xray > 0.5;
      else if (p.normal && xray < 0.5) visible = visible && toCam.subVectors(camera.position, p.point).dot(p.normal) > 0;
      p.btn.hidden = !visible;
      p.btn.style.setProperty("--x", `${s.x.toFixed(1)}px`);
      p.btn.style.setProperty("--y", `${s.y.toFixed(1)}px`);
    }
  };

  // ---------- Loop ----------
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
    clearTimeout(stopTurntable);
    flight = null;
    controls.enabled = true;
  });
  controls.addEventListener("change", () => studio.wake());
  studio.setLoop((dt) => {
    let busy = false;
    if (flight) {
      flight.t = Math.min(1, flight.t + dt / 1.1);
      const k = ease(flight.t);
      camera.position.lerpVectors(flight.fromPos, flight.pos, k);
      controls.target.lerpVectors(flight.fromTgt, flight.tgt, k);
      if (flight.t >= 1) {
        flight = null;
        controls.enabled = true;
      }
      busy = true;
    }
    const moved = controls.update();
    const step = reduceMotion ? 1 : 1 - Math.exp(-dt * 4);
    xray += (xrayTarget - xray) * step;
    if (Math.abs(xrayTarget - xray) < 0.002) xray = xrayTarget;
    energy += ((xrayTarget > 0 ? 1 : 0) - energy) * (reduceMotion ? 1 : 1 - Math.exp(-dt * 1.6));
    if (Math.abs((xrayTarget > 0 ? 1 : 0) - energy) < 0.002) energy = xrayTarget > 0 ? 1 : 0;
    studio.setXray(xray, energy);
    offset += (offsetTarget - offset) * step;
    if (Math.abs(offsetTarget - offset) < 0.0005) offset = offsetTarget;
    applyOffset();
    updatePins();
    busy = busy || moved || controls.autoRotate || xray !== xrayTarget || offset !== offsetTarget || (xrayTarget > 0 && energy < 1);
    return busy;
  });

  studio.onResize(() => {
    offsetTarget = desiredOffset();
    studio.wake();
  });
  compactQuery.addEventListener("change", () => { offsetTarget = desiredOffset(); studio.wake(); });
  offsetTarget = desiredOffset();
  offset = offsetTarget;
  applyOffset();

  await studio.compile();
  viewer.classList.remove("is-loading");
  viewer.classList.add("is-ready");
  studio.wake();
}

const start = () => boot().catch(fail);
if (reduceMotion) {
  // Motion-sensitive visitors get the still image first and can opt in to the viewer.
  startBtn.hidden = false;
  startBtn.addEventListener("click", start, { once: true });
} else {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  if (document.readyState === "complete") idle(start, { timeout: 1200 });
  else window.addEventListener("load", () => idle(start, { timeout: 1200 }), { once: true });
}
