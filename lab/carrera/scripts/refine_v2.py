# Builds the Carrera v2 web model from the current carrera.glb (or a later hand-made model).
#
# Usage (Blender 4.2+ / 5.x, headless):
#   Blender -b --python refine_v2.py -- in.glb out.glb hotspots.json [options]
#
# Options:
#   --nose=-x|+x|-z|+z      glTF axis the nose points along in the INPUT (default -x for the scan).
#   --body-tris=N           body triangle budget after cleanup (default 70000).
#   --glass-tris=N          canopy glass triangle budget (default 6000).
#   --denoise=N             feature-preserving denoise rounds (default 6, 0 = off).
#   --sigma=F               normal-difference threshold of the denoise (default 0.45; lower keeps more edges).
#   --rim=red|graphite      rim/motor-cover colour (default red, as in the team's suspension CAD).
#   --blend=path.blend      also save the Blender scene for inspection.
#
# Output conventions (glTF, metres): +Y up, nose toward +Z, car-left toward +X, origin on the ground
# (y=0, tyre contact) under the centre of the car's bounding box.
#
# Steps:
#   1. Import, find the parts by name/material (body, solar, glass, tire, light), measure the tyres.
#   2. Re-orient and re-centre everything (baked into the mesh data, so every node starts at identity).
#   3. Weld body + glass + light strip into one surface and denoise it with a bilateral normal filter
#      (Zheng et al. 2011 / Sun et al. 2007 vertex update). It removes scan ripples while keeping creases.
#   4. Split the parts again and decimate body and glass with their borders pinned (no cracks).
#   5. Smooth the solar array sheet, give it car-aligned cell UVs, press the body just beneath it.
#   6. Unwrap the body into a planar-projection atlas for liveries (layout written to the JSON).
#   7. Replace the scanned tyre blobs with procedural wheels (tyre, rim, spokes or motor disc, hub,
#      brake disc) at the measured axle positions; each wheel is an empty at its axle centre.
#   8. PBR materials with stable names, hotspot empties, JSON sidecar, GLB export.
import bpy, bmesh, sys, math, json
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, DST, HOT = argv[0], argv[1], argv[2]
OPT = dict(a[2:].split("=", 1) for a in argv[3:] if a.startswith("--") and "=" in a)
NOSE = OPT.get("nose", "-x")
BODY_TRIS = int(OPT.get("body-tris", 70000))
GLASS_TRIS = int(OPT.get("glass-tris", 6000))
DENOISE = int(OPT.get("denoise", 6))
SIGMA_R = float(OPT.get("sigma", 0.45))
RIM = OPT.get("rim", "red")
BLEND = OPT.get("blend")
CELL = 0.125          # solar cell pitch (m)
LIFT = 0.0015         # array height above the deck (m)
REPORT = {}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for m in bpy.data.materials: m.name = "src_" + m.name   # free the final names for the new materials

def find(pattern):
    import re
    for o in meshes:
        names = [o.name] + [m.name for m in o.data.materials if m]
        if any(re.search(pattern, n, re.I) for n in names): return o
    return None

body, solar = find(r"body"), find(r"solar")
glass, tires, light = find(r"glass|window|canopy"), find(r"tire|tyre|wheel"), find(r"light")
assert body and solar, "need at least Body and SolarCells meshes"

# --- 2. Orientation ------------------------------------------------------------------------
# Blender is Z-up; glTF (x, y, z) imports as Blender (x, -z, y). glTF +Z (target nose) = Blender -Y.
nose_bl = {"-x": Vector((-1, 0, 0)), "+x": Vector((1, 0, 0)), "-z": Vector((0, 1, 0)), "+z": Vector((0, -1, 0))}[NOSE]
yaw = math.atan2(-1, 0) - math.atan2(nose_bl.y, nose_bl.x)          # rotate nose onto Blender -Y
R = Matrix.Rotation(yaw, 4, "Z")
for o in meshes:
    o.data.transform(R @ o.matrix_world)
    o.matrix_world = Matrix.Identity(4)
    o.data.update()

def bounds(objs):
    pts = np.concatenate([np.array([v.co for v in o.data.vertices], dtype=float) for o in objs])
    return pts.min(0), pts.max(0)

mn, mx = bounds(meshes)
ground = bounds([tires])[0][2] if tires else mn[2]
T = Matrix.Translation(Vector((-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -ground)))
for o in meshes:
    o.data.transform(T); o.data.update()
REPORT["recentre_offset_m"] = [round(c, 4) for c in T.translation]

# --- 1b. Measure the tyres (islands of the Tires mesh) ------------------------------------
def islands(obj):
    me = obj.data
    co = np.array([v.co for v in me.vertices])
    parent = np.arange(len(co))
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for e in me.edges:
        a, b = root(e.vertices[0]), root(e.vertices[1])
        if a != b: parent[a] = b
    roots = np.array([root(i) for i in range(len(co))])
    return [co[roots == r] for r in np.unique(roots)]

