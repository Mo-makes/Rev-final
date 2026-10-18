# Carrera model lab

An experiment space for the Carrera GLB, kept outside `rev-site/` so none of it gets published.

- `index.html`: standalone viewer. It uses the same lights and material overrides as `rev-site/assets/js/car-viewer.js` and switches between the original model and the candidates.
- `scripts/refine.py`: rebuilds the solar array with rounded corners and clean edges, welds the body seam underneath it and adds a soft glow to the front light strip. With `--cells` it also adds a tiling 125 mm solar-cell texture.
- `scripts/inspect.py`, `scripts/outline.py`: diagnostics (mesh stats, top-view outline as SVG).

Rebuild the candidates from the repo root:

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b --python lab/carrera/scripts/refine.py -- rev-site/assets/models/carrera.glb lab/carrera/carrera-refined.glb
$B -b --python lab/carrera/scripts/refine.py -- rev-site/assets/models/carrera.glb lab/carrera/carrera-refined-cells.glb 0.05 0 --cells
```

Arguments after the output path: corner radius in metres (default 0.05), body smoothing passes (default 0), `--cells`.

View it with `npx serve . --listen 3018` and open http://localhost:3018/lab/carrera/.

The production model in `rev-site/assets/models/` is unchanged. Swapping it needs the project manager's sign-off (see AGENTS.md).

## v2 model (for the experimental rev-site-v2)

`scripts/refine_v2.py` turns the current `rev-site/assets/models/carrera.glb` into the v2 web model; `scripts/build_v2.sh` runs it, then the showroom pass (`scripts/enhance_v2.py`), and compresses the result (WebP textures, meshopt geometry). Rebuild from the repo root (Blender 4.2+ and Node needed):

```bash
sh lab/carrera/scripts/build_v2.sh
# or step by step:
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b --python lab/carrera/scripts/refine_v2.py -- rev-site/assets/models/carrera.glb \
   lab/carrera/carrera-v2-raw.glb rev-site-v2/assets/models/carrera-v2-hotspots.json --blend=lab/carrera/carrera-v2.blend
$B -b lab/carrera/carrera-v2.blend --python lab/carrera/scripts/enhance_v2.py -- lab/carrera/carrera-v2-raw.glb \
   rev-site-v2/assets/models/carrera-v2-hotspots.json --blend=lab/carrera/carrera-v2-showroom.blend   # showroom pass, see below
