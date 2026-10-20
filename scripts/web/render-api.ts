import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type RenderInput =
  | { kind: "skeleton"; elements: unknown }
  | { kind: "scene"; sceneJson: string };

export type RenderOutput =
  | { ok: true; sceneJson: string; pngBase64: string; warnings: string[] }
  | { ok: false; error: string };

declare global {
  interface Window {
    excalidrawRender?: (input: RenderInput) => Promise<RenderOutput>;
    excalidrawEditorApi?: ExcalidrawImperativeAPI;
  }
}
