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

`scripts/refine_v2.py` turns the current `rev-site/assets/models/carrera.glb` into the v2 web model; `scripts/build_v2.sh` runs it and compresses the result. Rebuild from the repo root (Blender 4.2+ and Node needed):

```bash
sh lab/carrera/scripts/build_v2.sh
# or step by step:
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b --python lab/carrera/scripts/refine_v2.py -- rev-site/assets/models/carrera.glb \
   lab/carrera/carrera-v2-raw.glb rev-site-v2/assets/models/carrera-v2-hotspots.json --blend=lab/carrera/carrera-v2.blend
npx @gltf-transform/cli meshopt lab/carrera/carrera-v2-raw.glb rev-site-v2/assets/models/carrera-v2.glb --level high
npx @gltf-transform/cli draco lab/carrera/carrera-v2-raw.glb lab/carrera/carrera-v2-draco.glb   # comparison only
```

Options for `refine_v2.py` (after the three paths): `--nose=-x|+x|-z|+z` (input nose axis, default `-x`), `--body-tris=70000`, `--glass-tris=6000`, `--denoise=6` (0 = off), `--sigma=0.45`, `--rim=red|graphite`, `--blend=path`. To run it on a different source model, it needs meshes or materials whose names contain `body`, `solar`, `glass`/`canopy` and `tire`/`wheel` (four separate tyre islands), plus optionally `light`.

What it produces (glTF, metres, +Y up, nose toward +Z, car-left toward +X, origin on the ground under the centre of the bounding box):

- Nodes: `Carrera` (root) > `Body`, `Canopy`, `SolarArray`, `LightStrip`, `Wheel_FL|FR|RL|RR` (empties at the axle centres, each with a `Wheel_XX_Geo` mesh child) and `Hotspot_*` empties.
- Materials: `CarBody` (clearcoat white, body UV atlas for liveries), `SolarArray` (cell-tile texture), `CanopyGlass` (tinted, alpha blend), `Tire`, `Rim`, `Hub`, `LightStrip` (emissive, strength 6).
- Spin a wheel with `wheel.rotation.x += distance / radius` (positive rolls forward). Animate the `Wheel_*` empties, never the `_Geo` children: compression puts a dequantisation transform on mesh nodes.
- `carrera-v2-hotspots.json` holds hotspot positions and normals, wheel axle centres and radius, and the body UV atlas layout.

The tyres, rims, hubs and brake discs are procedural, built at the scanned tyre positions and size. The body, canopy and light strip are the scan, denoised and decimated. The lab viewer lists the v2 builds; it has Clay, Env light, Hotspots, Spin wheels toggles and `lab.compare("original", "v2")` for a split view.
