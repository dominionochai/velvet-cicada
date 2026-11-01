"use client";

import { keyHeaders, loadSettings } from "@/lib/keys";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { useGaze } from "@/lib/gazeContext";
import { useGazeSelect } from "@/hooks/useGazeSelect";
import { presetProfile, type MotorProfile } from "@/lib/motor/profile";
import { DEFAULT_FACE, faceFromLandmarks, type FaceGeometry } from "@/lib/tryon/face";
import { detectFace, loadDemoPhoto } from "@/lib/tryon/demoFace";
import { CATALOG, findGroup, findOption, parseSlot, slotKey } from "@/lib/tryon/catalog";
import { INTENSITY_STEP, initialLookState, lookReducer } from "@/lib/tryon/lookHistory";
import { MockRenderer } from "@/lib/tryon/mockRenderer";
import { RemoteRenderer, type TryOnRenderer } from "@/lib/tryon/renderer";
import type { CategoryId } from "@/lib/tryon/types";

const RENDER_DEBOUNCE_MS = 500;

interface TryOnStudioProps {
  profile: MotorProfile;
  onProfileChange: (profile: MotorProfile) => void;
  onReprofile: () => void;
  /** The X-ray view is open on top: pause selection here so only its buttons respond. */
  xrayOpen?: boolean;
  onOpenXray: () => void;
}

type CompareLock = "A" | "B" | null;

function createRenderer(): TryOnRenderer {
  const settings = loadSettings();
  const envMode = process.env.NEXT_PUBLIC_TRYON_RENDERER === "youcam";
  return settings.mode === "youcam" || envMode ? new RemoteRenderer(keyHeaders(settings.keys)) : new MockRenderer();
}

