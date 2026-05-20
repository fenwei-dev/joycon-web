// Joy-Con HID driver via WebHID.
// Protocol references: dekuNukem/Nintendo_Switch_Reverse_Engineering

export const NINTENDO_VENDOR_ID = 0x057e;
export const JOYCON_L_PID = 0x2006;
export const JOYCON_R_PID = 0x2007;
export const PRO_CONTROLLER_PID = 0x2009;

export type JoyConSide = "left" | "right" | "pro";

export interface ButtonState {
  // shared
  minus: boolean;
  plus: boolean;
  home: boolean;
  capture: boolean;
  lStick: boolean;
  rStick: boolean;
  // right
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  r: boolean;
  zr: boolean;
  srR: boolean;
  slR: boolean;
  // left
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  l: boolean;
  zl: boolean;
  srL: boolean;
  slL: boolean;
}

export interface StickState {
  x: number; // -1..1
  y: number; // -1..1
  raw: { x: number; y: number };
}

export interface ImuFrame {
  accel: { x: number; y: number; z: number }; // g
  gyro: { x: number; y: number; z: number }; // deg/s
}

export interface BatteryState {
  level: number; // 0..4
  charging: boolean;
}

export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

export interface JoyConState {
  side: JoyConSide;
  buttons: ButtonState;
  leftStick: StickState;
  rightStick: StickState;
  imu: ImuFrame; // most recent of the 3 frames
  battery: BatteryState;
  orientation: Quaternion;
  packetCounter: number;
}

const emptyButtons = (): ButtonState => ({
  minus: false, plus: false, home: false, capture: false,
  lStick: false, rStick: false,
  a: false, b: false, x: false, y: false, r: false, zr: false, srR: false, slR: false,
  up: false, down: false, left: false, right: false, l: false, zl: false, srL: false, slL: false,
});

const emptyStick = (): StickState => ({ x: 0, y: 0, raw: { x: 2048, y: 2048 } });

const emptyImu = (): ImuFrame => ({
  accel: { x: 0, y: 0, z: 0 },
  gyro: { x: 0, y: 0, z: 0 },
});

export type StateListener = (state: JoyConState) => void;

export class JoyCon {
  device: HIDDevice;
  side: JoyConSide;
  state: JoyConState;
  private packetNumber = 0;
  private listeners = new Set<StateListener>();
  private subcommandResolvers = new Map<number, (data: DataView) => void>();
  private gyroBias = { x: 0, y: 0, z: 0 };
  private lastImuTime = 0;
  private calibrated = false;
  private calibSamples = 0;
  private calibSum = { x: 0, y: 0, z: 0 };

  // Stick calibration (defaults; replaced after reading SPI)
  private leftStickCal = {
    cx: 2048, cy: 2048,
    xMin: 700, xMax: 700,
    yMin: 700, yMax: 700,
  };
  private rightStickCal = {
    cx: 2048, cy: 2048,
    xMin: 700, xMax: 700,
    yMin: 700, yMax: 700,
  };

  constructor(device: HIDDevice) {
    this.device = device;
    this.side = JoyCon.detectSide(device);
    this.state = {
      side: this.side,
      buttons: emptyButtons(),
      leftStick: emptyStick(),
      rightStick: emptyStick(),
      imu: emptyImu(),
      battery: { level: 0, charging: false },
      orientation: { w: 1, x: 0, y: 0, z: 0 },
      packetCounter: 0,
    };
  }

  static detectSide(device: HIDDevice): JoyConSide {
    if (device.productId === JOYCON_L_PID) return "left";
    if (device.productId === JOYCON_R_PID) return "right";
    return "pro";
  }

  static async request(): Promise<JoyCon[]> {
    const devices = await navigator.hid.requestDevice({
      filters: [
        { vendorId: NINTENDO_VENDOR_ID, productId: JOYCON_L_PID },
        { vendorId: NINTENDO_VENDOR_ID, productId: JOYCON_R_PID },
        { vendorId: NINTENDO_VENDOR_ID, productId: PRO_CONTROLLER_PID },
      ],
    });
    return devices.map((d) => new JoyCon(d));
  }

