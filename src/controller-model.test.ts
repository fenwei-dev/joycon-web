import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildControllerModel, disposeObject, type ButtonName } from "./controller-model";
import type { JoyConSide } from "./joycon";

const expectedButtons: Record<JoyConSide, ButtonName[]> = {
  left: ["up", "down", "left", "right", "minus", "capture", "l", "zl", "slL", "srL", "lStick"],
  right: ["a", "b", "x", "y", "plus", "home", "r", "zr", "slR", "srR", "rStick"],
  pro: ["up", "down", "left", "right", "a", "b", "x", "y", "minus", "plus", "capture", "home", "l", "zl", "r", "zr", "lStick", "rStick"],
};

for (const side of ["left", "right", "pro"] as const) {
  describe(`${side} controller model`, () => {
    test("builds in neutral model coordinates without a browser or external assets", () => {
      const model = buildControllerModel(side);
      expect(model.outerGroup.children).toContain(model.group);
      expect(model.group.quaternion.equals(new THREE.Quaternion())).toBe(true);
      expect(model.outerGroup.quaternion.equals(new THREE.Quaternion())).toBe(true);
      const bounds = new THREE.Box3().setFromObject(model.group);
      const size = bounds.getSize(new THREE.Vector3());
      expect(size.x).toBeGreaterThan(side === "pro" ? 7 : 2);
      expect(size.x).toBeLessThan(side === "pro" ? 8 : 2.5);
      expect(size.y).toBeGreaterThan(4);
      expect(size.y).toBeLessThan(5.7);
      expect(size.z).toBeGreaterThan(1);
      expect(size.z).toBeLessThan(2);
      disposeObject(model.outerGroup);
    });

    test("all controls have independent feedback materials and press origins", () => {
      const model = buildControllerModel(side);
      expect(Object.keys(model.buttons).sort()).toEqual([...expectedButtons[side]].sort());
      const materials = new Set<THREE.Material>();
      for (const name of expectedButtons[side]) {
        const button = model.buttons[name]!;
        expect(button.userData.restPosition.equals(button.position)).toBe(true);
        expect(button.userData.pressDirection.length()).toBeCloseTo(1, 10);
        expect(button.userData.baseColor).toBe(button.material.color.getHex());
        materials.add(button.material);
      }
      expect(materials.size).toBe(expectedButtons[side].length);
      expect(model.playerLights).toHaveLength(4);
      expect(!!model.homeRing).toBe(side !== "left");
      disposeObject(model.outerGroup);
    });

    test("shoulder bumpers and rear triggers have separate, inward-pressing surfaces", () => {
      const model = buildControllerModel(side);
      const pairs = side === "left" ? [["l", "zl"]] as const
        : side === "right" ? [["r", "zr"]] as const
        : [["l", "zl"], ["r", "zr"]] as const;
      for (const [bumperName, triggerName] of pairs) {
        const bumper = model.buttons[bumperName]!;
        const trigger = model.buttons[triggerName]!;
        const frontBounds = new THREE.Box3().setFromObject(bumper);
        const rearBounds = new THREE.Box3().setFromObject(trigger);
        expect(rearBounds.max.z).toBeLessThan(frontBounds.min.z);
        expect(trigger.position.x).toBe(bumper.position.x);
        expect(Math.sign(bumper.position.x)).toBe(bumperName === "l" ? -1 : 1);
        expect(bumper.userData.pressDirection.y).toBe(-1);
        expect(bumper.userData.pressDirection.z).toBe(0);
        expect(trigger.userData.pressDirection.y).toBeLessThan(0);
        expect(trigger.userData.pressDirection.z).toBeGreaterThan(0);
        const topLegend = bumper.getObjectByName(`${bumperName}-legend`)!;
        const rearLegend = trigger.getObjectByName(`${triggerName}-legend`)!;
        expect(new THREE.Vector3(0, 0, 1).applyQuaternion(topLegend.quaternion).y).toBeCloseTo(1, 10);
        expect(new THREE.Vector3(0, 0, 1).applyQuaternion(rearLegend.quaternion).z).toBeCloseTo(-1, 10);
      }
      disposeObject(model.outerGroup);
    });

    test("geometry positions and normals are finite", () => {
      const model = buildControllerModel(side);
      let valid = true;
      model.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        for (const name of ["position", "normal"]) {
          const attribute = object.geometry.getAttribute(name);
          if (!attribute || !Array.from(attribute.array).every(Number.isFinite)) valid = false;
        }
      });
      expect(valid).toBe(true);
      disposeObject(model.outerGroup);
    });

    test("releasing a model disposes each GPU resource exactly once", () => {
      const model = buildControllerModel(side);
      const resources = new Set<THREE.BufferGeometry | THREE.Material>();
      model.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        resources.add(object.geometry);
        for (const mat of Array.isArray(object.material) ? object.material : [object.material]) resources.add(mat);
      });
      const disposed = new Map<THREE.BufferGeometry | THREE.Material, number>();
      resources.forEach((resource) => resource.addEventListener("dispose", () => disposed.set(resource, (disposed.get(resource) ?? 0) + 1)));
      disposeObject(model.outerGroup);
      expect(disposed.size).toBe(resources.size);
      expect([...disposed.values()].every((count) => count === 1)).toBe(true);
    });
  });
}

