# Renders review stills of a Carrera v2 GLB in a neutral studio (Cycles), with the materials as exported.
#
# Usage (from the repo root):
#   Blender -b --python lab/carrera/scripts/render_views.py -- model.glb out_dir [prefix] [--samples=96] [--res=1280x720]
#        [--views=front34,side,rear34,top,canopy,wheel] [--hide=Canopy,Cockpit]
#
# The rig is deliberately plain: an overhead softbox, two side strips, a dim grey world and a satin grey
# floor, so the stills show the model (shape, AO, materials) rather than a look. Writes <prefix><view>.jpg.
import bpy, sys, math, os
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
pos = [a for a in argv[2:] if not a.startswith("--")]
PREFIX = pos[0] if pos else ""
OPT = dict(a[2:].split("=", 1) for a in argv[2:] if a.startswith("--") and "=" in a)
SAMPLES = int(OPT.get("samples", 96))
RW, RH = (int(x) for x in OPT.get("res", "1280x720").split("x"))
VIEWS = OPT.get("views", "front34,side,rear34,top,canopy,wheel").split(",")
HIDE = [h for h in OPT.get("hide", "").split(",") if h]
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
sc = bpy.context.scene
for o in bpy.data.objects:   # --hide: node names; children go too (e.g. Cockpit hides every Cockpit_* part)
    p = o
    while p is not None and p.name not in HIDE: p = p.parent
    if p is not None: o.hide_render = True

# Render settings: Cycles on the GPU when there is one.
try:
    sc.render.engine = "CYCLES"
except TypeError:
    pass
prefs = bpy.context.preferences.addons["cycles"].preferences
for dev in ("METAL", "OPTIX", "CUDA", "HIP"):
    try:
        prefs.compute_device_type = dev
        prefs.get_devices()
        if any(d.type == dev for d in prefs.devices):
            for d in prefs.devices: d.use = True
            sc.cycles.device = "GPU"
            break
    except TypeError:
        continue
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = RW, RH
sc.render.image_settings.file_format = "JPEG"
sc.render.image_settings.quality = 88
try:
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
except TypeError:
    sc.view_settings.view_transform = "Filmic"

# World: dim neutral grey.
world = bpy.data.worlds.new("Studio"); sc.world = world; world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs["Color"].default_value = (0.05, 0.052, 0.056, 1); bg.inputs["Strength"].default_value = 1.0

# Floor: satin grey, large.
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
floor = bpy.context.active_object; floor.name = "StudioFloor"
fm = bpy.data.materials.new("StudioFloor"); fm.use_nodes = True
fb = next(n for n in fm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
fb.inputs["Base Color"].default_value = (0.11, 0.115, 0.12, 1); fb.inputs["Roughness"].default_value = 0.42
floor.data.materials.append(fm)

def area(name, loc, size, energy, rot=(0, 0, 0), size_y=None):
    l = bpy.data.lights.new(name, "AREA"); l.energy = energy; l.shape = "RECTANGLE"
    l.size = size; l.size_y = size_y or size
    o = bpy.data.objects.new(name, l); o.location = loc; o.rotation_euler = rot
    sc.collection.objects.link(o)
    return o

area("Softbox", (0, 0, 4.2), 2.2, 1400, size_y=7.0)
area("StripL", (4.5, -0.5, 1.8), 0.6, 450, rot=(0, math.radians(68), 0), size_y=6.0)
area("StripR", (-4.5, 0.5, 1.8), 0.6, 300, rot=(0, math.radians(-68), 0), size_y=6.0)
area("Kick", (0, -7, 1.2), 3.0, 200, rot=(math.radians(80), 0, 0), size_y=1.0)

cam_data = bpy.data.cameras.new("Cam"); cam = bpy.data.objects.new("Cam", cam_data)
sc.collection.objects.link(cam); sc.camera = cam

# Blender frame: nose -Y, car-left +X, Z up (glTF import of +Z nose / +X left).
SHOTS = {
    "front34": ((4.3, -6.4, 2.1), (0.05, -0.2, 0.55), 55, None),
    "side":    ((8.6, -0.05, 0.95), (0, -0.05, 0.62), 50, None),
    "rear34":  ((-4.4, 6.3, 2.3), (0.0, 0.2, 0.55), 55, None),
    "top":     ((0.0, -0.001, 12.0), (0, 0, 0), 0, 5.6),
    "canopy":  ((2.6, -1.95, 1.75), (0.62, 0.15, 1.02), 70, None),
    "wheel":   ((2.2, -2.75, 0.42), (0.72, -1.38, 0.24), 70, None),
    "cabin":   ((1.9, 0.9, 2.6), (0.62, -0.1, 0.75), 40, None),       # down into the cockpit (use --hide=Canopy)
}
for name in VIEWS:
    loc, tgt, lens, ortho = SHOTS[name]
    cam.location = loc
    d = Vector(tgt) - Vector(loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    if ortho:
        cam_data.type = "ORTHO"; cam_data.ortho_scale = ortho
    else:
        cam_data.type = "PERSP"; cam_data.lens = lens
    sc.render.filepath = os.path.join(OUT, f"{PREFIX}{name}.jpg")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", sc.render.filepath)
