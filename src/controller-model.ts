import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { ButtonState, JoyConSide } from "./joycon";

export type ButtonName = keyof ButtonState;
type PlasticMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

export interface ControllerModel {
  group: THREE.Group;
  outerGroup: THREE.Group;
  buttons: Partial<Record<ButtonName, PlasticMesh>>;
  sticks: Partial<Record<"leftStick" | "rightStick", THREE.Group>>;
  playerLights: PlasticMesh[];
  homeRing?: PlasticMesh;
}

const CHARCOAL = 0x25282e;
const RUBBER = 0x16191e;
const SEAM = 0x15181c;
const BLUE = 0x00b9dc;
const RED = 0xff4852;

function plastic(color: number, roughness = 0.42, metalness = 0.04) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function mesh(geometry: THREE.BufferGeometry, color: number, roughness = 0.42) {
  const result = new THREE.Mesh(geometry, plastic(color, roughness));
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function box(w: number, h: number, d: number, radius: number, color: number) {
  return mesh(new RoundedBoxGeometry(w, h, d, 3, radius), color);
}

function disc(radius: number, depth: number, color: number, roughness = 0.42) {
  const geo = new THREE.CylinderGeometry(radius, radius, depth, 48, 1);
  geo.rotateX(Math.PI / 2);
  return mesh(geo, color, roughness);
}

function ring(radius: number, thickness: number, color: number) {
  return mesh(new THREE.TorusGeometry(radius, thickness, 8, 64), color);
}

function shell(shape: THREE.Shape, depth: number, bevel: number, color: number, bevelThickness = bevel) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness, bevelSize: bevel,
    bevelSegments: 5, steps: 1, curveSegments: 24,
  });
  geometry.translate(0, 0, -depth / 2);
  return mesh(geometry, color);
}

// Vector-engraved legends: no external assets, canvas textures, or font loading.
const GLYPHS: Record<string, number[][][]> = {
  A: [[[-0.65, -0.8], [0, 0.85], [0.65, -0.8]], [[-0.4, -0.15], [0.4, -0.15]]],
  B: [[[-0.55, -0.8], [-0.55, 0.8], [0.15, 0.8], [0.6, 0.5], [0.15, 0], [-0.55, 0]], [[0.15, 0], [0.65, -0.4], [0.2, -0.8], [-0.55, -0.8]]],
  L: [[[-0.55, 0.8], [-0.55, -0.8], [0.55, -0.8]]],
  R: [[[-0.55, -0.8], [-0.55, 0.8], [0.15, 0.8], [0.6, 0.4], [0.15, 0], [-0.55, 0]], [[0.05, 0], [0.65, -0.8]]],
  Z: [[[-0.6, 0.8], [0.6, 0.8], [-0.6, -0.8], [0.6, -0.8]]],
  X: [[[-0.6, -0.8], [0.6, 0.8]], [[-0.6, 0.8], [0.6, -0.8]]],
  Y: [[[-0.65, 0.8], [0, 0], [0.65, 0.8]], [[0, 0], [0, -0.8]]],
  "+": [[[-0.75, 0], [0.75, 0]], [[0, -0.75], [0, 0.75]]],
  "−": [[[-0.75, 0], [0.75, 0]]],
  up: [[[-0.6, -0.25], [0, 0.45], [0.6, -0.25], [-0.6, -0.25]]],
  down: [[[-0.6, 0.25], [0, -0.45], [0.6, 0.25], [-0.6, 0.25]]],
  left: [[[0.25, -0.6], [-0.45, 0], [0.25, 0.6], [0.25, -0.6]]],
  right: [[[-0.25, -0.6], [0.45, 0], [-0.25, 0.6], [-0.25, -0.6]]],
  home: [[[-0.75, 0], [0, 0.65], [0.75, 0]], [[-0.5, 0.1], [-0.5, -0.65], [0.5, -0.65], [0.5, 0.1]], [[-0.12, -0.65], [-0.12, -0.15], [0.12, -0.15], [0.12, -0.65]]],
  capture: [[[-0.6, -0.6], [-0.6, 0.6], [0.6, 0.6], [0.6, -0.6], [-0.6, -0.6]]],
};

function legend(parent: THREE.Object3D, text: string, size: number, z: number) {
  const material = new THREE.MeshBasicMaterial({ color: 0xc5cad1 });
  for (const path of GLYPHS[text] ?? []) {
    const points = path.map(([x, y]) => new THREE.Vector3(x! * size, y! * size, z));
    const curve = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < points.length; i++) {
      curve.add(new THREE.LineCurve3(points[i - 1]!, points[i]!));
    }
    const stroke = new THREE.Mesh(new THREE.TubeGeometry(curve, points.length * 3, size * 0.075, 5, false), material);
    parent.add(stroke);
  }
}

