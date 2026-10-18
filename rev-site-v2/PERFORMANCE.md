# v2 performance: what the 3D costs

Short version: **the v2 homepage downloads about a sixth of what the approved homepage does (0.86 MB vs 5.4 MB), shows its content sooner, and scrolls at a steady 60 frames per second in our tests.** The 3D loads after the page, so a slow phone or a dead connection still gets a complete, readable site with a still image of the car.

Measured on 18 October 2026 against local builds of both sites (`npm start` on port 3000, `npm run start:v2` on port 3002). Tools: Lighthouse 12 in headless Chrome, plus a scripted scroll through the 3D story in Chrome on an M3 Pro MacBook.

## Download size and load times

Lighthouse "mobile" simulates a mid-range phone on slow 4G (about 1.6 Mbps, 150 ms latency, CPU slowed 4×). Scores vary from run to run by roughly ±5–10 points, so where I ran a page more than once the table gives the range.

| Page | Transferred | Performance (mobile) | Largest content shown (mobile) | Main-thread blocking (mobile) | Performance (desktop) |
| --- | --- | --- | --- | --- | --- |
| **Approved homepage (v1)** | 5,428 KB | 39–72 | 9.4–10.7 s | 0–2,380 ms | 94 |
| **v2 homepage** | 858 KB | 87–95 | 1.7–2.1 s | 230–480 ms | 100 |
| Approved Carrera page (v1) | 1,085 KB | 94–95 | 3.0 s | 0 ms | 95–99 |
| v2 Carrera page (3D viewer) | 1,061 KB | 83–98 | 2.0 s | 90–610 ms | 100 |
| v2 Livery Lab | 921 KB | 96–97 | 2.0 s | 170–180 ms | 100 |
| v2 Team / Join / Sponsors / Contact | 124–715 KB | 91–99 | 1.7–3.5 s | 0 ms | 100 |

- Accessibility scores 100 on every v2 page; the approved homepage scores 96.
- v2's SEO score shows 60–63 only because every v2 page is deliberately marked `noindex` while it's a preview. Remove that when adopting it.
- Layout shift is zero or near zero on every page.

## Why v2 is lighter

| Item | Approved site | v2 |
| --- | --- | --- |
| Car model | 5.4 MB, uncompressed | 687 KB on disk, ~390 KB over the wire, meshopt-compressed |
| three.js | full build, ~260 KB compressed | minified build, ~166 KB compressed |
| Fonts | ~1 MB of TTF | ~150 KB of WOFF2 (Latin subsets) |
| Still image before the 3D | 500 KB PNG | 10–18 KB WebP posters |

## Frame rate while scrolling

The test script scrolls the whole homepage 3D story (reveal, array, x-ray, profile, race) in 8 seconds and records every frame:

| Setup | Average fps | Median frame | 95th-percentile frame | Frames over 33 ms |
| --- | --- | --- | --- | --- |
| Desktop 1440×900, full quality | 60 | 16.7 ms | 16.7 ms | 0 |
| Desktop, full quality, CPU slowed 4× | 60 | 16.7 ms | 16.7 ms | 0 |
| Phone 390×844, light quality, CPU slowed 4× | 60 | 16.7 ms | 16.8 ms | 0 |

16.7 ms per frame is 60 fps, the display's limit. These runs used the MacBook's GPU. A CPU slowdown can't emulate a slow GPU, so real low-end phones still need a hands-on check (see below).

## What keeps it from lagging

- **Content first.** Text, photos and fonts load before any 3D. three.js and the model start only after the page has finished loading, and a still poster of the car fills the space until the 3D is ready.
- **Renders only when needed.** The 3D draws a frame only while something is moving: you're scrolling, the intro is playing, or you're dragging the car. When it's still, it uses no GPU. It also stops completely when it's scrolled out of view or the tab is in the background.
- **Two quality levels, picked automatically.**
  - **Light** is used on phones, devices with 4 or fewer CPU cores or 4 GB or less of memory, Data Saver users, and browsers without hardware graphics. It drops the live floor reflection and anti-aliasing and caps resolution at 1.25× instead of 1.5×.
  - **Safety net:** if the full level drops frames during the first second and a half, it switches the reflection off by itself.
  - **For testing:** `?quality=low` or `?quality=high` forces a level.
- **Short turntables.** The slow auto-spin on the Carrera page and the Livery Lab runs only on capable devices and stops after 14 seconds or on first touch.
- **Reduced motion respected.** People who set "reduce motion" on their device get the still poster on the homepage and choose whether to open the 3D viewer on the Carrera page.
- **No-WebGL fallback.** Browsers that can't do 3D get the poster image and the full text.

## Honest caveats

- **Not yet tried on real budget phones.** I tested on a MacBook (GPU) and with simulated slow CPUs. Before adopting v2, someone should open it on an older Android phone and an older iPhone and scroll the homepage. If it stutters, the light level can be made lighter (lower resolution, no x-ray glow) without touching the design.
- **First visit on mobile data** costs about 0.9 MB for the homepage, about the size of two or three phone photos. Repeat visits load the model from cache.
- **Battery.** Nothing renders while the page is still, but scrolling the 3D story and spinning the car do use the GPU, as a game would, for those few seconds.
- **Lighthouse is a simulation.** Its numbers move between runs; treat them as relative (v1 vs v2), not exact.
- **Hosting.** Make sure the host compresses `.glb` files (gzip or brotli). If it doesn't, switch to the Draco build of the model in `lab/carrera/`: 357 KB, visually identical in our pixel comparison, but it needs one extra decoder file.
- **Main-thread blocking on the 3D pages** (230–610 ms on a 4×-slowed CPU) comes from starting three.js and preparing the car's shaders after the page has loaded. The page is readable during that time, and scrolling stays smooth once it's done.

## How to re-measure

```sh
npm run start:v2
npx lighthouse http://localhost:3002/ --only-categories=performance
```

Compare with the approved site after `npm start`, at http://localhost:3000/.
