#!/bin/sh
# Rebuilds the Carrera v2 web model. Run from the repo root:
#   sh lab/carrera/scripts/build_v2.sh [input.glb] [extra refine_v2.py options...]
# Needs Blender (BLENDER env var or /Applications/Blender.app) and Node (npx @gltf-transform/cli).
set -e
B=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
IN=${1:-rev-site/assets/models/carrera.glb}
[ $# -gt 0 ] && shift
LAB=lab/carrera
OUT=rev-site-v2/assets/models
mkdir -p "$OUT"
"$B" -b --python "$LAB/scripts/refine_v2.py" -- "$IN" "$LAB/carrera-v2-raw.glb" "$OUT/carrera-v2-hotspots.json" \
  --blend="$LAB/carrera-v2.blend" "$@" | grep -E "^REPORT|Error|Traceback" || true
[ -s "$LAB/carrera-v2-raw.glb" ] || { echo "Blender step failed" >&2; exit 1; }
# Web model: EXT_meshopt_compression + KHR_mesh_quantization (needs three's MeshoptDecoder).
npx --yes @gltf-transform/cli meshopt "$LAB/carrera-v2-raw.glb" "$OUT/carrera-v2.glb" --level high
# Draco variant for comparison only (needs DRACOLoader).
npx --yes @gltf-transform/cli draco "$LAB/carrera-v2-raw.glb" "$LAB/carrera-v2-draco.glb"
ls -l "$LAB/carrera-v2-raw.glb" "$LAB/carrera-v2-draco.glb" "$OUT/carrera-v2.glb" "$OUT/carrera-v2-hotspots.json"
