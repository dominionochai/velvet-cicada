"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useGazeSelect } from "@/hooks/useGazeSelect";
import { useGaze } from "@/lib/gazeContext";
import { estimateHeadPose, POSE_LANDMARKS, type HeadPose } from "@/lib/headPose";
import { loadOpenCv, type OpenCv } from "@/lib/opencvVision";
import { createCropScratch, fitEyePupils, type EyeFit } from "@/lib/pupilTracking";
import { fetchYuNetModel, normalizeYuNetFace, YuNetDetector, type YuNetFace } from "@/lib/yunet";

const DRAW_INTERVAL_MS = 33;
const PUPIL_FIT_INTERVAL_MS = 80;
const POSE_SMOOTHING = 0.25;
/** OpenCV's YuNet face detector runs on a small copy of the frame, about eight times a second. */
const YUNET_INTERVAL_MS = 120;
const YUNET_SEARCH_WIDTH = 192;
const SCAN_PERIOD_MS = 3200;
const FPS_WINDOW = 20;

interface Connection {
  start: number;
  end: number;
}

interface SmoothedPose {
  yaw: number;
  pitch: number;
  roll: number;
}

const smooth = (previous: number | undefined, next: number) =>
  previous === undefined ? next : previous + (next - previous) * POSE_SMOOTHING;

/**
 * Full-screen "what the machine sees" view: the face mesh, eyelids, OpenCV
 * pupil ellipses and head-pose axes (solvePnP), plus the gaze ray to the cursor.
 * Everything is drawn on one canvas so it is captured by a screen recording.
 */
