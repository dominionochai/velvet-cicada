'use client';

import {
  useCallback, useEffect, useRef, useState,
  type MutableRefObject, type ReactNode,
} from 'react';
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { MODEL_URL, WASM_URL } from '@/lib/mediapipeConfig';
import {
  GazeContext, type GazePosition, type GazeState, type HoverState, type TrackingOverlay,
} from '@/lib/gazeContext';
import { CalibrationManager, CALIBRATION_TARGETS, type GazeCalibration } from '@/lib/calibration';
import { BlinkDetector } from '@/lib/blinkDetector';
import { EMASmooth, type GazeSmoother } from '@/lib/emaSmooth';
import {
  estimateRawGaze, IRIS_LEFT, IRIS_RIGHT, LEFT_EAR_IDX, RIGHT_EAR_IDX, type NormalizedLandmark,
} from '@/lib/gazeEstimator';

/** Lower = steadier cursor but more lag. */
const GAZE_SMOOTHING_ALPHA = 0.12;
/** Pixels the arrow keys move the cursor (accessibility / demo fallback). */
const KEYBOARD_NUDGE_PX = 32;
/** Calibration uses the median of this many recent raw frames, not a single noisy frame. */
const RAW_HISTORY = 15;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** MediaPipe's face mesh has 468 face points plus 10 iris points. */
const LANDMARK_COUNT = 478;
const NO_OVERLAY: TrackingOverlay = { eyes: [], landmarks: null };

type ReactiveState = Pick<
  GazeState,
  | 'blinkCount' | 'isFaceDetected' | 'isCalibrated' | 'isTracking' | 'isCalibrating'
  | 'calibrationStep' | 'initStatus' | 'errorMessage' | 'isWebGPU' | 'calibrationModel' | 'stream'
>;

const INITIAL_STATE: ReactiveState = {
  blinkCount: 0,
  isFaceDetected: false,
  isCalibrated: false,
  isTracking: false,
  isCalibrating: false,
  calibrationStep: 0,
  initStatus: 'idle',
  errorMessage: '',
  isWebGPU: false,
  calibrationModel: 'affine',
  stream: null,
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isEditableTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)));
};

function buildOverlay(landmarks: NormalizedLandmark[], buffer: Float32Array): TrackingOverlay {
  const eye = (earIndices: number[], irisIndex: number) => ({
    contour: earIndices.map((index) => ({ x: landmarks[index].x, y: landmarks[index].y })),
    iris: { x: landmarks[irisIndex].x, y: landmarks[irisIndex].y },
  });
  const count = Math.min(landmarks.length, LANDMARK_COUNT);
  for (let i = 0; i < count; i += 1) {
    buffer[2 * i] = landmarks[i].x;
    buffer[2 * i + 1] = landmarks[i].y;
  }
  return {
    eyes: [eye(LEFT_EAR_IDX, IRIS_LEFT), eye(RIGHT_EAR_IDX, IRIS_RIGHT)],
    landmarks: buffer,
  };
}

/**
 * MediaPipe's WASM runtime writes INFO/WARN lines through console.error, which
 * the Next.js dev overlay would surface as errors. Returns a function that
 * restores the original console.
 */
