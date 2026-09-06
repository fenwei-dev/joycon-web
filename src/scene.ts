import * as THREE from "three";
import type { ButtonState, JoyConSide, JoyConState, StickState } from "./joycon";
import { imuToModelQuaternion } from "./orientation";

type ButtonName = keyof ButtonState;

interface JoyConMesh {
  group: THREE.Group;
  outerGroup: THREE.Group; // positioning and orientation in model coordinates
  buttons: Partial<Record<ButtonName, THREE.Mesh>>;
  stickPivot?: THREE.Group;
  stickName?: "leftStick" | "rightStick";
}

const COLOR_LEFT = 0x1d8de8; // neon blue
const COLOR_RIGHT = 0xfa3232; // neon red
const COLOR_BUTTON = 0xffffff;
const COLOR_BUTTON_HI = 0xfff080;
const COLOR_STICK = 0x606060;
const COLOR_STICK_CAP_LEFT = 0x6ec1ff;  // bright cyan-ish for left stick cap
const COLOR_STICK_CAP_RIGHT = 0xff8080; // bright pink for right stick cap
const COLOR_TRIGGER = 0xffffff;
const COLOR_BODY_PRO = 0xa8d8f0;  // light blue
const COLOR_BODY_LEFT = 0xa8d8f0;  // light blue
const COLOR_BODY_RIGHT = 0xa8d8f0; // light blue
const COLOR_FRONT_MARK = 0x00ff88;      // bright green arrow on the front face
const COLOR_TOP_MARK = 0xffd24a;        // bright yellow stripe on the top
const COLOR_BACK_MARK = 0x6655ff;       // purple stripe on the back

function makeRoundedBox(w: number, h: number, d: number, r: number, color: number) {
  // Approximation: BoxGeometry with bevel via small extra boxes is overkill. Use ExtrudeGeometry of rounded rect.
  const shape = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geo.translate(0, 0, -d / 2);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
  return new THREE.Mesh(geo, mat);
}

