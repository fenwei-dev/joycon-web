import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { JoyConSide, JoyConState } from "./joycon";
import { buildControllerModel, disposeObject, type ButtonName, type ControllerModel } from "./controller-model";
import { imuToModelQuaternion } from "./orientation";

export type SceneUnit =
  | { kind: "single"; id: number; side: JoyConSide }
  | { kind: "pair"; id: number; leftId: number; rightId: number };

interface UnitModel {
  id: number;
  model: ControllerModel;
}

interface UnitInstance {
  id: number;
  kind: "single" | "pair";
  root: THREE.Group;
  models: UnitModel[];
  orientationSourceId: number;
}

export class SceneController {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  container: HTMLElement;
  units: UnitInstance[] = [];
  states = new Map<number, JoyConState>();
  homeLights = new Map<number, number>();
  playerLights = new Map<number, number>();
  private resizeObserver: ResizeObserver;
  private environment: THREE.WebGLRenderTarget;
  private key: THREE.DirectionalLight;
  private rafId = 0;
  private layoutWidth = 6;
  private layoutRadius = 3;
  private lastFrameTime = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0xf4f5f8, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 150);
    // Broad studio reflections reveal the bevels without metallic-looking plastic.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.35;
    room.dispose();
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8c96ac, 0.65));
    this.key = new THREE.DirectionalLight(0xfff5e8, 1.8);
    this.key.position.set(-3, 7, 8);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.radius = 4;
    this.key.shadow.blurSamples = 8;
    this.key.shadow.camera.near = 0.5;
    this.key.shadow.camera.far = 50;
    this.key.shadow.normalBias = 0.025;
    this.key.shadow.bias = -0.0001;
    this.scene.add(this.key);
    const fill = new THREE.DirectionalLight(0xc8dfff, 0.8);
    fill.position.set(5, 1, 4);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.8);
    rim.position.set(2, 5, -5);
    this.scene.add(rim);
    const backFill = new THREE.DirectionalLight(0xdfe8ff, 1.0);
    backFill.position.set(-3, -1, -7);
    this.scene.add(backFill);

    // A quiet studio floor instead of the distracting debug grid and markers.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ color: 0x657187, opacity: 0.13 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -4.3;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.setUnits([]);
    this.start();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Reserve depth as well as height: a tilted controller should not be clipped.
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const heightDistance = this.layoutRadius / Math.sin(halfFov);
    const horizontalHalfFov = Math.atan(Math.tan(halfFov) * this.camera.aspect);
    const widthDistance = this.layoutWidth / 2 / Math.sin(horizontalHalfFov);
    this.camera.position.set(0, 0, Math.max(heightDistance, widthDistance) * 1.08);
    this.camera.far = Math.max(150, this.camera.position.z + 50);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  setUnits(units: SceneUnit[]) {
    for (const unit of this.units) {
      this.scene.remove(unit.root);
      disposeObject(unit.root);
    }

    this.units = units.map((unit) => this.buildUnit(unit));
    this.states.clear();
    this.playerLights.clear();
    this.homeLights.clear();

    const gap = 1.25;
    const widths = this.units.map((unit) => {
      const bounds = new THREE.Box3().setFromObject(unit.root);
      return bounds.getSize(new THREE.Vector3()).x;
    });
    const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
    let cursor = -total / 2;
    let maxRadius = 0;
    let extent = 0;
    this.units.forEach((unit, i) => {
      const width = widths[i]!;
      const bounds = new THREE.Box3().setFromObject(unit.root);
      // Distance from the rotation origin, not the bounding-box center.
      const corner = new THREE.Vector3(
        Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)),
        Math.max(Math.abs(bounds.min.y), Math.abs(bounds.max.y)),
        Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)),
      );
      const radius = corner.length();
      unit.root.position.x = cursor + width / 2;
      cursor += width + gap;
      this.scene.add(unit.root);
      maxRadius = Math.max(maxRadius, radius);
      extent = Math.max(extent, Math.abs(unit.root.position.x) + radius);
    });
    this.layoutWidth = Math.max(6, extent * 2);
    this.layoutRadius = Math.max(3, maxRadius);
    const shadowExtent = Math.max(8, extent + 2);
    Object.assign(this.key.shadow.camera, { left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent });
    this.key.shadow.camera.updateProjectionMatrix();
    this.resize();
  }

  private buildUnit(unit: SceneUnit): UnitInstance {
    if (unit.kind === "single") {
      const model = buildControllerModel(unit.side);
      return {
        id: unit.id,
        kind: "single",
        root: model.outerGroup,
        models: [{ id: unit.id, model }],
        orientationSourceId: unit.id,
      };
    }

    const left = buildControllerModel("left");
    const right = buildControllerModel("right");
    const leftBounds = new THREE.Box3().setFromObject(left.group);
    const rightBounds = new THREE.Box3().setFromObject(right.group);

    // Seat the two inner rails face to face with a small gap for the connector.
    const gap = 0.28;
    left.outerGroup.position.x = -gap / 2 - leftBounds.max.x;
    right.outerGroup.position.x = gap / 2 - rightBounds.min.x;

    const connector = new THREE.Mesh(
      new RoundedBoxGeometry(gap + 0.45, 4.35, 0.56, 3, 0.07),
      new THREE.MeshPhysicalMaterial({
        color: 0x9db8d6,
        emissive: 0x16324a,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.34,
        roughness: 0.18,
        metalness: 0.08,
        depthWrite: false,
      }),
    );
    connector.position.set(0, 0, 0.02);
    connector.renderOrder = 2;

    const root = new THREE.Group();
    root.add(left.outerGroup, right.outerGroup, connector);

    return {
      id: unit.id,
      kind: "pair",
      root,
      models: [
        { id: unit.leftId, model: left },
        { id: unit.rightId, model: right },
      ],
      orientationSourceId: unit.leftId,
    };
  }

  updateState(id: number, state: JoyConState) {
    this.states.set(id, state);
  }

  setHomeLight(id: number, intensity: number) {
    this.homeLights.set(id, intensity);
  }

  setPlayerLights(id: number, mask: number) {
    this.playerLights.set(id, mask);
  }

  start() {
    cancelAnimationFrame(this.rafId);
    const animate = (time: number) => {
      this.rafId = requestAnimationFrame(animate);
      const dt = this.lastFrameTime ? Math.min((time - this.lastFrameTime) / 1000, 0.1) : 1 / 60;
      this.lastFrameTime = time;
      this.tick(time / 1000, dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.rafId = requestAnimationFrame(animate);
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    disposeObject(this.scene);
    this.key.shadow.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private tick(time: number, dt: number) {
    const smoothing = 1 - Math.exp(-24 * dt);
    this.units.forEach((unit) => {
      // Linked Joy-Cons share one rotation. Prefer the left controller, then
      // fall back to whichever half is reporting.
      const sourceState =
        this.states.get(unit.orientationSourceId) ??
        unit.models
          .map(({ id }) => this.states.get(id))
          .find((state): state is JoyConState => !!state) ??
        null;

      if (!sourceState) {
        unit.root.rotation.set(
          -0.10,
          (unit.id % 2 ? -1 : 1) * 0.20 + Math.sin(time * 0.45) * 0.08,
          (unit.id % 2 ? -1 : 1) * 0.06,
        );
      } else {
        // Keep orientation tracking exact; only button travel is smoothed.
        const q = imuToModelQuaternion(sourceState.orientation);
        unit.root.quaternion.set(q.x, q.y, q.z, q.w);
      }

      for (const { id, model } of unit.models) {
        const state = this.states.get(id) ?? null;
        const mask = this.playerLights.get(id) ?? 0;
        model.playerLights.forEach((led, j) => {
          const on = !!state && !!((mask >> j) & 1);
          led.material.color.setHex(on ? 0xb8ef83 : 0x525a50);
          led.material.emissive.setHex(on ? 0x8fda52 : 0x000000);
          led.material.emissiveIntensity = on ? 1.2 : 0;
        });
        if (model.homeRing) {
          model.homeRing.material.emissive.setHex(0x7fcfff);
          model.homeRing.material.emissiveIntensity = state
            ? (this.homeLights.get(id) ?? 0) * 2
            : 0;
        }

        for (const name of Object.keys(model.buttons) as ButtonName[]) {
          const button = model.buttons[name]!;
          const pressed = state ? state.buttons[name] : false;
          button.material.color.setHex(pressed ? 0x507e88 : button.userData.baseColor);
          button.material.emissive.setHex(pressed ? 0x43bfd1 : 0x000000);
          button.material.emissiveIntensity = pressed ? 0.25 : 0;
          const rest = button.userData.restPosition as THREE.Vector3;
          const direction = button.userData.pressDirection as THREE.Vector3;
          const travel = pressed ? 0.045 : 0;
          button.position.x = THREE.MathUtils.lerp(button.position.x, rest.x + direction.x * travel, smoothing);
          button.position.y = THREE.MathUtils.lerp(button.position.y, rest.y + direction.y * travel, smoothing);
          button.position.z = THREE.MathUtils.lerp(button.position.z, rest.z + direction.z * travel, smoothing);
        }
        for (const name of ["leftStick", "rightStick"] as const) {
          const pivot = model.sticks[name];
          if (!pivot) continue;
          const stick = state ? state[name] : null;
          pivot.rotation.y = (stick?.x ?? 0) * 0.32;
          pivot.rotation.x = -(stick?.y ?? 0) * 0.32;
        }
      }
    });
  }
}
