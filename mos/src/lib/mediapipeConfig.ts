// The WASM runtime must match the installed npm package exactly. package.json
// pins @mediapipe/tasks-vision to this version; bump both together.
export const MEDIAPIPE_VERSION = "0.10.35";
export const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