function makeButton(radius: number, label: string, color = COLOR_BUTTON) {
  const geo = new THREE.CylinderGeometry(radius, radius, 0.18, 24);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.baseColor = color;
  mesh.userData.label = label;
  // Lay flat (axis along Z so cylinder points outward)
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function makeMiniButton(w: number, h: number, color = COLOR_BUTTON) {
  const geo = new THREE.BoxGeometry(w, h, 0.18);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
  const m = new THREE.Mesh(geo, mat);
  m.userData.baseColor = color;
  return m;
}

function buildProController(group: THREE.Group, buttons: JoyConMesh["buttons"]): JoyConMesh {
  const W = 7.2;
  const H = 3.0;
  const D = 1.2;
  const bodyColor = COLOR_BODY_PRO;

  // Main body — MeshStandardMaterial so lighting creates visible edges/shading.
  const body = makeRoundedBox(W, H, D, 0.4, bodyColor);
  body.castShadow = true;
  body.receiveShadow = true;
  {
    const mat = body.material as THREE.MeshStandardMaterial;
    mat.roughness = 0.5;
    mat.metalness = 0.1;
  }
  group.add(body);

  const front = D / 2 + 0.01;
  const back = -D / 2 - 0.01;

  // ---- Orientation markers ----
  // Green arrow on FRONT, pointing UP
  {
    const arrow = new THREE.Shape();
    arrow.moveTo(0, 0.35);
    arrow.lineTo(0.28, -0.05);
    arrow.lineTo(0.1, -0.05);
    arrow.lineTo(0.1, -0.35);
    arrow.lineTo(-0.1, -0.35);
    arrow.lineTo(-0.1, -0.05);
    arrow.lineTo(-0.28, -0.05);
    arrow.closePath();
    const geo = new THREE.ShapeGeometry(arrow);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_FRONT_MARK,
      emissive: COLOR_FRONT_MARK,
      emissiveIntensity: 0.45,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0, front + 0.005);
    group.add(mesh);
  }

  // Yellow stripe on TOP
  {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.6, 0.08, D * 0.6),
      new THREE.MeshStandardMaterial({ color: COLOR_TOP_MARK, emissive: COLOR_TOP_MARK, emissiveIntensity: 0.4 }),
    );
    stripe.position.set(0, H / 2 - 0.2, 0);
    group.add(stripe);
  }

  // Purple stripe on BACK
  {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.4, H * 0.6, 0.04),
      new THREE.MeshStandardMaterial({ color: COLOR_BACK_MARK, emissive: COLOR_BACK_MARK, emissiveIntensity: 0.3 }),
    );
    stripe.position.set(0, 0, back);
    group.add(stripe);
  }

  // ---- Shoulder triggers ----
  const lTrigger = makeRoundedBox(1.6, 0.35, D * 0.85, 0.1, COLOR_TRIGGER);
  lTrigger.position.set(-2.6, H / 2 + 0.15, 0);
  group.add(lTrigger);
  buttons.l = lTrigger;

  const rTrigger = makeRoundedBox(1.6, 0.35, D * 0.85, 0.1, COLOR_TRIGGER);
  rTrigger.position.set(2.6, H / 2 + 0.15, 0);
  group.add(rTrigger);
  buttons.r = rTrigger;

  const zlTrigger = makeRoundedBox(1.6, 0.25, D * 0.7, 0.08, COLOR_TRIGGER);
  zlTrigger.position.set(-2.6, H / 2 + 0.05, -D / 2 - 0.1);
  group.add(zlTrigger);
  buttons.zl = zlTrigger;

  const zrTrigger = makeRoundedBox(1.6, 0.25, D * 0.7, 0.08, COLOR_TRIGGER);
  zrTrigger.position.set(2.6, H / 2 + 0.05, -D / 2 - 0.1);
  group.add(zrTrigger);
  buttons.zr = zrTrigger;

  // ---- Sticks ----
  // Left stick (lower-left quadrant)
  const leftStick = buildStick(group, -2.0, -0.3, front, COLOR_STICK_CAP_LEFT);
  // Right stick (lower-right quadrant)
  const rightStick = buildStick(group, 2.0, -0.3, front, COLOR_STICK_CAP_RIGHT);

  // ---- D-pad (upper-left) ----
  const dpadCenter = new THREE.Vector3(-2.0, 0.8, front);
  const dOff = 0.42;
  const dUp = makeButton(0.22, "Up", 0xdddddd);
  dUp.position.set(dpadCenter.x, dpadCenter.y + dOff, dpadCenter.z);
  const dDown = makeButton(0.22, "Down", 0xdddddd);
  dDown.position.set(dpadCenter.x, dpadCenter.y - dOff, dpadCenter.z);
  const dLeft = makeButton(0.22, "Left", 0xdddddd);
  dLeft.position.set(dpadCenter.x - dOff, dpadCenter.y, dpadCenter.z);
  const dRight = makeButton(0.22, "Right", 0xdddddd);
  dRight.position.set(dpadCenter.x + dOff, dpadCenter.y, dpadCenter.z);
  group.add(dUp, dDown, dLeft, dRight);
  buttons.up = dUp; buttons.down = dDown; buttons.left = dLeft; buttons.right = dRight;

  // ---- Face buttons (upper-right) ----
  const faceCenter = new THREE.Vector3(2.0, 0.8, front);
  const fOff = 0.42;
  const a = makeButton(0.24, "A", 0xff5555);
  a.position.set(faceCenter.x + fOff, faceCenter.y, faceCenter.z);
  const b = makeButton(0.24, "B", 0xffd24a);
  b.position.set(faceCenter.x, faceCenter.y - fOff, faceCenter.z);
  const x = makeButton(0.24, "X", 0x66c2ff);
  x.position.set(faceCenter.x, faceCenter.y + fOff, faceCenter.z);
  const y = makeButton(0.24, "Y", 0x66e08a);
  y.position.set(faceCenter.x - fOff, faceCenter.y, faceCenter.z);
  group.add(a, b, x, y);
  buttons.a = a; buttons.b = b; buttons.x = x; buttons.y = y;

  // ---- Center buttons ----
  const minus = makeMiniButton(0.32, 0.08, COLOR_BUTTON);
  minus.position.set(-0.5, 0.9, front);
  group.add(minus);
  buttons.minus = minus;

  const plus = makeMiniButton(0.32, 0.08, COLOR_BUTTON);
  const plus2 = makeMiniButton(0.08, 0.32, COLOR_BUTTON);
  plus.position.set(0.5, 0.9, front);
  plus2.position.set(0.5, 0.9, front + 0.001);
  group.add(plus, plus2);
  buttons.plus = plus;

  const home = makeButton(0.2, "Home");
  home.position.set(0.6, -0.6, front);
  (home.material as THREE.MeshStandardMaterial).color.setHex(COLOR_BUTTON);
  home.userData.baseColor = COLOR_BUTTON;
  home.userData.isHome = true;
  group.add(home);
  buttons.home = home;

  const capture = makeButton(0.18, "Capture");
  capture.position.set(-0.6, -0.6, front);
  capture.scale.set(0.9, 0.9, 0.9);
  group.add(capture);
  buttons.capture = capture;

  // Return right stick as the primary one for state updates (Pro has two but
  // interface currently tracks one stickPivot / stickName pair).
  return wrapForAxisRemap({ group, buttons, stickPivot: rightStick, stickName: "rightStick" });
}

