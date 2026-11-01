import { describe, expect, test } from "bun:test";
import {
  JoyCon,
  buildHomeLightPayload,
  normalizeStick,
  parseStickCalibration,
  parseSubcommandReply,
  type StickCalibration,
} from "./joycon";

const DEFAULT_CALIBRATION: StickCalibration = {
  cx: 2048,
  cy: 2048,
  xMin: 700,
  xMax: 700,
  yMin: 700,
  yMax: 700,
};

const JOYCON_R_PID = 0x2007;

// sendSubcommand schedules its reply timeout through window in the browser.
if (typeof (globalThis as any).window === "undefined") {
  (globalThis as any).window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
}

function fakeJoyCon(productId = JOYCON_R_PID) {
  return new JoyCon({ productId } as HIDDevice);
}

function fakeHidDevice(onSend?: (reportId: number, data: ArrayBuffer) => void) {
  return {
    productId: JOYCON_R_PID,
    collections: [
      {
        outputReports: [
          { reportId: 0x01, items: [{ reportSize: 8, reportCount: 48 }] },
          { reportId: 0x10, items: [{ reportSize: 8, reportCount: 9 }] },
        ],
      },
    ],
    sendReport: async (reportId: number, data: ArrayBuffer) => {
      onSend?.(reportId, data);
    },
  } as unknown as HIDDevice;
}

/**
 * Feed a 0x30 report with identical values in all three IMU frames.
 * Values are raw sensor units (4096 = 1 g).
 */
function feedImu(jc: JoyCon, ax: number, ay: number, az: number) {
  const body = new Uint8Array(48);
  body[1] = 0x80;
  const view = new DataView(body.buffer);
  for (let frame = 0; frame < 3; frame++) {
    const offset = 12 + frame * 12;
    view.setInt16(offset, ax, true);
    view.setInt16(offset + 2, ay, true);
    view.setInt16(offset + 4, az, true);
  }
  (jc as any).handleInputReport({ reportId: 0x30, data: view });
}

function replyBody(subcommand: number, payload: number[] = []) {
  const body = new Uint8Array(14 + payload.length);
  body[12] = payload.length ? 0x90 : 0x80;
  body[13] = subcommand;
  body.set(payload, 14);
  return new DataView(body.buffer);
}

function reportBytes(bytes: number[], length = 48) {
  const body = new Uint8Array(length);
  body.set(bytes);
  return new DataView(body.buffer);
}

/** Pack 12-bit values into the little-endian nibble pairs used by the SPI block. */
function pack12(values: number[]) {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 2) {
    const a = values[i]!;
    const b = values[i + 1]!;
    out.push(a & 0xff, ((a >> 8) & 0x0f) | ((b & 0x0f) << 4), (b >> 4) & 0xff);
  }
  return out;
}

describe("controller detection", () => {
  test("accepts only the supported Nintendo product ids", () => {
    const device = (productId: number) => ({ vendorId: 0x057e, productId } as HIDDevice);
    expect(JoyCon.isSupported(device(0x2006))).toBe(true);
    expect(JoyCon.isSupported(device(0x2007))).toBe(true);
    expect(JoyCon.isSupported(device(0x2009))).toBe(true);
    expect(JoyCon.isSupported(device(0x2017))).toBe(false);
    expect(JoyCon.isSupported({ vendorId: 0x1234, productId: 0x2007 } as HIDDevice)).toBe(false);
  });

  test("maps product ids to Joy-Con sides", () => {
    expect(JoyCon.detectSide({ productId: 0x2006 } as HIDDevice)).toBe("left");
    expect(JoyCon.detectSide({ productId: 0x2007 } as HIDDevice)).toBe("right");
    expect(JoyCon.detectSide({ productId: 0x2009 } as HIDDevice)).toBe("pro");
  });
});

