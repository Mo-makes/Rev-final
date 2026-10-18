# Showroom pass for the Carrera v2 web model: runs on the scene refine_v2.py saved (--blend) and adds the
# cues that make the model read as a real car rather than a clean 3D model.
#
# Usage (from the repo root; build_v2.sh runs it):
#   Blender -b lab/carrera/carrera-v2.blend --python lab/carrera/scripts/enhance_v2.py -- out-raw.glb hotspots.json
#        [--ao-size=1024] [--ao-samples=384] [--ao-dist=0.6] [--liner-tris=9000] [--end-smooth=24] [--no-cockpit] [--no-ao]
#        [--blend=out.blend]
#
# What it adds (material names stay as refine_v2.py made them, so studio.js keeps matching them):
#   1. Baked ambient occlusion (Cycles), the main grounding cue: creases between pods and deck, canopy base,
#      wheel openings, the underside and the floor contact (a ground plane is present during the bake).
#        - Body: second UV set (TEXCOORD_1, smart-projected) + occlusionTexture (texCoord 1). TEXCOORD_0 stays the
#          livery atlas, untouched.
#        - SolarArray: second UV set (TEXCOORD_1, planar from above) + occlusionTexture (texCoord 1).
#   2. An ILLUSTRATIVE cockpit in the car-left pod (not from CAD): dark liner inside the pod and canopy roof,
#      reclined seat shell, roll hoop with rear braces, wheel housings, dash cowl with a small screen, steering
#      wheel. Nodes Cockpit_* under one "Cockpit" empty; materials Interior*. Ambient occlusion is baked into
#      their vertex colours (COLOR_0) with the canopy glass removed, so the cabin is darker away from the glass.
#   3. Solar array: a 4 x 4 cell tile with per-cell colour variation, silver busbars and fingers, backsheet
#      diamonds at the chamfered corners (baseColorTexture), and a normal map for the encapsulation dipping into
#      the gaps between cells and the slight pillowing of each cell (normalTexture + clearcoatNormalTexture).
#   4. Body: a very fine "orange peel" paint normal map, tiled with KHR_texture_transform on TEXCOORD_0
#      (normalTexture + clearcoatNormalTexture; its strength is baked into the texture, scale 1).
#   5. Tyres: profile UVs (TEXCOORD_0) and a roughness map (metallicRoughnessTexture, G channel): a smoother
#      worn tread band and matte sidewalls with fine moulded rings.
#   6. Lighter, reflective canopy tint so the cockpit shows through.
import bpy, bmesh, sys, os, math, json
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
DST, HOT = argv[0], argv[1]
FLAGS = set(a for a in argv[2:] if a.startswith("--") and "=" not in a)
OPT = dict(a[2:].split("=", 1) for a in argv[2:] if a.startswith("--") and "=" in a)
AO_SIZE = int(OPT.get("ao-size", 1024))
AO_SAMPLES = int(OPT.get("ao-samples", 384))
AO_DIST = float(OPT.get("ao-dist", 0.6))
COCKPIT = "--no-cockpit" not in FLAGS
BAKE_AO = "--no-ao" not in FLAGS
BLEND = OPT.get("blend")
LINER_TRIS = int(OPT.get("liner-tris", 9000))
LIP_SMOOTH = int(OPT.get("end-smooth", 24))
REPORT = {}
sc = bpy.context.scene
rng = np.random.default_rng(7)

body = bpy.data.objects["Body"]
solar = bpy.data.objects["SolarArray"]
canopy = bpy.data.objects.get("Canopy")
root = bpy.data.objects["Carrera"]
wheel_geos = [o for o in bpy.data.objects if o.name.endswith("_Geo")]
wheel_piv = {o.name: o for o in bpy.data.objects if o.name.startswith("Wheel_") and o.type == "EMPTY"}

def srgb(c):
    return tuple(((x / 255) / 12.92) if x / 255 <= 0.04045 else (((x / 255) + 0.055) / 1.055) ** 2.4 for x in c)

def principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

def make_image(name, arr, non_color=False):
    # arr: (H, W, 3|4) float 0..1, row 0 = TOP of the image.
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    # Colour space first: changing it later reloads the image and drops the pixels written below.
    if non_color: img.colorspace_settings.name = "Non-Color"
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :arr.shape[2]] = arr[..., :4]
    img.pixels.foreach_set(rgba[::-1].ravel())     # Blender stores rows bottom-up
    img.file_format = "PNG"; img.pack()
    return img

def tex_node(mat, img, uv_name=None, non_color=False, scale=None, loc=(-800, 0)):
    nt = mat.node_tree
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = img; t.location = loc
    t.interpolation = "Linear"; t.extension = "REPEAT"
    vec = None
    if uv_name:
        uvn = nt.nodes.new("ShaderNodeUVMap"); uvn.uv_map = uv_name; uvn.location = (loc[0] - 400, loc[1])
        vec = uvn.outputs["UV"]
    if scale:
        mp = nt.nodes.new("ShaderNodeMapping"); mp.location = (loc[0] - 200, loc[1])
        mp.inputs["Scale"].default_value = (scale[0], scale[1], 1)
        if vec is None:
            uvn = nt.nodes.new("ShaderNodeUVMap"); uvn.location = (loc[0] - 400, loc[1])
            vec = uvn.outputs["UV"]
        nt.links.new(vec, mp.inputs["Vector"]); vec = mp.outputs["Vector"]
    if vec is not None: nt.links.new(vec, t.inputs["Vector"])
    return t

