"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GazeCursor } from "@/components/GazeCursor";
import { GazeProvider } from "@/components/GazeProvider";
import { MotorProfiler } from "@/components/studio/MotorProfiler";
import { StudioCalibration } from "@/components/studio/StudioCalibration";
import { TryOnStudio } from "@/components/studio/TryOnStudio";
import { XRayView } from "@/components/studio/XRayView";
import { useGaze } from "@/lib/gazeContext";
import type { MotorProfile } from "@/lib/motor/profile";

type Stage = "calibrate" | "profile" | "studio";

const STATUS_TEXT: Record<string, string> = {
  idle: "Starting…",
  "loading-model": "Loading the face-tracking model…",
  "requesting-camera": "Waiting for camera permission…",
  ready: "Ready",
  error: "Something went wrong",
};

function Flow() {
  const { isTracking, isCalibrated, isCalibrating, initStatus, errorMessage, startCalibration, gazePositionRef } = useGaze();
  const [stage, setStage] = useState<Stage>("calibrate");
  const [profile, setProfile] = useState<MotorProfile | null>(null);
  /** No camera: the mouse stands in for gaze and Enter for a blink, so the interface can still be tried. */
  const [demo, setDemo] = useState(false);
  const [xray, setXray] = useState(false);
  const calibrationStarted = useRef(false);

  // Start calibration once, as soon as tracking is live.
  useEffect(() => {
    if (stage === "calibrate" && isTracking && !isCalibrated && !isCalibrating && !calibrationStarted.current) {
      calibrationStarted.current = true;
      startCalibration();
    }
  }, [stage, isTracking, isCalibrated, isCalibrating, startCalibration]);

  useEffect(() => {
    if (stage === "calibrate" && isCalibrated) setStage("profile");
  }, [stage, isCalibrated]);

  useEffect(() => {
    if (stage === "calibrate" && demo) setStage("profile");
  }, [stage, demo]);

  // Demo mode: the pointer drives the gaze position.
  useEffect(() => {
    if (!demo) return;
    const onMove = (event: PointerEvent) => {
      gazePositionRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [demo, gazePositionRef]);

  const completeProfile = useCallback((next: MotorProfile) => {
    setProfile(next);
    setStage("studio");
  }, []);

  // X opens and closes the X-ray view (the view itself also has a gaze Close button).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "x" && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && stage === "studio") {
        setXray((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage]);

  // Keep the studio (and the current styling) mounted underneath while re-profiling.
  const reprofile = useCallback(() => setStage("profile"), []);

  const showLoading = stage === "calibrate" && !isTracking && !demo;

  return (
    <main style={{ position: "relative", height: "100vh", width: "100vw", overflow: "hidden", background: "var(--ms-bg)", color: "var(--ms-text)" }}>
      {showLoading && (
        <div className="ms-loading">
          <h1>Mirror of Sovereignty</h1>
          <p>{STATUS_TEXT[initStatus] ?? initStatus}</p>
          {errorMessage && <p style={{ color: "var(--ms-danger)" }} role="alert">{errorMessage}</p>}
          <button type="button" className="ms-button" onClick={() => setDemo(true)}>
            Continue without a camera (mouse + Enter)
          </button>
        </div>
      )}

      {stage === "calibrate" && !demo && <StudioCalibration />}
      {profile && (
        <TryOnStudio profile={profile} onProfileChange={setProfile} onReprofile={reprofile} xrayOpen={xray} onOpenXray={() => setXray(true)} />
      )}
      {xray && profile && <XRayView onClose={() => setXray(false)} dwellMs={profile.dwellMs} blinkSelect={profile.blinkSelect} />}
      {stage === "profile" && <MotorProfiler onComplete={completeProfile} />}

      <GazeCursor />
    </main>
  );
}

export default function Page() {
  return (
    <GazeProvider autoStart>
      <Flow />
    </GazeProvider>
  );
}
