# Rebuilds Carrera's solar array with rounded corners and clean edges, and tidies the body.
#
# Usage:
#   /Applications/Blender.app/Contents/MacOS/Blender -b --python refine.py -- in.glb out.glb [corner_radius_m]
#
# What it does:
#   1. Joins the original SolarCells surface back into Body and welds the seam, so the deck is one
#      continuous white surface (the old seam was the source of the jagged white slivers).
#   2. Takes the array's top-view outline, simplifies the scan noise away and fillets every corner.
#   3. Builds a new, evenly tessellated SolarCells mesh inside that outline and drapes it onto the
#      deck 1.5 mm above the surface. Body faces fully hidden under it are deleted to save bytes.
#   4. Gives the front LightStrip a soft emissive white.
import bpy, bmesh, sys, math
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import delaunay_2d_cdt

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, DST = argv[0], argv[1]
RADIUS = float(argv[2]) if len(argv) > 2 else 0.05   # corner fillet radius (m)
SMOOTH_ITERS = int(argv[3]) if len(argv) > 3 else 0   # optional body smoothing passes (off by default)
CELLS = "--cells" in argv     # add a tiling solar-cell texture to the array
CELL = 0.125                  # cell pitch (m); 125 mm pseudo-square cells
SIMPLIFY_TOL = 0.004   # outline simplification tolerance (m)
GRID = 0.025           # interior tessellation spacing (m)
EDGE_STEP = 0.008      # spacing of points along the outline (m)
LIFT = 0.0015          # height of the array above the deck (m)
HIDE_MARGIN = 0.02     # body faces this far inside the outline are deleted

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
body = bpy.data.objects["Body"]
solar = bpy.data.objects["SolarCells"]
light = bpy.data.objects.get("LightStrip")
solar_mat = solar.data.materials[0]
body_mat = body.data.materials[0]

# --- 1. Outline of the original array (top view, Blender is Z-up) ---------------------------
def boundary_loops(obj):
    bm = bmesh.new(); bm.from_mesh(obj.data); bm.transform(obj.matrix_world)
    adj = {}
    for e in bm.edges:
        if e.is_boundary:
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
        loops.append([Vector((v.co.x, v.co.y)) for v in loop])
    bm.free()
    return loops

outline = max(boundary_loops(solar), key=len)

def signed_area(poly):
    return 0.5 * sum(poly[i].x * poly[i - 1].y - poly[i - 1].x * poly[i].y for i in range(len(poly)))

if signed_area(outline) < 0: outline.reverse()   # counter-clockwise

def simplify(poly, tol):
    # Douglas-Peucker on a closed loop, anchored at the two most distant points.
    def dp(pts):
        if len(pts) < 3: return pts
        a, b = pts[0], pts[-1]
        ab = b - a; L = ab.length or 1e-9
        dmax, idx = 0, 0
        for i in range(1, len(pts) - 1):
            d = abs(ab.x * (a.y - pts[i].y) - ab.y * (a.x - pts[i].x)) / L
            if d > dmax: dmax, idx = d, i
        if dmax <= tol: return [a, b]
        return dp(pts[: idx + 1])[:-1] + dp(pts[idx:])
    i0 = 0
    i1 = max(range(len(poly)), key=lambda i: (poly[i] - poly[i0]).length)
    first = dp(poly[i0: i1 + 1]); second = dp(poly[i1:] + [poly[i0]])
    out = first[:-1] + second[:-1]
    # Drop near-duplicate and collinear points.
    clean = []
    for p in out:
        if not clean or (p - clean[-1]).length > 1e-4: clean.append(p)
    return clean

def fillet(poly, radius, step):
    # Replace every corner with a tangent arc; radius shrinks where edges are too short.
    n = len(poly); out = []
    for i in range(n):
        p0, p1, p2 = poly[i - 1], poly[i], poly[(i + 1) % n]
        d1 = (p0 - p1); d2 = (p2 - p1)
        l1, l2 = d1.length, d2.length
        d1.normalize(); d2.normalize()
        cosang = max(-1.0, min(1.0, d1.dot(d2)))
        ang = math.acos(cosang)                    # interior angle between the two edges
        if ang > math.radians(175) or ang < 1e-3:  # nearly straight: keep the point
            out.append(p1.copy()); continue
        t = math.tan(ang / 2)
        r = min(radius, 0.5 * min(l1, l2) * t)    # tangent length r/tan(ang/2) <= half edge
        tl = r / t
        a = p1 + d1 * tl; b = p1 + d2 * tl
        bis = (d1 + d2).normalized()
        c = p1 + bis * (r / math.sin(ang / 2))
        sa = math.atan2(a.y - c.y, a.x - c.x); sb = math.atan2(b.y - c.y, b.x - c.x)
        sweep = sb - sa
        while sweep > math.pi: sweep -= 2 * math.pi
        while sweep < -math.pi: sweep += 2 * math.pi
        segs = max(2, int(abs(sweep) * r / step) + 1)
        for k in range(segs + 1):
            s = sa + sweep * k / segs
            out.append(Vector((c.x + r * math.cos(s), c.y + r * math.sin(s))))
    return out

