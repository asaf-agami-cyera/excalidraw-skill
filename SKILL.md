---
name: excalidraw
description: Draw Excalidraw diagrams for Asaf with a local render-and-check loop and open them in his browser for editing. Use whenever Asaf asks for an Excalidraw diagram, a hand-drawn or whiteboard-style sketch, or to see, change, or read back a diagram he edited in Excalidraw.
---

# Excalidraw (local)

`~/scripts/excalidraw` (source: `~/scripts/excalidraw-local`) turns an element skeleton into a real
Excalidraw scene using Excalidraw's own library in headless Chrome, renders a PNG, and serves a
local editor at `http://127.0.0.1:4517` that auto-saves edits. Nothing is uploaded.

## Loop

1. Write a skeleton JSON array to a file in the pre-approved temp workspace.
2. `~/scripts/excalidraw render <name> <file.json>` writes
   `~/.local/share/excalidraw-local/scenes/<name>.excalidraw` and `<name>.png`, and prints
   warnings: partial overlaps between shapes or standalone text, and browser console errors such as
   arrow bindings to missing ids.
3. Read the PNG and fix what you see: clipped or cramped text, overlaps, low contrast, arrows that
   miss. Re-render until it's clean. Never open a diagram you haven't looked at.
4. `~/scripts/excalidraw open <name>` opens the editor in Asaf's default browser. That is a
   visible interruption: do it only when he asked to see the diagram in this session.
5. When the editor is already open, a re-render shows up there within about a second.
6. After Asaf edits in the browser, `~/scripts/excalidraw snapshot <name>` re-renders the saved
   scene to PNG so you can see his changes; the `.excalidraw` file holds the element data.

Other commands: `list`, `stop` (background server), `serve`. Self-test: `npm run selftest` in
`~/scripts/excalidraw-local`. After changing `web/`, run `npm run check && npm run build`; after
changing `server.ts`, also `~/scripts/excalidraw stop`, and the next command restarts it.

## Skeleton format

The input is Excalidraw's `ExcalidrawElementSkeleton[]` (what `convertToExcalidrawElements`
accepts). The essentials:

- Shapes: `{"type":"rectangle"|"ellipse"|"diamond","id","x","y","width","height"}` plus
  `backgroundColor`, `fillStyle:"solid"`, `strokeColor`, `roundness:{"type":3}` for rounded corners.
- Text in a shape: `"label":{"text","fontSize","fontFamily","textAlign","strokeColor"}`. It
  centers by default and the container grows to fit, but wrap long lines yourself with `\n`. Set
  `label.strokeColor` to a dark color: label text doesn't inherit the shape's stroke.
- Standalone text: `{"type":"text","id","x","y","text","fontSize"}`; `x` is the left edge.
- Arrows: `{"type":"arrow","id","x":0,"y":0,"start":{"id":"a"},"end":{"id":"b"}}`. Arrows bound
  at both ends without `points` are routed automatically between the two outlines, and stay
  attached when Asaf moves the shapes. Optional `label`, `strokeStyle:"dashed"`,
  `endArrowhead`/`startArrowhead`.
- Lines: `{"type":"line","x","y","points":[[0,0],[dx,dy]]}`.
- Frames: `{"type":"frame","children":["id1","id2"],"name"}`.
- `fontFamily`: 5 Excalifont (hand-drawn, default), 3 Cascadia (code), 6 Nunito, 2 Helvetica.
- No emoji; Excalidraw's fonts don't render them.

Readable defaults: body text 16 to 18, titles 28 to 32, at least 30px between boxes. Pastel fills
`#a5d8ff #b2f2bb #ffd8a8 #d0bfff #ffc9c9 #fff3bf #c3fae8 #f1f3f5`; strokes `#4a9eed #22c55e
#f59e0b #8b5cf6 #ef4444`; grey secondary text `#757575` (nothing lighter on white).