function register(model: ControllerModel, name: ButtonName, button: PlasticMesh, pressDirection?: THREE.Vector3) {
  button.name = name;
  button.userData.baseColor = button.material.color.getHex();
  button.userData.restPosition = button.position.clone();
  button.userData.pressDirection = pressDirection?.clone().normalize()
    ?? new THREE.Vector3(0, 0, -1).applyQuaternion(button.quaternion);
  model.buttons[name] = button;
  return button;
}

function button(model: ControllerModel, name: ButtonName, label: string, x: number, y: number, z: number, radius = 0.22, square = false) {
  const socket = square
    ? box(radius * 1.85 + 0.06, radius * 1.85 + 0.06, 0.04, 0.035, SEAM)
    : disc(radius + 0.035, 0.04, SEAM);
  socket.position.set(x, y, z - 0.045);
  model.group.add(socket);
  const cap = square ? box(radius * 1.85, radius * 1.85, 0.13, 0.045, CHARCOAL) : disc(radius, 0.13, CHARCOAL);
  cap.position.set(x, y, z);
  legend(cap, label, radius * 0.50, 0.073);
  model.group.add(cap);
  return register(model, name, cap);
}

function stick(model: ControllerModel, name: "leftStick" | "rightStick", x: number, y: number, z: number) {
  const well = disc(0.44, 0.06, SEAM, 0.65);
  well.position.set(x, y, z - 0.01);
  const bezel = ring(0.42, 0.025, 0x40444a);
  bezel.position.set(x, y, z + 0.015);
  model.group.add(well, bezel);

  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const dome = mesh(new THREE.SphereGeometry(0.32, 32, 20), RUBBER, 0.75);
  dome.scale.z = 0.6;
  const shaft = disc(0.12, 0.28, CHARCOAL);
  shaft.position.z = 0.14;
  const cap = disc(0.365, 0.12, RUBBER, 0.85);
  cap.position.z = 0.32;
  // Rounded rubber lip, recessed thumb surface, and subtle concentric grip ribs.
  const lip = ring(0.33, 0.038, 0x303339);
  lip.position.z = 0.058;
  cap.add(lip);
  for (const radius of [0.23, 0.27]) {
    const rib = ring(radius, 0.008, 0x34373c);
    rib.position.z = 0.062;
    cap.add(rib);
  }
  pivot.add(dome, shaft, cap);
  model.group.add(pivot);
  model.sticks[name] = pivot;
  register(model, name === "leftStick" ? "lStick" : "rStick", cap);
}

function faceButtons(model: ControllerModel, x: number, y: number, z: number, directional = false) {
  const names: ButtonName[] = directional ? ["right", "down", "up", "left"] : ["a", "b", "x", "y"];
  const labels = directional ? ["right", "down", "up", "left"] : ["A", "B", "X", "Y"];
  const offsets = [[0.47, 0], [0, -0.47], [0, 0.47], [-0.47, 0]];
  // Seat the directional caps into the shell instead of leaving a visible gap.
  const capZ = directional ? z - 0.025 : z;
  offsets.forEach(([dx, dy], i) => button(model, names[i]!, labels[i]!, x + dx!, y + dy!, capZ));
}

function home(model: ControllerModel, x: number, y: number, z: number) {
  const rim = ring(0.21, 0.025, 0x707984);
  rim.position.set(x, y, z);
  model.group.add(rim);
  model.homeRing = rim;
  button(model, "home", "home", x, y, z, 0.175);
}

function screw(model: ControllerModel, x: number, y: number, z: number) {
  const head = disc(0.065, 0.012, 0x454950);
  head.position.set(x, y, z);
  head.rotation.y = Math.PI;
  legend(head, "−", 0.045, 0.009);
  model.group.add(head);
}

function crossShape(outer: number, inner: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-inner, outer);
  for (const [x, y] of [[inner, outer], [inner, inner], [outer, inner], [outer, -inner], [inner, -inner], [inner, -outer], [-inner, -outer], [-inner, -inner], [-outer, -inner], [-outer, inner], [-inner, inner]]) {
    shape.lineTo(x!, y!);
  }
  shape.closePath();
  return shape;
}

