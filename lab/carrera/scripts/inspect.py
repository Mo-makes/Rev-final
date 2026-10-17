# Usage: Blender -b --python inspect.py -- model.glb
import bpy, bmesh, sys, json
from mathutils import Vector
from mathutils.bvhtree import BVHTree
path = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
out = {}
objs = {o.name: o for o in bpy.data.objects if o.type == "MESH"}
for name, o in objs.items():
    me = o.data
    bm = bmesh.new(); bm.from_mesh(me)
    boundary = sum(1 for e in bm.edges if e.is_boundary)
    nonmanifold = sum(1 for e in bm.edges if not e.is_manifold)
    xs = [ (o.matrix_world @ v.co) for v in bm.verts]
    mn = Vector((min(p.x for p in xs), min(p.y for p in xs), min(p.z for p in xs)))
    mx = Vector((max(p.x for p in xs), max(p.y for p in xs), max(p.z for p in xs)))
    import collections
    islands = 0
    seen = set()
    for f in bm.faces:
        if f.index in seen: continue
        islands += 1; stack=[f]; seen.add(f.index)
        while stack:
            g = stack.pop()
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen: seen.add(h.index); stack.append(h)
    out[name] = dict(verts=len(bm.verts), faces=len(bm.faces), boundary_edges=boundary, nonmanifold=nonmanifold,
                     islands=islands, min=list(mn), max=list(mx), parent=o.parent.name if o.parent else None,
                     smooth=sum(p.use_smooth for p in me.polygons))
    bm.free()
# Distance from solar cells down to the body surface (Blender is Z-up after import).
body = objs["Body"]; solar = objs["SolarCells"]
dg = bpy.context.evaluated_depsgraph_get()
bvh = BVHTree.FromObject(body, dg)
import random
random.seed(1)
vs = [solar.matrix_world @ v.co for v in solar.data.vertices]
samples = random.sample(vs, 400)
d_up = []; d_near = []
for p in samples:
    hit = bvh.ray_cast(body.matrix_world.inverted() @ (p + Vector((0,0,0.5))), Vector((0,0,-1)))
    if hit[0]: d_up.append(round((p.z - (body.matrix_world @ hit[0]).z)*1000, 2))
    n = bvh.find_nearest(body.matrix_world.inverted() @ p)
    if n[0]: d_near.append(round(n[3]*1000, 2))
d_up.sort(); d_near.sort()
out["solar_minus_body_top_mm"] = dict(min=d_up[0], p10=d_up[len(d_up)//10], median=d_up[len(d_up)//2], p90=d_up[9*len(d_up)//10], max=d_up[-1], n=len(d_up))
out["solar_to_body_nearest_mm"] = dict(min=d_near[0], median=d_near[len(d_near)//2], max=d_near[-1])
print("JSON" + json.dumps(out))