test("Pro Controller has two independent sticks in the asymmetric Nintendo layout", () => {
  const model = buildControllerModel("pro");
  const left = model.sticks.leftStick!;
  const right = model.sticks.rightStick!;
  expect(left).not.toBe(right);
  expect(left.position.x).toBeLessThan(0);
  expect(right.position.x).toBeGreaterThan(0);
  expect(left.position.y).toBeGreaterThan(right.position.y);
  const dpadCenterY = (model.buttons.up!.position.y + model.buttons.down!.position.y) / 2;
  expect(right.position.y).toBeCloseTo(dpadCenterY, 10);
  expect(model.buttons.lStick!.parent).toBe(left);
  expect(model.buttons.rStick!.parent).toBe(right);
  left.rotation.y = 0.3;
  expect(right.rotation.y).toBe(0);
  disposeObject(model.outerGroup);
});

for (const side of ["left", "pro"] as const) {
  test(`${side} arrow buttons sit in the face and stay inside its outline`, () => {
    const model = buildControllerModel(side);
    model.group.updateMatrixWorld(true);
    const front = model.group.getObjectByName("front-shell")!;
    const ray = new THREE.Raycaster();
    for (const name of ["up", "down", "left", "right"] as const) {
      const cap = model.buttons[name]!;
      const bounds = new THREE.Box3().setFromObject(cap);
      // Check the whole footprint, not just the center: the lower Pro D-pad
      // previously extended beyond the curved face near its bottom corners.
      for (const x of [bounds.min.x, cap.position.x, bounds.max.x]) {
        for (const y of [bounds.min.y, cap.position.y, bounds.max.y]) {
          ray.set(new THREE.Vector3(x, y, 2), new THREE.Vector3(0, 0, -1));
          const hit = ray.intersectObject(front, false)[0];
          expect(hit).toBeDefined();
          if (!hit) continue;
          expect(bounds.min.z).toBeLessThan(hit.point.z);
          // The legend and cap top remain visible above the face.
          expect(bounds.max.z).toBeGreaterThan(hit.point.z);
        }
      }
    }
    disposeObject(model.outerGroup);
  });
}

test("rail buttons press inward on both mirrored Joy-Cons", () => {
  const left = buildControllerModel("left");
  const right = buildControllerModel("right");
  expect(left.buttons.slL!.position.x).toBeGreaterThan(0);
  expect(right.buttons.slR!.position.x).toBeLessThan(0);
  expect(left.buttons.slL!.userData.pressDirection.x).toBeCloseTo(-1, 10);
  expect(right.buttons.slR!.userData.pressDirection.x).toBeCloseTo(1, 10);
  disposeObject(left.outerGroup);
  disposeObject(right.outerGroup);
});