function joyConShape(left: boolean) {
  // Flat inner rail, generous outer corners; mirror the silhouette for Joy-Con R.
  const shape = new THREE.Shape();
  const s = left ? 1 : -1;
  shape.moveTo(s * 0.82, -2.42);
  shape.lineTo(s * 0.82, 2.42);
  shape.quadraticCurveTo(s * 0.82, 2.5, s * 0.7, 2.5);
  shape.lineTo(s * -0.3, 2.5);
  shape.bezierCurveTo(s * -0.85, 2.5, s * -1.0, 2.15, s * -1.0, 1.78);
  shape.lineTo(s * -1.0, -1.74);
  shape.bezierCurveTo(s * -1.0, -2.27, s * -0.7, -2.5, s * -0.24, -2.5);
  shape.lineTo(s * 0.7, -2.5);
  shape.quadraticCurveTo(s * 0.82, -2.5, s * 0.82, -2.42);
  shape.closePath();
  return shape;
}

// Shoulder outlines follow the outer top corners, not the full shell width.
// L/R are narrow front bumpers; ZL/ZR are deeper, scalloped rear finger pads.
function shoulderProfile(sign: number, pro: boolean, rear: boolean) {
  const shape = new THREE.Shape();
  const move = (x: number, y: number) => shape.moveTo(sign * x, y);
  const line = (x: number, y: number) => shape.lineTo(sign * x, y);
  const curve = (a: number, b: number, c: number, d: number, x: number, y: number) =>
    shape.bezierCurveTo(sign * a, b, sign * c, d, sign * x, y);
  if (pro && !rear) {
    move(1.50, 1.64);
    line(1.60, 1.80);
    line(2.20, 1.82);
    curve(2.75, 1.78, 3.00, 1.50, 3.17, 1.10);
    line(2.88, 1.27);
    curve(2.55, 1.58, 2.10, 1.60, 1.50, 1.52);
  } else if (pro) {
    move(1.58, 1.63);
    line(2.16, 1.69);
    curve(2.67, 1.66, 2.97, 1.45, 3.04, 1.12);
    curve(3.03, 0.93, 2.81, 0.82, 2.63, 0.85);
    line(1.89, 1.04);
    curve(1.69, 1.16, 1.67, 1.40, 1.58, 1.63);
  } else if (!rear) {
    move(-0.42, 2.53);
    line(0.18, 2.53);
    curve(0.65, 2.53, 0.96, 2.23, 1.04, 1.85);
    line(0.86, 1.85);
    curve(0.70, 2.18, 0.50, 2.34, 0.14, 2.35);
    line(-0.42, 2.35);
  } else {
    move(-0.40, 2.45);
    curve(0.20, 2.53, 0.75, 2.40, 0.96, 1.91);
    line(0.89, 1.82);
    curve(0.54, 1.96, 0.42, 2.19, -0.30, 2.14);
  }
  shape.closePath();
  return shape;
}

function shoulders(model: ControllerModel, left: boolean, pro: boolean) {
  const sign = left ? -1 : 1;
  const centerX = sign * (pro ? 2.30 : 0.25);
  const centerY = pro ? 1.40 : 2.25;
  for (const rear of [false, true]) {
    const name = left ? (rear ? "zl" : "l") : (rear ? "zr" : "r");
    const depth = rear ? (pro ? 0.28 : 0.22) : 0.25;
    const bevel = rear ? 0.055 : 0.035;
    const cap = shell(shoulderProfile(sign, pro, rear), depth, bevel, CHARCOAL);
    cap.geometry.translate(-centerX, -centerY, 0);
    cap.position.set(centerX, centerY + (!pro && !rear ? 0.07 : 0), rear ? (pro ? -0.57 : -0.51) : 0.16);
    cap.material.roughness = rear ? 0.52 : 0.40;

    // L/R legends sit on top (+Y); ZL/ZR face backward (-Z). Front-facing
    // lettering would be occluded by the front shell at these mounting depths.
    const label = new THREE.Group();
    const labelX = sign * (pro ? (rear ? 2.30 : 2.05) : (rear ? 0.10 : 0));
    if (rear) {
      label.position.set(labelX - centerX, (pro ? 1.30 : 2.30) - centerY, -(depth / 2 + bevel + 0.006));
      label.rotation.y = Math.PI;
    } else {
      label.position.set(labelX - centerX, (pro ? 1.856 : 2.571) - centerY, 0);
      label.rotation.x = -Math.PI / 2;
    }
    label.name = `${name}-legend`;
    const size = pro ? 0.085 : 0.065;
    [...name.toUpperCase()].forEach((letter, i, letters) => {
      const glyph = new THREE.Group();
      glyph.position.x = (i - (letters.length - 1) / 2) * size * 1.7;
      legend(glyph, letter, size, 0);
      label.add(glyph);
    });
    cap.add(label);
    model.group.add(cap);
    // Bumpers push down; rear triggers push down and into the back, not away
    // from the shell as the face-button (-Z) travel would make them do.
    register(model, name, cap, rear ? new THREE.Vector3(0, -0.45, 1) : new THREE.Vector3(0, -1, 0));
  }
}

