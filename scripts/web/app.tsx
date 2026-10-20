import {
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  exportToCanvas,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RenderInput, RenderOutput } from "./render-api.ts";

const EXPORT_PADDING = 32;
const EXPORT_SCALE = 2;
const SAVE_DEBOUNCE_MS = 400;
const POLL_INTERVAL_MS = 1000;
const BOXED_TYPES = new Set(["rectangle", "ellipse", "diamond", "text", "image", "frame", "magicframe"]);

// ---------------------------------------------------------------------------
// Headless rendering (driven by cli.ts through Playwright)
// ---------------------------------------------------------------------------

function skeletonError(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "skeleton must be a JSON array of elements";
  }
  for (const [index, el] of value.entries()) {
    if (typeof el !== "object" || el === null || !("type" in el) || typeof el.type !== "string") {
      return `element #${index} must be an object with a string "type"`;
    }
  }
  return null;
}

function isSkeletonList(value: unknown): value is ExcalidrawElementSkeleton[] {
  return skeletonError(value) === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ShapeBox = { type: string; cx: number; cy: number; hw: number; hh: number };

const ARROW_GAP = 6;

// Distance from the shape's center to its outline along (dx, dy), in units of that vector.
function outlineScale(shape: ShapeBox, dx: number, dy: number): number {
  const ax = Math.abs(dx) / shape.hw;
  const ay = Math.abs(dy) / shape.hh;
  if (shape.type === "ellipse") {
    return 1 / Math.hypot(ax, ay);
  }
  if (shape.type === "diamond") {
    return 1 / (ax + ay);
  }
  return 1 / Math.max(ax, ay);
}

// convertToExcalidrawElements binds arrows to `start`/`end` shapes but keeps whatever geometry the
// skeleton gave (default: 100px to the right). For bound arrows without explicit points, draw a
// straight line between the two outlines so the skeleton only needs to say what connects to what.
function routeArrows(raw: unknown): unknown {
  if (!Array.isArray(raw)) {
    return raw;
  }
  const shapes = new Map<string, ShapeBox>();
  for (const el of raw) {
    if (
      isRecord(el) &&
      typeof el.id === "string" &&
      typeof el.type === "string" &&
      typeof el.x === "number" &&
      typeof el.y === "number" &&
      typeof el.width === "number" &&
      typeof el.height === "number"
    ) {
      shapes.set(el.id, { type: el.type, cx: el.x + el.width / 2, cy: el.y + el.height / 2, hw: el.width / 2, hh: el.height / 2 });
    }
  }
  const endpointShape = (endpoint: unknown): ShapeBox | undefined =>
    isRecord(endpoint) && typeof endpoint.id === "string" ? shapes.get(endpoint.id) : undefined;

  return raw.map((el: unknown) => {
    if (!isRecord(el) || el.type !== "arrow" || "points" in el) {
      return el;
    }
    const from = endpointShape(el.start);
    const to = endpointShape(el.end);
    if (!from || !to) {
      return el;
    }
    const dx = to.cx - from.cx;
    const dy = to.cy - from.cy;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      return el;
    }
    const gap = ARROW_GAP / length;
    const s = outlineScale(from, dx, dy) + gap;
    const e = 1 - outlineScale(to, -dx, -dy) - gap;
    const x = from.cx + dx * s;
    const y = from.cy + dy * s;
    const px = dx * (e - s);
    const py = dy * (e - s);
    return { ...el, x, y, width: Math.abs(px), height: Math.abs(py), points: [[0, 0], [px, py]] };
  });
}

// Text is measured while converting, so the fonts for every glyph in the scene must already be
// loaded. exportToCanvas loads exactly those fonts, so convert once, export, then convert again.
async function convertWithLoadedFonts(skeleton: ExcalidrawElementSkeleton[]): Promise<readonly ExcalidrawElement[]> {
  const draft = convertToExcalidrawElements(skeleton, { regenerateIds: false });
  await exportToCanvas({ elements: draft, files: null });
  await document.fonts.ready;
  return convertToExcalidrawElements(skeleton, { regenerateIds: false });
}

type Box = { id: string; desc: string; x1: number; y1: number; x2: number; y2: number };

function describe(el: ExcalidrawElement, boundText: Map<string, string>): string {
  const text = el.type === "text" ? el.text : boundText.get(el.id);
  const snippet = text ? ` "${text.replace(/\s+/g, " ").slice(0, 30)}"` : "";
  return `${el.type} ${el.id}${snippet}`;
}

function overlapWarnings(elements: readonly ExcalidrawElement[]): string[] {
  const live = elements.filter((el) => !el.isDeleted);
  const boundText = new Map<string, string>();
  for (const el of live) {
    if (el.type === "text" && el.containerId) {
      boundText.set(el.containerId, el.text);
    }
  }
  const boxes: Box[] = live
    .filter((el) => BOXED_TYPES.has(el.type) && !(el.type === "text" && el.containerId))
    .map((el) => ({
      id: el.id,
      desc: describe(el, boundText),
      x1: Math.min(el.x, el.x + el.width),
      y1: Math.min(el.y, el.y + el.height),
      x2: Math.max(el.x, el.x + el.width),
      y2: Math.max(el.y, el.y + el.height),
    }));
  const contains = (a: Box, b: Box): boolean => a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2;
  const warnings: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) {
        continue;
      }
      const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      if (w > 0 && h > 0 && !contains(a, b) && !contains(b, a)) {
        warnings.push(`partial overlap (${Math.round(w)}x${Math.round(h)}px): ${a.desc} <-> ${b.desc}`);
      }
    }
  }
  return warnings;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function renderPng(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): Promise<string> {
  const blob = await exportToBlob({
    elements: elements.filter((el) => !el.isDeleted),
    appState: { ...appState, exportBackground: true, exportScale: EXPORT_SCALE, exportWithDarkMode: false },
    files,
    exportPadding: EXPORT_PADDING,
    mimeType: "image/png",
  });
  return blobToBase64(blob);
}

