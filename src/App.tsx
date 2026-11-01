import React, { useCallback, useEffect, useRef, useState } from "react";
import { JoyCon, type JoyConSide, type JoyConState } from "./joycon";
import { SceneController } from "./scene";
import { imuToEuler } from "./orientation";

interface ConnectedController {
  id: number;
  joycon: JoyCon;
  state: JoyConState;
  playerLights: number;
  homeIntensity: number;
  unsubscribe: () => void;
}

const BATTERY_LABEL = ["Empty", "Critical", "Low", "Medium", "Full"];

function snapshotState(state: JoyConState): JoyConState {
  return {
    ...state,
    buttons: { ...state.buttons },
    leftStick: { ...state.leftStick, raw: { ...state.leftStick.raw } },
    rightStick: { ...state.rightStick, raw: { ...state.rightStick.raw } },
    imu: { ...state.imu, accel: { ...state.imu.accel }, gyro: { ...state.imu.gyro } },
    orientation: { ...state.orientation },
    battery: { ...state.battery },
  };
}

export default function App() {
  const [controllers, setControllers] = useState<ConnectedController[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [webhidSupported, setWebhidSupported] = useState(true);
  const sceneRef = useRef<SceneController | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const controllersRef = useRef<ConnectedController[]>([]);
  const attachedDevicesRef = useRef(new Set<HIDDevice>());
  const nextControllerIdRef = useRef(1);

  // Mount scene
  useEffect(() => {
    if (!sceneContainerRef.current) return;
    const scene = new SceneController(sceneContainerRef.current);
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!("hid" in navigator)) {
      setWebhidSupported(false);
    }
  }, []);

  // Rebuild the 3D scene only when the controller layout changes. Doing this
  // on every state update would recreate the models at report rate.
  const controllerSides = controllers.map((c) => c.joycon.side).join(",");
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setControllers(controllers.map((c) => c.joycon.side));
    controllers.forEach((c, i) => {
      scene.updateState(i, c.state);
      scene.setPlayerLights(i, c.playerLights);
      scene.setHomeLight(i, c.homeIntensity);
    });
  }, [controllerSides]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    controllers.forEach((c, i) => {
      scene.updateState(i, c.state);
      scene.setPlayerLights(i, c.playerLights);
      scene.setHomeLight(i, c.homeIntensity);
    });
  }, [controllers]);

  const updateControllers = useCallback(
    (update: (prev: ConnectedController[]) => ConnectedController[]) => {
      setControllers((prev) => {
        const next = update(prev);
        controllersRef.current = next;
        return next;
      });
    },
    [],
  );

  const attachController = useCallback(async (jc: JoyCon, options: { silent?: boolean } = {}) => {
    if (attachedDevicesRef.current.has(jc.device)) return;
    attachedDevicesRef.current.add(jc.device);

    try {
      await jc.open();
      const unsubscribe = jc.onState((state) => {
        updateControllers((prev) =>
          prev.map((c) => (c.joycon === jc ? { ...c, state: snapshotState(state) } : c)),
        );
      });
      const id = nextControllerIdRef.current++;
      updateControllers((prev) => [
        ...prev,
        {
          id,
          joycon: jc,
          state: snapshotState(jc.state),
          playerLights: 0b0001,
          homeIntensity: 0,
          unsubscribe,
        },
      ]);
    } catch (e) {
      attachedDevicesRef.current.delete(jc.device);
      await jc.close().catch(() => {});
      if (!options.silent) setError(e instanceof Error ? e.message : String(e));
    }
  }, [updateControllers]);

  const detachController = useCallback(async (controller: ConnectedController) => {
    controller.unsubscribe();
    attachedDevicesRef.current.delete(controller.joycon.device);
    updateControllers((prev) => prev.filter((c) => c.id !== controller.id));
    try {
      await controller.joycon.close();
    } catch {}
  }, [updateControllers]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      const found = await JoyCon.request();
      for (const jc of found) await attachController(jc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [attachController]);

  // Auto-reconnect previously paired devices
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("hid" in navigator)) return;
      const paired = await JoyCon.getPaired();
      for (const jc of paired) {
        if (cancelled) return;
        await attachController(jc, { silent: true });
      }
    })();
    const onConnect = (e: HIDConnectionEvent) => {
      if (!JoyCon.isSupported(e.device)) return;
      const jc = new JoyCon(e.device);
      void attachController(jc);
    };
    const onDisconnect = (e: HIDConnectionEvent) => {
      const target = controllersRef.current.find((c) => c.joycon.device === e.device);
      if (target) {
        target.unsubscribe();
        void target.joycon.close();
      }
      attachedDevicesRef.current.delete(e.device);
      updateControllers((prev) => prev.filter((c) => c.joycon.device !== e.device));
    };
    navigator.hid?.addEventListener("connect", onConnect);
    navigator.hid?.addEventListener("disconnect", onDisconnect);
    return () => {
      cancelled = true;
      navigator.hid?.removeEventListener("connect", onConnect);
      navigator.hid?.removeEventListener("disconnect", onDisconnect);
    };
  }, [attachController, updateControllers]);

  // Close any open devices when the app unmounts.
  useEffect(() => {
    return () => {
      for (const c of controllersRef.current) {
        c.unsubscribe();
        void c.joycon.close();
      }
      controllersRef.current = [];
      attachedDevicesRef.current.clear();
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◐</span>
          <div>
            <h1>Joy-Con WebHID</h1>
            <p>Connect a Joy-Con over Bluetooth and inspect every input / output.</p>
          </div>
        </div>
        <div className="actions">
          <button className="primary" onClick={handleConnect} disabled={!webhidSupported}>
            {controllers.length ? "Pair another Joy-Con" : "Connect Joy-Con"}
          </button>
        </div>
      </header>

      {!webhidSupported && (
        <div className="banner error">
          WebHID is not available in this browser. Use Chrome, Edge, or Opera on desktop.
        </div>
      )}
      {error && <div className="banner error">{error}</div>}

      <div className="layout">
        <div className="viewport">
          <div ref={sceneContainerRef} className="three-host" />
          {!controllers.length && (
            <div className="empty-state">
              <h2>No Joy-Con connected</h2>
              <ol>
                <li>Pair the Joy-Con in your OS Bluetooth settings (hold the sync button).</li>
                <li>Click <strong>Connect Joy-Con</strong> and pick it from the chooser.</li>
                <li>The 3D model mirrors IMU, buttons and stick in real time.</li>
              </ol>
            </div>
          )}
        </div>

        <aside className="sidebar">
          {controllers.map((c) => (
            <ControllerPanel
              key={c.id}
              controller={c}
              playerLights={c.playerLights}
              homeIntensity={c.homeIntensity}
              onPlayerLights={(mask) =>
                updateControllers((prev) =>
                  prev.map((item) => (item.id === c.id ? { ...item, playerLights: mask } : item)),
                )
              }
              onHomeIntensity={(v) =>
                updateControllers((prev) =>
                  prev.map((item) =>
                    item.id === c.id ? { ...item, homeIntensity: v } : item,
                  ),
                )
              }
              onDisconnect={() => detachController(c)}
            />
          ))}
        </aside>
      </div>
    </div>
  );
}

interface PanelProps {
  controller: ConnectedController;
  playerLights: number;
  homeIntensity: number;
  onPlayerLights: (mask: number) => void;
  onHomeIntensity: (v: number) => void;
  onDisconnect: () => void;
}

function ControllerPanel({
  controller,
  playerLights,
  homeIntensity,
  onPlayerLights,
  onHomeIntensity,
  onDisconnect,
}: PanelProps) {
  const { joycon, state } = controller;
  const sideLabel = sideTitle(joycon.side);

  const setMask = async (mask: number) => {
    onPlayerLights(mask);
    try { await joycon.setPlayerLights(mask); } catch {}
  };

  const setHome = async (v: number) => {
    onHomeIntensity(v);
    try { await joycon.setHomeLight(Math.round(v * 15)); } catch {}
  };

  const handleRumble = async () => {
    try {
      await joycon.rumble(160, 0.7, 320, 0.7);
      setTimeout(() => joycon.rumbleStop().catch(() => {}), 400);
    } catch {}
  };

  const resetOrientation = () => joycon.resetOrientation();

  return (
    <section className={`panel side-${joycon.side}`}>
      <header>
        <div>
          <h2>{sideLabel}</h2>
          <div className="meta">
            <span>VID {joycon.device.vendorId.toString(16).padStart(4, "0")}</span>
            <span>PID {joycon.device.productId.toString(16).padStart(4, "0")}</span>
          </div>
        </div>
        <button className="ghost" onClick={onDisconnect}>Disconnect</button>
      </header>

      <div className="row">
        <Battery state={state} />
        <Packets state={state} />
      </div>

      <Sticks state={state} side={joycon.side} />

      <Buttons state={state} side={joycon.side} />

      <Imu state={state} />

      <div className="block">
        <h3>Player Lights</h3>
        <div className="leds">
          {[0, 1, 2, 3].map((i) => (
            <button
              key={i}
              className={`led ${(playerLights >> i) & 1 ? "on" : ""}`}
              onClick={() => setMask(playerLights ^ (1 << i))}
              aria-label={`LED ${i + 1}`}
            >
              {i + 1}
            </button>
          ))}
          <button className="ghost small" onClick={() => setMask(0)}>Off</button>
          <button className="ghost small" onClick={() => setMask(0b1111)}>All</button>
        </div>
      </div>

      {joycon.side !== "left" && (
        <div className="block">
          <h3>Home Light</h3>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={homeIntensity}
            onChange={(e) => setHome(parseFloat(e.target.value))}
          />
          <span className="value">{Math.round(homeIntensity * 100)}%</span>
        </div>
      )}

      <div className="block">
        <h3>Rumble</h3>
        <button className="ghost" onClick={handleRumble}>Pulse (400 ms)</button>
        <button className="ghost" onClick={() => joycon.rumbleStop().catch(() => {})}>Stop</button>
      </div>

      <div className="block">
        <h3>Orientation</h3>
        <Quaternion state={state} />
        <button className="ghost" onClick={resetOrientation}>Recenter</button>
      </div>
    </section>
  );
}

function sideTitle(s: JoyConSide) {
  if (s === "left") return "Joy-Con (L)";
  if (s === "right") return "Joy-Con (R)";
  return "Pro Controller";
}

function Battery({ state }: { state: JoyConState }) {
  const pct = (state.battery.level / 4) * 100;
  return (
    <div className="card battery">
      <div className="card-label">Battery</div>
      <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
      <div className="card-value">
        {BATTERY_LABEL[state.battery.level]}
        {state.battery.charging && <span className="badge">Charging</span>}
      </div>
    </div>
  );
}

function Packets({ state }: { state: JoyConState }) {
  return (
    <div className="card">
      <div className="card-label">Packets</div>
      <div className="card-value mono">{state.packetCounter}</div>
    </div>
  );
}

function Sticks({ state, side }: { state: JoyConState; side: JoyConSide }) {
  return (
    <div className="block">
      <h3>Stick</h3>
      <div className="sticks">
        {(side === "left" || side === "pro") && (
          <StickView label="Left" stick={state.leftStick} />
        )}
        {(side === "right" || side === "pro") && (
          <StickView label="Right" stick={state.rightStick} />
        )}
      </div>
    </div>
  );
}

function StickView({ label, stick }: { label: string; stick: JoyConState["leftStick"] }) {
  const size = 96;
  const r = size / 2 - 6;
  const cx = size / 2 + stick.x * r;
  const cy = size / 2 - stick.y * r;
  return (
    <div className="stick-card">
      <div className="card-label">{label}</div>
      <svg width={size} height={size} className="stick-svg">
        <circle cx={size / 2} cy={size / 2} r={r} className="ring" />
        <line x1={size / 2} y1={6} x2={size / 2} y2={size - 6} className="cross" />
        <line x1={6} y1={size / 2} x2={size - 6} y2={size / 2} className="cross" />
        <circle cx={cx} cy={cy} r={6} className="dot" />
      </svg>
      <div className="mono small">
        {stick.x.toFixed(2)}, {stick.y.toFixed(2)}
      </div>
    </div>
  );
}

function Buttons({ state, side }: { state: JoyConState; side: JoyConSide }) {
  const groups: { title: string; keys: (keyof JoyConState["buttons"])[] }[] =
    side === "left"
      ? [
          { title: "D-Pad", keys: ["up", "down", "left", "right"] },
          { title: "L / ZL / SL / SR", keys: ["l", "zl", "slL", "srL"] },
          { title: "Stick / System", keys: ["lStick", "minus", "capture"] },
        ]
      : side === "right"
      ? [
          { title: "Face", keys: ["a", "b", "x", "y"] },
          { title: "R / ZR / SL / SR", keys: ["r", "zr", "slR", "srR"] },
          { title: "Stick / System", keys: ["rStick", "plus", "home"] },
        ]
      : [
          { title: "Face", keys: ["a", "b", "x", "y"] },
          { title: "D-Pad", keys: ["up", "down", "left", "right"] },
          { title: "Triggers", keys: ["l", "r", "zl", "zr"] },
          { title: "System", keys: ["minus", "plus", "home", "capture", "lStick", "rStick"] },
        ];

  return (
    <div className="block">
      <h3>Buttons</h3>
      {groups.map((g) => (
        <div key={g.title} className="button-group">
          <div className="group-label">{g.title}</div>
          <div className="button-grid">
            {g.keys.map((k) => (
              <span key={k} className={`chip ${state.buttons[k] ? "active" : ""}`}>
                {labelFor(k)}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function labelFor(k: string) {
  switch (k) {
    case "srL":
    case "srR": return "SR";
    case "slL":
    case "slR": return "SL";
    case "lStick": return "L-Stick";
    case "rStick": return "R-Stick";
    case "minus": return "−";
    case "plus": return "+";
    default: return k.toUpperCase();
  }
}

function Imu({ state }: { state: JoyConState }) {
  const { accel, gyro } = state.imu;
  return (
    <div className="block">
      <h3>IMU</h3>
      <div className="imu-grid">
        <div className="card">
          <div className="card-label">Accel (g)</div>
          <div className="mono small">
            x {accel.x.toFixed(3)}<br />
            y {accel.y.toFixed(3)}<br />
            z {accel.z.toFixed(3)}
          </div>
        </div>
        <div className="card">
          <div className="card-label">Gyro (°/s)</div>
          <div className="mono small">
            x {gyro.x.toFixed(1)}<br />
            y {gyro.y.toFixed(1)}<br />
            z {gyro.z.toFixed(1)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Quaternion({ state }: { state: JoyConState }) {
  const q = state.orientation;
  // The stored quaternion uses the canonical (L/Pro) IMU frame, not model coordinates.
  const { roll, pitch, yaw } = imuToEuler(q);
  const deg = (r: number) => (r * 180) / Math.PI;
  return (
    <div className="mono small">
      <div>q ({q.w.toFixed(3)}, {q.x.toFixed(3)}, {q.y.toFixed(3)}, {q.z.toFixed(3)})</div>
      <div>roll {deg(roll).toFixed(1)}° • pitch {deg(pitch).toFixed(1)}° • yaw {deg(yaw).toFixed(1)}°</div>
    </div>
  );
}