  static async getPaired(): Promise<JoyCon[]> {
    const devices = await navigator.hid.getDevices();
    return devices
      .filter((d) => d.vendorId === NINTENDO_VENDOR_ID)
      .map((d) => new JoyCon(d));
  }

  onState(listener: StateListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l(this.state);
  }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener("inputreport", this.handleInputReport);

    // Standard init: enable vibration, IMU, set report mode to 0x30 (60Hz full)
    await this.setShipmentLowPower(false);
    await this.enableVibration(true);
    await this.enableIMU(true);
    await this.readStickCalibration();
    await this.setReportMode(0x30);
    await this.setPlayerLights(0b0001);
  }

  async close() {
    try {
      this.device.removeEventListener("inputreport", this.handleInputReport);
      if (this.device.opened) await this.device.close();
    } catch {}
  }

  // ---- Output / subcommand layer ----

  private nextPacketNumber() {
    const n = this.packetNumber & 0x0f;
    this.packetNumber = (this.packetNumber + 1) & 0x0f;
    return n;
  }

  private buildRumbleNeutral(): Uint8Array {
    // Neutral rumble (no vibration), 8 bytes
    return new Uint8Array([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]);
  }

  private async sendOutput(reportId: number, payload: Uint8Array) {
    // Pad to the size declared by the device's HID descriptor for this report
    // (Joy-Con report 0x01 is typically 48 bytes; some platforms reject mismatched sizes).
    const expected = this.getOutputReportSize(reportId);
    const size = Math.max(payload.length, expected);
    const buf = new ArrayBuffer(size);
    new Uint8Array(buf).set(payload);
    await this.device.sendReport(reportId, buf);
  }

  private outputSizeCache = new Map<number, number>();
  private getOutputReportSize(reportId: number): number {
    const cached = this.outputSizeCache.get(reportId);
    if (cached !== undefined) return cached;
    let bits = 0;
    for (const c of this.device.collections ?? []) {
      for (const r of c.outputReports ?? []) {
        if (r.reportId !== reportId) continue;
        for (const item of r.items ?? []) {
          bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
        }
      }
    }
    const size = bits > 0 ? Math.ceil(bits / 8) : 0;
    this.outputSizeCache.set(reportId, size);
    return size;
  }

  async sendSubcommand(subcmd: number, args: Uint8Array = new Uint8Array()): Promise<DataView | null> {
    // Output report 0x01 body: packet#(1) + rumble(8) + subcmdId(1) + args(N) = 10 + N bytes.
    const payload = new Uint8Array(10 + args.length);
    payload[0] = this.nextPacketNumber();
    payload.set(this.buildRumbleNeutral(), 1);
    payload[9] = subcmd;
    if (args.length) payload.set(args, 10);
    // Wait for reply (report 0x21) carrying this subcommand
    const pending = new Promise<DataView>((resolve) => {
      const t = window.setTimeout(() => {
        if (this.subcommandResolvers.get(subcmd) === resolve as any) {
          this.subcommandResolvers.delete(subcmd);
        }
        resolve(new DataView(new ArrayBuffer(0)));
      }, 250);
      this.subcommandResolvers.set(subcmd, (data) => {
        window.clearTimeout(t);
        resolve(data);
      });
    });
    try {
      await this.sendOutput(0x01, payload);
    } catch (e) {
      this.subcommandResolvers.delete(subcmd);
      throw e;
    }
    return pending;
  }

  async setReportMode(mode: number) {
    await this.sendSubcommand(0x03, new Uint8Array([mode]));
  }

  async enableIMU(on: boolean) {
    await this.sendSubcommand(0x40, new Uint8Array([on ? 0x01 : 0x00]));
  }

  async enableVibration(on: boolean) {
    await this.sendSubcommand(0x48, new Uint8Array([on ? 0x01 : 0x00]));
  }

  async setShipmentLowPower(on: boolean) {
    await this.sendSubcommand(0x08, new Uint8Array([on ? 0x01 : 0x00]));
  }

  async setPlayerLights(mask: number) {
    // Lower nibble = solid, upper nibble = flash
    await this.sendSubcommand(0x30, new Uint8Array([mask & 0xff]));
  }

  async setHomeLight(intensity: number, durationCycles = 0xf) {
    // intensity 0..15. mini pattern: 1 cycle, both base+mini intensities.
    const i = Math.max(0, Math.min(15, Math.round(intensity)));
    const byte1 = (1 << 4) | (durationCycles & 0x0f); // 1 mini cycle, total duration nibble
    const byte2 = (i << 4) | 0x0; // start intensity (i) | LED off intensity (0)
    const byte3 = (0xf << 4) | 0x0; // fade duration | duration of intensity
    await this.sendSubcommand(0x38, new Uint8Array([byte1, byte2, byte3]));
  }

  async rumble(lowFreq: number, lowAmp: number, highFreq: number, highAmp: number) {
    // Simplified HD rumble encoding for both sides (one rumble payload, no subcommand).
    const data = encodeRumble(lowFreq, lowAmp, highFreq, highAmp);
    const payload = new Uint8Array(9);
    payload[0] = this.nextPacketNumber();
    payload.set(data, 1); // left 4 bytes
    payload.set(data, 5); // right 4 bytes
    await this.sendOutput(0x10, payload);
  }

  async rumbleStop() {
    const payload = new Uint8Array(9);
    payload[0] = this.nextPacketNumber();
    payload.set(this.buildRumbleNeutral(), 1);
    await this.sendOutput(0x10, payload);
  }

  // ---- SPI calibration read ----

  private async readSpi(address: number, length: number): Promise<Uint8Array | null> {
    const args = new Uint8Array(5);
    args[0] = address & 0xff;
    args[1] = (address >> 8) & 0xff;
    args[2] = (address >> 16) & 0xff;
    args[3] = (address >> 24) & 0xff;
    args[4] = length;
    const reply = await this.sendSubcommand(0x10, args);
    // Reply layout: address(4) + length(1) + data(N).
    if (!reply || reply.byteLength < 5 + length) return null;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = reply.getUint8(5 + i);
    return out;
  }

  private async readStickCalibration() {
    try {
      // Factory left + right stick cal at 0x603D, 18 bytes (L 9, R 9)
      const data = await this.readSpi(0x603d, 18);
      if (!data) return;
      const lXmax = data[0]! | ((data[1]! & 0x0f) << 8);
      const lYmax = (data[1]! >> 4) | (data[2]! << 4);
      const lCx = data[3]! | ((data[4]! & 0x0f) << 8);
      const lCy = (data[4]! >> 4) | (data[5]! << 4);
      const lXmin = data[6]! | ((data[7]! & 0x0f) << 8);
      const lYmin = (data[7]! >> 4) | (data[8]! << 4);

      const rCx = data[9]! | ((data[10]! & 0x0f) << 8);
      const rCy = (data[10]! >> 4) | (data[11]! << 4);
      const rXmin = data[12]! | ((data[13]! & 0x0f) << 8);
      const rYmin = (data[13]! >> 4) | (data[14]! << 4);
      const rXmax = data[15]! | ((data[16]! & 0x0f) << 8);
      const rYmax = (data[16]! >> 4) | (data[17]! << 4);

      if (lCx > 0) {
        this.leftStickCal = { cx: lCx, cy: lCy, xMin: lXmin, xMax: lXmax, yMin: lYmin, yMax: lYmax };
      }
      if (rCx > 0) {
        this.rightStickCal = { cx: rCx, cy: rCy, xMin: rXmin, xMax: rXmax, yMin: rYmin, yMax: rYmax };
      }
    } catch {
      // ignore, use defaults
    }
  }

  // ---- Input parsing ----

  private handleInputReport = (event: HIDInputReportEvent) => {
    try {
      const data = event.data;
      const reportId = event.reportId;
      if (reportId === 0x30 || reportId === 0x21) {
        this.parseStandard(data);
        if (reportId === 0x21) this.handleSubcommandReply(data);
        this.emit();
      } else if (reportId === 0x3f) {
        // simple HID mode (not used after init)
      }
    } catch (err) {
      console.warn("Joy-Con: input report parse failed", err, event);
    }
  };

  private handleSubcommandReply(data: DataView) {
    // 0x21 body layout (no report ID): 0..11 standard, 12 = ACK, 13 = subcmd id, 14+ = reply data.
    if (data.byteLength < 14) return;
    const subcmd = data.getUint8(13);
    const resolver = this.subcommandResolvers.get(subcmd);
    if (!resolver) return;
    this.subcommandResolvers.delete(subcmd);
    // Reply DataView starts at the actual reply data (byte 14).
    const start = data.byteOffset + 14;
    const len = data.byteLength - 14;
    if (len <= 0 || start + len > data.buffer.byteLength) {
      resolver(new DataView(new ArrayBuffer(0)));
      return;
    }
    resolver(new DataView(data.buffer, start, len));
  }

  private parseStandard(data: DataView) {
    // data is the report body (without reportId byte for WebHID)
    // byte 0 = timer, byte 1 = battery/conn, bytes 2-4 = buttons, 5-7 left stick, 8-10 right stick,
    // byte 11 vibrator input, 12..47 imu (3 frames of 12).
    if (data.byteLength < 12) return;

    const battByte = data.getUint8(1);
    this.state.battery = {
      level: (battByte >> 5) & 0x07,
      charging: ((battByte >> 4) & 0x01) === 1,
    };
    // The official mapping uses upper nibble: bit7..4. Battery levels 8=full,6,4,2,0 with +1 = charging
    const upper = (battByte >> 4) & 0x0f;
    this.state.battery.charging = (upper & 0x01) === 1;
    this.state.battery.level = Math.min(4, Math.floor(upper / 2));

    const b0 = data.getUint8(2); // right side buttons
    const b1 = data.getUint8(3); // shared
    const b2 = data.getUint8(4); // left side buttons
    const btn = this.state.buttons;
    btn.y = !!(b0 & 0x01);
    btn.x = !!(b0 & 0x02);
    btn.b = !!(b0 & 0x04);
    btn.a = !!(b0 & 0x08);
    btn.srR = !!(b0 & 0x10);
    btn.slR = !!(b0 & 0x20);
    btn.r = !!(b0 & 0x40);
    btn.zr = !!(b0 & 0x80);

    btn.minus = !!(b1 & 0x01);
    btn.plus = !!(b1 & 0x02);
    btn.rStick = !!(b1 & 0x04);
    btn.lStick = !!(b1 & 0x08);
    btn.home = !!(b1 & 0x10);
    btn.capture = !!(b1 & 0x20);

    btn.down = !!(b2 & 0x01);
    btn.up = !!(b2 & 0x02);
    btn.right = !!(b2 & 0x04);
    btn.left = !!(b2 & 0x08);
    btn.srL = !!(b2 & 0x10);
    btn.slL = !!(b2 & 0x20);
    btn.l = !!(b2 & 0x40);
    btn.zl = !!(b2 & 0x80);

    // Left stick (bytes 5-7)
    const ls0 = data.getUint8(5);
    const ls1 = data.getUint8(6);
    const ls2 = data.getUint8(7);
    const lx = ls0 | ((ls1 & 0x0f) << 8);
    const ly = (ls1 >> 4) | (ls2 << 4);
    this.state.leftStick = this.normalizeStick(lx, ly, this.leftStickCal);

    // Right stick (bytes 8-10)
    const rs0 = data.getUint8(8);
    const rs1 = data.getUint8(9);
    const rs2 = data.getUint8(10);
    const rx = rs0 | ((rs1 & 0x0f) << 8);
    const ry = (rs1 >> 4) | (rs2 << 4);
    this.state.rightStick = this.normalizeStick(rx, ry, this.rightStickCal);

    // IMU
    if (data.byteLength >= 12 + 36) {
      const frames: ImuFrame[] = [];
      for (let f = 0; f < 3; f++) {
        const off = 12 + f * 12;
        const ax = data.getInt16(off + 0, true);
        const ay = data.getInt16(off + 2, true);
        const az = data.getInt16(off + 4, true);
        const gx = data.getInt16(off + 6, true);
        const gy = data.getInt16(off + 8, true);
        const gz = data.getInt16(off + 10, true);
        frames.push({
          accel: { x: ax / 4096, y: ay / 4096, z: az / 4096 },
          gyro: { x: gx * 0.06103, y: gy * 0.06103, z: gz * 0.06103 },
        });
      }
      this.state.imu = frames[2]!;
      this.integrateOrientation(frames);
    }

    this.state.packetCounter++;
  }

  private normalizeStick(rx: number, ry: number, cal: typeof this.leftStickCal): StickState {
    const dx = rx - cal.cx;
    const dy = ry - cal.cy;
    const nx = dx >= 0 ? dx / Math.max(1, cal.xMax) : dx / Math.max(1, cal.xMin);
    const ny = dy >= 0 ? dy / Math.max(1, cal.yMax) : dy / Math.max(1, cal.yMin);
    // small deadzone
    const dz = 0.1;
    const ax = Math.abs(nx) < dz ? 0 : nx;
    const ay = Math.abs(ny) < dz ? 0 : ny;
    return {
      x: Math.max(-1, Math.min(1, ax)),
      y: Math.max(-1, Math.min(1, ay)),
      raw: { x: rx, y: ry },
    };
  }

  // ---- Orientation integration (gyroscope) ----

  resetOrientation() {
    this.state.orientation = { w: 1, x: 0, y: 0, z: 0 };
    this.calibrated = false;
    this.calibSamples = 0;
    this.calibSum = { x: 0, y: 0, z: 0 };
    this.gyroBias = { x: 0, y: 0, z: 0 };
  }

  private integrateOrientation(frames: ImuFrame[]) {
    const now = performance.now();
    const dtTotal = this.lastImuTime ? (now - this.lastImuTime) / 1000 : 0.015;
    this.lastImuTime = now;
    const dtFrame = dtTotal / frames.length;

    // Initial bias calibration over first ~60 samples assuming controller is still
    if (!this.calibrated) {
      for (const f of frames) {
        this.calibSum.x += f.gyro.x;
        this.calibSum.y += f.gyro.y;
        this.calibSum.z += f.gyro.z;
        this.calibSamples++;
      }
      if (this.calibSamples >= 60) {
        this.gyroBias.x = this.calibSum.x / this.calibSamples;
        this.gyroBias.y = this.calibSum.y / this.calibSamples;
        this.gyroBias.z = this.calibSum.z / this.calibSamples;
        this.calibrated = true;
      }
      return;
    }

    let q = this.state.orientation;
    for (const f of frames) {
      const gx = ((f.gyro.x - this.gyroBias.x) * Math.PI) / 180;
      const gy = ((f.gyro.y - this.gyroBias.y) * Math.PI) / 180;
      const gz = ((f.gyro.z - this.gyroBias.z) * Math.PI) / 180;
      // Quaternion derivative: q' = 0.5 * q * (0, gx, gy, gz)
      const dqw = 0.5 * (-q.x * gx - q.y * gy - q.z * gz);
      const dqx = 0.5 * (q.w * gx + q.y * gz - q.z * gy);
      const dqy = 0.5 * (q.w * gy - q.x * gz + q.z * gx);
      const dqz = 0.5 * (q.w * gz + q.x * gy - q.y * gx);
      q = {
        w: q.w + dqw * dtFrame,
        x: q.x + dqx * dtFrame,
        y: q.y + dqy * dtFrame,
        z: q.z + dqz * dtFrame,
      };
      const norm = Math.hypot(q.w, q.x, q.y, q.z) || 1;
      q.w /= norm; q.x /= norm; q.y /= norm; q.z /= norm;
    }

    // Complementary filter with accelerometer for tilt correction
    const a = frames[frames.length - 1]!.accel;
    const aMag = Math.hypot(a.x, a.y, a.z);
    if (aMag > 0.5 && aMag < 1.5) {
      const ax = a.x / aMag;
      const ay = a.y / aMag;
      const az = a.z / aMag;
      // Predicted gravity direction in body frame from q: rotate (0,0,1) by q^-1
      // = q* * (0,0,1) * q. With g = (0,0,1) world.
      const gxp = 2 * (q.x * q.z - q.w * q.y);
      const gyp = 2 * (q.w * q.x + q.y * q.z);
      const gzp = q.w * q.w - q.x * q.x - q.y * q.y + q.z * q.z;
      // Error = cross(measured, predicted)
      const ex = ay * gzp - az * gyp;
      const ey = az * gxp - ax * gzp;
      const ez = ax * gyp - ay * gxp;
      const k = 0.02;
      const cx = ex * k;
      const cy = ey * k;
      const cz = ez * k;
      const dqw = 0.5 * (-q.x * cx - q.y * cy - q.z * cz);
      const dqx = 0.5 * (q.w * cx + q.y * cz - q.z * cy);
      const dqy = 0.5 * (q.w * cy - q.x * cz + q.z * cx);
      const dqz = 0.5 * (q.w * cz + q.x * cy - q.y * cx);
      q = {
        w: q.w + dqw,
        x: q.x + dqx,
        y: q.y + dqy,
        z: q.z + dqz,
      };
      const norm = Math.hypot(q.w, q.x, q.y, q.z) || 1;
      q.w /= norm; q.x /= norm; q.y /= norm; q.z /= norm;
    }

    this.state.orientation = q;
  }
}