describe("standard input report parsing", () => {
  test("decodes battery, buttons, sticks, and the last IMU frame", () => {
    // Pro Controller shares the left Joy-Con's IMU axis convention.
    const jc = fakeJoyCon(0x2009);
    const body = new Uint8Array(48);
    body[1] = 0x80; // full battery, not charging
    body[2] = 0x01 | 0x08; // Y + A
    body[3] = 0x01 | 0x10; // Minus + Home
    body[4] = 0x02 | 0x40; // Up + L
    // Both sticks at their 2048 centre.
    body[5] = 0x00;
    body[6] = 0x08; // left X high nibble = 8, left Y low nibble = 0
    body[7] = 0x80;
    body[8] = 0x00;
    body[9] = 0x08;
    body[10] = 0x80;
    // Third IMU frame starts at byte 36: accel Z is at 40 (int16 LE), 4096 = 1 g.
    body[41] = 0x10;

    (jc as any).handleInputReport({ reportId: 0x30, data: new DataView(body.buffer) });

    expect(jc.state.battery).toEqual({ level: 4, charging: false });
    expect(jc.state.buttons.y).toBe(true);
    expect(jc.state.buttons.a).toBe(true);
    expect(jc.state.buttons.minus).toBe(true);
    expect(jc.state.buttons.home).toBe(true);
    expect(jc.state.buttons.up).toBe(true);
    expect(jc.state.buttons.l).toBe(true);
    expect(jc.state.buttons.b).toBe(false);
    expect(jc.state.leftStick.x).toBeCloseTo(0, 10);
    expect(jc.state.leftStick.y).toBeCloseTo(0, 10);
    expect(jc.state.imu.accel.z).toBeCloseTo(1, 10);
    expect(jc.state.packetCounter).toBe(1);
  });

  test("normalizes the reverse-mounted right Joy-Con IMU axes", () => {
    const jc = fakeJoyCon(JOYCON_R_PID);
    const body = new Uint8Array(48);
    body[1] = 0x80;
    const view = new DataView(body.buffer);

    // Third IMU frame starts at byte 36.
    view.setInt16(36, 4096, true); // accel X = 1 g
    view.setInt16(38, 2048, true); // accel Y = 0.5 g
    view.setInt16(40, 1024, true); // accel Z = 0.25 g
    view.setInt16(42, 100, true);
    view.setInt16(44, 200, true);
    view.setInt16(46, 300, true);

    (jc as any).handleInputReport({ reportId: 0x30, data: view });

    expect(jc.state.imu.accel).toEqual({ x: 1, y: -0.5, z: -0.25 });
    expect(jc.state.imu.gyro.x).toBeCloseTo(6.103, 10);
    expect(jc.state.imu.gyro.y).toBeCloseTo(-12.206, 10);
    expect(jc.state.imu.gyro.z).toBeCloseTo(-18.309, 10);
  });

  test("0x21 subcommand replies never overwrite IMU data", () => {
    const jc = fakeJoyCon();
    const body = new Uint8Array(48).fill(0xff, 12);
    body[1] = 0x80;

    (jc as any).handleInputReport({ reportId: 0x21, data: new DataView(body.buffer) });

    expect(jc.state.imu).toEqual({
      accel: { x: 0, y: 0, z: 0 },
      gyro: { x: 0, y: 0, z: 0 },
    });
  });

  test("charging is read from the battery nibble LSB", () => {
    const jc = fakeJoyCon();
    const body = new Uint8Array(48);
    body[1] = 0x10; // empty + charging
    (jc as any).handleInputReport({ reportId: 0x21, data: new DataView(body.buffer) });

    expect(jc.state.battery).toEqual({ level: 0, charging: true });
  });
});

describe("IMU orientation", () => {
  test("right and left Joy-Cons agree on the same physical pose", () => {
    const left = new JoyCon({ productId: 0x2006 } as HIDDevice);
    const right = new JoyCon({ productId: 0x2007 } as HIDDevice);

    // Canonical accel = (0.5, 0.5, 0.707) g. The right Joy-Con reports Y and Z inverted.
    for (let i = 0; i < 100; i++) {
      feedImu(left, 2048, 2048, 2896);
      feedImu(right, 2048, -2048, -2896);
    }

    const l = left.state.orientation;
    const r = right.state.orientation;
    expect(Math.abs(l.w - 1)).toBeGreaterThan(0.01);
    expect(r.w).toBeCloseTo(l.w, 8);
    expect(r.x).toBeCloseTo(l.x, 8);
    expect(r.y).toBeCloseTo(l.y, 8);
    expect(r.z).toBeCloseTo(l.z, 8);
  });
});

describe("stick calibration", () => {
  test("parses both factory calibration blocks", () => {
    const left = [0x123, 0x234, 0x456, 0x567, 0x321, 0x432];
    const right = [0x654, 0x765, 0x222, 0x333, 0x444, 0x555];
    const data = new Uint8Array(pack12([...left, ...right]));

    expect(parseStickCalibration(data)).toEqual({
      left: { xMax: 0x123, yMax: 0x234, cx: 0x456, cy: 0x567, xMin: 0x321, yMin: 0x432 },
      right: { cx: 0x654, cy: 0x765, xMin: 0x222, yMin: 0x333, xMax: 0x444, yMax: 0x555 },
    });
  });

  test("rejects an incomplete block", () => {
    expect(parseStickCalibration(new Uint8Array(17))).toBeNull();
  });
});

