#!/bin/sh
# Rebuilds the Carrera v2 web model. Run from the repo root:
#   sh lab/carrera/scripts/build_v2.sh [input.glb] [extra refine_v2.py options...]
# Needs Blender (BLENDER env var or /Applications/Blender.app) and Node (npx @gltf-transform/cli).
# Set SHOWROOM=0 to skip the showroom pass (baked AO, cockpit, textures) and get the plain refine_v2.py model.
set -e
B=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
IN=${1:-rev-site/assets/models/carrera.glb}
[ $# -gt 0 ] && shift
LAB=lab/carrera
OUT=rev-site-v2/assets/models
GLTF="npx --yes @gltf-transform/cli"
mkdir -p "$OUT"
rm -f "$LAB/carrera-v2-raw.glb"
# 1. Geometry: denoised scan, procedural wheels, materials, hotspots (also saves the scene for step 2).
"$B" -b --python "$LAB/scripts/refine_v2.py" -- "$IN" "$LAB/carrera-v2-raw.glb" "$OUT/carrera-v2-hotspots.json" \
  --blend="$LAB/carrera-v2.blend" "$@" | grep -E "^REPORT|Error|Traceback" || true
[ -s "$LAB/carrera-v2-raw.glb" ] || { echo "Blender step failed" >&2; exit 1; }
# 2. Showroom pass: baked AO (TEXCOORD_1), illustrative cockpit, array/paint/tyre textures. Overwrites the raw GLB.
if [ "${SHOWROOM:-1}" != "0" ]; then
  rm -f "$LAB/carrera-v2-raw.glb"
  "$B" -b "$LAB/carrera-v2.blend" --python "$LAB/scripts/enhance_v2.py" -- "$LAB/carrera-v2-raw.glb" \
    "$OUT/carrera-v2-hotspots.json" --blend="$LAB/carrera-v2-showroom.blend" | grep -E "^REPORT|Error|Traceback" || true
  [ -s "$LAB/carrera-v2-raw.glb" ] || { echo "Showroom step failed" >&2; exit 1; }
fi
# 3. Textures to WebP (EXT_texture_webp): lossy for AO and colour, lossless for the subtle normal/roughness maps.
# (One slot per call, written --opt=value: the CLI misreads brace globs and space-separated values here.)
cp "$LAB/carrera-v2-raw.glb" "$LAB/carrera-v2-webp.glb"
$GLTF webp "$LAB/carrera-v2-webp.glb" "$LAB/carrera-v2-webp.glb" --slots=occlusionTexture --quality=80
$GLTF webp "$LAB/carrera-v2-webp.glb" "$LAB/carrera-v2-webp.glb" --slots=baseColorTexture --quality=85
$GLTF webp "$LAB/carrera-v2-webp.glb" "$LAB/carrera-v2-webp.glb" --slots=normalTexture --lossless=true
$GLTF webp "$LAB/carrera-v2-webp.glb" "$LAB/carrera-v2-webp.glb" --slots=metallicRoughnessTexture --lossless=true
# 4. Web model: EXT_meshopt_compression + KHR_mesh_quantization (needs three's MeshoptDecoder).
$GLTF meshopt "$LAB/carrera-v2-webp.glb" "$OUT/carrera-v2.glb" --level=high
# Draco variant for comparison only (needs DRACOLoader).
$GLTF draco "$LAB/carrera-v2-webp.glb" "$LAB/carrera-v2-draco.glb"
ls -l "$LAB/carrera-v2-raw.glb" "$LAB/carrera-v2-draco.glb" "$OUT/carrera-v2.glb" "$OUT/carrera-v2-hotspots.json"