export function TryOnStudio({ profile, onProfileChange, onReprofile, xrayOpen = false, onOpenXray }: TryOnStudioProps) {
  const { stream, overlayRef } = useGaze();
  const rootRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<TryOnRenderer | null>(null);
  /** The face frame every render in this styling session is based on, so results stay consistent. */
  const originalRef = useRef<string | null>(null);
  /** Where the face was in that frame. */
  const faceRef = useRef<FaceGeometry>(DEFAULT_FACE);

  const [look, dispatch] = useReducer(lookReducer, initialLookState);
  const [categoryId, setCategoryId] = useState<CategoryId>("hair");
  const [groupId, setGroupId] = useState("color");
  const [activeSlot, setActiveSlot] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [lock, setLock] = useState<CompareLock>(null);
  const [touchLocked, setTouchLocked] = useState(true);
  const [rendered, setRendered] = useState<{ url: string; source: string; local: number } | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Demo photo shown in place of the camera when there is none. */
  const [idleImage, setIdleImage] = useState<string | null>(null);

  const category = CATALOG.find((c) => c.id === categoryId) ?? CATALOG[0];
  const group = findGroup(category.id, groupId) ?? category.groups[0];
  const scale = profile.targetScale;

  // The right rail stops above the bottom sheet, whatever height the sheet ends up with.
  useEffect(() => {
    const sheet = sheetRef.current;
    const root = rootRef.current;
    if (!sheet || !root) return;
    const update = () => root.style.setProperty("--sheet-h", `${sheet.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, []);

  // With no camera, show the demo photo (if present) instead of a black stage.
  useEffect(() => {
    if (stream) return;
    let cancelled = false;
    void loadDemoPhoto().then((url) => {
      if (!cancelled) setIdleImage(url);
    });
    return () => {
      cancelled = true;
    };
  }, [stream]);

  // ── Camera preview ────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (video && stream) {
      video.srcObject = stream;
      void video.play().catch(() => undefined);
    }
  }, [stream, compare]);

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.9);
  }, []);

  // A fixed placeholder lets the studio run for layout and demo purposes with no camera.
  const placeholderFrame = useCallback((): string => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, 480);
      g.addColorStop(0, "#2A2A2E");
      g.addColorStop(1, "#101012");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 640, 480);
    }
    return canvas.toDataURL("image/jpeg", 0.9);
  }, []);

  /** Fixes the frame and face position that every render in this styling session is based on. */
  const lockOriginal = useCallback(async (): Promise<string> => {
    if (originalRef.current) return originalRef.current;
    const real = captureFrame();
    if (real) {
      originalRef.current = real;
      faceRef.current = faceFromLandmarks(overlayRef.current.landmarks) ?? DEFAULT_FACE;
      return real;
    }
    // No camera: use the demo photo if there is one, and find the face in it.
    const demo = await loadDemoPhoto();
    if (demo) {
      originalRef.current = demo;
      faceRef.current = (await detectFace(demo)) ?? DEFAULT_FACE;
      return demo;
    }
    originalRef.current = placeholderFrame();
    faceRef.current = DEFAULT_FACE;
    return originalRef.current;
  }, [captureFrame, placeholderFrame, overlayRef]);

  // ── Rendering: debounce look changes, drop stale responses ────────────────
  useEffect(() => {
    if (Object.keys(look.present).length === 0) {
      originalRef.current = null;
      setOriginal(null);
      setRendered(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      rendererRef.current ??= createRenderer();
      setRendering(true);
      setError(null);
      try {
        const frame = await lockOriginal();
        setOriginal(frame);
        const result = await rendererRef.current.render({ frame, face: faceRef.current, look: look.present }, controller.signal);
        if (!controller.signal.aborted) setRendered({ url: result.imageUrl, source: result.source, local: result.localSlots?.length ?? 0 });
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Rendering failed.");
      } finally {
        if (!controller.signal.aborted) setRendering(false);
      }
    }, RENDER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [look.present, lockOriginal]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const selectCategory = (id: CategoryId) => {
    const next = CATALOG.find((c) => c.id === id);
    if (!next) return;
    setCategoryId(id);
    setGroupId(next.groups[0].id);
  };

  const selectOption = (optionId: string) => {
    const slot = slotKey(category.id, group.id);
    dispatch({ type: "select", slot, optionId });
    setActiveSlot(slot);
  };

  const adjust = (delta: number) => {
    if (activeSlot) dispatch({ type: "adjust", slot: activeSlot, delta });
  };

  const toggleCompare = () => {
    setCompare((on) => !on);
    setLock(null);
    void lockOriginal().then(setOriginal);
  };

  const handleAction = (id: string) => {
    if (id.startsWith("cat:")) selectCategory(id.slice(4) as CategoryId);
    else if (id.startsWith("grp:")) setGroupId(id.slice(4));
    else if (id.startsWith("opt:")) selectOption(id.slice(4));
    else if (id === "intensity-up") adjust(INTENSITY_STEP);
    else if (id === "intensity-down") adjust(-INTENSITY_STEP);
    else if (id === "compare") toggleCompare();
    else if (id === "undo") dispatch({ type: "undo" });
    else if (id === "reprofile") onReprofile();
    else if (id === "xray") onOpenXray();
    else if (id === "lock-A") setLock("A");
    else if (id === "lock-B") setLock("B");
  };

  // Presenter shortcuts: 1/2/3 switch to a preset motor profile, T toggles the touch lock.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const screen = { width: window.innerWidth, height: window.innerHeight };
      if (event.key === "1") onProfileChange(presetProfile("steady", screen));
      else if (event.key === "2") onProfileChange(presetProfile("moderate", screen));
      else if (event.key === "3") onProfileChange(presetProfile("high", screen));
      else if (event.key.toLowerCase() === "t") setTouchLocked((locked) => !locked);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onProfileChange]);

  const { focusedId, progress } = useGazeSelect({
    rootRef,
    dwellMs: profile.dwellMs,
    blinkSelect: profile.blinkSelect,
    enabled: !xrayOpen,
  });

  // ── Derived display values ────────────────────────────────────────────────
  const active = activeSlot ? look.present[activeSlot] : undefined;
  const activeInfo = useMemo(() => {
    if (!activeSlot || !active) return null;
    const { categoryId: c, groupId: g } = parseSlot(activeSlot);
    return { group: findGroup(c, g), option: findOption(c, g, active.optionId) };
  }, [activeSlot, active]);
  const canAdjust = Boolean(activeInfo?.group?.adjustable);

  const zone = profile.safeZone;
  // A small reach zone (high-tremor / ultra-limited range) cannot fit the full layout, so drop the extras and keep the controls.
  const compact = zone.bottom - zone.top < 620 || zone.right - zone.left < 900;
  const rootStyle = {
    left: zone.left,
    top: zone.top,
    width: zone.right - zone.left,
    height: zone.bottom - zone.top,
    "--scale": scale,
  } as CSSProperties;

  const gazeButton = (id: string, label: string, opts: { pressed?: boolean; disabled?: boolean; swatch?: string; kind?: "opt" | "tab" | "pill" | "fab" } = {}) => (
    <button
      key={id}
      type="button"
      className={`ms-tile ms-${opts.kind ?? "fab"}`}
      data-gaze-action={id}
      data-focused={focusedId === id ? "true" : undefined}
      aria-pressed={opts.pressed}
      disabled={opts.disabled}
      onClick={() => handleAction(id)}
      style={{ "--p": focusedId === id ? progress : 0 } as CSSProperties}
    >
      {opts.swatch && <span className="ms-swatch" aria-hidden="true" style={{ "--c": opts.swatch } as CSSProperties} />}
      <span>{label}</span>
    </button>
  );

  const stageImage = rendered?.url ?? (stream ? null : idleImage);
  const hasLook = Object.keys(look.present).length > 0;
  const localCount = rendered?.local ?? 0;

  return (
    <div
      ref={rootRef}
      className="ms-root"
      data-compact={compact ? "true" : undefined}
      style={rootStyle}
      // Real pointer clicks are swallowed while the touch lock is on; gaze selection calls element.click(), which is untrusted.
      onClickCapture={(event: { nativeEvent: Event; stopPropagation: () => void; preventDefault: () => void }) => {
        if (touchLocked && event.nativeEvent.isTrusted) {
          event.stopPropagation();
          event.preventDefault();
        }
      }}
    >
      <div className="ms-stage">
        {/* Always mounted so frames can be captured whatever is on screen. */}
        <video ref={videoRef} autoPlay muted playsInline style={{ visibility: stageImage || compare ? "hidden" : "visible" }} />
        {compare ? (
          (["A", "B"] as const).map((side) => {
            const id = `lock-${side}`;
            const locked = lock === side;
            return (
              <button
                key={side}
                type="button"
                className="ms-pane"
                data-gaze-action={id}
                data-focused={focusedId === id ? "true" : undefined}
                onClick={() => handleAction(id)}
                style={{ flex: lock === null ? 1 : locked ? 3 : 1 }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={(side === "A" ? original : stageImage ?? original) ?? undefined} alt={side === "A" ? "Original" : "Full styling"} />
                <span className="ms-label">{side === "A" ? "Original" : "Full styling"}{locked ? " · locked" : ""}</span>
              </button>
            );
          })
        ) : (
          <>
            {stageImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={stageImage} alt="Try-on result" />
            )}
            {rendered?.source === "mock" && <span className="ms-label" data-tone="warn">Mock preview · not a real try-on</span>}
            {rendered?.source === "youcam" && <span className="ms-label">YouCam{localCount > 0 ? ` + ${localCount} local` : ""}</span>}
            {rendering && <span className="ms-label ms-label--right">Rendering…</span>}
            {!hasLook && <span className="ms-hint">Look at an option and hold to apply it</span>}
            {error && <span className="ms-error" role="alert">{error}</span>}
          </>
        )}
      </div>

      <header className="ms-topbar">
        <div className="ms-brand">
          <span className="ms-logo" aria-hidden="true">✦</span>
          <span>
            Mirror of Sovereignty
            <small>Hands-free try-on · gaze + dwell{profile.blinkSelect ? " + blink" : ""}</small>
          </span>
        </div>
        <div className="ms-chips">
          <span className="ms-chip" data-tone={touchLocked ? "alert" : undefined}>{touchLocked ? "Touch disabled" : "Touch enabled"}</span>
          <span className="ms-chip">Dwell {profile.dwellMs}ms</span>
          <span className="ms-chip">Tolerance {profile.tolerance}</span>
          <span className="ms-chip" data-tone={profile.blinkSelect ? "ok" : undefined}>Blink {profile.blinkSelect ? "on" : "off"}</span>
        </div>
      </header>

      <aside className="ms-rail" aria-label="Adjust and actions">
        {gazeButton("intensity-up", "+", { disabled: !canAdjust, kind: "fab" })}
        <div className="ms-meter" aria-live="polite">
          <span className="ms-meter-value">{canAdjust && active ? `${active.intensity}%` : "—"}</span>
          <div className="ms-meter-bar"><div style={{ height: `${canAdjust && active ? active.intensity : 0}%` }} /></div>
        </div>
        {gazeButton("intensity-down", "−", { disabled: !canAdjust, kind: "fab" })}
        {gazeButton("compare", compare ? "Exit" : "Compare", { pressed: compare, kind: "fab" })}
        {gazeButton("undo", "Undo", { disabled: look.past.length === 0, kind: "fab" })}
        {gazeButton("reprofile", "Profile", { kind: "fab" })}
        {gazeButton("xray", "X-ray", { kind: "fab" })}
      </aside>

      <section className="ms-sheet" ref={sheetRef}>
        <p className="ms-sheet-title">
          {category.label} · {group.label}
        </p>
        <div className="ms-options-row" style={{ gridTemplateColumns: `repeat(${Math.max(group.options.length, 1)}, minmax(0, 1fr))` }} aria-label="Options">
          {group.options.map((o) => {
            const applied = look.present[slotKey(category.id, group.id)]?.optionId === o.id;
            return gazeButton(`opt:${o.id}`, o.label, { pressed: applied, swatch: o.color, kind: "opt" });
          })}
        </div>
        {category.groups.length > 1 && (
          <div className="ms-groups" style={{ gridTemplateColumns: `repeat(${category.groups.length}, minmax(0, 1fr))` }} aria-label="Groups">
            {category.groups.map((g) => gazeButton(`grp:${g.id}`, g.label, { pressed: g.id === group.id, kind: "pill" }))}
          </div>
        )}
        <nav className="ms-tabs" aria-label="Categories">
          {CATALOG.map((c) => gazeButton(`cat:${c.id}`, c.label, { pressed: c.id === category.id, kind: "tab" }))}
        </nav>
      </section>
    </div>
  );
}