describe("stick normalization", () => {
  test("centres, scales, deadzones, and clamps 12-bit readings", () => {
    expect(normalizeStick(2048, 2048, DEFAULT_CALIBRATION)).toEqual({
      x: 0,
      y: 0,
      raw: { x: 2048, y: 2048 },
    });
    expect(normalizeStick(2748, 2048, DEFAULT_CALIBRATION).x).toBe(1);
    expect(normalizeStick(1348, 2048, DEFAULT_CALIBRATION).x).toBe(-1);
    expect(normalizeStick(2748, 2048, DEFAULT_CALIBRATION).y).toBe(0);
    expect(normalizeStick(2098, 2048, DEFAULT_CALIBRATION).x).toBe(0);
    expect(normalizeStick(9999, 2048, DEFAULT_CALIBRATION).x).toBe(1);
  });
});

describe("HOME light payload", () => {
  test("keeps the LED steady at the requested intensity", () => {
    expect([...buildHomeLightPayload(0)]).toEqual([0x01, 0x00, 0x00, 0x00]);
    expect([...buildHomeLightPayload(15)]).toEqual([0x01, 0xf0, 0xf0, 0x00]);
    expect([...buildHomeLightPayload(7.6)]).toEqual([0x01, 0x80, 0x80, 0x00]);
  });

  test("clamps values outside 0..15", () => {
    expect([...buildHomeLightPayload(-3)]).toEqual([0x01, 0x00, 0x00, 0x00]);
    expect([...buildHomeLightPayload(99)]).toEqual([0x01, 0xf0, 0xf0, 0x00]);
  });
});

describe("subcommand queue", () => {
  test("serializes requests and matches replies by subcommand id", async () => {
    const sent: { reportId: number; data: Uint8Array }[] = [];
    const jc = new JoyCon(
      fakeHidDevice((reportId, data) => sent.push({ reportId, data: new Uint8Array(data) })),
    );

    const first = jc.sendSubcommand(0x30, Uint8Array.of(0x01));
    const second = jc.sendSubcommand(0x30, Uint8Array.of(0x02));

    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.reportId).toBe(0x01);
    expect(sent[0]!.data[9]).toBe(0x30);

    (jc as any).handleSubcommandReply(replyBody(0x30, [0x11]));
    expect((await first)?.getUint8(0)).toBe(0x11);

    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.data[10]).toBe(0x02);

    (jc as any).handleSubcommandReply(replyBody(0x30, [0x22]));
    expect((await second)?.getUint8(0)).toBe(0x22);
  });

  test("ignores a reply for a different subcommand", async () => {
    const jc = new JoyCon(fakeHidDevice());
    const pending = jc.sendSubcommand(0x30, Uint8Array.of(0x01));
    await Promise.resolve();
    await Promise.resolve();

    (jc as any).handleSubcommandReply(replyBody(0x40, [0xff]));
    expect((jc as any).pendingSubcommand?.subcommand).toBe(0x30);

    (jc as any).handleSubcommandReply(replyBody(0x30, [0x01]));
    expect((await pending)?.getUint8(0)).toBe(0x01);
  });
});

describe("subcommand reply parsing", () => {
  test("extracts reply data after the ACK byte and subcommand ID", () => {
    const body = new Uint8Array(19);
    body[12] = 0x90; // ACK with data
    body[13] = 0x10; // SPI read
    body.set([0x3d, 0x60, 0x00, 0x00, 18], 14);

    const reply = parseSubcommandReply(new DataView(body.buffer));
    expect(reply?.subcommand).toBe(0x10);
    expect([...new Uint8Array(reply!.data.buffer, reply!.data.byteOffset, reply!.data.byteLength)]).toEqual([
      0x3d, 0x60, 0x00, 0x00, 18,
    ]);
  });

  test("supports empty payloads and rejects truncated reports", () => {
    expect(parseSubcommandReply(new DataView(new ArrayBuffer(13)))).toBeNull();

    const body = new Uint8Array(14);
    body[13] = 0x03;
    const reply = parseSubcommandReply(new DataView(body.buffer));
    expect(reply?.subcommand).toBe(0x03);
    expect(reply?.data.byteLength).toBe(0);
  });
});