wheels = []
if tires:
    for pts in islands(tires):
        lo, hi = pts.min(0), pts.max(0)
        c = (lo + hi) / 2
        wheels.append(dict(center=Vector(c), radius=float((hi[2] - lo[2]) / 2),
                           width=float(hi[0] - lo[0]), diam_long=float(hi[1] - lo[1])))
wheels.sort(key=lambda w: w["center"].y)                     # front pair (more -Y) first
wheels = sorted(wheels[:2], key=lambda w: -w["center"].x) + sorted(wheels[2:], key=lambda w: -w["center"].x)
for w, name in zip(wheels, ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"]):
    w["name"] = name
assert len(wheels) == 4 and wheels[0]["center"].x > 0 > wheels[1]["center"].x, wheels
REPORT["wheels_measured"] = {w["name"]: dict(center=[round(c, 4) for c in w["center"]], radius=round(w["radius"], 4),
                                             width=round(w["width"], 4)) for w in wheels}

# --- 3. Join body + glass + light into one welded surface and denoise ---------------------
parts = [o for o in (body, glass, light) if o]
tags = {}
for o in parts:   # remember each part's material so the joined mesh can be split back by material
    tags[o.name] = o.data.materials[0]
bpy.ops.object.select_all(action="DESELECT")
for o in parts: o.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
work = bpy.context.view_layer.objects.active
work.name = "Work"
bm = bmesh.new(); bm.from_mesh(work.data)
bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
seam = list({v for e in bm.edges if e.is_boundary for v in e.verts})
bmesh.ops.remove_doubles(bm, verts=seam, dist=0.002)
REPORT["boundary_edges_after_weld"] = sum(1 for e in bm.edges if e.is_boundary)
bm.to_mesh(work.data); bm.free()

def mesh_arrays(me):
    n, m = len(me.vertices), len(me.polygons)
    V = np.empty(n * 3); me.vertices.foreach_get("co", V)
    F = np.empty(m * 3, dtype=np.int64); me.polygons.foreach_get("vertices", F)
    return V.reshape(-1, 3), F.reshape(-1, 3)

def face_geom(V, F):
    e1, e2 = V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]
    N = np.cross(e1, e2); A = np.linalg.norm(N, axis=1)
    return N / np.maximum(A, 1e-20)[:, None], A / 2, V[F].mean(1)

def ring_pairs(F, n):
    # Face pairs that share at least one vertex (the 1-ring face neighbourhood).
    m = len(F)
    inc_v = F.ravel(); inc_f = np.repeat(np.arange(m), 3)
    order = np.argsort(inc_v, kind="stable"); sv, sf = inc_v[order], inc_f[order]
    counts = np.bincount(sv, minlength=n); starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    I, J = [], []
    for a in range(counts.max()):
        for b in range(counts.max()):
            if a == b: continue
            vs = np.nonzero((counts > a) & (counts > b))[0]
            if len(vs) == 0: continue
            I.append(sf[starts[vs] + a]); J.append(sf[starts[vs] + b])
    key = np.unique(np.concatenate(I) * m + np.concatenate(J))
    return key // m, key % m

