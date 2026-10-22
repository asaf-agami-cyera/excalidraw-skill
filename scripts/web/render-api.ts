import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type RenderInput =
  | { kind: "skeleton"; elements: unknown }
  | { kind: "scene"; sceneJson: string };

export type RenderOutput =
  | { ok: true; sceneJson: string; pngBase64: string; warnings: string[] }
  | { ok: false; error: string };

// One entry of GET /api/scenes. Times are epoch milliseconds; pngMtime is null when no PNG exists.
export type SceneSummary = { name: string; mtime: number; pngMtime: number | null };

declare global {
  interface Window {
    excalidrawRender?: (input: RenderInput) => Promise<RenderOutput>;
    excalidrawEditorApi?: ExcalidrawImperativeAPI;
  }
}
