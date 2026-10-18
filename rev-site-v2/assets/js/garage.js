// Livery Lab: paint Carrera's body through its UV atlas with a 2D canvas, orbit it in the studio,
// save a beauty shot and share designs through the URL hash.
//
// How the paint reaches the car: the body material "CarBody" carries a planar-projection UV atlas
// (see body_uv_atlas in carrera-v2-hotspots.json). Every region is an exact linear map from world
// metres to UV, measured from the model, so each region below lists u = a*h + b and v = c*w + d,
// where (h, w) are the two world axes that region projects. v is measured from the top of the image
// (glTF convention, texture.flipY = false). Patterns draw in world metres, so a stripe at a given
// height lines up across both sides, the nose and the tail. Text and logos are placed by world
// position but drawn upright in image space, which reads correctly because every region is laid
// out "as seen from outside".

const stage = document.getElementById("stage");
const canvas = stage.querySelector(".lab-canvas");
const loaderBar = stage.querySelector(".lab-loader");
const form = document.getElementById("livery");
const controlsSet = form.querySelector(".lab-controls");
const statusEl = document.getElementById("status");
const viewButtons = [...stage.querySelectorAll(".lab-views button")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- State ----------
const PATTERNS = ["clean", "twin", "fade", "speed", "split", "sunburst", "carbon"];
const DEFAULTS = Object.freeze({ base: "#0b2a4a", accent: "#f2c15b", pattern: "twin", number: "27", logo: true });
const state = { ...DEFAULTS };
let art = null; // { img, url, size, z, y } — local only, never encoded in links

const HEX = /^#?([0-9a-f]{6})$/i;
const normHex = (v) => {
  const m = HEX.exec(String(v || "").trim());
  return m ? `#${m[1].toLowerCase()}` : null;
};

function encodeHash(s) {
  const p = new URLSearchParams();
  p.set("base", s.base.slice(1));
  p.set("accent", s.accent.slice(1));
  p.set("pattern", s.pattern);
  p.set("number", s.number);
  p.set("logo", s.logo ? "1" : "0");
  return p.toString();
}
function decodeHash(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  if (![...p.keys()].length) return null;
  const out = {};
  const base = normHex(p.get("base"));
  const accent = normHex(p.get("accent"));
  if (base) out.base = base;
  if (accent) out.accent = accent;
  if (PATTERNS.includes(p.get("pattern"))) out.pattern = p.get("pattern");
  if (p.has("number")) out.number = (p.get("number") || "").replace(/\D/g, "").slice(0, 3);
  if (p.has("logo")) out.logo = p.get("logo") !== "0";
  return out;
}

// ---------- Colour helpers ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const la = lum(typeof a === "string" ? rgb(a) : a);
  const lb = lum(typeof b === "string" ? rgb(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const rgba = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; };
const WHITE = "#f7f7f4";
const INK = "#0f1115";
const best = (bg, options) => options.reduce((a, b) => (contrast(b, bg) > contrast(a, bg) ? b : a));

// ---------- UV atlas ----------
const K = 0.12146; // UV units per metre (1 / 8.234 m)
// rect: [x0, y0, x1, y1] as fractions of the image from the top-left. u/v: [scale, offset].
const REGIONS = {
  top:    { kind: "top",    rect: [0.0073, 0.0072, 0.5923, 0.2342], u: [-K, 0.30024], v: [K, 0.12076] },  // h = z, w = x
  left:   { kind: "side",   rect: [0.0073, 0.2415, 0.5923, 0.3919], u: [-K, 0.30023], v: [-K, 0.40117], outer: true }, // h = z, w = y
  right:  { kind: "side",   rect: [0.0073, 0.3992, 0.5923, 0.5496], u: [K, 0.29932], v: [-K, 0.55882], outer: true },
  bottom: { kind: "bottom", rect: [0.0073, 0.5568, 0.5923, 0.7838], u: [-K, 0.30024], v: [-K, 0.67033] }, // h = z, w = x
  innerL: { kind: "side",   rect: [0.0073, 0.7911, 0.5923, 0.8883], u: [K, 0.29934], v: [-K, 0.89752] },
  innerR: { kind: "side",   rect: [0.0073, 0.8955, 0.5923, 0.9927], u: [-K, 0.30021], v: [-K, 1.00197] },
  front:  { kind: "end",    rect: [0.5996, 0.0073, 0.8266, 0.1577], u: [K, 0.71306], v: [-K, 0.16691], z: 2.4 },  // h = x, w = y
  back:   { kind: "end",    rect: [0.5996, 0.1649, 0.8266, 0.3153], u: [-K, 0.71301], v: [-K, 0.32461], z: -2.4 },
};

// Where things sit on the outer sides (world metres; z along the car, nose +z; y up).
const ROUNDEL = { z: 0.5, y: 0.45, r: 0.2 };   // between the wheel fairings
const WORDMARK = { z: -1.12, y: 0.27, w: 0.52 }; // behind the rear wheel, below the stripes
const WORDMARK_Y = { speed: 0.45, carbon: 0.5 }; // patterns that need the mark elsewhere

// ---------- REV mark from the page's own logo symbol ----------
let markPath = null;
const getMark = () => {
  if (markPath) return markPath;
  markPath = new Path2D();
  const symbol = document.getElementById("rev-mark");
  symbol?.querySelectorAll("path, polygon").forEach((el) => {
    if (el.tagName === "path") markPath.addPath(new Path2D(el.getAttribute("d")));
    else {
      const n = el.getAttribute("points").trim().split(/[\s,]+/).map(Number);
      let d = `M${n[0]},${n[1]}`;
      for (let i = 2; i < n.length; i += 2) d += `L${n[i]},${n[i + 1]}`;
      markPath.addPath(new Path2D(`${d}Z`));
    }
  });
  return markPath;
};

// ---------- Patterns (draw in world metres; ctx already maps (h, w) to pixels) ----------
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const isSide = (v) => v.kind === "side";

let weaveTile = null;
const weave = (ctx, x, y, w, h) => {
  if (!weaveTile) {
    // 2/2 twill, 4x4 tows per tile.
    const t = document.createElement("canvas");
    t.width = t.height = 64;
    const c = t.getContext("2d");
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const along = (i + j) % 4 < 2;
        const g = along ? c.createLinearGradient(i * 16, 0, i * 16 + 16, 0) : c.createLinearGradient(0, j * 16, 0, j * 16 + 16);
        g.addColorStop(0, along ? "#1c1f24" : "#121417");
        g.addColorStop(0.5, along ? "#30343b" : "#1d2025");
        g.addColorStop(1, along ? "#1c1f24" : "#121417");
        c.fillStyle = g;
        c.fillRect(i * 16, j * 16, 16, 16);
      }
    }
    weaveTile = t;
  }
  const pattern = ctx.createPattern(weaveTile, "repeat");
  pattern.setTransform(new DOMMatrix().scale(0.09 / 64)); // a tile is 9 cm
  ctx.fillStyle = pattern;
  ctx.fillRect(x, y, w, h);
};