# then WebP textures (one slot per call) and meshopt, exactly as in build_v2.sh
```

Options for `refine_v2.py` (after the three paths): `--nose=-x|+x|-z|+z` (input nose axis, default `-x`), `--body-tris=70000`, `--glass-tris=6000`, `--denoise=6` (0 = off), `--sigma=0.45`, `--rim=red|graphite`, `--blend=path`. To run it on a different source model, it needs meshes or materials whose names contain `body`, `solar`, `glass`/`canopy` and `tire`/`wheel` (four separate tyre islands), plus optionally `light`.

What it produces (glTF, metres, +Y up, nose toward +Z, car-left toward +X, origin on the ground under the centre of the bounding box):

- Nodes: `Carrera` (root) > `Body`, `Canopy`, `SolarArray`, `LightStrip`, `Wheel_FL|FR|RL|RR` (empties at the axle centres, each with a `Wheel_XX_Geo` mesh child) and `Hotspot_*` empties.
- Materials: `CarBody` (clearcoat white, body UV atlas for liveries), `SolarArray` (cell-tile texture), `CanopyGlass` (tinted, alpha blend), `Tire`, `Rim`, `Hub`, `LightStrip` (emissive, strength 6).
- Spin a wheel with `wheel.rotation.x += distance / radius` (positive rolls forward). Animate the `Wheel_*` empties, never the `_Geo` children: compression puts a dequantisation transform on mesh nodes.
- `carrera-v2-hotspots.json` holds hotspot positions and normals, wheel axle centres and radius, and the body UV atlas layout.

The tyres, rims, hubs and brake discs are procedural, built at the scanned tyre positions and size. The body, canopy and light strip are the scan, denoised and decimated. The lab viewer lists the v2 builds; it has Clay, Env light, Hotspots, Spin wheels toggles and `lab.compare("original", "v2")` for a split view.

### Showroom pass (`scripts/enhance_v2.py`)

`build_v2.sh` runs a second Blender step on the scene `refine_v2.py` saved, then converts the textures to WebP and compresses with meshopt. It adds the cues that make the model read as a real car (`SHOWROOM=0 sh lab/carrera/scripts/build_v2.sh` skips it):

- **Baked ambient occlusion** (Cycles, with a ground plane present): creases between pods and deck, canopy base, wheel openings, the underside. `CarBody` and `SolarArray` get a second UV set (`TEXCOORD_1`; smart-projected on the body, planar from above on the array) and an `occlusionTexture` with `texCoord: 1`. `TEXCOORD_0` on the body is still the livery atlas, unchanged.
- **Illustrative cockpit** in the car-left pod, not from CAD: reclined seat shell, roll hoop with rear braces and harness bar, wheel housings over the two left wheels, dash cowl with a small screen, steering wheel and column, plus a dark liner 12 mm inside the whole shell and under the array (the body is an open shell drawn double-sided, so without it the glass shows white paint). Nodes `Cockpit_*` under one `Cockpit` empty; materials `Interior*` (studio.js keeps them as exported). Their AO is baked into vertex colours (`COLOR_0`) with the glass removed, so the cabin is darker away from the windows. The layout was fitted to the scanned pod (hips just ahead of the rear-left wheel, head under the roof, feet behind the front-left wheel).
- **Solar array**: a 4 x 4 cell tile (per-cell colour variation, silver busbars and fingers, tabbing ribbons, pale backsheet in the gaps and corner diamonds) and a normal map for the encapsulant dipping into the gaps plus slight cell pillowing (`normalTexture` and `clearcoatNormalTexture`). The array UVs were divided by 4 so one tile spans four cells.
- **Body paint**: a fine orange-peel normal map, tiled on `TEXCOORD_0` with `KHR_texture_transform` (one tile = 9 cm), strength baked into the texture, used as `normalTexture` and `clearcoatNormalTexture`. Only visible in close-ups.
- **Tyres**: profile UVs and a `metallicRoughnessTexture` (G = roughness factor): a smoother worn tread band (0.68) and matte sidewalls (1.0) with fine moulded rings.
- **Scan ripples**: a region-limited, normal-only Taubin smooth at the nose deck lip and tail blade (creases and part seams protected; mean 0.24 mm, max 3.3 mm).
- **Canopy**: exported lighter and more transparent (alpha 0.58) so the cockpit shows. studio.js sets its own glass values; the cockpit only reads through glass at about 0.55-0.65 opacity.

Options after the two paths: `--ao-size=1024`, `--ao-samples=384`, `--ao-dist=0.6` (metres), `--liner-tris=9000`, `--end-smooth=24` (0 = off), `--no-cockpit`, `--no-ao`, `--blend=path`. It also adds `textures` and `cockpit` sections to `carrera-v2-hotspots.json` listing the slots above.

Review tools:

- `scripts/preview.html`: rebuilds the materials as studio.js does and carries the GLB texture slots over. Served from the repo root: http://localhost:3020/lab/carrera/scripts/preview?view=canopy (use the short URL: `serve` drops the query when it redirects `.html`). Parameters: `model`, `carry=0|1`, `glass`, `cockpit=0|1`, `ao`, `view=front34|side|rear34|top|canopy|wheel|nose|tail|lip|blade`.
- `scripts/render_views.py`: Cycles stills in a neutral studio: `$B -b --python lab/carrera/scripts/render_views.py -- lab/carrera/carrera-v2-raw.glb out/ prefix_ [--views=front34,side,rear34,top,canopy,wheel,cabin] [--hide=Canopy]`. Blender's glTF importer does not render the occlusion texture, so judge the baked AO in the browser.

Known limits: the remaining waviness along the nose deck lip edge is in the scan and only partly smoothed; the cockpit is generic; the liner shows as a dark fill behind the body in x-ray views, so hide the `Cockpit` node there.
