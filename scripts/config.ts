import os from "node:os";
import path from "node:path";

const portFromEnv = Number(process.env.EXCALIDRAW_SKILL_PORT);

export const SERVICE_NAME = "excalidraw-skill";
export const PORT = Number.isInteger(portFromEnv) && portFromEnv > 0 ? portFromEnv : 4517;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const ROOT = import.meta.dirname;
export const WEB_DIR = path.join(ROOT, "web");
export const DIST_DIR = path.join(WEB_DIR, "dist");
export const EXCALIDRAW_ASSETS_DIR = path.join(ROOT, "node_modules/@excalidraw/excalidraw/dist/prod");
export const DATA_DIR =
  process.env.EXCALIDRAW_SKILL_DATA_DIR ??
  path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"), "excalidraw-skill");
export const SCENES_DIR = path.join(DATA_DIR, "scenes");
export const SERVER_LOG = path.join(DATA_DIR, "server.log");

const SCENE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSceneName(name: string): boolean {
  return SCENE_NAME.test(name) && !name.includes("..");
}

export function scenePath(name: string): string {
  if (!isSceneName(name)) {
    throw new Error(`invalid scene name "${name}": use letters, digits, '.', '_' or '-'`);
  }
  return path.join(SCENES_DIR, `${name}.excalidraw`);
}

export function pngPath(name: string): string {
  return path.join(SCENES_DIR, `${name}.png`);
}

// Fingerprint of the scene version an agent last rendered or snapshotted; see cli.ts.
export function seenPath(name: string): string {
  return path.join(SCENES_DIR, `${name}.seen`);
}