def denoise(obj, rounds, sigma_r, normal_iters=6, vert_iters=10):
    me = obj.data
    V, F = mesh_arrays(me)
    n, m = len(V), len(F)
    bm = bmesh.new(); bm.from_mesh(me)
    fixed = np.array([v.is_boundary for v in bm.verts])
    # Part seams (body/glass, body/light strip): straighten them along their own length first, then
    # hold them still. Left free, the filter snaps seam vertices to either side and the edge turns jagged.
    seam_adj = {}
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.link_faces[0].material_index != e.link_faces[1].material_index:
            a_, b_ = e.verts[0].index, e.verts[1].index
            seam_adj.setdefault(a_, []).append(b_); seam_adj.setdefault(b_, []).append(a_)
    bm.free()
    chain = [v for v, nb in seam_adj.items() if len(nb) == 2 and not fixed[v]]
    if chain:
        ci = np.array(chain); nb = np.array([seam_adj[v] for v in chain])
        for i in range(40):
            V[ci] += (0.5 if i % 2 == 0 else -0.53) * (0.5 * (V[nb[:, 0]] + V[nb[:, 1]]) - V[ci])
    fixed[list(seam_adj)] = True
    I, J = ring_pairs(F, n)
    V0 = V.copy()
    deg = np.bincount(F.ravel(), minlength=n).astype(float)
    def roughness(V):
        N, A, C = face_geom(V, F)
        return float(np.degrees(np.arccos(np.clip((N[I] * N[J]).sum(1), -1, 1))).mean())
    r0 = roughness(V)
    N0 = face_geom(V, F)[0]
    reverted = np.zeros(n, bool)
    for _ in range(rounds):
        N, A, C = face_geom(V, F)
        d2 = ((C[I] - C[J]) ** 2).sum(1)
        sigma_s = np.sqrt(d2).mean()
        ws = np.exp(-d2 / (2 * sigma_s ** 2)) * A[J]
        for _ in range(normal_iters):
            wr = np.exp(-((N[I] - N[J]) ** 2).sum(1) / (2 * sigma_r ** 2))
            w = ws * wr
            acc = A[:, None] * N
            for k in range(3): acc[:, k] += np.bincount(I, weights=w * N[J, k], minlength=m)
            N = acc / np.linalg.norm(acc, axis=1)[:, None]
        for _ in range(vert_iters):
            C = V[F].mean(1)
            delta = np.zeros_like(V)
            for k in range(3):
                proj = (N * (C - V[F[:, k]])).sum(1)[:, None] * N
                for c in range(3): delta[:, c] += np.bincount(F[:, k], weights=proj[:, c], minlength=n)
            delta /= np.maximum(deg, 1)[:, None]
            delta[fixed] = 0
            Vn = V + delta
            # Fold guard: undo the step around any face that turned more than ~60 deg away from the
            # scan (these show up as dark specks on thin edges such as the deck lip).
            Nn = face_geom(Vn, F)[0]
            bad = (Nn * N0).sum(1) < 0.5
            if bad.any():
                Vn[F[bad].ravel()] = V[F[bad].ravel()]; reverted[F[bad].ravel()] = True
            V = Vn
    me.vertices.foreach_set("co", V.ravel()); me.update()
    disp = np.linalg.norm(V - V0, axis=1) * 1000
    return dict(roughness_deg_before=round(r0, 3), roughness_deg_after=round(roughness(V), 3),
                disp_mm_mean=round(float(disp.mean()), 3), disp_mm_p99=round(float(np.percentile(disp, 99)), 3),
                disp_mm_max=round(float(disp.max()), 3), fold_guard_verts=int(reverted.sum()))

if DENOISE > 0:
    REPORT["denoise"] = denoise(work, DENOISE, SIGMA_R)

# --- 4. Split back into parts and decimate with borders pinned ----------------------------
bpy.ops.object.select_all(action="DESELECT")
work.select_set(True); bpy.context.view_layer.objects.active = work
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.separate(type="MATERIAL"); bpy.ops.object.mode_set(mode="OBJECT")
split = {}
for o in bpy.context.selected_objects:
    mat = o.data.materials[o.data.polygons[0].material_index]
    for name, m in tags.items():
        if m == mat: split[name] = o
    # drop unused slots so each part has exactly one material
    keep = mat
    o.data.materials.clear(); o.data.materials.append(keep)
    for p in o.data.polygons: p.material_index = 0
for name, o in split.items():
    lname = name.lower()
    if "body" in lname: body = o
    elif "light" in lname: light = o
    else: glass = o
body.name = "Body"
if glass: glass.name = "Canopy"
if light: light.name = "LightStrip"

def decimate(obj, target_tris):
    me = obj.data
    if len(me.polygons) <= target_tris: return len(me.polygons)
    bm = bmesh.new(); bm.from_mesh(me)
    border = [v.index for v in bm.verts if v.is_boundary]; bm.free()
    vg = obj.vertex_groups.new(name="decimate")
    vg.add(list(range(len(me.vertices))), 1.0, "REPLACE")
    vg.add(border, 0.0, "REPLACE")        # weight 0 = pinned (higher collapse cost)
    mod = obj.modifiers.new("dec", "DECIMATE")
    mod.decimate_type = "COLLAPSE"; mod.ratio = target_tris / len(me.polygons)
    mod.vertex_group = "decimate"; mod.vertex_group_factor = 1000.0
    mod.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True); bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.vertex_groups.clear()
    return len(obj.data.polygons)

REPORT["body_tris"] = [len(body.data.polygons), decimate(body, BODY_TRIS)]
if glass: REPORT["glass_tris"] = [len(glass.data.polygons), decimate(glass, GLASS_TRIS)]