function buildStick(parent: THREE.Group, x: number, y: number, z: number, capColor: number): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.05, 24),
    new THREE.MeshStandardMaterial({ color: COLOR_STICK }),
  );
  base.rotation.x = Math.PI / 2;
  pivot.add(base);

  const shaftPivot = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.14, 0.4, 16),
    new THREE.MeshStandardMaterial({ color: COLOR_STICK }),
  );
  shaft.position.set(0, 0, 0.2);
  shaft.rotation.x = Math.PI / 2;
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.12, 24),
    new THREE.MeshStandardMaterial({ color: capColor, emissive: capColor, emissiveIntensity: 0.25, roughness: 0.5 }),
  );
  cap.position.set(0, 0, 0.42);
  cap.rotation.x = Math.PI / 2;
  shaftPivot.add(shaft);
  shaftPivot.add(cap);
  shaftPivot.userData.isStickShaft = true;
  pivot.add(shaftPivot);

  parent.add(pivot);
  return shaftPivot;
}

function wrapForAxisRemap(inner: Omit<JoyConMesh, 'outerGroup'>): JoyConMesh {
  // Keep geometry in model coordinates. The wrapper receives the converted
  // quaternion, so identity leaves the front facing the camera.
  const outer = new THREE.Group();
  outer.add(inner.group);
  return { ...inner, outerGroup: outer };
}

