import { describe, expect, test } from "bun:test";
import { Euler, Quaternion, Vector3 } from "three";
import { imuToEuler, imuToModelQuaternion } from "./orientation";

function modelRotation(q: Quaternion) {
  const mapped = imuToModelQuaternion(q);
  return new Quaternion(mapped.x, mapped.y, mapped.z, mapped.w);
}

function expectVector(actual: Vector3, expected: Vector3) {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.z).toBeCloseTo(expected.z, 10);
}

describe("IMU to model orientation", () => {
  test("identity/reset keeps the model upright and front-facing", () => {
    const q = modelRotation(new Quaternion());
    expectVector(new Vector3(0, 1, 0).applyQuaternion(q), new Vector3(0, 1, 0));
    expectVector(new Vector3(0, 0, 1).applyQuaternion(q), new Vector3(0, 0, 1));
  });

  for (const sign of [-1, 1]) {
    test(`roll (${sign}) rotates around the model's longitudinal Y axis`, () => {
      const imu = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), sign * Math.PI / 2);
      const q = modelRotation(imu);
      expectVector(new Vector3(0, 1, 0).applyQuaternion(q), new Vector3(0, 1, 0));
      expectVector(new Vector3(0, 0, 1).applyQuaternion(q), new Vector3(sign, 0, 0));
    });

    test(`pitch (${sign}) rotates around the model's transverse -X axis`, () => {
      const imu = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), sign * Math.PI / 2);
      const q = modelRotation(imu);
      expectVector(new Vector3(1, 0, 0).applyQuaternion(q), new Vector3(1, 0, 0));
      expectVector(new Vector3(0, 0, 1).applyQuaternion(q), new Vector3(0, sign, 0));
    });

    test(`yaw (${sign}) retains the Z axis and direction`, () => {
      const imu = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), sign * Math.PI / 2);
      expectVector(new Vector3(1, 0, 0).applyQuaternion(modelRotation(imu)), new Vector3(0, sign, 0));
    });
  }

  test("compound rotations match a proper basis change", () => {
    const imu = new Quaternion().setFromEuler(new Euler(0.4, -0.6, 0.8, "ZYX"));
    const basis = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const expected = basis.clone().multiply(imu).multiply(basis.clone().invert());
    const actual = modelRotation(imu);
    expect(Math.abs(actual.dot(expected))).toBeCloseTo(1, 10);
    expect(actual.length()).toBeCloseTo(1, 10);
  });

  test("conversion preserves rotation composition", () => {
    const roll = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    const pitch = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.5);
    const actual = modelRotation(roll.clone().multiply(pitch));
    const expected = modelRotation(roll).multiply(modelRotation(pitch));
    expect(Math.abs(actual.dot(expected))).toBeCloseTo(1, 10);
  });
});

describe("orientation readout", () => {
  for (const axis of ["roll", "pitch", "yaw"] as const) {
    for (const angle of [-0.6, 0.6]) {
      test(`${axis} ${angle} is not labeled as another axis`, () => {
        const angles = { roll: 0, pitch: 0, yaw: 0 };
        angles[axis] = angle;
        const q = new Quaternion().setFromEuler(new Euler(angles.roll, angles.pitch, angles.yaw, "ZYX"));
        const actual = imuToEuler(q);
        expect(actual.roll).toBeCloseTo(angles.roll, 10);
        expect(actual.pitch).toBeCloseTo(angles.pitch, 10);
        expect(actual.yaw).toBeCloseTo(angles.yaw, 10);
      });
    }
  }

  test("compound angles use the same IMU convention", () => {
    const q = new Quaternion().setFromEuler(new Euler(0.4, -0.6, 0.8, "ZYX"));
    const actual = imuToEuler(q);
    expect(actual.roll).toBeCloseTo(0.4, 10);
    expect(actual.pitch).toBeCloseTo(-0.6, 10);
    expect(actual.yaw).toBeCloseTo(0.8, 10);
  });

  test("pitch remains finite at the asin rounding boundary", () => {
    const half = Math.SQRT1_2;
    expect(imuToEuler({ w: half, x: 0, y: half, z: 0 }).pitch).toBeCloseTo(Math.PI / 2, 10);
  });
});