export function XRayView({ onClose, dwellMs = 900, blinkSelect = true }: { onClose: () => void; dwellMs?: number; blinkSelect?: boolean }) {
  const { stream, overlayRef, gazePositionRef, isFaceDetected, blinkCount, calibrationModel } = useGaze();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cvRef = useRef<OpenCv | null>(null);
  const meshRef = useRef<Connection[]>([]);
  const yunetRef = useRef<YuNetDetector | null>(null);
  const blinkCountRef = useRef(blinkCount);
  const faceRef = useRef(isFaceDetected);
  const calibrationRef = useRef(calibrationModel);
  const [cvReady, setCvReady] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { focusedId, progress } = useGazeSelect({ rootRef, dwellMs, blinkSelect });

  useEffect(() => {
    blinkCountRef.current = blinkCount;
    faceRef.current = isFaceDetected;
    calibrationRef.current = calibrationModel;
  });

  // Close with X, matching the shortcut that opens it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key.toLowerCase() === "x" && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !typing) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([import("@mediapipe/tasks-vision"), loadOpenCv()])
      .then(([mediapipe, cv]) => {
        if (cancelled) return;
        meshRef.current = mediapipe.FaceLandmarker.FACE_LANDMARKS_TESSELATION;
        cvRef.current = cv;
        setCvReady(true);
      })
      .catch((error: unknown) => console.warn("X-ray extras unavailable.", error));
    return () => { cancelled = true; };
  }, []);

  // OpenCV's own face detector (YuNet), loaded separately so the rest of the view works without it.
  useEffect(() => {
    let cancelled = false;
    let detector: YuNetDetector | null = null;
    void Promise.all([loadOpenCv(), fetchYuNetModel()])
      .then(([cv, model]) => {
        if (cancelled) return;
        detector = YuNetDetector.create(cv, model);
        yunetRef.current = detector;
      })
      .catch((error: unknown) => console.warn("Face detector unavailable.", error));
    return () => {
      cancelled = true;
      yunetRef.current = null;
      detector?.dispose();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context) return;

    video.srcObject = stream;
    if (stream) void video.play().catch(() => undefined);

    const scratch = createCropScratch();
    let eyeFits: EyeFit[] = [];
    let yunetFace: YuNetFace | null = null;
    let lastYunet = 0;
    const yunetScratch = document.createElement("canvas");
    const yunetContext = yunetScratch.getContext("2d", { willReadFrequently: true });
    let pose: SmoothedPose | null = null;
    let axes: HeadPose["axes"] | null = null;
    let lastDraw = 0;
    let lastFit = 0;
    const frameTimes: number[] = [];
    let animationFrame = 0;

    const draw = (time: number) => {
      animationFrame = requestAnimationFrame(draw);
      if (time - lastDraw < DRAW_INTERVAL_MS) return;
      lastDraw = time;
      frameTimes.push(time);
      if (frameTimes.length > FPS_WINDOW) frameTimes.shift();

      const { videoWidth, videoHeight } = video;
      if (!stream || !videoWidth || !videoHeight) return;
      if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
        canvas.width = videoWidth;
        canvas.height = videoHeight;
      }
      const W = canvas.width;
      const H = canvas.height;
      // Landmarks are normalised to the unmirrored frame; the view is a mirror.
      const X = (nx: number) => (1 - nx) * W;
      const Y = (ny: number) => ny * H;

      context.clearRect(0, 0, W, H);
      context.save();
      context.translate(W, 0);
      context.scale(-1, 1);
      context.drawImage(video, 0, 0, W, H);
      context.restore();
      context.fillStyle = "rgba(2, 8, 14, 0.62)";
      context.fillRect(0, 0, W, H);

      // OpenCV YuNet: a second, independent face detector (box plus eyes, nose, mouth corners).
      const yunet = yunetRef.current;
      if (yunet && yunetContext && time - lastYunet >= YUNET_INTERVAL_MS) {
        lastYunet = time;
        const searchHeight = Math.round((YUNET_SEARCH_WIDTH * H) / W);
        if (yunetScratch.width !== YUNET_SEARCH_WIDTH || yunetScratch.height !== searchHeight) {
          yunetScratch.width = YUNET_SEARCH_WIDTH;
          yunetScratch.height = searchHeight;
        }
        yunetContext.drawImage(video, 0, 0, YUNET_SEARCH_WIDTH, searchHeight);
        try {
          const [best] = yunet.detectCanvas(yunetScratch).sort((a, b) => b.score - a.score);
          yunetFace = best ? normalizeYuNetFace(best, YUNET_SEARCH_WIDTH, searchHeight) : null;
        } catch {
          yunetFace = null;
        }
      }
      if (yunetFace) {
        const { box } = yunetFace;
        const left = X(box.x + box.width);
        context.strokeStyle = "#FF8A3D";
        context.lineWidth = 3;
        context.strokeRect(left, Y(box.y), box.width * W, box.height * H);
        // The label sits inside the box's top-right corner, away from the readout at the top left.
        context.fillStyle = "#FF8A3D";
        context.font = `700 ${Math.max(11, Math.round(W / 56))}px ui-monospace, Menlo, Consolas, monospace`;
        context.textAlign = "right";
        context.textBaseline = "top";
        context.fillText(`FACE DETECTOR ${(yunetFace.score * 100).toFixed(0)}%`, left + box.width * W - 8, Y(box.y) + 8);
        context.textAlign = "left";
        for (const point of [yunetFace.rightEye, yunetFace.leftEye, yunetFace.nose, yunetFace.rightMouth, yunetFace.leftMouth]) {
          context.beginPath();
          context.arc(X(point.x), Y(point.y), 5, 0, Math.PI * 2);
          context.fillStyle = "#FF8A3D";
          context.fill();
          context.strokeStyle = "#fff";
          context.lineWidth = 2;
          context.stroke();
        }
      }

      const overlay = overlayRef.current;
      const landmarks = overlay.landmarks;
      const cv = cvRef.current;
      const tracking = faceRef.current && landmarks !== null && overlay.eyes.length > 0;

      if (tracking && landmarks) {
        // Face mesh.
        context.strokeStyle = "rgba(34, 211, 238, 0.2)";
        context.lineWidth = 0.7;
        context.beginPath();
        for (const { start, end } of meshRef.current) {
          context.moveTo(X(landmarks[2 * start]), Y(landmarks[2 * start + 1]));
          context.lineTo(X(landmarks[2 * end]), Y(landmarks[2 * end + 1]));
        }
        context.stroke();
        context.fillStyle = "rgba(165, 243, 252, 0.85)";
        for (let i = 0; i < landmarks.length / 2; i += 1) {
          context.fillRect(X(landmarks[2 * i]) - 0.8, Y(landmarks[2 * i + 1]) - 0.8, 1.6, 1.6);
        }

        // Pupils (OpenCV) at a lower rate than the draw loop.
        if (cv && scratch && time - lastFit >= PUPIL_FIT_INTERVAL_MS) {
          lastFit = time;
          eyeFits = fitEyePupils(cv, video, overlay.eyes, scratch);
        }

        // Head pose (OpenCV solvePnP).
        if (cv) {
          const points = POSE_LANDMARKS.map((index) => ({ x: landmarks[2 * index] * W, y: landmarks[2 * index + 1] * H }));
          const estimate = estimateHeadPose(cv, points, W, H);
          if (estimate) {
            // Shown as seen in the mirror: turning toward your right is positive yaw.
            pose = {
              yaw: smooth(pose?.yaw, -estimate.yaw),
              pitch: smooth(pose?.pitch, estimate.pitch),
              roll: smooth(pose?.roll, -estimate.roll),
            };
            axes = estimate.axes;
          }
        }

        // Eyelids and irises.
        context.strokeStyle = "rgba(165, 243, 252, 0.95)";
        context.lineWidth = 2;
        for (const eye of overlay.eyes) {
          context.beginPath();
          eye.contour.forEach((point, i) => (i === 0 ? context.moveTo(X(point.x), Y(point.y)) : context.lineTo(X(point.x), Y(point.y))));
          context.closePath();
          context.stroke();
        }

        // Pupil ellipses.
        context.strokeStyle = "rgba(252, 211, 77, 1)";
        context.lineWidth = 2.5;
        for (const { pupil } of eyeFits) {
          context.beginPath();
          context.ellipse(X(pupil.cx), Y(pupil.cy), Math.max(1, pupil.rx * W), Math.max(1, pupil.ry * W), -(pupil.angleDeg * Math.PI) / 180, 0, Math.PI * 2);
          context.stroke();
        }

        // Corneal glints (the light source's reflection) as white crosshairs.
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        for (const { glint } of eyeFits) {
          if (!glint) continue;
          const gx = X(glint.x);
          const gy = Y(glint.y);
          context.beginPath();
          context.moveTo(gx - 7, gy);
          context.lineTo(gx + 7, gy);
          context.moveTo(gx, gy - 7);
          context.lineTo(gx, gy + 7);
          context.stroke();
        }

        // Head-pose axes at the nose tip (x red, y green, z blue).
        if (axes) {
          const mirror = (p: { x: number; y: number }) => ({ x: W - p.x, y: p.y });
          const origin = mirror(axes.origin);
          for (const [end, color] of [[axes.x, "#f87171"], [axes.y, "#4ade80"], [axes.z, "#60a5fa"]] as const) {
            const tip = mirror(end);
            context.strokeStyle = color;
            context.lineWidth = 3;
            context.beginPath();
            context.moveTo(origin.x, origin.y);
            context.lineTo(tip.x, tip.y);
            context.stroke();
          }
        }

        // Gaze ray from between the eyes to where the cursor is on screen.
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0) {
          const irises = overlay.eyes.map((eye) => eye.iris);
          const ox = X(irises.reduce((sum, p) => sum + p.x, 0) / irises.length);
          const oy = Y(irises.reduce((sum, p) => sum + p.y, 0) / irises.length);
          const gaze = gazePositionRef.current;
          const tx = ((gaze.x - rect.left) / rect.width) * W;
          const ty = ((gaze.y - rect.top) / rect.height) * H;
          context.strokeStyle = "rgba(103, 232, 249, 0.9)";
          context.setLineDash([10, 8]);
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(ox, oy);
          context.lineTo(tx, ty);
          context.stroke();
          context.setLineDash([]);
          context.fillStyle = "rgba(103, 232, 249, 0.95)";
          context.beginPath();
          context.arc(tx, ty, 7, 0, Math.PI * 2);
          context.fill();
        }
      } else {
        eyeFits = [];
        pose = null;
        axes = null;
      }

      // Scan line.
      const scanY = ((time % SCAN_PERIOD_MS) / SCAN_PERIOD_MS) * H;
      const scan = context.createLinearGradient(0, scanY - 40, 0, scanY);
      scan.addColorStop(0, "rgba(34, 211, 238, 0)");
      scan.addColorStop(1, "rgba(34, 211, 238, 0.22)");
      context.fillStyle = scan;
      context.fillRect(0, scanY - 40, W, 40);

      // Readout.
      const fps = frameTimes.length > 1 ? ((frameTimes.length - 1) * 1000) / (frameTimes[frameTimes.length - 1] - frameTimes[0]) : 0;
      const lines = [
        "Mirror of Sovereignty · X-RAY",
        `HEAD POSE · PUPIL FIT${cv ? "" : "  (loading…)"}`,
        tracking ? "FACE LOCK ●" : "NO FACE",
        pose ? `YAW ${pose.yaw.toFixed(0).padStart(4)}°  PITCH ${pose.pitch.toFixed(0).padStart(4)}°  ROLL ${pose.roll.toFixed(0).padStart(4)}°` : "YAW —  PITCH —  ROLL —",
        `PUPILS ${eyeFits.length}/2  GLINTS ${eyeFits.filter((fit) => fit.glint).length}/2  BLINKS ${blinkCountRef.current}   ${fps.toFixed(0)} FPS`,
        `CALIBRATION ${calibrationRef.current.toUpperCase()}   DETECTOR ${yunetFace ? `${(yunetFace.score * 100).toFixed(0)}%` : "—"}`,
      ];
      const fontSize = Math.max(13, Math.round(W / 46));
      context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      context.textBaseline = "top";
      lines.forEach((line, i) => {
        context.fillStyle = i === 0 ? "#67e8f9" : i === 2 && tracking ? "#4ade80" : "rgba(226, 232, 240, 0.92)";
        context.fillText(line, 16, 14 + i * (fontSize + 5));
      });
    };

    animationFrame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animationFrame);
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream, overlayRef, gazePositionRef, cvReady]);

  return (
    <div ref={rootRef} className="ms-xray" role="region" aria-label="X-ray view">
      <header className="ms-xray-header">
        <div className="ms-brand">
          X-RAY
          <small>WHAT THE MACHINE SEES · PRESS X TO CLOSE</small>
        </div>
        <button
          type="button"
          className="ms-tile ms-tile--sm"
          data-gaze-action="close-xray"
          data-focused={focusedId === "close-xray" ? "true" : undefined}
          onClick={onClose}
          style={{ "--p": focusedId === "close-xray" ? progress : 0, flex: "none", minWidth: 200 } as CSSProperties}
        >
          <span>CLOSE ✕</span>
        </button>
      </header>
      <div className="ms-xray-body">
        <canvas ref={canvasRef} width={640} height={480} aria-label="Live X-ray of the face tracker" />
        {!stream && <p className="ms-xray-wait">Camera is waiting to start…</p>}
      </div>
      <video ref={videoRef} muted playsInline aria-hidden="true" tabIndex={-1} style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />
    </div>
  );
}