function buildJoyCon(side: JoyConSide): JoyConMesh {
  const group = new THREE.Group();
  const buttons: JoyConMesh["buttons"] = {};

  if (side === "pro") {
    return buildProController(group, buttons);
  }

  const isLeft = side === "left";
  const color = isLeft ? COLOR_LEFT : COLOR_RIGHT;
  const W = 2.0;
  const H = 5.2;
  const D = 1.0;
  const body = makeRoundedBox(W, H, D, 0.35, color);
  body.castShadow = true;
  body.receiveShadow = true;
  // MeshStandardMaterial (from makeRoundedBox) so directional lights shade
  // different faces differently, giving the body visible edges.
  {
    const mat = body.material as THREE.MeshStandardMaterial;
    mat.roughness = 0.5;
    mat.metalness = 0.1;
  }
  group.add(body);

  // Front face is at +Z half-D. We'll place items at z = D/2 + 0.01.
  const front = D / 2 + 0.01;
  const back = -D / 2 - 0.01;

  // ---- Orientation markers (so it's easy to tell which side is which) ----
  // Bright green arrow on the FRONT face pointing UP the controller.
  {
    const arrow = new THREE.Shape();
    arrow.moveTo(0, 0.35);
    arrow.lineTo(0.28, -0.05);
    arrow.lineTo(0.1, -0.05);
    arrow.lineTo(0.1, -0.35);
    arrow.lineTo(-0.1, -0.35);
    arrow.lineTo(-0.1, -0.05);
    arrow.lineTo(-0.28, -0.05);
    arrow.closePath();
    const geo = new THREE.ShapeGeometry(arrow);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_FRONT_MARK,
      emissive: COLOR_FRONT_MARK,
      emissiveIntensity: 0.45,
      roughness: 0.3,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0, front + 0.005);
    group.add(mesh);
  }

  // Bright yellow stripe on the TOP edge (near the shoulder buttons).
  {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.7, 0.08, D * 0.6),
      new THREE.MeshStandardMaterial({
        color: COLOR_TOP_MARK,
        emissive: COLOR_TOP_MARK,
        emissiveIntensity: 0.4,
      }),
    );
    stripe.position.set(0, H / 2 - 0.18, 0);
    group.add(stripe);
  }

  // Purple stripe on the BACK so the controller is easy to read from any angle.
  {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.5, H * 0.7, 0.04),
      new THREE.MeshStandardMaterial({
        color: COLOR_BACK_MARK,
        emissive: COLOR_BACK_MARK,
        emissiveIntensity: 0.3,
      }),
    );
    stripe.position.set(0, 0, back);
    group.add(stripe);
  }

  // Shoulder triggers (top): SR/SL on the inner edge; L/ZL or R/ZR on the top edge
  const shoulderTop = makeRoundedBox(W * 0.95, 0.35, D * 0.95, 0.1, COLOR_TRIGGER);
  shoulderTop.position.set(0, H / 2 + 0.15, 0);
  shoulderTop.userData.baseColor = COLOR_TRIGGER;
  group.add(shoulderTop);
  buttons[isLeft ? "l" : "r"] = shoulderTop;

  const zShoulder = makeRoundedBox(W * 0.9, 0.25, D * 0.7, 0.08, COLOR_TRIGGER);
  zShoulder.position.set(0, H / 2 + 0.05, -D / 2 - 0.1);
  zShoulder.userData.baseColor = COLOR_TRIGGER;
  group.add(zShoulder);
  buttons[isLeft ? "zl" : "zr"] = zShoulder;

  // SR / SL on inner rail (the rail side faces the other controller). For L, inner is +X; for R, inner is -X.
  const innerX = isLeft ? W / 2 + 0.02 : -W / 2 - 0.02;
  const slMesh = makeMiniButton(0.15, 0.5, COLOR_TRIGGER);
  slMesh.position.set(innerX, 1.0, 0);
  slMesh.rotation.y = Math.PI / 2;
  slMesh.userData.baseColor = COLOR_TRIGGER;
  group.add(slMesh);
  buttons[isLeft ? "slL" : "slR"] = slMesh;

  const srMesh = makeMiniButton(0.15, 0.5, COLOR_TRIGGER);
  srMesh.position.set(innerX, -1.0, 0);
  srMesh.rotation.y = Math.PI / 2;
  srMesh.userData.baseColor = COLOR_TRIGGER;
  group.add(srMesh);
  buttons[isLeft ? "srL" : "srR"] = srMesh;

  // Stick
  const stickPivot = new THREE.Group();
  stickPivot.position.set(0, isLeft ? 1.4 : -1.4, front);
  const stickBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.05, 24),
    new THREE.MeshStandardMaterial({ color: COLOR_STICK }),
  );
  stickBase.rotation.x = Math.PI / 2;
  stickPivot.add(stickBase);

  const stickShaftPivot = new THREE.Group();
  const stickShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.14, 0.4, 16),
    new THREE.MeshStandardMaterial({ color: COLOR_STICK }),
  );
  stickShaft.position.set(0, 0, 0.2);
  stickShaft.rotation.x = Math.PI / 2;
  const stickCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 0.12, 24),
    new THREE.MeshStandardMaterial({
      color: isLeft ? COLOR_STICK_CAP_LEFT : COLOR_STICK_CAP_RIGHT,
      emissive: isLeft ? COLOR_STICK_CAP_LEFT : COLOR_STICK_CAP_RIGHT,
      emissiveIntensity: 0.25,
      roughness: 0.5,
    }),
  );
  stickCap.position.set(0, 0, 0.42);
  stickCap.rotation.x = Math.PI / 2;
  stickShaftPivot.add(stickShaft);
  stickShaftPivot.add(stickCap);
  stickShaftPivot.userData.isStickShaft = true;
  stickPivot.add(stickShaftPivot);
  group.add(stickPivot);

  if (isLeft) {
    // D-pad: up/down/left/right buttons (light grey so they pop against blue)
    const DPAD_COLOR = 0xdddddd;
    const dpadCenter = new THREE.Vector3(0, -1.4, front);
    const off = 0.5;
    const dUp = makeButton(0.22, "Up", DPAD_COLOR);
    dUp.position.set(dpadCenter.x, dpadCenter.y + off, dpadCenter.z);
    const dDown = makeButton(0.22, "Down", DPAD_COLOR);
    dDown.position.set(dpadCenter.x, dpadCenter.y - off, dpadCenter.z);
    const dLeft = makeButton(0.22, "Left", DPAD_COLOR);
    dLeft.position.set(dpadCenter.x - off, dpadCenter.y, dpadCenter.z);
    const dRight = makeButton(0.22, "Right", DPAD_COLOR);
    dRight.position.set(dpadCenter.x + off, dpadCenter.y, dpadCenter.z);
    group.add(dUp, dDown, dLeft, dRight);
    buttons.up = dUp;
    buttons.down = dDown;
    buttons.left = dLeft;
    buttons.right = dRight;

    // Minus and capture
    const minus = makeMiniButton(0.32, 0.08, COLOR_BUTTON);
    minus.position.set(0.45, 2.1, front);
    group.add(minus);
    buttons.minus = minus;

    const capture = makeButton(0.18, "Capture");
    capture.position.set(0, -2.3, front);
    capture.scale.set(0.9, 0.9, 0.9);
    group.add(capture);
    buttons.capture = capture;

    return wrapForAxisRemap({ group, buttons, stickPivot: stickShaftPivot, stickName: "leftStick" });
  } else {
    // Face buttons: A (right), B (bottom), X (top), Y (left) — Nintendo colors.
    const faceCenter = new THREE.Vector3(0, 1.4, front);
    const off = 0.5;
    const a = makeButton(0.24, "A", 0xff5555);    // red-ish
    a.position.set(faceCenter.x + off, faceCenter.y, faceCenter.z);
    const b = makeButton(0.24, "B", 0xffd24a);    // yellow
    b.position.set(faceCenter.x, faceCenter.y - off, faceCenter.z);
    const x = makeButton(0.24, "X", 0x66c2ff);    // light blue
    x.position.set(faceCenter.x, faceCenter.y + off, faceCenter.z);
    const y = makeButton(0.24, "Y", 0x66e08a);    // green
    y.position.set(faceCenter.x - off, faceCenter.y, faceCenter.z);
    group.add(a, b, x, y);
    buttons.a = a;
    buttons.b = b;
    buttons.x = x;
    buttons.y = y;

    const plus = makeMiniButton(0.32, 0.08, COLOR_BUTTON);
    const plus2 = makeMiniButton(0.08, 0.32, COLOR_BUTTON);
    plus.position.set(-0.45, 2.1, front);
    plus2.position.set(-0.45, 2.1, front + 0.001);
    plus.userData.baseColor = COLOR_BUTTON;
    plus2.userData.baseColor = COLOR_BUTTON;
    group.add(plus, plus2);
    buttons.plus = plus; // we'll color both, but only one is mapped

    const home = makeButton(0.2, "Home");
    home.position.set(0, -2.3, front);
    home.scale.set(0.9, 0.9, 0.9);
    (home.material as THREE.MeshStandardMaterial).color.setHex(COLOR_BUTTON);
    home.userData.baseColor = COLOR_BUTTON;
    home.userData.isHome = true;
    group.add(home);
    buttons.home = home;

    return wrapForAxisRemap({ group, buttons, stickPivot: stickShaftPivot, stickName: "rightStick" });
  }
}