def resample(poly, step):
    out = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        L = (b - a).length
        k = max(1, int(L / step))
        for j in range(k):
            out.append(a.lerp(b, j / k))
    return out

simple = simplify(outline, SIMPLIFY_TOL)
rounded = resample(fillet(simple, RADIUS, EDGE_STEP), EDGE_STEP)

import numpy as np
RP = np.array([(p.x, p.y) for p in rounded])

def inside_np(q):
    # Vectorised even-odd point-in-polygon test for an (N, 2) array.
    x, y = q[:, 0:1], q[:, 1:2]
    a, b = RP, np.roll(RP, 1, axis=0)
    cond = (a[:, 1] > y) != (b[:, 1] > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        xint = (b[:, 0] - a[:, 0]) * (y - a[:, 1]) / (b[:, 1] - a[:, 1]) + a[:, 0]
    return (np.count_nonzero(cond & (x < xint), axis=1) % 2) == 1

def dist_np(q):
    a, b = np.roll(RP, 1, axis=0), RP
    ab = b - a; L2 = np.maximum((ab ** 2).sum(1), 1e-12)
    out = np.empty(len(q))
    for s in range(0, len(q), 2000):   # chunked to bound memory
        qq = q[s:s + 2000, None, :]
        t = np.clip(((qq - a) * ab).sum(2) / L2, 0, 1)
        out[s:s + 2000] = np.sqrt((((a + ab * t[..., None]) - qq) ** 2).sum(2)).min(1)
    return out

# --- 2. Join the old array into the body and weld the seam ---------------------------------
for f in solar.data.polygons: f.material_index = 0
solar.data.materials.clear(); solar.data.materials.append(body_mat)
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True); solar.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body = bpy.context.view_layer.objects.active

bm = bmesh.new(); bm.from_mesh(body.data); bm.transform(body.matrix_world)
boundary_before = sum(1 for e in bm.edges if e.is_boundary)
seam = list({v for e in bm.edges if e.is_boundary for v in e.verts})
bmesh.ops.remove_doubles(bm, verts=seam, dist=0.002)
boundary_after = sum(1 for e in bm.edges if e.is_boundary)

# Optional plain averaging smooth (Laplacian smoothing spikes on this scan mesh, so it isn't used).
inner = [v for v in bm.verts if not v.is_boundary]
for _ in range(SMOOTH_ITERS):
    bmesh.ops.smooth_vert(bm, verts=inner, factor=0.3, use_axis_x=True, use_axis_y=True, use_axis_z=True)
bm.normal_update()

# --- 3. New array mesh ----------------------------------------------------------------------
bm.faces.ensure_lookup_table()
bvh = BVHTree.FromBMesh(bm)

def drape(p2):
    hit, normal, _, _ = bvh.ray_cast(Vector((p2.x, p2.y, 5.0)), Vector((0, 0, -1)))
    if hit is None: return None
    if normal.z < 0: normal = -normal
    return hit + normal * LIFT

# Interior grid points (kept away from the edge so the outline triangles stay well shaped).
xs = [p.x for p in rounded]; ys = [p.y for p in rounded]
pts2 = list(rounded)
nb = len(rounded)
gx, gy = np.meshgrid(np.arange(min(xs) + GRID / 2, max(xs), GRID), np.arange(min(ys) + GRID / 2, max(ys), GRID))
grid = np.stack([gx.ravel(), gy.ravel()], 1)
grid = grid[inside_np(grid)]
grid = grid[dist_np(grid) > GRID * 0.45]
pts2 += [Vector((float(x), float(y))) for x, y in grid]
cdt_verts, _, cdt_faces, _, _, _ = delaunay_2d_cdt(
    pts2, [(i, (i + 1) % nb) for i in range(nb)], [list(range(nb))], 2, 1e-6)

panel = bmesh.new()
uv = panel.loops.layers.uv.new("UVMap")
pv = []
for p in cdt_verts:
    co = drape(p)
    pv.append(panel.verts.new(co) if co else None)