# --- 5. Solar array: smooth sheet, car-aligned cell UVs, body pressed beneath ---------------
def taubin(obj, iters=30, lam=0.5, mu=-0.53, zonly=True):
    V, F = mesh_arrays(obj.data)
    bm = bmesh.new(); bm.from_mesh(obj.data)
    fixed = np.array([v.is_boundary for v in bm.verts])
    E = np.array([[e.verts[0].index, e.verts[1].index] for e in bm.edges]); bm.free()
    n = len(V); deg = np.bincount(E.ravel(), minlength=n).astype(float)
    V0 = V.copy()
    for i in range(iters * 2):
        s = lam if i % 2 == 0 else mu
        acc = np.zeros_like(V)
        for c in range(3):
            acc[:, c] = np.bincount(E[:, 0], weights=V[E[:, 1], c], minlength=n) + \
                        np.bincount(E[:, 1], weights=V[E[:, 0], c], minlength=n)
        lap = acc / np.maximum(deg, 1)[:, None] - V
        lap[fixed] = 0
        if zonly: lap[:, :2] = 0      # the array is a height field: smooth heights only, no sliding
        V = V + s * lap
    obj.data.vertices.foreach_set("co", V.ravel()); obj.data.update()
    d = np.linalg.norm(V - V0, axis=1) * 1000
    return dict(disp_mm_mean=round(float(d.mean()), 3), disp_mm_max=round(float(d.max()), 3))

solar.name = "SolarArray"
REPORT["array_smooth"] = taubin(solar)
me = solar.data
uvl = me.uv_layers[0] if me.uv_layers else me.uv_layers.new(name="UVMap")
for loop in me.loops:   # rows of cells run along the car; u = along length, v = across
    co = me.vertices[loop.vertex_index].co
    uvl.data[loop.index].uv = (co.y / CELL, co.x / CELL)

dg = bpy.context.evaluated_depsgraph_get()
array_bvh = BVHTree.FromObject(solar, dg)
bm = bmesh.new(); bm.from_mesh(body.data)
pressed = 0
for v in bm.verts:
    hit = array_bvh.ray_cast(Vector((v.co.x, v.co.y, v.co.z - 0.05)), Vector((0, 0, 1)), 0.08)
    if hit[0] is not None and hit[0].z - v.co.z < 0.03 and v.co.z > hit[0].z - LIFT:
        v.co.z = hit[0].z - LIFT; pressed += 1
bm.to_mesh(body.data); bm.free()
REPORT["body_verts_pressed_under_array"] = pressed

# --- 6. Body UV atlas for liveries ----------------------------------------------------------
# Every body face is projected flat from one of eight directions, all at the same scale (metres),
# so a livery drawn on a 1:1 side/top view lands undistorted. Regions (image space, top = v 1):
#   top | left outer side | right outer side | bottom | tunnel walls (L, R) in the main column,
#   front and back in a narrow right-hand column. Front and back are drawn as seen from outside.
bmn, bmx = bounds([body])
Lr, Wr, Hr = bmx[1] - bmn[1], bmx[0] - bmn[0], bmx[2] - bmn[2]
PAD = 0.06
def proj(region, co):
    x, y, z = co
    if region == "top":    return (y - bmn[1], bmx[0] - x)          # seen from above: nose left, car-right up
    if region == "bottom": return (y - bmn[1], x - bmn[0])
    if region == "left":   return (y - bmn[1], z - bmn[2])          # viewed from car-left: nose on the left
    if region == "right":  return (bmx[1] - y, z - bmn[2])          # viewed from car-right: nose on the right
    if region == "innerL": return (bmx[1] - y, z - bmn[2])          # left pod inner wall, seen from the tunnel
    if region == "innerR": return (y - bmn[1], z - bmn[2])
    if region == "front":  return (x - bmn[0], z - bmn[2])
    if region == "back":   return (bmx[0] - x, z - bmn[2])
# Heights of the tunnel wall bands: the tunnel walls sit below the deck.
TUN = 0.8
size = {"top": (Lr, Wr), "left": (Lr, Hr), "right": (Lr, Hr), "bottom": (Lr, Wr),
        "innerL": (Lr, TUN), "innerR": (Lr, TUN), "front": (Wr, Hr), "back": (Wr, Hr)}
order_main = ["top", "left", "right", "bottom", "innerL", "innerR"]
col_h = sum(size[r][1] for r in order_main) + PAD * (len(order_main) + 1)
S = max(col_h, Lr + Wr + PAD * 3)          # side of the square atlas, in metres
origin = {}
yv = S - PAD
for r in order_main:
    yv -= size[r][1]; origin[r] = (PAD, yv); yv -= PAD
yv = S - PAD
for r in ["front", "back"]:
    yv -= size[r][1]; origin[r] = (Lr + 2 * PAD, yv); yv -= PAD
bm = bmesh.new(); bm.from_mesh(body.data)
uv = bm.loops.layers.uv.new("UVMap")
counts = {}
for f in bm.faces:
    nx, ny, nz = f.normal; cx = f.calc_center_median().x
    if ny < -0.8: r = "front"
    elif ny > 0.8: r = "back"
    elif abs(nz) >= abs(nx): r = "top" if nz > 0 else "bottom"
    elif nx * cx > 0: r = "left" if nx > 0 else "right"
    else:
        r = "innerL" if cx > 0 else "innerR"
        if f.calc_center_median().z > bmn[2] + TUN: r = "left" if nx > 0 else "right"
    counts[r] = counts.get(r, 0) + 1
    ox, oy = origin[r]
    for loop in f.loops:
        u, v = proj(r, loop.vert.co)
        if r in ("innerL", "innerR"): v = min(v, TUN)
        loop[uv].uv = ((ox + u) / S, (oy + v) / S)
