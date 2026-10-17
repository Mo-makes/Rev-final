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