def gltf_output_group():
    ng = bpy.data.node_groups.get("glTF Material Output")
    if ng: return ng
    ng = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    ng.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    ng.nodes.new("NodeGroupInput")
    return ng

def hook_occlusion(mat, img, uv_name):
    nt = mat.node_tree
    t = tex_node(mat, img, uv_name, non_color=True, loc=(-800, -700))
    sep = nt.nodes.new("ShaderNodeSeparateColor"); sep.location = (-500, -700)
    nt.links.new(t.outputs["Color"], sep.inputs["Color"])
    g = nt.nodes.new("ShaderNodeGroup"); g.node_tree = gltf_output_group(); g.location = (-250, -700)
    nt.links.new(sep.outputs["Red"], g.inputs["Occlusion"])
    return t

def hook_normal(mat, img, uv_name=None, scale=None, coat=True):
    nt = mat.node_tree; b = principled(mat)
    t = tex_node(mat, img, uv_name, non_color=True, scale=scale, loc=(-800, -350))
    nm = nt.nodes.new("ShaderNodeNormalMap"); nm.location = (-450, -350); nm.inputs["Strength"].default_value = 1.0
    if uv_name: nm.uv_map = uv_name
    nt.links.new(t.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    if coat and b.inputs["Coat Weight"].default_value > 0:
        nt.links.new(nm.outputs["Normal"], b.inputs["Coat Normal"])
    return t

def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True); bpy.context.view_layer.objects.active = obj

def mesh_obj(name, bm, mat, parent, smooth_angle=None):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me); sc.collection.objects.link(o)
    o.parent = parent
    for p in me.polygons: p.use_smooth = smooth_angle is not None
    if smooth_angle is not None:
        select_only(o); bpy.ops.object.shade_smooth_by_angle(angle=math.radians(smooth_angle))
    return o