for f in cdt_faces:
    vs = [pv[i] for i in f]
    if None in vs: continue
    try:
        face = panel.faces.new(vs)
    except ValueError:
        continue
    face.smooth = True
    for loop in face.loops:   # planar UVs, one unit per cell
        loop[uv].uv = (loop.vert.co.x / CELL, loop.vert.co.y / CELL)
bmesh.ops.recalc_face_normals(panel, faces=panel.faces)
for f in panel.faces:   # make sure the array faces up
    if f.normal.z < 0: f.normal_flip()
panel_me = bpy.data.meshes.new("SolarCells")
panel.to_mesh(panel_me); panel.free()
panel_me.materials.append(solar_mat)
panel_obj = bpy.data.objects.new("SolarCells", panel_me)
bpy.context.scene.collection.objects.link(panel_obj)

# --- 4. Keep the body under the array, then delete faces it fully hides ------------------
# Any deck vertex that pokes up through the array is pressed down just beneath it.
panel_bvh = BVHTree.FromObject(panel_obj, bpy.context.evaluated_depsgraph_get())
pressed = 0
for v in bm.verts:
    if v.co.z < 0.55 or v.normal.z < 0.2: continue
    hit = panel_bvh.ray_cast(Vector((v.co.x, v.co.y, 5.0)), Vector((0, 0, -1)))[0]
    if hit is not None and v.co.z > hit.z - 0.0008 and v.co.z < hit.z + 0.02:
        v.co.z = hit.z - 0.0008; pressed += 1
cand = [f for f in bm.faces if f.normal.z >= 0.3 and f.calc_center_median().z >= 0.55]
cc = np.array([tuple(f.calc_center_median())[:2] for f in cand])
mask = inside_np(cc)
idx = np.nonzero(mask)[0]
mask[idx[dist_np(cc[idx]) <= HIDE_MARGIN]] = False
hidden = []
for f, keep in zip(cand, mask):
    if not keep: continue
    c = f.calc_center_median()
    top = drape(Vector((c.x, c.y)))   # only delete if this face is the top surface the array covers
    if top is not None and abs(top.z - LIFT - c.z) < 0.01: hidden.append(f)
bmesh.ops.delete(bm, geom=hidden, context="FACES")
for f in bm.faces: f.smooth = True
body.matrix_world.identity()
bm.to_mesh(body.data); bm.free()
body.data.name = "Body"
body.name = "Body"

# Smooth shading with crisp creases.
for obj in (body, panel_obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True); bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))

# --- 5. LightStrip: soft emissive white ----------------------------------------------------
if light:
    m = light.data.materials[0]
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Emission Color"].default_value = (0.85, 0.93, 1.0, 1.0)
    bsdf.inputs["Emission Strength"].default_value = 1.0

# --- 6. Optional solar-cell texture ---------------------------------------------------------
# One tile = one pseudo-square cell: dark cell, light gaps and chamfered corners showing the
# backsheet. The site viewer tints the array navy, so the tile is greyscale and multiplies with it.
if CELLS:
    import numpy as np
    N = 128
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    gap = 3.0                      # gap half-width in pixels (~3 mm per side at 125 mm / 128 px)
    chamfer = 16.0                 # pseudo-square corner cut, in pixels
    d = np.minimum(np.minimum(xx, N - xx), np.minimum(yy, N - yy))
    corner = np.minimum(xx, N - xx) + np.minimum(yy, N - yy)
    cell = (d > gap) & (corner > chamfer + 2 * gap)
    v = np.where(cell, 0.62, 1.0)
    # Faint horizontal sheen variation so cells don't look like flat stickers.
    v = np.where(cell, v + 0.04 * np.sin(yy / N * np.pi), v)
    img = bpy.data.images.new("SolarCellTile", N, N, alpha=False)
    rgba = np.ones((N, N, 4), dtype=np.float32)
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = v
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = "PNG"
    img.pack()
    nt = solar_mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img; tex.extension = "REPEAT"
    tex.interpolation = "Linear"
    for link in list(bsdf.inputs["Base Color"].links): nt.links.remove(link)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

# --- Export --------------------------------------------------------------------------------
bpy.ops.export_scene.gltf(filepath=DST, export_format="GLB", export_yup=True, export_apply=True,
                          export_animations=False, export_cameras=False, export_lights=False,
                          export_texcoords=True, export_normals=True,
                          export_image_format="AUTO")
print("REPORT", dict(outline_pts=len(outline), simplified_corners=len(simple), rounded_pts=len(rounded),
                     seam_boundary_edges_before=boundary_before, after=boundary_after,
                     panel_tris=len(panel_me.polygons), hidden_body_faces=len(hidden), pressed_verts=pressed,
                     body_faces=len(body.data.polygons)))