const PAINTERS = {
  clean() {},

  twin(ctx, v, c) {
    ctx.fillStyle = c.accent;
    if (isSide(v) || v.kind === "end") {
      ctx.fillRect(-3, 0.40, 6, 0.07);
      ctx.fillRect(-3, 0.505, 6, 0.07);
    } else if (v.kind === "top") {
      // Over the canopy fairing (car-left pod, x ≈ 0.63).
      ctx.fillRect(-2.0, 0.515, 2.9, 0.075);
      ctx.fillRect(-2.0, 0.64, 2.9, 0.075);
    }
  },

  fade(ctx, v, c) {
    // Solid accent at the nose breaking into halftone dots towards the tail.
    ctx.fillStyle = c.accent;
    if (v.kind === "end") { if (v.z > 0) ctx.fillRect(-3, -1, 6, 3); return; }
    if (v.kind === "bottom") return;
    const z0 = -0.6;
    const z1 = 2.05;
    const [w0, w1] = v.kind === "top" ? [-1.1, 1.1] : [-0.1, 1.45];
    ctx.fillRect(z1, w0, 3, w1 - w0);
    const sp = 0.05;
    ctx.beginPath();
    for (let z = z1, col = 0; z > z0; z -= sp, col++) {
      const t = smooth(z0, z1 + 0.1, z);
      const r = sp * 0.74 * Math.pow(t, 1.15);
      if (r < 0.002) continue;
      for (let w = w0 + (col % 2) * sp * 0.5; w < w1; w += sp) {
        ctx.moveTo(z + r, w);
        ctx.arc(z, w, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  },

  speed(ctx, v, c) {
    const lines = [[0.19, 0.05, -1.05], [0.265, 0.02, 0.1], [0.6, 0.06, -1.45], [0.685, 0.024, -0.35], [0.735, 0.012, 0.55]];
    ctx.fillStyle = c.accent;
    if (v.kind === "end") {
      if (v.z > 0) for (const [y, t] of lines) ctx.fillRect(-3, y - t / 2, 6, t);
      return;
    }
    if (!isSide(v)) return;
    ctx.beginPath();
    for (const [y, t, end] of lines) {
      ctx.moveTo(3, y - t / 2);
      ctx.lineTo(3, y + t / 2);
      ctx.lineTo(end, y + t * 0.1);
      ctx.closePath();
    }
    ctx.fill();
  },

  split(ctx, v, c) {
    // Accent below a line that rises from the nose to the tail, with a trim pinstripe.
    const low = 0.3;
    const high = 0.58;
    const score = (t) => Math.min(contrast(t, c.base), contrast(t, c.accent));
    const trim = score(WHITE) >= score(INK) ? WHITE : INK;
    if (v.kind === "bottom") { ctx.fillStyle = c.accent; ctx.fillRect(-3, -2, 6, 4); return; }
    if (v.kind === "end") {
      const y = v.z > 0 ? low : high;
      ctx.fillStyle = c.accent;
      ctx.fillRect(-3, -1, 6, 1 + y);
      ctx.fillStyle = trim;
      ctx.fillRect(-3, y + 0.024, 6, 0.016);
      return;
    }
    if (!isSide(v)) return;
    const edge = (off) => { ctx.lineTo(3, low + off); ctx.lineTo(2.1, low + off); ctx.lineTo(-2.1, high + off); ctx.lineTo(-3, high + off); };
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(3, -1);
    edge(0);
    ctx.lineTo(-3, -1);
    ctx.fill();
    ctx.fillStyle = trim;
    ctx.beginPath();
    ctx.moveTo(3, low + 0.024);
    edge(0.024);
    ctx.lineTo(-3, high + 0.04);
    ctx.lineTo(-2.1, high + 0.04);
    ctx.lineTo(2.1, low + 0.04);
    ctx.lineTo(3, low + 0.04);
    ctx.fill();
  },

  sunburst(ctx, v, c) {
    // Rays fanning out from behind the race number, outer sides only.
    if (!(isSide(v) && v.outer)) return;
    const { z, y } = ROUNDEL;
    const g = ctx.createRadialGradient(z, y, 0.16, z, y, 2.2);
    g.addColorStop(0, rgba(c.accent, 1));
    g.addColorStop(0.45, rgba(c.accent, 0.75));
    g.addColorStop(1, rgba(c.accent, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    const n = 15;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2 + 0.06;
      const a1 = a0 + Math.PI / n;
      ctx.moveTo(z, y);
      ctx.lineTo(z + Math.cos(a0) * 3.2, y + Math.sin(a0) * 3.2);
      ctx.lineTo(z + Math.cos(a1) * 3.2, y + Math.sin(a1) * 3.2);
      ctx.closePath();
    }
    ctx.fill();
  },

  carbon(ctx, v, c) {
    // Carbon sills, belly and canopy fairing with accent pinstripes.
    if (v.kind === "bottom" || v.kind === "top") { weave(ctx, -3, -2, 6, 4); return; }
    if (v.kind === "end" || isSide(v)) {
      weave(ctx, -3, -1, 6, 1.3);
      ctx.fillStyle = c.accent;
      ctx.fillRect(-3, 0.3, 6, 0.018);
      if (v.kind === "end" && v.z > 0) return;
      ctx.fillRect(-3, 0.335, 6, 0.008);
    }
  },
};

// ---------- Decals (outer sides): artwork, wordmark, race number ----------
// toPx maps world (z, y) on that side to pixels; ppm is pixels per metre.
function drawDecals(ctx, toPx, ppm, s, { sampleBg = true } = {}) {
  if (art?.img) {
    const w = art.size * ppm;
    const h = w * (art.img.naturalHeight || art.img.height) / (art.img.naturalWidth || art.img.width);
    const [x, y] = toPx(art.z, art.y);
    ctx.drawImage(art.img, x - w / 2, y - h / 2, w, h);
  }

  if (s.logo) {
    const w = WORDMARK.w * ppm;
    const h = w * 80 / 235.06;
    const [x, y] = toPx(WORDMARK.z, WORDMARK_Y[s.pattern] ?? WORDMARK.y);
    let colour = contrast(s.accent, s.base) >= 3 ? s.accent : best(s.base, [WHITE, INK]);
    if (sampleBg) {
      // Pick the colour that stands out best from what is actually painted under the mark,
      // preferring the accent when it does nearly as well.
      try {
        const sx = Math.max(0, Math.round(x - w / 2));
        const sy = Math.max(0, Math.round(y - h / 2));
        const data = ctx.getImageData(sx, sy, Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data;
        const px = [];
        for (let i = 0; i < data.length; i += 20) px.push([data[i], data[i + 1], data[i + 2]]);
        const score = (cand) => px.reduce((a, p) => a + Math.min(contrast(cand, p), 4.5), 0) / px.length;
        const scores = [s.accent, WHITE, INK].map(score);
        const top = Math.max(...scores);
        colour = scores[0] >= top * 0.85 ? s.accent : (scores[1] >= scores[2] ? WHITE : INK);
      } catch { /* keep the estimate */ }
    }
    ctx.save();
    ctx.translate(x - w / 2, y - h / 2);
    ctx.scale(w / 235.06, h / 80);
    ctx.fillStyle = colour;
    ctx.fill(getMark());
    ctx.restore();
  }

  if (s.number) {
    const [x, y] = toPx(ROUNDEL.z, ROUNDEL.y);
    const r = ROUNDEL.r * ppm;
    const ring = contrast(s.accent, WHITE) >= 1.6 ? s.accent : (contrast(s.base, WHITE) >= 1.6 ? s.base : INK);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = WHITE;
    ctx.fill();
    const lw = 0.03 * ppm;
    ctx.beginPath();
    ctx.arc(x, y, r - lw / 2, 0, Math.PI * 2);
    ctx.lineWidth = lw;
    ctx.strokeStyle = ring;
    ctx.stroke();
    const size = [0, 0.25, 0.22, 0.17][s.number.length] * ppm;
    ctx.font = `900 ${size}px "REV Text", Lato, "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const m = ctx.measureText(s.number);
    const fit = Math.min(1, (r * 1.42) / Math.max(1, m.width));
    const asc = m.actualBoundingBoxAscent || size * 0.72;
    const desc = m.actualBoundingBoxDescent || 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(fit, fit);
    ctx.fillStyle = INK;
    ctx.fillText(s.number, 0, (asc - desc) / 2);
    ctx.restore();
  }
}

// ---------- Atlas painter ----------
const colours = (s) => ({ base: s.base, accent: s.accent });

function paintAtlas(ctx, S, s) {
  const c = colours(s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = s.base;
  ctx.fillRect(0, 0, S, S);
  const pad = 5;
  for (const [name, r] of Object.entries(REGIONS)) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.rect[0] * S - pad, r.rect[1] * S - pad, (r.rect[2] - r.rect[0]) * S + pad * 2, (r.rect[3] - r.rect[1]) * S + pad * 2);
    ctx.clip();
    ctx.setTransform(r.u[0] * S, 0, 0, r.v[0] * S, r.u[1] * S, r.v[1] * S);
    PAINTERS[s.pattern](ctx, { kind: r.kind, outer: !!r.outer, z: r.z, name }, c);
    if (r.outer) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const toPx = (z, y) => [(r.u[0] * z + r.u[1]) * S, (r.v[0] * y + r.v[1]) * S];
      drawDecals(ctx, toPx, K * S, s);
    }
    ctx.restore();
  }
}

// ---------- Pattern tile previews (left side profile, nose left) ----------
const PROFILE = [[2.0, 0.11], [2.22, 0.2], [2.36, 0.38], [2.42, 0.58], [2.38, 0.68], [2.2, 0.74], [1.6, 0.8], [1.0, 0.84], [0.55, 0.86], [0.35, 0.92], [0.15, 1.1], [-0.12, 1.24], [-0.45, 1.27], [-0.78, 1.2], [-1.05, 1.0], [-1.3, 0.86], [-1.75, 0.76], [-2.38, 0.68], [-2.43, 0.64], [-2.0, 0.6], [-1.75, 0.56], [-1.55, 0.2], [-1.4, 0.11]];
const GLASS = [[0.5, 0.88], [0.32, 0.94], [0.12, 1.12], [-0.12, 1.235], [-0.42, 1.255], [-0.3, 1.1], [-0.05, 0.96], [0.25, 0.89]];

function paintPreview(cv, pattern, s) {
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const W = cv.width;
  const H = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const ppm = Math.min(W / 5.1, H / 1.42);
  const ox = W / 2;
  const oy = H / 2 + 0.66 * ppm;
  const toPx = (z, y) => [ox - z * ppm, oy - y * ppm];
  const shape = (pts) => { ctx.beginPath(); pts.forEach(([z, y], i) => (i ? ctx.lineTo(...toPx(z, y)) : ctx.moveTo(...toPx(z, y)))); ctx.closePath(); };

  // Wheels peeking below the fairings.
  ctx.fillStyle = "#050506";
  for (const z of [1.38, -0.38]) { ctx.beginPath(); ctx.arc(...toPx(z, 0.313), 0.313 * ppm, 0, Math.PI * 2); ctx.fill(); }

  ctx.save();
  shape(PROFILE);
  ctx.clip();
  ctx.setTransform(-ppm, 0, 0, -ppm, ox, oy);
  ctx.fillStyle = s.base;
  ctx.fillRect(-3, -1, 6, 3);
  PAINTERS[pattern](ctx, { kind: "side", outer: true }, colours(s));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawDecals(ctx, toPx, ppm, { ...s, pattern });
  ctx.restore();

  ctx.fillStyle = "rgba(4, 5, 7, 0.92)";
  shape(GLASS);
  ctx.fill();
  // Solar array edge along the top.
  ctx.strokeStyle = "rgba(111, 134, 166, 0.85)";
  ctx.lineWidth = Math.max(1, ppm * 0.02);
  ctx.beginPath();
  ctx.moveTo(...toPx(2.17, 0.79));
  ctx.lineTo(...toPx(0.6, 0.86));
  ctx.moveTo(...toPx(-1.3, 0.86));
  ctx.lineTo(...toPx(-2.37, 0.69));
  ctx.stroke();
}

// ---------- UI ----------
const previews = [...form.querySelectorAll(".pattern canvas")];
const dpr = Math.min(2, window.devicePixelRatio || 1);
previews.forEach((cv) => { cv.width = Math.round(240 * dpr); cv.height = Math.round(56 * dpr); });

function syncUI() {
  for (const input of form.querySelectorAll('input[name="pattern"]')) input.checked = input.value === state.pattern;
  for (const key of ["base", "accent"]) {
    let matched = false;
    for (const input of form.querySelectorAll(`input[name="${key}"]`)) {
      input.checked = input.value === state[key];
      matched ||= input.checked;
    }
    const custom = form.querySelector(`input[name="${key}-custom"]`);
    custom.value = state[key];
    custom.parentElement.classList.toggle("is-on", !matched);
    custom.parentElement.style.setProperty("--c", state[key]);
    document.getElementById(`${key}-hex`).textContent = state[key].toUpperCase();
  }
  const num = form.elements.number;
  if (num.value !== state.number) num.value = state.number;
  form.elements.logo.checked = state.logo;
}

let paintQueued = false;
let afterPaint = null; // set by the 3D boot: upload the texture and redraw
const schedulePaint = () => {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(paintNow);
};
function paintNow() {
  paintQueued = false;
  previews.forEach((cv, i) => paintPreview(cv, PATTERNS[i], state));
  afterPaint?.();
}

let hashTimer = 0;
const writeHash = () => {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => history.replaceState(null, "", `${location.pathname}${location.search}#${encodeHash(state)}`), 250);
};

function setState(patch, { hash = true } = {}) {
  Object.assign(state, patch);
  syncUI();
  schedulePaint();
  if (hash) writeHash();
}

let statusTimer = 0;
const say = (msg, hold = 4000) => {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  if (hold) statusTimer = setTimeout(() => { statusEl.textContent = ""; }, hold);
};

form.addEventListener("submit", (e) => e.preventDefault());
form.addEventListener("change", (e) => {
  const t = e.target;
  if (t.name === "pattern") setState({ pattern: t.value });
  else if (t.name === "base" || t.name === "accent") setState({ [t.name]: t.value });
  else if (t.name === "logo") setState({ logo: t.checked });
});
form.addEventListener("input", (e) => {
  const t = e.target;
  if (t.name === "base-custom" || t.name === "accent-custom") setState({ [t.name.split("-")[0]]: normHex(t.value) || state[t.name.split("-")[0]] });
  else if (t.name === "number") {
    const clean = t.value.replace(/\D/g, "").slice(0, 3);
    t.setAttribute("aria-invalid", String(clean !== t.value));
    if (clean !== t.value) {
      t.value = clean;
      say("Race numbers use digits only.", 2500);
    }
    setState({ number: clean });
  } else if (t.name?.startsWith("art-") && art) {
    art[t.name.slice(4)] = Number(t.value);
    schedulePaint();
  }
});

// Artwork: read locally with an object URL; nothing is sent anywhere.
const artFile = document.getElementById("art-file");
const artRemove = document.getElementById("art-remove");
const artSliders = [...form.querySelectorAll('input[name^="art-"]')];
const setArtControls = (on) => { artSliders.forEach((s) => { s.disabled = !on; }); artRemove.disabled = !on; };
const clearArt = () => {
  if (art?.url) URL.revokeObjectURL(art.url);
  art = null;
  artFile.value = "";
  setArtControls(false);
};
artFile.addEventListener("change", () => {
  const file = artFile.files?.[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) { say("Choose a PNG, JPEG, WebP or SVG image."); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    if (art?.url) URL.revokeObjectURL(art.url);
    const v = Object.fromEntries(artSliders.map((s) => [s.name.slice(4), Number(s.value)]));
    art = { img, url, ...v };
    setArtControls(true);
    schedulePaint();
    say("Artwork placed on both sides. It stays on this device.");
  };
  img.onerror = () => { URL.revokeObjectURL(url); say("That image couldn’t be read. Try a PNG or JPEG."); };
  img.src = url;
});
artRemove.addEventListener("click", () => { clearArt(); schedulePaint(); say("Artwork removed."); });

// Restore a shared design, then start.
const fromHash = decodeHash(location.hash);
if (fromHash) Object.assign(state, fromHash);
controlsSet.disabled = false;
syncUI();
schedulePaint();
// Repaint the tile previews once the race-number face arrives.
document.fonts?.load('900 64px "REV Text"').then(schedulePaint, () => {});
window.addEventListener("hashchange", () => {
  const next = decodeHash(location.hash);
  if (next) setState({ ...DEFAULTS, ...next }, { hash: false });
});

// ---------- 3D ----------
const VIEWS = {
  hero: { theta: 0.72, phi: 1.3, dist: 1 },
  left: { theta: Math.PI / 2, phi: 1.45, dist: 0.95 },
  right: { theta: -Math.PI / 2, phi: 1.45, dist: 0.95 },
  nose: { theta: 0, phi: 1.32, dist: 0.72 },
  tail: { theta: Math.PI, phi: 1.32, dist: 0.72 },
  top: { theta: Math.PI / 2, phi: 0.06, dist: 1.02 },
};

const fail = (err) => {
  if (err) console.warn("[v2] Livery Lab 3D unavailable:", err);
  stage.classList.remove("is-loading");
  stage.classList.add("has-error");
  controlsSet.disabled = true;
};

async function boot() {
  const [{ createStudio, webglAvailable, THREE }, { OrbitControls }] = await Promise.all([
    import("./studio.js"),
    import("three/addons/controls/OrbitControls.js"),
  ]);
  if (!webglAvailable()) return fail("no WebGL");
  stage.classList.add("is-loading");
  const studio = await createStudio({
    stage,
    canvas,
    onProgress: (p) => loaderBar.style.setProperty("--p", p.toFixed(3)),
  });
  window.__studio = studio; // for debugging and screenshots
  const { camera, renderer } = studio;

  // Livery texture.
  const S = 2048;
  const atlas = document.createElement("canvas");
  atlas.width = atlas.height = S;
  const actx = atlas.getContext("2d", { willReadFrequently: true }); // CPU canvas: one readback per paint, fast uploads
  const texture = new THREE.CanvasTexture(atlas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(studio.quality === "high" ? 8 : 4, renderer.capabilities.getMaxAnisotropy());
  // Canvas text only uses a web font once it has loaded: wait for the number face (and the caption face).
  try {
    await Promise.race([
      Promise.all([document.fonts.load('900 64px "REV Text"'), document.fonts.load('700 34px "Martian Mono"')]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch { /* system font fallback */ }
  afterPaint = () => {
    paintAtlas(actx, S, state);
    texture.needsUpdate = true;
    studio.wake();
  };
  paintAtlas(actx, S, state);
  studio.setBodyMap(texture);

  // Orbit.
  const target = new THREE.Vector3(0, 0.42, 0);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 0.7;
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = 1.5;
  // The turntable renders every frame, so it runs on capable devices only and stops by itself.
  controls.autoRotate = !reduceMotion && studio.quality === "high";
  controls.autoRotateSpeed = 0.7;
  setTimeout(() => { controls.autoRotate = false; }, 14000);
  camera.fov = 30;

  let touched = false;
  let fit = 9;
  const fitDistance = () => {
    const aspect = studio.width / Math.max(1, studio.height);
    const vf = THREE.MathUtils.degToRad(camera.fov);
    const hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
    return (2.55 / Math.sin(Math.min(vf, hf) / 2)) * (aspect > 1.1 ? 0.9 : 1.02);
  };
  const sph = new THREE.Spherical();
  const placeAt = (theta, phi, radius) => {
    sph.set(radius, phi, theta);
    camera.position.setFromSpherical(sph).add(controls.target);
    camera.lookAt(controls.target);
  };
  const relayout = () => {
    camera.clearViewOffset();
    const prev = fit;
    fit = fitDistance();
    controls.minDistance = fit * 0.45;
    controls.maxDistance = fit * 1.6;
    sph.setFromVector3(camera.position.clone().sub(controls.target));
    placeAt(sph.theta, sph.phi, touched ? THREE.MathUtils.clamp(sph.radius * (fit / prev), controls.minDistance, controls.maxDistance) : fit * VIEWS.hero.dist);
    controls.update();
  };
  fit = fitDistance();
  placeAt(VIEWS.hero.theta, VIEWS.hero.phi, fit);
  studio.onResize(relayout);
  relayout();

  const press = (name) => viewButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === name)));
  const takeOver = () => {
    if (!touched) stage.classList.add("is-touched");
    touched = true;
    controls.autoRotate = false;
  };
  let tween = null;
  controls.addEventListener("start", () => { takeOver(); tween = null; press(""); });
  controls.addEventListener("change", () => studio.wake());

  // Scrolling over the car scrolls the page; zoom needs a pinch, Ctrl/Cmd + wheel, or a click in the stage first.
  let engaged = false;
  stage.addEventListener("pointerdown", () => { engaged = true; });
  stage.addEventListener("pointerleave", () => { engaged = false; });
  stage.addEventListener("wheel", (e) => {
    if (!engaged && !e.ctrlKey && !e.metaKey) e.stopPropagation();
    else takeOver();
  }, { capture: true });

  const goTo = (name) => {
    const v = VIEWS[name];
    if (!v) return;
    takeOver();
    press(name);
    sph.setFromVector3(camera.position.clone().sub(controls.target));
    let dTheta = v.theta - sph.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    const to = { theta: sph.theta + dTheta, phi: v.phi, radius: fit * v.dist };
    if (reduceMotion) {
      placeAt(to.theta, to.phi, to.radius);
      controls.update();
      studio.wake();
      return;
    }
    tween = { t: 0, from: { theta: sph.theta, phi: sph.phi, radius: sph.radius }, to };
    studio.wake();
  };
  viewButtons.forEach((b) => b.addEventListener("click", () => goTo(b.dataset.view)));

  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  studio.setLoop((dt) => {
    let busy = false;
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 1.1);
      const k = easeInOut(tween.t);
      const L = THREE.MathUtils.lerp;
      placeAt(L(tween.from.theta, tween.to.theta, k), L(tween.from.phi, tween.to.phi, k), L(tween.from.radius, tween.to.radius, k));
      if (tween.t >= 1) tween = null;
      busy = true;
    }
    const moved = controls.update(dt);
    return busy || moved || controls.autoRotate;
  });

  // ---------- Save image ----------
  const saveBtn = document.getElementById("save");
  saveBtn.addEventListener("click", async () => {
    saveBtn.setAttribute("aria-disabled", "true");
    try {
      const W = 1920;
      const H = 1200;
      const scale = studio.quality === "high" ? 1 : 1.5; // supersample when there is no MSAA
      const keep = { pos: camera.position.clone(), fov: camera.fov };
      studio.setRenderSize(Math.round(W * scale), Math.round(H * scale), 1);
      camera.aspect = W / H;
      camera.fov = 26;
      camera.clearViewOffset();
      const shotTarget = new THREE.Vector3(0, 0.3, 0.05);
      sph.set(9.1, 1.3, 0.8);
      camera.position.setFromSpherical(sph).add(shotTarget);
      camera.lookAt(shotTarget);
      camera.updateProjectionMatrix();
      studio.fadeRig(camera.position.y);
      studio.render(); // through the camera finish on the high tier, like the live view
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const c = out.getContext("2d");
      c.imageSmoothingQuality = "high";
      c.drawImage(renderer.domElement, 0, 0, W, H);
      // Restore the live view before encoding.
      camera.position.copy(keep.pos);
      camera.fov = keep.fov;
      camera.lookAt(controls.target);
      studio.resize(true);
      controls.update();
      // Caption: REV mark, "Livery Lab concept", number.
      c.save();
      c.translate(56, H - 78);
      c.scale(64 / 235.06, 64 / 235.06);
      c.fillStyle = "rgba(236, 238, 241, 0.92)";
      c.fill(getMark());
      c.restore();
      c.font = '700 28px "Martian Mono", ui-monospace, monospace';
      c.fillStyle = "rgba(236, 238, 241, 0.92)";
      c.textBaseline = "alphabetic";
      c.fillText("Livery Lab concept", 136, H - 48);
      c.font = '500 16px ui-monospace, "SF Mono", Menlo, monospace';
      c.fillStyle = "rgba(138, 144, 154, 1)";
      c.textAlign = "right";
      const label = [state.number ? `No. ${state.number}` : "", `${state.base.toUpperCase()} / ${state.accent.toUpperCase()}`].filter(Boolean).join("   ");
      c.fillText(label, W - 56, H - 52);
      c.fillText("Not Carrera’s final livery", W - 56, H - 76);
      const blob = await new Promise((r) => out.toBlob(r, "image/png"));
      if (!blob) throw new Error("PNG encoding failed");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `rev-livery-${state.number || "concept"}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      say(`Saved ${a.download}.`);
    } catch (err) {
      console.warn("[v2] save image failed", err);
      say("The image couldn’t be saved in this browser. Try a screenshot instead.");
    } finally {
      saveBtn.removeAttribute("aria-disabled");
    }
  });

  await studio.compile();
  stage.classList.remove("is-loading");
  stage.classList.add("is-ready");
  studio.wake();
  window.__livery = { state, setState, goTo, paintNow, atlas, controls }; // debugging and screenshots
}

// ---------- Copy link and reset (work before the 3D is ready) ----------
document.getElementById("copy").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}${location.search}#${encodeHash(state)}`;
  history.replaceState(null, "", url);
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  say(ok ? `Link copied.${art ? " Your artwork stays on this device and isn’t in the link." : ""}` : `Copy this link: ${url}`, ok ? 4000 : 0);
});
document.getElementById("reset").addEventListener("click", () => {
  clearArt();
  setState({ ...DEFAULTS }, { hash: false });
  clearTimeout(hashTimer);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  window.__livery?.goTo("hero");
  say("Reset to the starting design.");
});

// Start after first paint so text and images win the bandwidth race.
const start = () => boot().catch(fail);
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 150));
if (document.readyState === "complete") idle(start, { timeout: 1200 });
else window.addEventListener("load", () => idle(start, { timeout: 1200 }), { once: true });