bm.to_mesh(body.data); bm.free()
REPORT["uv_atlas"] = dict(size_m=round(S, 3), faces_per_region=counts,
                          convention="One square texture, same scale everywhere (size_m metres per texture side). "
                                     "origin_uv/size_uv are measured from the image's bottom-left corner, so 'top' is the "
                                     "top band of the image. Paint an image in this layout and use it as a glTF texture "
                                     "(three: texture.flipY = false, as GLTFLoader does). top: seen from above, nose left; "
                                     "left/right: outer sides seen from outside (nose left on the left side, nose right on "
                                     "the right side); bottom: seen from below; innerL/innerR: tunnel-facing pod walls; "
                                     "front/back: nose and tail faces seen from outside.",
                          regions={r: dict(origin_uv=[round(origin[r][0] / S, 4), round(origin[r][1] / S, 4)],
                                           size_uv=[round(size[r][0] / S, 4), round(size[r][1] / S, 4)]) for r in size})

# --- 7. Procedural wheels -------------------------------------------------------------------
if tires:
    bpy.data.objects.remove(tires, do_unlink=True)

def revolve(bm, profile, segs, closed_profile=False, mat=0):
    # profile: list of (x, r); revolves around the local X axis (the axle).
    rings = []
    for k in range(segs):
        a = 2 * math.pi * k / segs
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm.verts.new((x, r * ca, r * sa)) for x, r in profile])
    n = len(profile)
    faces = []
    for k in range(segs):
        r0, r1 = rings[k], rings[(k + 1) % segs]
        for i in range(n if closed_profile else n - 1):
            j = (i + 1) % n
            try:
                f = bm.faces.new((r0[i], r1[i], r1[j], r0[j])); f.material_index = mat; f.smooth = True
                faces.append(f)
            except ValueError:
                pass
    return faces

def box(bm, p0, p1, w0, w1, d0, d1, et, ex, mat):
    # Tapered box from p0 to p1 (Vectors); width along et, depth along ex.
    vs = []
    for p, w, d in ((p0, w0, d0), (p1, w1, d1)):
        for sx, st in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            vs.append(bm.verts.new(p + et * (st * w / 2) + ex * (sx * d / 2)))
    quads = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    for q in quads:
        f = bm.faces.new([vs[i] for i in q]); f.material_index = mat; f.smooth = False

