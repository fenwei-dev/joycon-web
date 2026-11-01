import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { JoyCon, type JoyConSide, type JoyConState } from "./joycon";
import { SceneController, type SceneUnit } from "./scene";
import { imuToEuler } from "./orientation";

interface ConnectedController {
  id: number;
  partnerId: number | null;
  joycon: JoyCon;
  state: JoyConState;
  playerLights: number;
  homeIntensity: number;
  unsubscribe: () => void;
}

interface ControllerUnit {
  id: number;
  kind: "single" | "pair";
  controllers: ConnectedController[];
}

const BATTERY_LABEL = ["Empty", "Critical", "Low", "Medium", "Full"];
const SIDE_RANK: Record<JoyConSide, number> = { left: 0, right: 1, pro: 0 };

function buildUnits(controllers: ConnectedController[], order: number[]): ControllerUnit[] {
  const byId = new Map(controllers.map((controller) => [controller.id, controller]));
  const seen = new Set<number>();
  const units: ControllerUnit[] = [];

  const addUnit = (id: number, primary: ConnectedController) => {
    if (seen.has(primary.id)) return;
    const members = [primary];
    seen.add(primary.id);
    if (primary.partnerId !== null) {
      const partner = byId.get(primary.partnerId);
      if (partner && !seen.has(partner.id)) {
        members.push(partner);
        seen.add(partner.id);
      }
    }
    members.sort((a, b) => SIDE_RANK[a.joycon.side] - SIDE_RANK[b.joycon.side]);
    units.push({ id, kind: members.length === 2 ? "pair" : "single", controllers: members });
  };

  for (const id of order) {
    const primary = byId.get(id);
    if (primary) addUnit(id, primary);
  }

  // Defensive: include controllers that arrived before the order was updated.
  for (const controller of controllers) {
    if (!seen.has(controller.id)) addUnit(controller.id, controller);
  }
  return units;
}

function isLinkablePair(a: JoyConSide, b: JoyConSide) {
  return (a === "left" && b === "right") || (a === "right" && b === "left");
}

function unitLabel(unit: ControllerUnit) {
  if (unit.kind === "pair") return "Linked";
  return sideShort(unit.controllers[0]!.joycon.side);
}