// --- HD Rumble encoding (very approximate). Encodes a single low+high tone.
// Frequency ranges: low 41-626 Hz, high 82-1252 Hz, amp 0..1.
function encodeRumble(lowFreq: number, lowAmp: number, highFreq: number, highAmp: number): Uint8Array {
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const hf = clamp(highFreq, 82, 1252);
  const lf = clamp(lowFreq, 41, 626);
  const ha = clamp(highAmp, 0, 1);
  const la = clamp(lowAmp, 0, 1);

  // Encode high freq as 9-bit value (per dekuNukem)
  const hfEnc = (Math.round(32 * Math.log2(hf / 10)) - 0x60) & 0x1ff;
  const lfEnc = (Math.round(32 * Math.log2(lf / 10)) - 0x40) & 0x7f;
  const haEnc = encodeAmp(ha) & 0xff; // 8-bit
  const laEnc = encodeAmpLow(la) & 0xff; // mapped

  const out = new Uint8Array(4);
  out[0] = hfEnc & 0xff;
  out[1] = (haEnc & 0xfe) | ((hfEnc >> 8) & 0x01);
  out[2] = (lfEnc & 0x7f) | ((laEnc & 0x01) << 7);
  out[3] = (laEnc >> 1) & 0x7f;
  // Set the "amp on" bit pattern - default base from neutral rumble
  out[1] |= 0x40;
  return out;
}

function encodeAmp(amp: number) {
  if (amp <= 0) return 0;
  if (amp >= 1) return 0xc8;
  // Approximate mapping
  return Math.round(amp * 0xc8);
}
function encodeAmpLow(amp: number) {
  if (amp <= 0) return 0;
  if (amp >= 1) return 0x72;
  return Math.round(amp * 0x72);
}
