# Usage: Blender -b --python outline.py -- model.glb out.svg
# Extracts the SolarCells boundary loops in top view and writes them as SVG for inspection.
import bpy, bmesh, sys
argv = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=argv[0])
solar = bpy.data.objects["SolarCells"]
bm = bmesh.new(); bm.from_mesh(solar.data); bm.transform(solar.matrix_world)
edges = [e for e in bm.edges if e.is_boundary]
adj = {}
for e in edges:
    a, b = e.verts
    adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
loops, used = [], set()
for start in adj:
    if start in used: continue
    loop = [start]; used.add(start); prev, cur = None, start
    while True:
        nxt = [v for v in adj[cur] if v is not prev and v not in used]
        if not nxt: break
        prev, cur = cur, nxt[0]; used.add(cur); loop.append(cur)
    loops.append([(v.co.x, v.co.y, v.co.z) for v in loop])
odd = [v for v, n in adj.items() if len(n) != 2]
print("LOOPS", [len(l) for l in loops], "nonmanifold-boundary-verts", len(odd))
S = 400
def pts(l): return " ".join(f"{(x+2.5)*S:.1f},{(1.0-y)*S:.1f}" for x, y, z in l)
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {5*S} {2*S}" style="background:#fff">']
for l in loops:
    svg.append(f'<polygon points="{pts(l)}" fill="#0b3d75" fill-opacity="0.25" stroke="#0b3d75" stroke-width="1"/>')
svg.append("</svg>")
open(argv[1], "w").write("\n".join(svg))