export class SceneController {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  container: HTMLElement;
  meshes: JoyConMesh[] = [];
  states: (JoyConState | null)[] = [];
  homeLightIntensity = 0; // 0..1
  playerLights = 0; // bitmask 4 LEDs
  playerLightStrips: THREE.Mesh[][] = [];
  private resizeObserver: ResizeObserver;
  private rafId = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.setClearColor(0xf4f5f8, 1);
    // Enable shadow maps so directional lights cast shadows onto the body.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
        const fog = new THREE.Fog(0xf4f5f8, 12, 26);
    this.scene.fog = fog;

    this.camera = new THREE.PerspectiveCamera(35, container.clientWidth / container.clientHeight, 0.1, 100);
    this.camera.position.set(0, 0, 13);
    this.camera.lookAt(0, 0, 0);

    const amb = new THREE.AmbientLight(0xffffff, 1.2);
    this.scene.add(amb);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(4, 6, 7);
    key.castShadow = true;
    key.shadow.mapSize.width = 1024;
    key.shadow.mapSize.height = 1024;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 30;
    key.shadow.camera.left = -10;
    key.shadow.camera.right = 10;
    key.shadow.camera.top = 10;
    key.shadow.camera.bottom = -10;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x90b8ff, 0.9);
    rim.position.set(-6, -3, 4);
    this.scene.add(rim);
    // Fill light from below/behind so the back of the controller never goes black.
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(0, -4, -6);
    this.scene.add(fill);
    const ground = new THREE.HemisphereLight(0x506080, 0x101018, 0.6);
    this.scene.add(ground);

    // Subtle backdrop grid
        const grid = new THREE.GridHelper(40, 40, 0xc0c4ce, 0xd8dbe4);
    grid.position.y = -6;
    this.scene.add(grid);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.start();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setControllers(sides: JoyConSide[]) {
    // Remove old
    for (const m of this.meshes) this.scene.remove(m.outerGroup);
    this.meshes = [];
    this.playerLightStrips = [];

    sides.forEach((side, i) => {
      const m = buildJoyCon(side);
      // Position pair side by side
      const offset = sides.length > 1 ? (i === 0 ? -1.6 : 1.6) : 0;
      m.outerGroup.position.x = offset;
      this.scene.add(m.outerGroup);
      this.meshes.push(m);

      // Player lights strip on the inner rail
      const strip: THREE.Mesh[] = [];
      const innerX = side === "left" ? 1.0 : -1.0;
      for (let j = 0; j < 4; j++) {
        const led = new THREE.Mesh(
          new THREE.BoxGeometry(0.18, 0.05, 0.04),
          new THREE.MeshStandardMaterial({ color: 0xaaaaaa, emissive: 0x000000 }),
        );
        led.position.set(innerX, -0.4 - j * 0.25, 0.05);
        m.group.add(led);
        strip.push(led);
      }
      this.playerLightStrips.push(strip);
    });
    this.states = new Array(sides.length).fill(null);
  }

  updateState(idx: number, state: JoyConState | null) {
    this.states[idx] = state;
  }

  setHomeLight(intensity: number) {
    this.homeLightIntensity = intensity;
  }

  setPlayerLights(mask: number) {
    this.playerLights = mask;
  }

  start() {
    const animate = () => {
      this.rafId = requestAnimationFrame(animate);
      this.tick();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private tick() {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i]!;
      const state = this.states[i];

      // Player LEDs
      const strip = this.playerLightStrips[i];
      if (strip) {
        for (let j = 0; j < 4; j++) {
          const on = (this.playerLights >> j) & 1;
          const mat = strip[j]!.material as THREE.MeshStandardMaterial;
          mat.color.setHex(on ? 0xfff0a0 : 0xaaaaaa);
          mat.emissive.setHex(on ? 0xfff080 : 0x000000);
          mat.emissiveIntensity = on ? 1.0 : 0;
        }
      }

      if (!state) {
        // idle gentle rotation
        m.outerGroup.rotation.y += 0.005;
        continue;
      }

      // Convert the sensor basis rather than rotating the geometry or swapping
      // Euler angles; this also preserves compound rotations.
      const q = imuToModelQuaternion(state.orientation);
      m.outerGroup.quaternion.set(q.x, q.y, q.z, q.w);

      // Buttons
      const isHome = (name: string) => name === "home";
      for (const [name, mesh] of Object.entries(m.buttons)) {
        if (!mesh) continue;
        const pressed = (state.buttons as any)[name] as boolean;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const base = mesh.userData.baseColor ?? COLOR_BUTTON;
        if (isHome(name) && this.homeLightIntensity > 0 && !pressed) {
          mat.color.setHex(COLOR_BUTTON);
          mat.emissive.setHex(0xffffff);
          mat.emissiveIntensity = this.homeLightIntensity;
        } else if (pressed) {
          mat.color.setHex(COLOR_BUTTON_HI);
          mat.emissive.setHex(COLOR_BUTTON_HI);
          mat.emissiveIntensity = 0.7;
        } else {
          mat.color.setHex(base);
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 0;
        }
      }

      // Stick
      if (m.stickPivot && m.stickName) {
        const stick: StickState = state[m.stickName];
        const tilt = 0.35; // radians at full
        m.stickPivot.rotation.y = stick.x * tilt;
        m.stickPivot.rotation.x = -stick.y * tilt;
      }
    }
  }
}