def build_wheel(w, materials):
    name, R, W = w["name"], w["radius"], w["width"]
    side = 1 if w["center"].x > 0 else -1          # +1: outer face toward +X (car-left)
    front = name in ("Wheel_FL", "Wheel_FR")
    hw = W / 2
    rb = R - 0.105                                 # bead seat radius (~16 in rim)
    bm = bmesh.new()
    SEG = 64
    # Tyre: superellipse cross-section, slick tread, slightly squared shoulders.
    h = R - rb; rc = rb + h * 0.5; ax, br, p = hw, h * 0.5, 2.6
    prof = []
    for k in range(25):
        phi = math.radians(-58 + (180 + 116) * k / 24)
        c, s = math.cos(phi), math.sin(phi)
        x = ax * math.copysign(abs(c) ** (2 / p), c)
        r = rc + br * math.copysign(abs(s) ** (2 / p), s)
        prof.append((x, r))
    revolve(bm, prof, SEG, closed_profile=False, mat=0)
    # Rim hoop (closed profile): flanges, bead seats and the drop centre.
    bx = prof[0][0]
    rim = [(bx + 0.002, rb + 0.012), (bx + 0.006, rb + 0.004), (bx * 0.9, rb - 0.006), (bx * 0.45, rb - 0.01),
           (bx * 0.35, rb - 0.024), (-bx * 0.35, rb - 0.024), (-bx * 0.45, rb - 0.01), (-bx * 0.9, rb - 0.006),
           (-bx - 0.006, rb + 0.004), (-bx - 0.002, rb + 0.012), (-bx + 0.001, rb + 0.006), (-bx * 0.9, rb - 0.034),
           (bx * 0.9, rb - 0.034), (bx - 0.001, rb + 0.006)]
    revolve(bm, rim, SEG, closed_profile=True, mat=1)
    r_in = rb - 0.034                              # inner face of the rim, where spokes/disc meet it
    if front:
        # Five Y-spoke pairs (as in the team's suspension CAD), dished slightly outward at the hub.
        for k in range(5):
            a0 = 2 * math.pi * k / 5
            for da in (-0.13, 0.13):
                er0 = Vector((0, math.cos(a0), math.sin(a0)))
                er1 = Vector((0, math.cos(a0 + da), math.sin(a0 + da)))
                p0 = er0 * 0.05 + Vector((side * 0.012, 0, 0))
                p1 = er1 * (r_in + 0.004)
                et = Vector((1, 0, 0)).cross((p1 - p0).normalized()).normalized()
                box(bm, p0, p1, 0.022, 0.014, 0.024, 0.014, et, Vector((1, 0, 0)), 1)
        hub = [(side * 0.03, 0.0), (side * 0.03, 0.028), (side * 0.024, 0.04), (side * 0.012, 0.055),
               (-side * 0.012, 0.055), (-side * 0.035, 0.04), (-side * 0.035, 0.0)]
        revolve(bm, hub, 32, mat=2)
    else:
        # Hub motor: a domed outer cover and flat inner cover spanning hub to rim.
        motor = [(side * 0.034, 0.0), (side * 0.034, 0.03), (side * 0.03, 0.045), (side * 0.026, 0.06),
                 (side * 0.026, 0.11), (side * 0.024, 0.16), (side * 0.02, r_in - 0.012), (side * 0.012, r_in + 0.004),
                 (-side * 0.012, r_in + 0.004), (-side * 0.024, r_in - 0.012), (-side * 0.03, 0.12),
                 (-side * 0.03, 0.06), (-side * 0.04, 0.045), (-side * 0.04, 0.0)]
        revolve(bm, motor, SEG, mat=1)
        cap = [(side * 0.0345, 0.0), (side * 0.0345, 0.026), (side * 0.03, 0.03)]
        revolve(bm, cap, 32, mat=2)
        for k in range(10):   # bolt circle on the motor cover
            a = 2 * math.pi * k / 10
            c = Vector((side * 0.0262, math.cos(a) * 0.085, math.sin(a) * 0.085))
            bolt = [(0.0, 0.0), (0.0, 0.006), (side * 0.004, 0.006), (side * 0.004, 0.0)]
            vs0 = len(bm.verts)
            revolve(bm, [(c.x + x, r) for x, r in bolt], 8, mat=2)
            bm.verts.ensure_lookup_table()
            for v in bm.verts[vs0:]:
                v.co.y += c.y; v.co.z += c.z
    # Brake disc and caliper on the inboard side.
    dx = -side * (0.045 if front else 0.05)
    disc = [(dx + 0.002, 0.075), (dx + 0.002, 0.11), (dx - 0.002, 0.11), (dx - 0.002, 0.075)]
    revolve(bm, disc, 48, closed_profile=True, mat=2)
    hat = [(dx + 0.002, 0.03), (dx + 0.002, 0.079), (dx - 0.0015, 0.079), (dx - 0.0015, 0.05),
           (-side * 0.03, 0.045), (-side * 0.03, 0.03)]          # disc carrier back to the hub
    revolve(bm, hat, 32, closed_profile=True, mat=2)
    # No caliper: it would spin with the wheel node.
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name + "_Geo")
    bm.to_mesh(me); bm.free()
    for m in materials: me.materials.append(m)
    geo = bpy.data.objects.new(name + "_Geo", me)
    pivot = bpy.data.objects.new(name, None)
    pivot.empty_display_type = "ARROWS"; pivot.empty_display_size = 0.15
    pivot.location = w["center"]
    for o in (geo, pivot): bpy.context.scene.collection.objects.link(o)
    geo.parent = pivot
    bpy.ops.object.select_all(action="DESELECT")
    geo.select_set(True); bpy.context.view_layer.objects.active = geo
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
    return pivot, geo

# --- 8a. Materials -------------------------------------------------------------------------
def srgb(c):
    return tuple(((x / 255) / 12.92) if x / 255 <= 0.04045 else (((x / 255) + 0.055) / 1.055) ** 2.4 for x in c)

