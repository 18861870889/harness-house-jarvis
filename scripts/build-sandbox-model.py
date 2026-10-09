"""Author the sample home in Blender; coordinate contract is Three.js Y-up."""
import bpy
import json
import math
import os
import random
import sys
from mathutils import Vector

manifest, output, work = sys.argv[sys.argv.index("--") + 1:]
with open(manifest, encoding="utf-8") as source:
    blueprint = json.load(source)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
random.seed(12)

def material(name, color, roughness=0.65, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat

white = material("Warm white plaster", (0.87, 0.89, 0.87))
oak = material("Pale oak", (0.53, 0.37, 0.22))
floor_mat = material("Ash flooring", (0.71, 0.66, 0.55))
green = material("Sage upholstery", (0.27, 0.45, 0.38))
blue = material("Powder blue fabric", (0.35, 0.52, 0.63))
rose = material("Terracotta accent", (0.69, 0.36, 0.30))
dark = material("Charcoal", (0.08, 0.11, 0.13), 0.45)
metal = material("Brushed metal", (0.29, 0.32, 0.31), 0.34, 0.65)
glass = material("Sky glass", (0.63, 0.81, 0.87), 0.16)
cream = material("Linen", (0.82, 0.83, 0.79))
skin = material("Skin", (0.73, 0.48, 0.32))
hair = material("Hair", (0.09, 0.075, 0.07))

def position(p):
    return (p[0], -p[2], p[1])

def cube(name, p, size, mat, bevel=0.03):
    bpy.ops.mesh.primitive_cube_add(size=1, location=position(p))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new("Soft edges", "BEVEL")
        mod.width = bevel
        mod.segments = 3
        obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    obj.data.materials.append(mat)
    return obj

def cylinder(name, p, radius, height, mat, vertices=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=height, location=position(p))
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj

def sphere(name, p, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, location=position(p))
    obj = bpy.context.object
    obj.name = name
    obj.scale = (scale[0], scale[2], scale[1])
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj

# A deterministic original bitmap texture, embedded into the exported GLB.
image = bpy.data.images.new("Ash grain", width=256, height=256)
pixels = []
for y in range(256):
    for x in range(256):
        grain = math.sin(x * 0.46 + math.sin(y * 0.018) * 3) * 0.025
        grain += random.uniform(-0.009, 0.009)
        seam = -0.055 if x % 64 < 2 else 0
        pixels.extend((0.73 + grain + seam, 0.68 + grain + seam, 0.57 + grain + seam, 1))
image.pixels = pixels
image.filepath_raw = os.path.join(output, "ash-grain.png")
image.file_format = "PNG"
image.save()
tex = floor_mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = image
floor_mat.node_tree.links.new(tex.outputs["Color"], floor_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"])

for room in blueprint["rooms"]:
    cx = (room["minX"] + room["maxX"]) / 2
    cube("floor_" + room["id"], [cx, -0.07, 0], [room["maxX"] - room["minX"], 0.14, 5.6], floor_mat, 0.015)
    cube("skirting_" + room["id"], [cx, 0.1, -2.65], [5.2, 0.15, 0.035], white, 0.008)
cube("foundation", [0, -0.23, 0], [11.35, 0.22, 5.85], white, 0.05)
for block in blueprint["colliders"][:6]:
    if block["id"] == "front":
        continue
    height = 1.9 if block["id"] == "back" else 1.05
    p = list(block["center"])
    p[1] = height / 2
    size = list(block["size"])
    size[1] = height
    cube("wall_" + block["id"], p, size, white, 0.018)
for x in [-0.13, 0.13]:
    cube("door_jamb", [x, 0.6, -1.0], [0.08, 1.2, 0.09], oak)
    cube("door_jamb", [x, 0.6, 1.0], [0.08, 1.2, 0.09], oak)

# Study: desk, individual switched lights, three-gang controller, chair and books.
cube("desk_top", [-3.5, 0.77, -1.75], [2.05, 0.09, 0.86], oak, 0.045)
for x in [-4.32, -2.68]:
    for z in [-2.03, -1.48]:
        cube("desk_leg", [x, 0.37, z], [0.065, 0.74, 0.065], metal, 0.014)
cube("monitor", [-3.45, 1.12, -1.96], [0.78, 0.48, 0.04], dark)
cube("monitor_display", [-3.45, 1.12, -1.93], [0.72, 0.42, 0.009], blue, 0.01)
cube("monitor_stand", [-3.45, 0.89, -1.97], [0.06, 0.22, 0.06], metal)
cube("keyboard", [-3.45, 0.83, -1.56], [0.47, 0.025, 0.14], cream, 0.015)
cylinder("coffee_mug", [-2.88, 0.88, -1.65], 0.065, 0.12, rose)
cube("chair_seat", [-3.5, 0.48, -0.8], [0.58, 0.14, 0.58], blue, 0.07)
cube("chair_back", [-3.5, 0.82, -0.51], [0.56, 0.53, 0.13], blue, 0.08)
cylinder("chair_stem", [-3.5, 0.24, -0.8], 0.045, 0.48, metal)
for x in [-3.75, -3.25]:
    cube("chair_base", [x, 0.05, -0.8], [0.12, 0.07, 0.56], metal)
cube("study_rug", [-3.05, 0.015, -0.15], [2.85, 0.02, 2.55], blue, 0.04)
cube("bookcase_back", [-5.16, 0.74, 0], [0.13, 1.48, 1.95], oak)
for y in [0.08, 0.52, 0.96, 1.42]:
    cube("bookcase_shelf", [-5.03, y, 0], [0.48, 0.05, 1.95], oak)
for z in [-0.96, 0.96]:
    cube("bookcase_side", [-5.03, 0.74, z], [0.48, 1.48, 0.06], oak)
for level in [0.25, 0.70, 1.13]:
    for i in range(9):
        cube("book", [-4.9, level, -0.78 + i * 0.18], [0.22, 0.28 + random.random() * 0.1, 0.065 + random.random() * 0.025], random.choice([cream, green, blue, rose]), 0.007)
cube("three_gang_panel", [-0.095, 0.96, -1.5], [0.045, 0.19, 0.27], cream, 0.015)
for z in [-1.59, -1.5, -1.41]:
    cube("switch_gang", [-0.13, 0.96, z], [0.025, 0.14, 0.068], white, 0.007)
cube("study_air_conditioner", [-1.55, 1.5, -2.62], [1.1, 0.26, 0.18], cream, 0.035)
cube("ac_vent", [-1.55, 1.42, -2.5], [0.93, 0.035, 0.025], dark, 0.004)

def plant(x, z):
    cylinder("planter", [x, 0.2, z], 0.18, 0.4, rose)
    for i in range(7):
        a = i * math.pi * 2 / 7
        sphere("leaf", [x + math.cos(a) * 0.18, 0.65 + (i % 3) * 0.12, z + math.sin(a) * 0.18], [0.14, 0.34, 0.08], green)
plant(-4.8, 2.1)

# Living room furniture and window treatments.
cube("living_rug", [3.2, 0.02, 0.55], [3.85, 0.025, 2.65], cream, 0.05)
cube("sofa_base", [3.2, 0.35, 1.6], [3.1, 0.35, 0.95], green, 0.1)
cube("sofa_back", [3.2, 0.74, 1.98], [3.1, 0.75, 0.24], green, 0.11)
for x in [1.77, 4.63]:
    cube("sofa_arm", [x, 0.61, 1.6], [0.25, 0.61, 0.93], green, 0.09)
for x in [2.25, 3.2, 4.15]:
    cube("sofa_cushion", [x, 0.57, 1.55], [0.88, 0.2, 0.74], green, 0.09)
for x, mat in [(2.15, cream), (4.1, rose)]:
    pillow = cube("pillow", [x, 0.9, 1.79], [0.5, 0.46, 0.14], mat, 0.1)
    pillow.rotation_euler[0] = -0.15
cube("coffee_table_top", [3.2, 0.39, 0], [1.45, 0.1, 0.85], oak, 0.17)
for x in [2.67, 3.73]:
    cube("coffee_table_leg", [x, 0.2, 0], [0.075, 0.38, 0.55], metal, 0.018)
cube("living_book", [3.35, 0.48, 0.04], [0.31, 0.06, 0.23], rose)
cylinder("vase", [2.84, 0.56, 0], 0.075, 0.25, cream)
cube("tv_bench", [3.2, 0.28, -2.35], [2.8, 0.5, 0.5], oak, 0.035)
cube("tv_frame", [3.2, 1.02, -2.36], [1.75, 1.0, 0.075], dark, 0.035)
cube("living_tv_screen", [3.2, 1.02, -2.31], [1.63, 0.88, 0.012], dark, 0.012)
for x in [2.62, 3.78]:
    cube("tv_foot", [x, 0.58, -2.27], [0.18, 0.06, 0.24], metal)
cube("window_glass", [0.81, 1.1, -2.66], [1.0, 1.42, 0.035], glass, 0.01)
for x in [0.28, 1.34]:
    cube("window_frame", [x, 1.1, -2.61], [0.045, 1.52, 0.06], cream, 0.01)
for y in [0.35, 1.85]:
    cube("window_frame", [0.81, y, -2.61], [1.13, 0.045, 0.06], cream, 0.01)
cube("living_curtain_left", [0.45, 1.1, -2.5], [0.42, 1.56, 0.055], cream, 0.014)
cube("living_curtain_right", [1.2, 1.1, -2.5], [0.42, 1.56, 0.055], cream, 0.014)
cylinder("fan_base", [1.15, 0.045, 1.8], 0.24, 0.07, white)
cylinder("fan_stem", [1.15, 0.56, 1.8], 0.035, 1.05, metal)
fan = cylinder("fan_cage", [1.15, 1.1, 1.8], 0.27, 0.08, white)
fan.rotation_euler[0] = math.pi / 2
rotor = bpy.data.objects.new("fan_rotor", None)
bpy.context.collection.objects.link(rotor)
rotor.location = position([1.15, 1.1, 1.85])
for i in range(3):
    blade = cube("fan_blade", [1.15, 1.1, 1.85], [0.07, 0.4, 0.018], metal, 0.035)
    blade.parent = rotor
    blade.matrix_parent_inverse = rotor.matrix_world.inverted()
    blade.rotation_euler[1] = i * math.pi * 2 / 3

# Dynamic lamp meshes are distinct so rendering cannot turn every light on together.
for lamp in blueprint["lamps"]:
    p = lamp["position"]
    cylinder(lamp["id"] + "_fixture", [p[0], p[1] + 0.08, p[2]], 0.21, 0.09, white)
    cylinder(lamp["bulbName"], p, 0.16, 0.028, cream)
    cylinder(lamp["id"] + "_stem", [p[0], p[1] + 0.3, p[2]], 0.015, 0.45, metal)

# Stylized adult, kept separate from the house so the runtime can move it.
avatar = bpy.data.objects.new("avatar", None)
bpy.context.collection.objects.link(avatar)
parts = [
    sphere("head", [0, 1.48, 0], [0.15, 0.18, 0.145], skin),
    sphere("hair", [0, 1.57, -0.025], [0.158, 0.105, 0.148], hair),
    cube("torso", [0, 1.06, 0], [0.39, 0.49, 0.24], white, 0.085),
    cube("left_leg", [-0.1, 0.49, 0], [0.14, 0.54, 0.17], dark, 0.04),
    cube("right_leg", [0.1, 0.49, 0], [0.14, 0.54, 0.17], dark, 0.04),
    cube("left_arm", [-0.26, 1.0, 0], [0.12, 0.45, 0.13], green, 0.05),
    cube("right_arm", [0.26, 1.0, 0], [0.12, 0.45, 0.13], green, 0.05),
    cube("left_shoe", [-0.1, 0.17, 0.05], [0.17, 0.13, 0.26], white, 0.04),
    cube("right_shoe", [0.1, 0.17, 0.05], [0.17, 0.13, 0.26], white, 0.04),
]
for obj in parts:
    obj.parent = avatar

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(work, "house.blend"))
bpy.ops.export_scene.gltf(filepath=os.path.join(output, "house.glb"), export_format="GLB", export_apply=True, export_extras=True)

# Modular Blender-authored furniture lets the runtime reuse a saved, arbitrary floor plan.
kit = []
def group_objects(name, objects, origin=(0, 0, 0)):
    parent = bpy.data.objects.new("kit_" + name, None)
    bpy.context.collection.objects.link(parent)
    parent.location = position(origin)
    bpy.context.view_layer.update()
    for obj in objects:
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    parent.location = (0, 0, 0)
    kit.append(parent)
    return parent

presets = [
    ("desk", ("desk_", "monitor", "keyboard", "coffee_mug"), (-3.5, 0, -1.75)),
    ("chair", ("chair_",), (-3.5, 0, -0.8)),
    ("bookshelf", ("bookcase_", "book"), (-5.03, 0, 0)),
    ("sofa", ("sofa_", "pillow"), (3.2, 0, 1.6)),
    ("coffee_table", ("coffee_table_",), (3.2, 0, 0)),
    ("plant", ("planter", "leaf"), (-4.8, 0, 2.1)),
    ("tv", ("living_tv", "tv_bench"), (3.2, 0, -2.35)),
    ("fan", ("fan_",), (1.15, 0, 1.8)),
    ("curtain", ("living_curtain",), (0.8, 0, -2.67)),
]
for name, prefixes, origin in presets:
    objects = [obj for obj in list(bpy.data.objects) if obj.parent is None and any(obj.name.startswith(p) for p in prefixes)]
    group_objects(name, objects, origin)

before = set(bpy.data.objects)
cube("bed_frame", [0, 0.26, 0], [2.05, 0.36, 2.6], oak, 0.09)
cube("bed_mattress", [0, 0.5, 0], [1.94, 0.28, 2.48], cream, 0.12)
cube("bed_headboard", [0, 0.75, 1.22], [2.15, 1.2, 0.13], blue, 0.07)
cube("bed_cover", [0, 0.68, -0.35], [1.96, 0.09, 1.75], blue, 0.04)
for x in [-0.5, 0.5]:
    cube("bed_pillow", [x, 0.7, 0.8], [0.8, 0.15, 0.42], white, 0.09)
group_objects("bed", set(bpy.data.objects) - before)

before = set(bpy.data.objects)
cube("dining_top", [0, 0.74, 0], [1.5, 0.09, 0.84], oak, 0.15)
for x in [-0.57, 0.57]:
    for z in [-0.26, 0.26]:
        cube("dining_leg", [x, 0.36, z], [0.05, 0.7, 0.05], metal, 0.01)
for x in [-0.55, 0.55]:
    for z in [-0.55, 0.55]:
        cube("dining_chair", [x, 0.4, z], [0.36, 0.14, 0.36], blue, 0.05)
        cube("dining_chair_leg", [x, 0.19, z], [0.06, 0.37, 0.06], metal)
cylinder("dining_vase", [0, 0.9, 0], 0.065, 0.24, rose)
group_objects("dining", set(bpy.data.objects) - before)

before = set(bpy.data.objects)
cube("kitchen_base", [0, 0.42, 0], [1.7, 0.84, 0.6], white)
cube("kitchen_worktop", [0, 0.87, 0], [1.73, 0.05, 0.62], cream)
for x in [-0.56, 0, 0.56]:
    cube("kitchen_cabinet", [x, 0.46, 0.305], [0.52, 0.7, 0.018], white)
    cube("kitchen_handle", [x, 0.65, 0.327], [0.18, 0.02, 0.018], metal)
cube("kitchen_hob", [-0.4, 0.905, 0], [0.55, 0.02, 0.4], dark)
cube("kitchen_sink", [0.44, 0.908, 0], [0.4, 0.025, 0.35], metal)
group_objects("kitchen", set(bpy.data.objects) - before)

before = set(bpy.data.objects)
cube("vanity_base", [0, 0.42, 0], [1.25, 0.7, 0.5], oak)
cube("vanity_sink", [0, 0.82, 0], [0.6, 0.1, 0.4], white, 0.08)
cube("vanity_mirror", [0, 1.42, -0.23], [0.84, 0.72, 0.028], glass)
group_objects("vanity", set(bpy.data.objects) - before)

bpy.ops.object.select_all(action="DESELECT")
for root in kit + [avatar]:
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(output, "furniture-kit.glb"), export_format="GLB", export_apply=True, export_extras=True, use_selection=True)
print("Sandbox GLB exported to", output)
