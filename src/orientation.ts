import type { Quaternion } from "./joycon";

/**
 * Convert IMU orientation to the model's coordinates (X across, Y along the
 * controller, Z out of its face). IMU X is roll and IMU Y is pitch.
 *
 * Change basis by +90° about Z: modelQ = basis * imuQ * inverse(basis).
 * X -> Y, Y -> -X, Z -> Z. The sign preserves handedness; simply swapping
 * quaternion X/Y would reverse composed rotations. Identity stays identity.
 * Keep sensor fusion in IMU coordinates so gyro and gravity remain aligned.
 */
export function imuToModelQuaternion(q: Quaternion): Quaternion {
  return { w: q.w, x: -q.y, y: q.x, z: q.z };
}

/** Intrinsic Z-Y-X Euler angles in the IMU frame, in radians. */
export function imuToEuler(q: Quaternion) {
  const roll = Math.atan2(
    2 * (q.w * q.x + q.y * q.z),
    1 - 2 * (q.x * q.x + q.y * q.y),
  );
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x))));
  const yaw = Math.atan2(
    2 * (q.w * q.z + q.x * q.y),
    1 - 2 * (q.y * q.y + q.z * q.z),
  );
  return { roll, pitch, yaw };
}