def pbr(name, base, rough, metal=0.0, coat=0.0, coat_rough=0.1, alpha=1.0, emit=None, emit_strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*base, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = coat_rough
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        try: m.surface_render_method = "BLENDED"
        except Exception: m.blend_method = "BLEND"
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = emit_strength
    m.diffuse_color = (*base, alpha)
    m.use_backface_culling = name not in ("CarBody",)   # the body is an open shell: show both sides
    return m, b

M = {}
M["CarBody"], _ = pbr("CarBody", srgb((238, 241, 245)), 0.32, coat=1.0, coat_rough=0.08)
M["SolarArray"], sb = pbr("SolarArray", (1, 1, 1), 0.34, coat=0.5, coat_rough=0.14)
M["SolarArray"].diffuse_color = (*srgb((14, 24, 44)), 1)   # viewport colour only
M["CanopyGlass"], _ = pbr("CanopyGlass", srgb((16, 21, 28)), 0.04, alpha=0.9)
M["Tire"], _ = pbr("Tire", srgb((18, 18, 20)), 0.86)
M["Rim"], _ = pbr("Rim", srgb((178, 28, 34)) if RIM == "red" else srgb((52, 56, 62)), 0.38, metal=0.35, coat=0.5, coat_rough=0.15)
M["Hub"], _ = pbr("Hub", srgb((196, 199, 204)), 0.3, metal=1.0)
M["LightStrip"], _ = pbr("LightStrip", srgb((235, 244, 255)), 0.3, emit=srgb((215, 235, 255)), emit_strength=6.0)

# Solar cell tile: one 125 mm pseudo-square mono cell per tile, 256 px. Dark blue-black cell,
# five faint busbars, fine fingers, and slate-coloured gaps and chamfer corners (the backsheet).
N = 256
yy, xx = np.mgrid[0:N, 0:N] + 0.5
gap = 5.0; chamfer = 30.0
d = np.minimum(np.minimum(xx, N - xx), np.minimum(yy, N - yy))
corner = np.minimum(xx, N - xx) + np.minimum(yy, N - yy)
cell = (d > gap) & (corner > chamfer + 2 * gap)
col = np.zeros((N, N, 3)); col[:] = srgb((78, 100, 138))                   # backsheet / gaps
cellc = np.array(srgb((14, 34, 68)))
sheen = 1 + 0.10 * np.sin(yy / N * np.pi)[..., None]
col = np.where(cell[..., None], cellc * sheen, col)
fingers = cell & ((yy.astype(int) % 6) == 0)
col = np.where(fingers[..., None], np.array(srgb((22, 42, 78))), col)
bus = np.zeros((N, N), bool)
for k in range(5):
    cx = gap + (N - 2 * gap) * (k + 0.5) / 5
    bus |= np.abs(xx - cx) < 1.2
bus &= cell
col = np.where(bus[..., None], np.array(srgb((92, 108, 134))), col)
img = bpy.data.images.new("SolarCellTile", N, N, alpha=False)
rgba = np.ones((N, N, 4), dtype=np.float32); rgba[..., :3] = col
img.pixels.foreach_set(rgba.ravel()); img.file_format = "PNG"; img.pack()
nt = M["SolarArray"].node_tree
tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img; tex.extension = "REPEAT"; tex.interpolation = "Linear"
nt.links.new(tex.outputs["Color"], sb.inputs["Base Color"])

def assign(obj, mat):
    obj.data.materials.clear(); obj.data.materials.append(mat)
    for p in obj.data.polygons: p.material_index = 0

assign(body, M["CarBody"]); assign(solar, M["SolarArray"])
if glass: assign(glass, M["CanopyGlass"])
if light: assign(light, M["LightStrip"])

for obj, ang in ((body, 32), (solar, 40), (glass, 50), (light, 50)):
    if not obj: continue
    for p in obj.data.polygons: p.use_smooth = True
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True); bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(ang))

pivots = {}
for w in wheels:
    pv, geo = build_wheel(w, [M["Tire"], M["Rim"], M["Hub"]])
    pivots[w["name"]] = pv

# --- 8b. Hotspots ----------------------------------------------------------------------------
dg = bpy.context.evaluated_depsgraph_get()
skin = [o for o in (body, glass, solar) if o]
bvhs = [BVHTree.FromObject(o, dg) for o in skin]

def cast(origin, direction, dist=10.0):
    best = None
    for b in bvhs:
        hit = b.ray_cast(origin, direction, dist)
        if hit[0] is not None and (best is None or hit[3] < best[3]): best = hit
    return best

def to_gltf(v):
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]

hot = {}
def add_hot(name, pos, normal, kind, note):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = "SPHERE"; e.empty_display_size = 0.04
    e.location = pos
    bpy.context.scene.collection.objects.link(e)
    hot[name] = dict(position=to_gltf(pos), normal=to_gltf(normal.normalized()), kind=kind, note=note)

bco = np.array([v.co for v in body.data.vertices])
# Nose: the most forward point of the body, on the centre-ish of the leading edge.
fwd = bco[:, 1].min()
cand = bco[bco[:, 1] < fwd + 0.01]
nose_pt = Vector(cand[np.argmin(np.abs(cand[:, 0]))])
hit = cast(Vector((0, fwd - 1.0, nose_pt.z)), Vector((0, 1, 0)))
add_hot("Hotspot_Nose", hit[0] if hit else nose_pt, Vector((0, -1, 0)), "surface", "Leading edge of the nose, on the centreline.")
# Solar array: area-weighted centre of the array, dropped onto its top surface.
sme = solar.data
ac = Vector(); at = 0.0
for p in sme.polygons:
    ac += p.center * p.area; at += p.area