async function render(input: RenderInput): Promise<RenderOutput> {
  try {
    if (input.kind === "skeleton") {
      const skeleton = routeArrows(input.elements);
      if (!isSkeletonList(skeleton)) {
        return { ok: false, error: skeletonError(skeleton) ?? "invalid skeleton" };
      }
      const elements = await convertWithLoadedFonts(skeleton);
      const appState: Partial<AppState> = { viewBackgroundColor: "#ffffff" };
      return {
        ok: true,
        sceneJson: serializeAsJSON(elements, appState, {}, "local"),
        pngBase64: await renderPng(elements, appState, {}),
        warnings: overlapWarnings(elements),
      };
    }
    const data = await loadFromBlob(new Blob([input.sceneJson], { type: "application/json" }), null, null);
    await exportToCanvas({ elements: data.elements, files: data.files });
    await document.fonts.ready;
    return {
      ok: true,
      sceneJson: input.sceneJson,
      pngBase64: await renderPng(data.elements, data.appState, data.files),
      warnings: overlapWarnings(data.elements),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Editor (what Asaf sees in the browser)
// ---------------------------------------------------------------------------

type LoadedScene = Awaited<ReturnType<typeof loadFromBlob>> & { mtime: number | null };

async function fetchScene(name: string): Promise<LoadedScene> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(name)}`);
  if (!res.ok) {
    throw new Error(`could not load scene "${name}": HTTP ${res.status}`);
  }
  const mtimeHeader = res.headers.get("X-Scene-Mtime");
  const data = await loadFromBlob(await res.blob(), null, null);
  return { ...data, mtime: mtimeHeader ? Number(mtimeHeader) : null };
}

async function fetchMtime(name: string): Promise<number | null> {
  const res = await fetch(`/api/scenes/${encodeURIComponent(name)}/mtime`);
  if (!res.ok) {
    return null;
  }
  const body: unknown = await res.json();
  if (typeof body === "object" && body !== null && "mtime" in body && typeof body.mtime === "number") {
    return body.mtime;
  }
  return null;
}

function Editor({ name }: { name: string }) {
  const [initial, setInitial] = useState<LoadedScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastSavedJson = useRef("");
  const lastMtime = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    document.title = name;
    fetchScene(name)
      .then((scene) => {
        lastMtime.current = scene.mtime;
        lastSavedJson.current = serializeAsJSON(scene.elements, scene.appState, scene.files, "local");
        setInitial(scene);
      })
      .catch((err: unknown) => setError(String(err)));
  }, [name]);

  // Pick up re-renders written by the CLI while the editor is open.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (saving.current || saveTimer.current !== null || !api.current) {
        return;
      }
      fetchMtime(name)
        .then(async (mtime) => {
          if (mtime === null || mtime === lastMtime.current || saving.current || saveTimer.current !== null) {
            return;
          }
          const scene = await fetchScene(name);
          lastMtime.current = scene.mtime;
          lastSavedJson.current = serializeAsJSON(scene.elements, scene.appState, scene.files, "local");
          const editor = api.current;
          if (!editor) {
            return;
          }
          editor.addFiles(Object.values(scene.files));
          editor.updateScene({ elements: scene.elements });
          editor.scrollToContent(scene.elements, { fitToContent: true, animate: true });
        })
        .catch((err: unknown) => console.error("scene reload failed", err));
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [name]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
      }
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const json = serializeAsJSON(elements, appState, files, "local");
        if (json === lastSavedJson.current) {
          return;
        }
        saving.current = true;
        document.title = `${name} (saving…)`;
        fetch(`/api/scenes/${encodeURIComponent(name)}`, { method: "PUT", body: json })
          .then(async (res) => {
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            }
            const body: unknown = await res.json();
            if (typeof body === "object" && body !== null && "mtime" in body && typeof body.mtime === "number") {
              lastMtime.current = body.mtime;
            }
            lastSavedJson.current = json;
            document.title = name;
          })
          .catch((err: unknown) => {
            console.error("save failed", err);
            document.title = `${name} (SAVE FAILED)`;
          })
          .finally(() => {
            saving.current = false;
          });
      }, SAVE_DEBOUNCE_MS);
    },
    [name],
  );

  if (error) {
    return <pre style={{ padding: 24, color: "#b91c1c" }}>{error}</pre>;
  }
  if (!initial) {
    return <p style={{ padding: 24, fontFamily: "system-ui" }}>Loading {name}…</p>;
  }
  return (
    <Excalidraw
      initialData={{ elements: initial.elements, appState: initial.appState, files: initial.files, scrollToContent: true }}
      excalidrawAPI={(instance) => {
        api.current = instance;
        window.excalidrawEditorApi = instance;
      }}
      onChange={onChange}
    />
  );
}

// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
if (params.get("mode") === "render") {
  window.excalidrawRender = render;
} else {
  const rootEl = document.getElementById("root");
  const sceneName = params.get("scene");
  if (rootEl) {
    createRoot(rootEl).render(
      sceneName ? <Editor name={sceneName} /> : <p style={{ padding: 24 }}>Open with ?scene=&lt;name&gt;</p>,
    );
  }
}