def pbr(name, base, rough, metal=0.0, emit=None, emit_strength=0.0, cull=True):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = principled(m)
    b.inputs["Base Color"].default_value = (*base, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = emit_strength
    m.diffuse_color = (*base, 1)
    m.use_backface_culling = cull
    return m

# =============================================================================================
# 0. Scan ripples at the two ends (the deck lip over the nose and the tail blade)
# =============================================================================================
# A region-limited Taubin smooth of the normal component only: it flattens the low bumps that make the
# highlights wobble along the lip without sliding vertices or shrinking the part. Creases keep most of their
# shape (their weight drops with the dihedral angle) and part seams (canopy, light strip) stay pinned.
def smooth_ends(obj, iters, y_from=1.95, y_full=2.15, z_min=0.42):
    me = obj.data
    bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
    n = len(bm.verts)
    V = np.array([v.co[:] for v in bm.verts]); N = np.array([v.normal[:] for v in bm.verts])
    E = np.array([[e.verts[0].index, e.verts[1].index] for e in bm.edges])
    crease = np.zeros(n)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            a = e.calc_face_angle(0.0)
            for v in e.verts: crease[v.index] = max(crease[v.index], a)
    fixed = np.array([v.is_boundary for v in bm.verts]); bm.free()
    ay = np.abs(V[:, 1])
    w = np.clip((ay - y_from) / (y_full - y_from), 0, 1) * np.clip((V[:, 2] - z_min) / 0.06, 0, 1)
    w *= np.clip(1 - (crease - 0.9) / 0.6, 0.15, 1)            # 0.9 rad ~ 52 deg: protect real edges
    w[fixed] = 0
    deg = np.bincount(E.ravel(), minlength=n).astype(float)
    V0 = V.copy()
    for i in range(iters * 2):
        acc = np.zeros_like(V)
        for c in range(3):
            acc[:, c] = np.bincount(E[:, 0], weights=V[E[:, 1], c], minlength=n) + \
                        np.bincount(E[:, 1], weights=V[E[:, 0], c], minlength=n)
        lap = acc / np.maximum(deg, 1)[:, None] - V
        lap = (lap * N).sum(1)[:, None] * N                    # normal component only
        V = V + (0.5 if i % 2 == 0 else -0.53) * w[:, None] * lap
    me.vertices.foreach_set("co", V.ravel()); me.update()
    d = np.linalg.norm(V - V0, axis=1) * 1000
    return dict(verts=int((w > 0).sum()), disp_mm_mean=round(float(d[w > 0].mean()), 3), disp_mm_max=round(float(d.max()), 3))

if LIP_SMOOTH > 0:
    REPORT["end_smooth"] = smooth_ends(body, LIP_SMOOTH)

# =============================================================================================
# 2. Illustrative cockpit (car-left pod). Blender frame: nose -Y, car-left +X, Z up, metres.
# =============================================================================================
# Measured from the model (probe rays): the left pod is an open hull, floor z~0.08, inner walls x 0.36..0.92;
# the canopy opening runs y -0.56..1.32 (windshield to rear window), roof underside z~1.26..1.31 at y 0..0.6.
# The rear-left wheel sits inside the pod (axle y 0.384, z 0.313, r 0.313), the front-left at y -1.384.
# Driver layout chosen to fit: hips just ahead of the rear wheel, reclined back, head under the roof's front,
# feet just behind the front wheel.
cockpit_objs = []
if COCKPIT:
    cock = bpy.data.objects.new("Cockpit", None); sc.collection.objects.link(cock); cock.parent = root
    M_shell = pbr("InteriorShell", srgb((22, 23, 25)), 0.72)
    M_seat = pbr("InteriorSeat", srgb((34, 35, 38)), 0.86)
    M_metal = pbr("InteriorMetal", srgb((150, 153, 158)), 0.38, metal=0.85)
    M_grip = pbr("InteriorGrip", srgb((16, 16, 17)), 0.9)
    M_screen = pbr("InteriorScreen", srgb((8, 10, 12)), 0.18, emit=srgb((150, 205, 235)), emit_strength=0.6)
    PX = 0.64                                   # pod centreline (x)

    # --- Liner: a dark matte skin 12 mm inside the whole body shell and under the solar array, single-sided,
    # facing inward. The body is one open shell rendered double-sided and the array is single-sided, so without
    # it the glass would show white paint (the pod walls, and through the hollow deck the top of the tunnel
    # ceiling) lit by the environment as if it were outside. Thin parts (the tail blade, lips; under 35 mm) are
    # left out so the liner can never poke through the paint, and so are array faces near its outline or with
    # the body deck right beneath them.
    LINER_OFF = 0.012
    dg = bpy.context.evaluated_depsgraph_get()
    body_bvh = BVHTree.FromObject(body, dg)
    bme = body.data
    thin = np.zeros(len(bme.vertices), bool)
    for v in bme.vertices:
        h = body_bvh.ray_cast(v.co - v.normal * 0.002, -v.normal, 0.035)
        thin[v.index] = h[0] is not None
    sme_ = solar.data
    bmz = bmesh.new(); bmz.from_mesh(sme_)
    edge_pts = [v.co.copy() for v in bmz.verts if v.is_boundary]; bmz.free()
    from mathutils.kdtree import KDTree
    kd = KDTree(len(edge_pts))
    for i, c in enumerate(edge_pts): kd.insert(Vector((c.x, c.y, 0)), i)
    kd.balance()
    def array_ok(p):
        c = p.center
        if kd.find(Vector((c.x, c.y, 0)))[2] < 0.04: return False
        h = body_bvh.ray_cast(c, Vector((0, 0, -1)), 0.04)
        return h[0] is None
    bm = bmesh.new()
    def add_faces(src, sel, offset):
        me = src.data
        vmap = {}
        for p in me.polygons:
            if not sel(p): continue
            for vi in p.vertices:
                if vi not in vmap:
                    v = me.vertices[vi]
                    vmap[vi] = bm.verts.new(v.co - v.normal * offset)
            try:
                f = bm.faces.new([vmap[vi] for vi in reversed(p.vertices)])   # reversed: faces inward
                f.smooth = True
            except ValueError:
                pass
    add_faces(body, lambda p: not thin[list(p.vertices)].any(), LINER_OFF)
    add_faces(solar, array_ok, LINER_OFF)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.004)
    liner = mesh_obj("Cockpit_Liner", bm, M_shell, cock, smooth_angle=40)
    n0 = len(liner.data.polygons)
    mod = liner.modifiers.new("dec", "DECIMATE"); mod.ratio = min(1.0, LINER_TRIS / max(n0, 1)); mod.use_collapse_triangulate = True
    select_only(liner); bpy.ops.object.modifier_apply(modifier=mod.name)
    REPORT["liner_tris"] = [n0, len(liner.data.polygons)]
    cockpit_objs.append(liner)

    # --- Seat shell: a reclined bucket lofted along the seat line, U-shaped section, 12 mm shell.
    def loft(path, width_fn, depth_fn, n_sec=12):
        bm = bmesh.new()
        rings = []
        for i, (p, t) in enumerate(path):
            nrm = Vector((0, -t.z, t.y)).normalized()        # in the y-z plane, perpendicular to the path
            if nrm.dot(Vector((0, -0.6, 0.8))) < 0: nrm = -nrm  # toward the driver (up on the cushion, forward on the back)
            w, d = width_fn(i / (len(path) - 1)), depth_fn(i / (len(path) - 1))
            ring = []
            for k in range(n_sec + 1):
                a = math.pi * k / n_sec                        # 0..pi: one bolster round the back to the other
                lx = -math.cos(a) * w / 2
                ln = d * (1 - math.sin(a)) ** 1.6              # bolsters rise toward the driver at the edges
                ring.append(bm.verts.new(p + Vector((lx, 0, 0)) + nrm * ln))
            rings.append(ring)
        for r0, r1 in zip(rings, rings[1:]):
            for k in range(n_sec):
                bm.faces.new((r0[k], r0[k + 1], r1[k + 1], r1[k]))
        return bm
    def seat_path():
        # Cushion front edge -> hip -> backrest -> head rest (y, z).
        ctrl = [(-0.46, 0.27), (-0.30, 0.19), (-0.12, 0.17), (-0.04, 0.38), (0.03, 0.66), (0.085, 0.92), (0.10, 1.05)]
        pts = []
        for i in range(len(ctrl) - 1):
            for s in np.linspace(0, 1, 3, endpoint=False):
                (y0, z0), (y1, z1) = ctrl[i], ctrl[i + 1]
                pts.append(Vector((PX, y0 + (y1 - y0) * s, z0 + (z1 - z0) * s)))
        pts.append(Vector((PX, *ctrl[-1])))
        # Smooth the polyline a little (Chaikin) so the shell bends rather than kinks.
        for _ in range(1):
            q = [pts[0]]
            for a, b in zip(pts, pts[1:]):
                q += [a.lerp(b, 0.25), a.lerp(b, 0.75)]
            q.append(pts[-1]); pts = q
        out = []
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            out.append((p, t))
        return out
    path = seat_path()
    bm = loft(path, lambda s: 0.40 - 0.10 * max(0, s - 0.75) / 0.25, lambda s: 0.07 + 0.05 * math.sin(math.pi * min(1, s * 1.2)))
    seat = mesh_obj("Cockpit_Seat", bm, M_seat, cock, smooth_angle=60)
    m = seat.modifiers.new("solid", "SOLIDIFY"); m.thickness = 0.012; m.offset = -1
    select_only(seat); bpy.ops.object.modifier_apply(modifier=m.name)
    cockpit_objs.append(seat)

    # --- Tubes (roll hoop, braces, steering column).
    def tube(bm, pts, r, segs=10, closed=False):
        rings = []
        n = len(pts)
        for i, p in enumerate(pts):
            if closed:
                t = (pts[(i + 1) % n] - pts[(i - 1) % n]).normalized()
            else:
                t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
            a = t.cross(Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))).normalized()
            b = t.cross(a)
            rings.append([bm.verts.new(p + (a * math.cos(2 * math.pi * k / segs) + b * math.sin(2 * math.pi * k / segs)) * r)
                          for k in range(segs)])
        pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
        for r0, r1 in pairs:
            for k in range(segs):
                f = bm.faces.new((r0[k], r0[(k + 1) % segs], r1[(k + 1) % segs], r1[k])); f.smooth = True
        if not closed:
            for ring in (rings[0], rings[-1][::-1]):
                f = bm.faces.new(ring[::-1]); f.smooth = True
    HY = 0.165                                     # hoop plane (just behind the seat back)
    hoop = []
    for k in range(25):                            # legs up the pod walls, arch under the roof
        s = k / 24
        if s < 0.3:   x, z = 0.43, 0.10 + (0.93 - 0.10) * s / 0.3
        elif s > 0.7: x, z = 0.855, 0.93 - (0.93 - 0.10) * (s - 0.7) / 0.3
        else:
            a = math.pi * (s - 0.3) / 0.4
            x = 0.43 + (0.855 - 0.43) * (1 - math.cos(a)) / 2
            z = 0.93 + math.sin(a) * 0.25
        hoop.append(Vector((x, HY, z)))
    bm = bmesh.new()
    tube(bm, hoop, 0.017, 12)
    for a, b in (((0.44, HY + 0.01, 1.0), (0.48, 0.80, 0.42)), ((0.845, HY + 0.01, 1.0), (0.80, 0.80, 0.42))):
        a, b = Vector(a), Vector(b)                # rear braces, either side of the wheel housing
        tube(bm, [a.lerp(b, s) for s in np.linspace(0, 1, 6)], 0.012, 10)
    tube(bm, [Vector((0.43, HY, 0.86)), Vector((0.855, HY, 0.86))], 0.012, 10)   # harness bar
    hoopo = mesh_obj("Cockpit_RollHoop", bm, M_metal, cock, smooth_angle=50)
    cockpit_objs.append(hoopo)

    # --- Wheel housings over the two left wheels (they sit inside the pod).
    def housing(center_y, center_z, R, x0, x1, n=28):
        bm = bmesh.new()
        arcs = []
        floor_z = 0.10
        a0 = -math.asin(min(1, (center_z - floor_z) / R))    # angle where the arc meets the floor
        angs = np.linspace(math.pi - a0, a0, n)               # front-bottom over the top to rear-bottom
        for x in (x0, x1):
            arcs.append([bm.verts.new((x, center_y - math.cos(a) * R, center_z + math.sin(a) * R)) for a in angs])
        for i in range(n - 1):
            bm.faces.new((arcs[0][i], arcs[0][i + 1], arcs[1][i + 1], arcs[1][i]))
        for arc, flip in ((arcs[0], False), (arcs[1], True)):   # side walls
            c = bm.verts.new((arc[0].co.x, center_y, floor_z))
            for i in range(n - 1):
                tri = (c, arc[i], arc[i + 1]) if not flip else (c, arc[i + 1], arc[i])
                bm.faces.new(tri)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return bm
    hb = bmesh.new()
    for wn in ("Wheel_RL", "Wheel_FL"):
        piv = wheel_piv.get(wn)
        if not piv: continue
        c = piv.location
        tmp = housing(c.y, c.z, 0.355, c.x - 0.075, c.x + 0.07)
        me_tmp = bpy.data.meshes.new("tmp"); tmp.to_mesh(me_tmp); tmp.free()
        hb.from_mesh(me_tmp); bpy.data.meshes.remove(me_tmp)
    housings = mesh_obj("Cockpit_WheelHousings", hb, M_shell, cock, smooth_angle=40)
    cockpit_objs.append(housings)

    # --- Dash cowl under the windshield base, with a small screen facing the driver.
    bm = bmesh.new()
    prof = [(-0.585, 0.70), (-0.585, 0.84), (-0.52, 0.853), (-0.45, 0.83), (-0.41, 0.80), (-0.385, 0.70), (-0.47, 0.66)]
    rows = []
    for x in np.linspace(0.44, 0.84, 9):
        bulge = 0.012 * (1 - ((x - PX) / 0.2) ** 2)
        rows.append([bm.verts.new((x, y, z + bulge)) for y, z in prof])
    for r0, r1 in zip(rows, rows[1:]):
        for k in range(len(prof) - 1):
            bm.faces.new((r0[k], r1[k], r1[k + 1], r0[k + 1]))
    for row in (rows[0], rows[-1]):
        try: bm.faces.new(row)
        except ValueError: pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    dash = mesh_obj("Cockpit_Dash", bm, M_shell, cock, smooth_angle=35)
    cockpit_objs.append(dash)
    bm = bmesh.new()                               # screen: on the sloped face, toward the driver
    c = Vector((PX, -0.3975, 0.75)); n = Vector((0, 0.10, 0.025)).normalized()
    u = Vector((1, 0, 0)); v = n.cross(u).normalized()
    if v.z < 0: v = -v
    c = c + n * 0.004
    qs = [bm.verts.new(c + u * sx * 0.06 + v * sy * 0.032) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    f = bm.faces.new(qs)
    if f.normal.dot(n) < 0: f.normal_flip()
    screen = mesh_obj("Cockpit_Screen", bm, M_screen, cock)
    cockpit_objs.append(screen)

    # --- Steering wheel: rounded-rectangle rim with two grips, a centre plate and a column to the dash.
    wc = Vector((PX, -0.30, 0.855))
    wn = Vector((0, 1, 0.42)).normalized()          # faces the driver
    wu = Vector((1, 0, 0)); wv = wn.cross(wu).normalized()
    if wv.z < 0: wv = -wv
    W, H, rr = 0.125, 0.07, 0.045                    # half width, half height, corner radius
    loop = []
    for cx, cy, a0 in ((W - rr, H - rr, 0), (-(W - rr), H - rr, 90), (-(W - rr), -(H - rr), 180), (W - rr, -(H - rr), 270)):
        for k in range(7):
            a = math.radians(a0 + 90 * k / 6)
            loop.append(wc + wu * (cx + rr * math.cos(a)) + wv * (cy + rr * math.sin(a)))
    bm = bmesh.new(); tube(bm, loop, 0.011, 8, closed=True)
    rim_o = mesh_obj("Cockpit_SteeringWheel", bm, M_grip, cock, smooth_angle=60)
    cockpit_objs.append(rim_o)
    bm = bmesh.new()
    plate = [wc + wu * sx * 0.085 + wv * sy * 0.045 - wn * 0.006 for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    vs = [bm.verts.new(p) for p in plate] + [bm.verts.new(p - wn * 0.012) for p in plate]
    for q in ((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
        bm.faces.new([vs[i] for i in q])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    col_end = Vector((PX, -0.47, 0.80))
    tube(bm, [wc - wn * 0.018 + (col_end - wc) * s for s in np.linspace(0, 1, 4)], 0.011, 8)
    hub_o = mesh_obj("Cockpit_SteeringHub", bm, M_metal, cock, smooth_angle=40)
    cockpit_objs.append(hub_o)
    REPORT["cockpit_parts"] = [o.name for o in cockpit_objs]

# =============================================================================================
# Second UV sets (for the baked AO)
# =============================================================================================
def add_uv(obj, name):
    me = obj.data
    uv = me.uv_layers.get(name) or me.uv_layers.new(name=name)
    first = me.uv_layers[0]
    first.active_render = True               # TEXCOORD_0 stays the original first layer
    return uv

ao_uv_body = add_uv(body, "UV_AO")
body.data.uv_layers.active = ao_uv_body
select_only(body)
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.uv.pack_islands(margin=0.004, rotate=True, shape_method="CONCAVE")
bpy.ops.object.mode_set(mode="OBJECT")
body.data.uv_layers.active = body.data.uv_layers[0]

ao_uv_arr = add_uv(solar, "UV_AO")
sco = np.array([v.co for v in solar.data.vertices])
amn, amx = sco.min(0), sco.max(0)
for loop in solar.data.loops:                # planar from above: the array is a height field (no seams)
    co = solar.data.vertices[loop.vertex_index].co
    ao_uv_arr.data[loop.index].uv = ((co.y - amn[1]) / (amx[1] - amn[1]) * 0.996 + 0.002,
                                     (co.x - amn[0]) / (amx[0] - amn[0]) * 0.992 + 0.004)

# =============================================================================================
# 1. AO bakes
# =============================================================================================
def setup_cycles(samples, dist):
    try: sc.render.engine = "CYCLES"
    except TypeError: pass
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for dev in ("METAL", "OPTIX", "CUDA", "HIP"):
        try:
            prefs.compute_device_type = dev; prefs.get_devices()
            if any(d.type == dev for d in prefs.devices):
                for d in prefs.devices: d.use = True
                sc.cycles.device = "GPU"; break
        except TypeError:
            continue
    sc.cycles.samples = samples
    if sc.world is None: sc.world = bpy.data.worlds.new("World")
    sc.world.light_settings.distance = dist

def masked_blur(px, mask, passes=2):
    # 3x3 blur that only averages covered texels (keeps UV islands from bleeding into each other).
    a = px * mask; m = mask.astype(float)
    for _ in range(passes):
        s = np.zeros_like(a); c = np.zeros_like(m)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                s += np.roll(np.roll(a, dy, 0), dx, 1); c += np.roll(np.roll(m, dy, 0), dx, 1)
        a = np.where(mask, s / np.maximum(c, 1e-6), a) * mask
    return np.where(mask, a, px)

def bake_ao_image(obj, uv_name, w, h, name, extra_hidden=()):
    img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=True)
    img.generated_color = (1, 1, 1, 1)
    mat = obj.data.materials[0]
    nt = mat.node_tree
    tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = img
    for n in nt.nodes: n.select = False
    tn.select = True; nt.nodes.active = tn
    obj.data.uv_layers.active = obj.data.uv_layers[uv_name]
    hidden = []
    for o in extra_hidden:
        if o and not o.hide_render: o.hide_render = True; hidden.append(o)
    select_only(obj)
    sc.render.bake.target = "IMAGE_TEXTURES"; sc.render.bake.margin = 8; sc.render.bake.margin_type = "EXTEND"
    sc.render.bake.use_clear = True
    bpy.ops.object.bake(type="AO")
    for o in hidden: o.hide_render = False
    obj.data.uv_layers.active = obj.data.uv_layers[0]
    nt.nodes.remove(tn)
    px = np.empty(w * h * 4, dtype=np.float32); img.pixels.foreach_get(px)
    ao = px.reshape(h, w, 4)[::-1, :, 0].copy()          # top row first
    bpy.data.images.remove(img)
    return ao

def coverage_mask(obj, uv_name, w, h):
    # Rasterise the UV triangles at texel centres to know which texels belong to an island.
    me = obj.data; uvl = me.uv_layers[uv_name]
    me.calc_loop_triangles()
    mask = np.zeros((h, w), bool)
    uv = np.array([d.uv[:] for d in uvl.data])
    for tri in me.loop_triangles:
        p = uv[list(tri.loops)] * [w, h]
        x0, y0 = np.floor(p.min(0)).astype(int); x1, y1 = np.ceil(p.max(0)).astype(int)
        if x1 - x0 <= 0 or y1 - y0 <= 0: continue
        xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        a, b, c = p
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12: continue
        l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d
        l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d
        inside = (l1 >= -0.02) & (l2 >= -0.02) & (1 - l1 - l2 >= -0.02)
        yy = np.clip(ys[inside].astype(int), 0, h - 1); xx = np.clip(xs[inside].astype(int), 0, w - 1)
        mask[yy, xx] = True
    return mask[::-1]                                     # top row first, like the baked arrays

ao_images = {}
if BAKE_AO:
    setup_cycles(AO_SAMPLES, AO_DIST)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    ground = bpy.context.active_object; ground.name = "BakeGround"
    ground.data.materials.append(pbr("BakeGround", (0.5, 0.5, 0.5), 0.8))
    interior = cockpit_objs
    # Body: occluded by everything outside (canopy, array, wheels, ground). Cockpit parts sit behind the shell.
    ao = bake_ao_image(body, "UV_AO", AO_SIZE, AO_SIZE, "bake_body", extra_hidden=interior)
    mask = coverage_mask(body, "UV_AO", AO_SIZE, AO_SIZE)
    ao = masked_blur(ao, mask, 2)
    REPORT["body_ao_mean"] = round(float(ao[mask].mean()), 3)
    ao_images["Body"] = make_image("CarBody_AO", np.repeat(ao[..., None], 3, 2), non_color=True)
    # Solar array.
    aw, ah = AO_SIZE, AO_SIZE // 4
    ao = bake_ao_image(solar, "UV_AO", aw, ah, "bake_array", extra_hidden=interior)
    ao = masked_blur(ao, np.ones_like(ao, bool), 1)
    REPORT["array_ao_mean"] = round(float(ao.mean()), 3)
    ao_images["SolarArray"] = make_image("SolarArray_AO", np.repeat(ao[..., None], 3, 2), non_color=True)
    # Cockpit: vertex AO with the glass removed (light only comes in through the canopy openings) and a long
    # ray distance (the cabin is enclosed, so nearly every direction except the glass is blocked).
    if cockpit_objs:
        sc.world.light_settings.distance = 2.5
        sc.render.bake.target = "VERTEX_COLORS"
        for o in cockpit_objs:
            ca = o.data.color_attributes.new("AO", "BYTE_COLOR", "POINT")
            o.data.color_attributes.active_color = ca
        if canopy: canopy.hide_render = True
        for o in cockpit_objs:
            select_only(o)
            bpy.ops.object.bake(type="AO")
        if canopy: canopy.hide_render = False
        # Lift the result a little: in a real cabin light also bounces in from the glass and the bright deck.
        for o in cockpit_objs:
            ca = o.data.color_attributes["AO"]
            c = np.empty(len(ca.data) * 4, dtype=np.float32); ca.data.foreach_get("color", c)
            c = c.reshape(-1, 4)
            c[:, :3] = 0.18 + 0.82 * c[:, :3]
            c[:, 3] = 1
            ca.data.foreach_set("color", c.ravel())
        REPORT["cockpit_ao_mean"] = round(float(np.mean([np.mean([d.color[0] for d in o.data.color_attributes["AO"].data])
                                                         for o in cockpit_objs])), 3)
    bpy.data.objects.remove(ground, do_unlink=True)
    hook_occlusion(body.data.materials[0], ao_images["Body"], "UV_AO")
    hook_occlusion(solar.data.materials[0], ao_images["SolarArray"], "UV_AO")

# =============================================================================================
# 3. Solar array textures (4 x 4 cells per tile; UVs rescaled so one tile spans four cells)
# =============================================================================================
uvl = solar.data.uv_layers[0]
uvs = np.empty(len(uvl.data) * 2); uvl.data.foreach_get("uv", uvs); uvl.data.foreach_set("uv", uvs / 4)
NC, CP = 4, 256                                   # cells per tile side, pixels per cell (125 mm -> 2 px/mm)
N = NC * CP
yy, xx = np.mgrid[0:N, 0:N] + 0.5
lx, ly = xx % CP, yy % CP                          # position inside the cell
ci, cj = (xx // CP).astype(int), (yy // CP).astype(int)
gap = 2.2                                          # half gap in px (~2 mm between cells)
chamfer = 26.0                                     # pseudo-square corner chamfer
d_edge = np.minimum(np.minimum(lx, CP - lx), np.minimum(ly, CP - ly))
d_corner = (np.minimum(lx, CP - lx) + np.minimum(ly, CP - ly) - chamfer) / math.sqrt(2)
dist = np.minimum(d_edge, d_corner)                # distance to the cell outline (px)
cell = dist > gap
# Per-cell variation: brightness and a slight hue shift, as real mono cells vary from bin to bin.
var_b = 1 + 0.07 * rng.standard_normal((NC, NC)); var_h = 0.04 * rng.standard_normal((NC, NC))
base = np.array(srgb((16, 30, 58)))
cellc = base[None, None, :] * var_b[cj, ci][..., None]
cellc[..., 2] *= (1 + var_h[cj, ci]); cellc[..., 0] *= (1 - var_h[cj, ci])
# Fine texture of the cell surface (pyramid texturing reads as a faint mottle).
mott = rng.standard_normal((N // 8, N // 8))
mott = np.kron(mott, np.ones((8, 8)))
mott = (mott + np.roll(mott, 4, 0) + np.roll(mott, 4, 1) + np.roll(np.roll(mott, 4, 0), 4, 1)) / 4
cellc *= (1 + 0.035 * mott)[..., None]
back = np.array(srgb((128, 136, 150)))            # pale backsheet in the gaps and corner diamonds
col = np.where(cell[..., None], cellc, back)
# Fingers: thin lines across the cell every ~1.7 mm; busbars: five silver bands along the cell.
fing = cell & (np.abs(((ly - CP / 2) % 3.5) - 1.75) < 0.35)
col = np.where(fing[..., None], col * 0.6 + np.array(srgb((70, 82, 104))) * 0.4, col)
bus = np.zeros((N, N), bool)
for k in range(5):
    bc = CP * (k + 0.5) / 5
    bus |= np.abs(lx - bc) < 1.1
bus &= cell & (d_edge > gap + 3)
col = np.where(bus[..., None], np.array(srgb((150, 158, 170))), col)
# Tabbing ribbons cross the gaps between cells in the row direction, in line with the busbars.
tab = np.zeros((N, N), bool)
for k in range(5):
    bc = CP * (k + 0.5) / 5
    tab |= (np.abs(lx - bc) < 1.4) & (np.minimum(ly, CP - ly) < gap + 4)
col = np.where((tab & ~cell)[..., None], np.array(srgb((185, 190, 198))), col)
solar_img = make_image("SolarCellTile", np.clip(col, 0, 1))
# Normal map: the encapsulant dips into the gaps (2 mm wide grooves) and each cell is very slightly pillowed.
H = np.clip(1 - np.exp(-(np.maximum(dist, 0) / 6.0) ** 2), 0, 1) * 1.0           # groove: 0 in gap -> 1 inside
H += 0.6 * np.sin(np.pi * lx / CP) * np.sin(np.pi * ly / CP)                       # pillow
gy, gx = np.gradient(H)
k = 0.35                                                                           # strength
nx, ny = -gx * k, gy * k                                                           # image rows go down = -v
nz = np.ones_like(nx)
ln = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
nmap = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5
nmap = nmap.reshape(N // 2, 2, N // 2, 2, 3).mean((1, 3))                          # 512 px is plenty
solar_nrm = make_image("SolarCellNormal", nmap, non_color=True)
sm = solar.data.materials[0]
tn = next(n for n in sm.node_tree.nodes if n.type == "TEX_IMAGE" and n.image and n.image.name.startswith("SolarCellTile"))
old = tn.image; tn.image = solar_img
if old and old.users == 0: bpy.data.images.remove(old)
hook_normal(sm, solar_nrm, uv_name=solar.data.uv_layers[0].name)
principled(sm).inputs["Roughness"].default_value = 0.22
principled(sm).inputs["Coat Weight"].default_value = 1.0
principled(sm).inputs["Coat Roughness"].default_value = 0.06

# =============================================================================================
# 4. Body paint: fine orange peel on TEXCOORD_0 (tiled; strength baked into the texture)
# =============================================================================================
atlas_m = json.load(open(HOT))["body_uv_atlas"]["size_m"]
TILE_M = 0.09                                      # one texture tile covers 9 cm of body
NP = 256
f = np.fft.fftfreq(NP)[:, None] ** 2 + np.fft.fftfreq(NP)[None, :] ** 2
spec = np.exp(-f / (2 * (1.0 / 18) ** 2)) * (f > 0)                               # blobs ~5 mm across
noise = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal((NP, NP))) * spec))   # periodic, seamless
noise /= noise.std()
gy, gx = np.gradient(noise)
k = 0.015                                                                          # very subtle
nx, ny = -gx * k, gy * k; nz = np.ones_like(nx); ln = np.sqrt(nx ** 2 + ny ** 2 + 1)
peel = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5
peel_img = make_image("CarBody_Peel", peel, non_color=True)
rep = atlas_m / TILE_M
hook_normal(body.data.materials[0], peel_img, uv_name=body.data.uv_layers[0].name, scale=(rep, rep))
REPORT["peel_repeat"] = round(rep, 2)

# =============================================================================================
# 5. Tyres: profile UVs and a roughness map
# =============================================================================================
tyre_img = None
TW, TH = 64, 128                                   # u: across the profile (0 = bead .. 1 = centre of tread)
u = (np.arange(TH) + 0.5)[:, None] / TH * np.ones((1, TW))
rough = np.where(u > 0.78, 0.68, 1.0)              # worn slick tread band vs matte sidewall (x 0.82 in studio.js)
rough = np.where((u > 0.25) & (u < 0.6) & ((np.arange(TH)[:, None] % 6) < 2), 0.9, rough)   # moulded rings
rough = rough + 0.02 * rng.standard_normal((TH, TW))
orm = np.stack([np.ones_like(rough), np.clip(rough, 0, 1), np.zeros_like(rough)], -1)       # R=AO, G=rough, B=metal
tyre_img = make_image("Tire_Rough", orm[::-1], non_color=True)
for g in wheel_geos:
    me = g.data
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    piv = g.parent
    R = json.load(open(HOT))["wheels"][piv.name]["radius"]
    rb = R - 0.105                                                    # bead seat radius, as in refine_v2.py
    tyre_idx = [i for i, m in enumerate(me.materials) if m and m.name.startswith("Tire")]
    for p in me.polygons:
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co           # local to the wheel pivot (axle = X)
            r = math.hypot(co.y, co.z)
            if p.material_index in tyre_idx:
                t = (r - rb) / (R - rb)                               # 0 at the bead, 1 at the tread
                uvl.data[li].uv = (0.5, min(max(t, 0), 1))                  # the map only varies across the profile
            else:
                uvl.data[li].uv = (0.5, 0.5)
tm = bpy.data.materials["Tire"]
nt = tm.node_tree
t = tex_node(tm, tyre_img, "UVMap", non_color=True, loc=(-800, -200))
sep = nt.nodes.new("ShaderNodeSeparateColor"); sep.location = (-500, -200)
nt.links.new(t.outputs["Color"], sep.inputs["Color"])
nt.links.new(sep.outputs["Green"], principled(tm).inputs["Roughness"])
nt.links.new(sep.outputs["Blue"], principled(tm).inputs["Metallic"])

# =============================================================================================
# 6. Canopy: lighter, reflective tint so the cockpit shows through
# =============================================================================================
if canopy:
    gm = canopy.data.materials[0]; gb = principled(gm)
    gb.inputs["Base Color"].default_value = (*srgb((30, 38, 46)), 1)
    gb.inputs["Alpha"].default_value = 0.58
    gb.inputs["Roughness"].default_value = 0.02
    gb.inputs["Coat Weight"].default_value = 1.0; gb.inputs["Coat Roughness"].default_value = 0.02

# =============================================================================================
# Export
# =============================================================================================
for o in cockpit_objs: o.data.name = o.name
if BLEND: bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.export_scene.gltf(filepath=DST, export_format="GLB", export_yup=True, export_apply=True,
                          export_animations=False, export_cameras=False, export_lights=False,
                          export_texcoords=True, export_normals=True, export_extras=False,
                          export_vertex_color="NAME", export_vertex_color_name="AO",
                          export_all_vertex_colors=False, export_active_vertex_color_when_no_material=False,
                          export_image_format="AUTO")

hot = json.load(open(HOT))
hot["textures"] = {
    "note": "Texture slots in carrera-v2.glb, for renderers that rebuild the materials (studio.js).",
    "CarBody": {"occlusionTexture": "baked AO, TEXCOORD_1 (texCoord 1)",
                "normalTexture": "orange-peel paint, TEXCOORD_0 with KHR_texture_transform repeat %.1f; strength baked in (scale 1)" % rep,
                "clearcoatNormalTexture": "same image as normalTexture (three: clearcoatNormalMap)",
                "baseColorTexture": "none; TEXCOORD_0 is the livery atlas (body_uv_atlas)"},
    "SolarArray": {"baseColorTexture": "4 x 4 cell tile, TEXCOORD_0",
                   "normalTexture": "encapsulant grooves and cell pillowing, TEXCOORD_0",
                   "clearcoatNormalTexture": "same image as normalTexture",
                   "occlusionTexture": "baked AO, TEXCOORD_1 (texCoord 1)"},
    "Tire": {"metallicRoughnessTexture": "G = roughness factor (tread 0.68, sidewall 1.0), TEXCOORD_0"},
    "Interior*": {"COLOR_0": "baked cabin AO in vertex colours (multiplies base colour)"},
}
hot["cockpit"] = {"node": "Cockpit", "parts": [o.name for o in cockpit_objs],
                  "note": "ILLUSTRATIVE interior (seat, roll hoop, wheel housings, dash, steering wheel, dark liner), "
                          "not from CAD. Hide the Cockpit node in x-ray/cutaway views."}
with open(HOT, "w") as fh: json.dump(hot, fh, indent=2)
print("REPORT " + json.dumps(REPORT))
