import { MODEL_URL, WASM_URL } from "@/lib/mediapipeConfig";
import { faceFromLandmarks, type FaceGeometry } from "./face";

/**
 * Optional demo photo. Drop a front-facing portrait at `public/demo-face.jpg` and the studio uses it
 * whenever there is no camera, so looks can be tried (and YouCam can find a real face) without one.
 */
export const DEMO_FACE_URL = "/demo-face.jpg";

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 480;

let photo: Promise<string | null> | null = null;

/** The demo photo letterboxed into a 4:3 frame (so the whole face is kept), or null when there is none. */
export function loadDemoPhoto(): Promise<string | null> {
  photo ??= new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = FRAME_WIDTH;
      canvas.height = FRAME_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.fillStyle = "#101012";
      ctx.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      const scale = Math.min(FRAME_WIDTH / image.naturalWidth, FRAME_HEIGHT / image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      ctx.drawImage(image, (FRAME_WIDTH - w) / 2, (FRAME_HEIGHT - h) / 2, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    image.onerror = () => resolve(null);
    image.src = DEMO_FACE_URL;
  });
  return photo;
}

/** Finds the face in a frame so overlays land on the lips, eyes and hairline. Null when no face is found. */
export async function detectFace(frameDataUrl: string): Promise<FaceGeometry | null> {
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image"));
      image.src = frameDataUrl;
    });
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      runningMode: "IMAGE",
      numFaces: 1,
    });
    try {
      const points = landmarker.detect(image).faceLandmarks[0];
      if (!points) return null;
      const flat = new Float32Array(points.length * 2);
      points.forEach((p, i) => {
        flat[2 * i] = p.x;
        flat[2 * i + 1] = p.y;
      });
      return faceFromLandmarks(flat);
    } finally {
      landmarker.close();
    }
  } catch {
    return null;
  }
}