function sideShort(side: JoyConSide) {
  if (side === "left") return "L";
  if (side === "right") return "R";
  return "Pro";
}

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
  const [unitOrder, setUnitOrder] = useState<number[]>([]);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhidSupported, setWebhidSupported] = useState(true);
  const sceneRef = useRef<SceneController | null>(null);
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const controllersRef = useRef<ConnectedController[]>([]);
  const attachedDevicesRef = useRef(new Set<HIDDevice>());
  const nextControllerIdRef = useRef(1);
  const layoutMenuRef = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const units = useMemo(() => buildUnits(controllers, unitOrder), [controllers, unitOrder]);

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
  const sceneUnits = units.map((unit): SceneUnit => {
    if (unit.kind === "pair") {
      const left = unit.controllers.find((c) => c.joycon.side === "left")!;
      const right = unit.controllers.find((c) => c.joycon.side === "right")!;
      return { kind: "pair", id: unit.id, leftId: left.id, rightId: right.id };
    }
    return { kind: "single", id: unit.id, side: unit.controllers[0]!.joycon.side };
  });
  const unitSignature = sceneUnits
    .map((unit) =>
      unit.kind === "pair"
        ? `pair:${unit.id}:${unit.leftId}:${unit.rightId}`
        : `single:${unit.id}:${unit.side}`,
    )
    .join("|");

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setUnits(sceneUnits);
    for (const c of controllers) {
      scene.updateState(c.id, c.state);
      scene.setPlayerLights(c.id, c.playerLights);
      scene.setHomeLight(c.id, c.homeIntensity);
    }
  }, [unitSignature]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const c of controllers) {
      scene.updateState(c.id, c.state);
      scene.setPlayerLights(c.id, c.playerLights);
      scene.setHomeLight(c.id, c.homeIntensity);
    }
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

  const updateUnitOrder = useCallback((update: (prev: number[]) => number[]) => {
    setUnitOrder((prev) => update(prev));
  }, []);

  const reorderUnits = useCallback(
    (activeId: number, overId: number) => {
      updateUnitOrder((prev) => {
        const oldIndex = prev.indexOf(activeId);
        const newIndex = prev.indexOf(overId);
        if (oldIndex < 0 || newIndex < 0) return prev;
        return arrayMove(prev, oldIndex, newIndex);
      });
    },
    [updateUnitOrder],
  );

  const linkControllers = useCallback(
    (activeId: number, targetId: number) => {
      const active = controllersRef.current.find((c) => c.id === activeId);
      const target = controllersRef.current.find((c) => c.id === targetId);
      if (!active || !target) return;
      if (active.partnerId !== null || target.partnerId !== null) return;
      if (!isLinkablePair(active.joycon.side, target.joycon.side)) return;

      updateControllers((prev) =>
        prev.map((c) => {
          if (c.id === activeId) return { ...c, partnerId: targetId };
          if (c.id === targetId) return { ...c, partnerId: activeId };
          return c;
        }),
      );
      updateUnitOrder((prev) => {
        const activeIndex = prev.indexOf(activeId);
        const targetIndex = prev.indexOf(targetId);
        if (activeIndex < 0 || targetIndex < 0) return prev;
        const insertAt = targetIndex - (activeIndex < targetIndex ? 1 : 0);
        const next = prev.filter((id) => id !== activeId && id !== targetId);
        next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, targetId);
        return next;
      });
    },
    [updateControllers, updateUnitOrder],
  );

  const unlinkUnit = useCallback(
    (unit: ControllerUnit) => {
      if (unit.kind !== "pair") return;
      const ids = unit.controllers.map((c) => c.id);
      updateControllers((prev) =>
        prev.map((c) => (ids.includes(c.id) ? { ...c, partnerId: null } : c)),
      );
      updateUnitOrder((prev) => {
        const index = prev.indexOf(unit.id);
        if (index < 0) return prev;
        const next = [...prev];
        next.splice(index, 1, ...ids);
        return next;
      });
    },
    [updateControllers, updateUnitOrder],
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
          partnerId: null,
          joycon: jc,
          state: snapshotState(jc.state),
          playerLights: 0b0001,
          homeIntensity: 0,
          unsubscribe,
        },
      ]);
      updateUnitOrder((prev) => [...prev, id]);
    } catch (e) {
      attachedDevicesRef.current.delete(jc.device);
      await jc.close().catch(() => {});
      if (!options.silent) setError(e instanceof Error ? e.message : String(e));
    }
  }, [updateControllers, updateUnitOrder]);

  const detachController = useCallback(async (controller: ConnectedController) => {
    controller.unsubscribe();
    attachedDevicesRef.current.delete(controller.joycon.device);

    const partnerId = controller.partnerId;
    const partnerExists =
      partnerId !== null && controllersRef.current.some((c) => c.id === partnerId);
    updateControllers((prev) =>
      prev
        .filter((c) => c.id !== controller.id)
        .map((c) => (c.id === partnerId ? { ...c, partnerId: null } : c)),
    );
    updateUnitOrder((prev) => {
      const index = prev.indexOf(controller.id);
      if (index < 0) return prev;
      const next = [...prev];
      if (partnerExists) next.splice(index, 1, partnerId!);
      else next.splice(index, 1);
      return next;
    });

    try {
      await controller.joycon.close();
    } catch {}
  }, [updateControllers, updateUnitOrder]);

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
      if (target) void detachController(target);
      else attachedDevicesRef.current.delete(e.device);
    };
    navigator.hid?.addEventListener("connect", onConnect);
    navigator.hid?.addEventListener("disconnect", onDisconnect);
    return () => {
      cancelled = true;
      navigator.hid?.removeEventListener("connect", onConnect);
      navigator.hid?.removeEventListener("disconnect", onDisconnect);
    };
  }, [attachController, detachController]);

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

  // The arrangement popover only makes sense while something is connected.
  useEffect(() => {
    if (!controllers.length) setLayoutOpen(false);
  }, [controllers.length]);

  useEffect(() => {
    if (!layoutOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (layoutMenuRef.current && !layoutMenuRef.current.contains(event.target as Node)) {
        setLayoutOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLayoutOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [layoutOpen]);

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
          {controllers.length > 0 && (
            <div className="layout-menu-wrap" ref={layoutMenuRef}>
              <button
                className="ghost arrange-button"
                onClick={() => setLayoutOpen((open) => !open)}
                aria-expanded={layoutOpen}
              >
                Arrange <span className="chevron" aria-hidden="true">{layoutOpen ? "▴" : "▾"}</span>
              </button>
              {layoutOpen && (
                <LayoutMenu
                  units={units}
                  sensors={sensors}
                  onReorder={reorderUnits}
                  onLink={linkControllers}
                  onDisconnect={(controller) => void detachController(controller)}
                  onUnlink={unlinkUnit}
                />
              )}
            </div>
          )}
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
          {units.map((unit) => (
            <div
              key={unit.id}
              className={`controller-group${unit.kind === "pair" ? " pair" : ""}`}
            >
              {unit.controllers.map((c) => (
                <ControllerPanel
                  key={c.id}
                  controller={c}
                  playerLights={c.playerLights}
                  homeIntensity={c.homeIntensity}
                  onPlayerLights={(mask) =>
                    updateControllers((prev) =>
                      prev.map((item) =>
                        item.id === c.id ? { ...item, playerLights: mask } : item,
                      ),
                    )
                  }
                  onHomeIntensity={(v) =>
                    updateControllers((prev) =>
                      prev.map((item) =>
                        item.id === c.id ? { ...item, homeIntensity: v } : item,
                      ),
                    )
                  }
                  onDisconnect={() => void detachController(c)}
                />
              ))}
            </div>
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

interface LayoutMenuProps {
  units: ControllerUnit[];
  sensors: ReturnType<typeof useSensors>;
  onReorder: (activeId: number, overId: number) => void;
  onLink: (activeControllerId: number, targetControllerId: number) => void;
  onDisconnect: (controller: ConnectedController) => void;
  onUnlink: (unit: ControllerUnit) => void;
}

function LayoutMenu({ units, sensors, onReorder, onLink, onDisconnect, onUnlink }: LayoutMenuProps) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);
  const activeUnit = activeId === null ? null : units.find((unit) => unit.id === activeId) ?? null;
  const connected = units.reduce((sum, unit) => sum + unit.controllers.length, 0);

  const canMergeInto = (unit: ControllerUnit) => {
    if (!activeUnit || activeUnit.kind !== "single") return false;
    if (unit.kind !== "single" || unit.id === activeUnit.id) return false;
    return isLinkablePair(
      activeUnit.controllers[0]!.joycon.side,
      unit.controllers[0]!.joycon.side,
    );
  };

  // A chip's horizontal middle is a merge target; its left/right edges remain
  // normal sortable areas. The merge zone wins only when the pointer is in it.
  const collisionDetection: CollisionDetection = (args) => {
    if (activeUnit?.kind === "single") {
      const mergeZones = args.droppableContainers.filter((container) => {
        const id = String(container.id);
        if (!id.startsWith("merge:")) return false;
        const unit = units.find((candidate) => candidate.id === Number(id.slice(6)));
        return !!unit && canMergeInto(unit);
      });
      if (mergeZones.length) {
        const hits = pointerWithin({ ...args, droppableContainers: mergeZones });
        if (hits.length) return hits;
      }
    }
    const chips = args.droppableContainers.filter(
      (container) => !String(container.id).startsWith("merge:"),
    );
    return closestCenter({ ...args, droppableContainers: chips });
  };

  const handleDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id;
    setMergeTargetId(
      typeof overId === "string" && overId.startsWith("merge:")
        ? Number(overId.slice(6))
        : null,
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    setMergeTargetId(null);
    const { active, over } = event;
    if (!over) return;

    const activeUnit = units.find((unit) => unit.id === active.id);
    if (!activeUnit) return;

    const overId = over.id;
    if (typeof overId === "string" && overId.startsWith("merge:")) {
      const targetUnit = units.find((unit) => unit.id === Number(overId.slice(6)));
      if (targetUnit && activeUnit.kind === "single" && targetUnit.kind === "single") {
        const activeController = activeUnit.controllers[0]!;
        const targetController = targetUnit.controllers[0]!;
        if (isLinkablePair(activeController.joycon.side, targetController.joycon.side)) {
          onLink(activeController.id, targetController.id);
        }
      }
      return;
    }

    if (active.id === overId) return;
    const overUnit = units.find((unit) => unit.id === overId);
    if (!overUnit) return;
    onReorder(activeUnit.id, overUnit.id);
  };

  return (
    <div className="layout-popover" role="dialog" aria-label="Controller arrangement">
      <div className="layout-popover-head">
        <div>
          <strong>Controller order</strong>
          <p>
            {activeUnit
              ? "Drop on the middle to merge; near the edges to reorder."
              : "Drag to reorder. Drop on a chip's middle to merge L + R."}
          </p>
        </div>
        <span className="layout-count">{connected} connected</span>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[restrictToHorizontalAxis]}
        onDragStart={(event) => {
          setActiveId(Number(event.active.id));
          setMergeTargetId(null);
        }}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          setMergeTargetId(null);
        }}
      >
        <SortableContext
          items={units.map((unit) => unit.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="layout-row">
            {units.map((unit) => (
              <SortableLayoutChip
                key={unit.id}
                unit={unit}
                mergeTarget={mergeTargetId === unit.id}
                hideGhost={activeId === unit.id && mergeTargetId !== null}
                onDisconnect={onDisconnect}
                onUnlink={onUnlink}
              />
            ))}
          </div>
        </SortableContext>
        {createPortal(
          <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
            {activeUnit ? (
              <div
                className={`layout-chip-overlay${mergeTargetId !== null ? " hidden" : ""}`}
                inert
                aria-hidden="true"
              >
                <LayoutChipBody
                  unit={activeUnit}
                  overlay
                  onDisconnect={() => {}}
                  onUnlink={() => {}}
                />
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>

      <p className="layout-hint">
        Middle merges L + R · edges reorder · × disconnects · Unlink splits a pair.
      </p>
    </div>
  );
}

function SortableLayoutChip({
  unit,
  mergeTarget,
  hideGhost,
  onDisconnect,
  onUnlink,
}: {
  unit: ControllerUnit;
  mergeTarget: boolean;
  hideGhost: boolean;
  onDisconnect: (controller: ConnectedController) => void;
  onUnlink: (unit: ControllerUnit) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: unit.id });

  return (
    <div
      ref={setNodeRef}
      className={`layout-chip-item${isDragging ? " dragging" : ""}${hideGhost ? " hide-ghost" : ""}`}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 2 : undefined,
      }}
    >
      <LayoutChipBody
        unit={unit}
        mergeTarget={mergeTarget}
        dragRef={setActivatorNodeRef}
        dragAttributes={attributes}
        dragListeners={listeners}
        onDisconnect={onDisconnect}
        onUnlink={onUnlink}
      />
    </div>
  );
}

interface LayoutChipBodyProps {
  unit: ControllerUnit;
  overlay?: boolean;
  mergeTarget?: boolean;
  dragRef?: (node: HTMLElement | null) => void;
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  onDisconnect: (controller: ConnectedController) => void;
  onUnlink: (unit: ControllerUnit) => void;
}

function LayoutChipBody({
  unit,
  overlay = false,
  mergeTarget = false,
  dragRef,
  dragAttributes,
  dragListeners,
  onDisconnect,
  onUnlink,
}: LayoutChipBodyProps) {
  return (
    <div className={`layout-chip${overlay ? " overlay" : ""}${mergeTarget ? " merge-target" : ""}`}>
      <div
        ref={dragRef}
        className={`layout-chip-drag${overlay ? " static" : ""}`}
        {...(dragAttributes ?? {})}
        {...(dragListeners ?? {})}
        aria-label={overlay ? undefined : `Reorder ${unitLabel(unit)} controller`}
      >
        <span className="chip-grip" aria-hidden="true">⠿</span>
        <div className={`chip-pads${unit.kind === "pair" ? " linked" : ""}`}>
          {unit.controllers.map((controller) => (
            <span
              key={controller.id}
              className={`chip-pad side-${controller.joycon.side}`}
              aria-hidden="true"
            />
          ))}
        </div>
        <span className="chip-label">{unitLabel(unit)}</span>
      </div>

      <div className="layout-chip-actions">
        {unit.kind === "pair" && (
          <button
            type="button"
            className="chip-action"
            title="Unlink"
            aria-label="Unlink controllers"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onUnlink(unit)}
          >
            Unlink
          </button>
        )}
        {unit.controllers.map((controller) => (
          <button
            key={controller.id}
            type="button"
            className="chip-action"
            title={`Disconnect ${sideTitle(controller.joycon.side)}`}
            aria-label={`Disconnect ${sideTitle(controller.joycon.side)}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onDisconnect(controller)}
          >
            {unit.kind === "pair" ? `${sideShort(controller.joycon.side)}×` : "×"}
          </button>
        ))}
      </div>

      {!overlay && unit.kind === "single" && (
        <MergeZone unitId={unit.id} active={mergeTarget} />
      )}
    </div>
  );
}

function MergeZone({ unitId, active }: { unitId: number; active: boolean }) {
  const { setNodeRef } = useDroppable({ id: `merge:${unitId}` });

  return (
    <div
      ref={setNodeRef}
      className={`merge-zone${active ? " visible" : ""}`}
      aria-hidden="true"
    >
      {active && (
        <span className="merge-label">
          <span aria-hidden="true">⛓</span> Release to merge
        </span>
      )}
    </div>
  );
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
  const linked = controller.partnerId !== null;

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
            {linked && <span className="badge link-badge">Linked</span>}
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