ac /= at
hit = cast(Vector((ac.x, ac.y, 5)), Vector((0, 0, -1)))
add_hot("Hotspot_SolarArray", hit[0], hit[1], "surface", "Top of the solar array near its area centre.")
# Canopy: the highest point of the canopy dome.
gco = np.array([v.co for v in glass.data.vertices]) if glass else bco
gx, gy = (gco[:, 0].min() + gco[:, 0].max()) / 2, (gco[:, 1].min() + gco[:, 1].max()) / 2
hit = cast(Vector((gx, gy, 5)), Vector((0, 0, -1)))
add_hot("Hotspot_Canopy", hit[0], hit[1], "surface", "Top of the canopy over the driver's cockpit (car-left pod).")
# Wheels: the outer wall of the wheel fairing, level with the axle.
def fairing_point(w):
    c = w["center"]; s = 1 if c.x > 0 else -1
    hit = cast(Vector((s * 3, c.y, c.z)), Vector((-s, 0, 0)))
    return hit
wd = {w["name"]: w for w in wheels}
h = fairing_point(wd["Wheel_FR"]); add_hot("Hotspot_WheelFront", h[0], h[1], "surface", "Fairing wall over the front-right axle (hub inside: see wheels.Wheel_FR).")
h = fairing_point(wd["Wheel_RR"]); add_hot("Hotspot_WheelRear", h[0], h[1], "surface", "Fairing wall over the rear-right axle (hub inside: see wheels.Wheel_RR).")
h = fairing_point(wd["Wheel_RL"]); add_hot("Hotspot_Motor", h[0], h[1], "surface", "Fairing wall over the rear-left hub. Carrera drives one rear wheel with a hub motor; which side is an assumption (left).")
# Battery: estimate. Driver sits in the car-left pod under the canopy, so the pack is placed low in the
# car-right pod between the axles (the space between the pods is an open tunnel).
rp = wd["Wheel_FR"]["center"]; rr = wd["Wheel_RR"]["center"]
by = (rp.y + rr.y) / 2
up = cast(Vector((rp.x, by, -1)), Vector((0, 0, 1)))
floor_z = up[0].z if up else 0.08
batt = Vector((rp.x, by, floor_z + 0.12))
add_hot("Hotspot_BatteryPack", batt, Vector((-1, 0, 0)), "interior",
        "ESTIMATE, not from CAD: low in the car-right pod between the axles, 12 cm above the pod floor.")

# --- 8c. Hierarchy and export ---------------------------------------------------------------
root = bpy.data.objects.new("Carrera", None)
bpy.context.scene.collection.objects.link(root)
for o in list(bpy.context.scene.collection.objects):
    if o is root or o.parent is not None or o.type not in ("MESH", "EMPTY"): continue
    o.parent = root
for o in list(bpy.data.objects):   # remove anything left over from the import
    if o.type == "MESH" and o.users_collection and o.name not in {"Body", "SolarArray", "Canopy", "LightStrip"} \
            and not o.name.endswith("_Geo"):
        bpy.data.objects.remove(o, do_unlink=True)

for i, me in enumerate(bpy.data.meshes): me.name = f"tmp_{i}"
for o in bpy.data.objects:   # mesh data names = node names, so glTF mesh names are stable too
    if o.type == "MESH": o.data.name = o.name
for m in [m for m in bpy.data.materials if m.name.startswith("src_")]: bpy.data.materials.remove(m)
if BLEND: bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.export_scene.gltf(filepath=DST, export_format="GLB", export_yup=True, export_apply=True,
                          export_animations=False, export_cameras=False, export_lights=False,
                          export_texcoords=True, export_normals=True, export_extras=False,
                          export_image_format="AUTO")

wheel_info = {}
for w in wheels:
    wheel_info[w["name"]] = dict(axle_center=to_gltf(w["center"]), axis=[1, 0, 0], radius=round(w["radius"], 4),
                                 tyre_width=round(w["width"], 4),
                                 type="hub-motor disc (procedural)" if w["name"].startswith("Wheel_R") else "Y-spoke (procedural)")
out = dict(model="carrera-v2.glb", units="metres",
           axes={"up": "+Y", "nose": "+Z", "car_left": "+X", "origin": "ground plane, centre of the car's bounding box"},
           hotspots=hot, wheels=wheel_info,
           wheel_spin="rotate each Wheel_* node about its local X axis; positive rotation.x rolls the car forward (+Z). "
                      "Angle per metre travelled = 1 / radius.",
           body_uv_atlas=REPORT["uv_atlas"])
with open(HOT, "w") as f: json.dump(out, f, indent=2)
print("REPORT " + json.dumps(REPORT))