function silenceMediaPipeLogs(): () => void {
  const original = console.error;
  const isMediaPipeLog = (message: unknown) =>
    typeof message === 'string' && (
      /^[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d{6}/.test(message) ||
      /TensorFlow Lite XNNPACK delegate|OpenGL error checking is disabled|xnnpack/.test(message)
    );
  console.error = (...args: unknown[]) => {
    if (!isMediaPipeLog(args[0])) original.apply(console, args);
  };
  return () => { console.error = original; };
}

export function GazeProvider({ children, autoStart = false }: { children: ReactNode; autoStart?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const initializingRef = useRef(false);
  // Gaze path is MediaPipe-only: affine calibration + EMA smoothing. No OpenCV, so behaviour is identical on every load.
  const calibrationRef = useRef<GazeCalibration>(new CalibrationManager());
  const smootherRef = useRef<GazeSmoother>(new EMASmooth(GAZE_SMOOTHING_ALPHA));
  const blinkDetectorRef = useRef<BlinkDetector | null>(null);

  // High-frequency values live in refs so per-frame updates never re-render.
  const gazePositionRef = useRef<GazePosition>({ x: 0.5, y: 0.5 });
  const rawIrisRef = useRef<GazePosition>({ x: 0.5, y: 0.5 }) as MutableRefObject<GazePosition>;
  const overlayRef = useRef<TrackingOverlay>(NO_OVERLAY);
  const landmarkBufferRef = useRef(new Float32Array(LANDMARK_COUNT * 2));
  const hoverStateRef = useRef<HoverState>({ isHovering: false, dwellPct: 0 });
  const recentRawRef = useRef<GazePosition[]>([]);

  const [state, setState] = useState<ReactiveState>(INITIAL_STATE);

  useEffect(() => {
    blinkDetectorRef.current = new BlinkDetector(() => {
      setState((prev) => ({ ...prev, blinkCount: prev.blinkCount + 1 }));
    });
    return () => { blinkDetectorRef.current = null; };
  }, []);

  const setFaceDetected = useCallback((detected: boolean) => {
    // Returning `prev` keeps React from re-rendering on unchanged frames.
    setState((prev) => (prev.isFaceDetected === detected ? prev : { ...prev, isFaceDetected: detected }));
  }, []);

  const processFrame = useCallback((video: HTMLVideoElement, landmarker: FaceLandmarker, timestamp: number) => {
    const landmarks = landmarker.detectForVideo(video, timestamp).faceLandmarks[0];
    if (!landmarks) {
      overlayRef.current = NO_OVERLAY;
      setFaceDetected(false);
      return;
    }

    const isBlinking = blinkDetectorRef.current?.update(landmarks) ?? false;
    // Hold the cursor while the lids are closed: iris landmarks swing downward mid-blink.
    const raw = isBlinking ? null : estimateRawGaze(landmarks);
    if (raw) {
      rawIrisRef.current = raw;
      recentRawRef.current.push(raw);
      if (recentRawRef.current.length > RAW_HISTORY) recentRawRef.current.shift();
      const target = calibrationRef.current.apply(raw.x, raw.y)
        ?? { x: raw.x * window.innerWidth, y: raw.y * window.innerHeight };
      const smoothed = smootherRef.current.update(target.x, target.y);
      gazePositionRef.current = {
        x: clamp(smoothed.x, 0, window.innerWidth),
        y: clamp(smoothed.y, 0, window.innerHeight),
      };
    }
    overlayRef.current = buildOverlay(landmarks, landmarkBufferRef.current);
    setFaceDetected(true);
  }, [setFaceDetected]);

  const startLoop = useCallback(() => {
    let lastVideoTime = -1;
    let lastTimestamp = -1;

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      if (!video || !landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (video.currentTime === lastVideoTime) return; // no new camera frame yet
      lastVideoTime = video.currentTime;

      // MediaPipe requires strictly increasing timestamps.
      lastTimestamp = Math.max(performance.now(), lastTimestamp + 1);
      processFrame(video, landmarker, lastTimestamp);
    };

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [processFrame]);

  const initialize = useCallback(() => {
    if (initializingRef.current || streamRef.current) return;
    initializingRef.current = true;

    const fail = (message: string) =>
      setState((prev) => ({ ...prev, initStatus: 'error', isTracking: false, errorMessage: message }));
    const restoreConsole = silenceMediaPipeLogs();

    (async () => {
      setState((prev) => ({ ...prev, initStatus: 'loading-model', errorMessage: '' }));

      try {
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
        landmarkerRef.current = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });
      } catch (error) {
        fail(`Failed to load the face model: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      setState((prev) => ({ ...prev, initStatus: 'requesting-camera' }));
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) throw new Error('Camera video element was not mounted.');
        video.srcObject = stream;
        await video.play();
        setState((prev) => ({ ...prev, isTracking: true, initStatus: 'ready', stream }));
        startLoop();
      } catch {
        fail('Camera access denied. Please allow camera permission and reload.');
      }
    })().finally(() => {
      restoreConsole();
      initializingRef.current = false;
    });
  }, [startLoop]);

  useEffect(() => {
    if (autoStart) initialize();
  }, [autoStart, initialize]);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
  }, []);

  const startCalibration = useCallback(() => {
    calibrationRef.current.reset();
    smootherRef.current.reset();
    setState((prev) => ({ ...prev, isCalibrating: true, isCalibrated: false, calibrationStep: 0 }));
  }, []);

  const recordCalibrationPoint = useCallback(() => {
    setState((prev) => {
      const target = CALIBRATION_TARGETS[prev.calibrationStep];
      if (!prev.isCalibrating || !target) return prev;

      calibrationRef.current.addSample({
        screenX: target.x * window.innerWidth,
        screenY: target.y * window.innerHeight,
        irisX: recentRawRef.current.length ? median(recentRawRef.current.map((p) => p.x)) : rawIrisRef.current.x,
        irisY: recentRawRef.current.length ? median(recentRawRef.current.map((p) => p.y)) : rawIrisRef.current.y,
      });
      recentRawRef.current = [];

      const nextStep = prev.calibrationStep + 1;
      return nextStep >= CALIBRATION_TARGETS.length
        ? { ...prev, isCalibrating: false, calibrationStep: 0, isCalibrated: calibrationRef.current.isReady }
        : { ...prev, calibrationStep: nextStep };
    });
  }, []);

  const resetCalibration = useCallback(() => {
    calibrationRef.current.reset();
    smootherRef.current.reset();
    setState((prev) => ({ ...prev, isCalibrated: false, isCalibrating: false, calibrationStep: 0 }));
  }, []);

  // Keyboard fallback: arrows nudge the cursor, Enter/Space act as a blink.
  useEffect(() => {
    const nudges: Record<string, GazePosition> = {
      ArrowLeft: { x: -KEYBOARD_NUDGE_PX, y: 0 },
      ArrowRight: { x: KEYBOARD_NUDGE_PX, y: 0 },
      ArrowUp: { x: 0, y: -KEYBOARD_NUDGE_PX },
      ArrowDown: { x: 0, y: KEYBOARD_NUDGE_PX },
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const nudge = nudges[event.key];
      if (nudge) {
        event.preventDefault();
        const { x, y } = gazePositionRef.current;
        gazePositionRef.current = {
          x: clamp(x + nudge.x, 0, window.innerWidth),
          y: clamp(y + nudge.y, 0, window.innerHeight),
        };
      } else if ((event.key === 'Enter' || event.code === 'Space') && !event.repeat) {
        event.preventDefault();
        setState((prev) => ({ ...prev, blinkCount: prev.blinkCount + 1 }));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <GazeContext.Provider
      value={{
        ...state,
        gazePositionRef,
        rawIrisRef,
        overlayRef,
        hoverStateRef,
        initialize,
        startCalibration,
        recordCalibrationPoint,
        resetCalibration,
      }}
    >
      {children}
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        aria-hidden="true"
        style={{ position: 'fixed', top: -9999, left: -9999, width: 640, height: 480, opacity: 0, pointerEvents: 'none' }}
      />
    </GazeContext.Provider>
  );
}
