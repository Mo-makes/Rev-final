// Turns a Radiance .hdr environment (e.g. a 1k Poly Haven HDRI) into the compact WebP the v2
// studio uses for reflections (rev-site-v2/assets/env/showroom-env.webp).
//
// Each channel stores log2(radiance) mapped from [LO, HI] to 0..255, so 8 bits cover 19 stops at
// about 5% per step, which is plenty for reflections once PMREM blurs them. studio.js decodes it
// on the GPU (ENV_LOG2_RANGE there must match LO/HI here).
//
// Grade: radiance^GAMMA crushes the mid-tones so walls go dark while the softboxes stay bright
// (a night showroom); LOWER darkens everything below the horizon to match the dark floor; the
// result is white-balanced so the paint doesn't pick up the studio's tint.
//
// Usage (needs `cwebp` from libwebp on PATH):
//   node tools/encode-env.mjs monochrome_studio_02_1k.hdr rev-site-v2/assets/env/showroom-env.webp
// The checked-in file was made with the defaults below from Poly Haven's "Monochrome Studio 02"
// (https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/monochrome_studio_02_1k.hdr, CC0).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [, , input, output, ...rest] = process.argv;
if (!input || !output) {
  console.error('usage: node tools/encode-env.mjs in.hdr out.webp [width=1024] [gamma=1.3] [lower=0.12] [quality=92]');
  process.exit(1);
}
const [W = 1024, GAMMA = 1.3, LOWER = 0.12, QUALITY = 92] = rest.map(Number);
const H = W / 2;
const LO = -10;
const HI = 9;

function readHDR(file) {
  const buf = readFileSync(file);
  let pos = 0;
  const line = () => {
    let s = '';
    while (buf[pos] !== 0x0a) s += String.fromCharCode(buf[pos++]);
    pos++;
    return s;
  };
  while (line() !== '') if (pos > 8192) throw new Error('bad header');
  const m = line().match(/-Y (\d+) \+X (\d+)/);
  if (!m) throw new Error('unsupported orientation');
  const h = +m[1];
  const w = +m[2];
  const data = new Float32Array(w * h * 3);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    if (buf[pos] === 2 && buf[pos + 1] === 2 && ((buf[pos + 2] << 8) | buf[pos + 3]) === w) {
      pos += 4;
      for (let ch = 0; ch < 4; ch++) {
        let x = 0;
        while (x < w) {
          let n = buf[pos++];
          if (n > 128) {
            n -= 128;
            const v = buf[pos++];
            for (let i = 0; i < n; i++) scan[(x++) * 4 + ch] = v;
          } else {
            for (let i = 0; i < n; i++) scan[(x++) * 4 + ch] = buf[pos++];
          }
        }
      }
    } else {
      for (let x = 0; x < w * 4; x++) scan[x] = buf[pos++];
    }
    for (let x = 0; x < w; x++) {
      const e = scan[x * 4 + 3];
      const f = e ? 2 ** (e - 136) : 0;
      const o = (y * w + x) * 3;
      data[o] = scan[x * 4] * f;
      data[o + 1] = scan[x * 4 + 1] * f;
      data[o + 2] = scan[x * 4 + 2] * f;
    }
  }
  return { w, h, data };
}

const src = readHDR(input);
const fx = src.w / W;
const fy = src.h / H;
const img = new Float32Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const acc = [0, 0, 0];
    let n = 0;
    for (let j = Math.floor(y * fy); j < Math.floor((y + 1) * fy); j++) {
      for (let i = Math.floor(x * fx); i < Math.floor((x + 1) * fx); i++) {
        const o = (j * src.w + i) * 3;
        acc[0] += src.data[o];
        acc[1] += src.data[o + 1];
        acc[2] += src.data[o + 2];
        n++;
      }
    }
    for (let ch = 0; ch < 3; ch++) img[(y * W + x) * 3 + ch] = acc[ch] / n;
  }
}

// Grade.
for (let y = 0; y < H; y++) {
  const elevation = (0.5 - (y + 0.5) / H) * Math.PI;
  const t = Math.min(1, Math.max(0, -elevation / 0.25));
  const k = 1 + (LOWER - 1) * t * t * (3 - 2 * t);
  for (let i = y * W * 3; i < (y + 1) * W * 3; i++) img[i] = img[i] ** GAMMA * k;
}

// White balance on the solid-angle-weighted average.
const sum = [0, 0, 0];
for (let y = 0; y < H; y++) {
  const weight = Math.cos((0.5 - (y + 0.5) / H) * Math.PI);
  for (let x = 0; x < W; x++) for (let ch = 0; ch < 3; ch++) sum[ch] += img[(y * W + x) * 3 + ch] * weight;
}
const wb = [sum[1] / sum[0], 1, sum[1] / sum[2]];

// Log-encode to 8-bit PPM, then WebP.
const px = Buffer.alloc(W * H * 3);
for (let i = 0; i < img.length; i++) {
  const v = Math.max(img[i] * wb[i % 3], 2 ** LO);
  px[i] = Math.round(255 * Math.min(1, Math.max(0, (Math.log2(v) - LO) / (HI - LO))));
}
const dir = mkdtempSync(path.join(tmpdir(), 'encode-env-'));
const ppm = path.join(dir, 'env.ppm');
writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), px]));
execFileSync('cwebp', ['-quiet', '-q', String(QUALITY), '-m', '6', '-sharp_yuv', ppm, '-o', output]);
rmSync(dir, { recursive: true, force: true });
console.log(`${output}: ${W}x${H}, white balance ${wb.map((v) => v.toFixed(3)).join(' ')}, log2 range ${LO}..${HI}`);