function buildJoyCon(model: ControllerModel, left: boolean) {
  const color = left ? BLUE : RED;
  const shape = joyConShape(left);
  const seam = shell(shape, 0.016, 0.102, SEAM, 0.004);
  const back = shell(shape, 0.28, 0.10, color);
  back.position.z = -0.23;
  const front = shell(shape, 0.24, 0.10, color);
  front.position.z = 0.23;
  front.name = "front-shell";
  model.group.add(seam, back, front);
  const z = 0.53;
  const center = left ? -0.06 : 0.06;

  const railX = left ? 0.94 : -0.94;
  const rail = box(0.18, 4.64, 0.64, 0.045, CHARCOAL);
  rail.position.set(railX, 0, -0.015);
  const channel = box(0.05, 4.25, 0.31, 0.018, 0x565b63);
  channel.position.set(railX + (left ? 0.1 : -0.1), 0, -0.015);
  model.group.add(rail, channel);
  for (const [i, y] of [0.92, -0.92].entries()) {
    const cap = box(0.24, 0.45, 0.10, 0.04, color);
    cap.rotation.y = left ? Math.PI / 2 : -Math.PI / 2;
    cap.position.set(railX + (left ? 0.13 : -0.13), y, 0);
    model.group.add(cap);
    register(model, left ? (i === 0 ? "slL" : "srL") : (i === 0 ? "slR" : "srR"), cap);
  }
  for (let i = 0; i < 4; i++) {
    const led = box(0.018, 0.085, 0.075, 0.008, 0x525a50);
    led.position.set(railX + (left ? 0.135 : -0.135), 0.30 - i * 0.20, 0);
    model.group.add(led);
    model.playerLights.push(led);
  }
  const sync = disc(0.07, 0.04, RUBBER);
  sync.rotation.y = left ? Math.PI / 2 : -Math.PI / 2;
  sync.position.set(railX + (left ? 0.14 : -0.14), -0.58, 0);
  model.group.add(sync);

  shoulders(model, left, false);

  stick(model, left ? "leftStick" : "rightStick", center, left ? 1.25 : -0.90, z);
  faceButtons(model, center, left ? -0.70 : 1.18, z, left);
  const system = left
    ? box(0.30, 0.09, 0.12, 0.02, CHARCOAL)
    : shell(crossShape(0.15, 0.045), 0.10, 0.012, CHARCOAL);
  system.position.set(left ? 0.44 : -0.44, 2.10, z);
  model.group.add(system);
  register(model, left ? "minus" : "plus", system);
  if (left) button(model, "capture", "capture", 0.32, -1.86, z, 0.18, true);
  else home(model, -0.32, -1.90, z);

  // Back shell details remain readable without the old fluorescent debug stripes.
  for (const x of [-0.58, 0.55]) for (const y of [-2.04, 1.89]) screw(model, x, y, -0.477);
  const release = box(0.24, 0.48, 0.10, 0.065, CHARCOAL);
  release.position.set(left ? 0.59 : -0.59, 1.52, -0.49);
  model.group.add(release);
  if (!left) {
    const irWindow = box(0.85, 0.12, 0.48, 0.055, 0x111922);
    irWindow.material.roughness = 0.16;
    irWindow.position.set(0, -2.53, -0.04);
    model.group.add(irWindow);
  }
}

function proShape() {
  const s = new THREE.Shape();
  s.moveTo(-2.10, 1.60);
  s.bezierCurveTo(-2.9, 1.62, -3.22, 0.95, -3.37, 0.25);
  s.lineTo(-3.70, -1.55);
  s.bezierCurveTo(-3.85, -2.42, -2.90, -2.68, -2.42, -2.03);
  s.lineTo(-1.55, -0.95);
  s.quadraticCurveTo(0, -1.28, 1.55, -0.95);
  s.lineTo(2.42, -2.03);
  s.bezierCurveTo(2.90, -2.68, 3.85, -2.42, 3.70, -1.55);
  s.lineTo(3.37, 0.25);
  s.bezierCurveTo(3.22, 0.95, 2.9, 1.62, 2.10, 1.60);
  s.quadraticCurveTo(0, 1.83, -2.10, 1.60);
  s.closePath();
  return s;
}

function buildPro(model: ControllerModel) {
  const shape = proShape();
  const seam = shell(shape, 0.012, 0.122, SEAM, 0.004);
  seam.position.z = 0.035;
  const back = shell(shape, 0.34, 0.12, 0x25282d);
  back.position.z = -0.25;
  const front = shell(shape, 0.25, 0.12, 0x292d33);
  front.position.z = 0.29;
  front.name = "front-shell";
  model.group.add(seam, back, front);

  for (const sign of [-1, 1]) {
    const grip = new THREE.Shape();
    grip.moveTo(sign * 2.68, 0.44);
    grip.bezierCurveTo(sign * 3.12, 0.55, sign * 3.18, 0.1, sign * 3.27, -0.3);
    grip.lineTo(sign * 3.50, -1.57);
    grip.bezierCurveTo(sign * 3.60, -2.17, sign * 3.04, -2.36, sign * 2.65, -1.83);
    grip.lineTo(sign * 2.03, -1.01);
    grip.quadraticCurveTo(sign * 2.48, -0.50, sign * 2.68, 0.44);
    const panel = shell(grip, 0.12, 0.09, RUBBER);
    panel.material.roughness = 0.9;
    panel.position.z = 0.44;
    model.group.add(panel);
    for (let i = 0; i < 6; i++) {
      const rib = box(0.34, 0.025, 0.015, 0.006, 0x303339);
      rib.rotation.z = sign * 0.35;
      rib.position.set(sign * (2.86 + i * 0.035), -0.92 - i * 0.14, 0.60);
      model.group.add(rib);
    }
    shoulders(model, sign < 0, true);
    screw(model, sign * 2.85, -1.65, -0.55);
    screw(model, sign * 2.10, 1.20, -0.55);
  }
  const z = 0.61;
  const lowerControlsY = -0.43;
  stick(model, "leftStick", -2.02, 0.69, z);
  stick(model, "rightStick", 1.13, lowerControlsY, z);
  faceButtons(model, 2.12, 0.72, z);

  // Keep the entire D-pad inside the curved lower edge and seated in the face.
  const dpadX = -1.14;
  const dpadY = lowerControlsY;
  const dpadZ = z - 0.025;
  const dpadSocket = shell(crossShape(0.50, 0.20), 0.04, 0.018, SEAM);
  dpadSocket.position.set(dpadX, dpadY, dpadZ - 0.05);
  model.group.add(dpadSocket);
  const center = box(0.36, 0.36, 0.13, 0.025, CHARCOAL);
  center.position.set(dpadX, dpadY, dpadZ);
  model.group.add(center);
  for (const [name, dx, dy] of [["up", 0, 0.32], ["down", 0, -0.32], ["left", -0.32, 0], ["right", 0.32, 0]] as const) {
    const cap = box(dx ? 0.30 : 0.36, dy ? 0.30 : 0.36, 0.13, 0.025, CHARCOAL);
    cap.position.set(dpadX + dx, dpadY + dy, dpadZ);
    legend(cap, name, 0.11, 0.073);
    model.group.add(cap);
    register(model, name, cap);
  }
  button(model, "minus", "−", -0.66, 1.08, z, 0.16);
  button(model, "plus", "+", 0.66, 1.08, z, 0.16);
  button(model, "capture", "capture", -0.40, 0.35, z, 0.16, true);
  home(model, 0.40, 0.35, z);
  const usb = box(0.46, 0.04, 0.19, 0.015, SEAM);
  usb.position.set(0, 1.87, -0.05);
  model.group.add(usb);
  for (let i = 0; i < 4; i++) {
    const led = box(0.095, 0.055, 0.025, 0.01, 0x525a50);
    led.position.set(-0.27 + i * 0.18, -1.06, 0.45);
    model.group.add(led);
    model.playerLights.push(led);
  }
}

export function buildControllerModel(side: JoyConSide): ControllerModel {
  const group = new THREE.Group();
  const outerGroup = new THREE.Group();
  outerGroup.add(group);
  const model: ControllerModel = { group, outerGroup, buttons: {}, sticks: {}, playerLights: [] };
  group.name = `${side}-controller`;
  if (side === "pro") buildPro(model);
  else buildJoyCon(model, side === "left");
  return model;
}

/** Dispose unique resources, including materials shared by legend strokes. */
export function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
