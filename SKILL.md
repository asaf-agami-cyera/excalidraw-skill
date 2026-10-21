---
name: excalidraw
description: Draw Excalidraw diagrams with a local render-and-check loop and open them in the user's browser for editing. Use whenever the user asks for an Excalidraw diagram, a hand-drawn or whiteboard-style sketch, or to see, change, or read back a diagram they edited in Excalidraw.
---

# Excalidraw

`scripts/excalidraw` (relative to this skill's base directory) turns an element skeleton into a real
Excalidraw scene using Excalidraw's own library in headless Chrome, renders a PNG for you to check,
and serves a local editor at `http://127.0.0.1:4517` that auto-saves edits. Nothing is uploaded.

Requirements: Node.js 22.18+, `npm`, `rsync`, and Google Chrome (or Playwright's Chromium:
`npx playwright install chromium --only-shell`). The first run installs about 300 MB of npm
dependencies into `~/.cache/excalidraw-skill/app`, which takes about a minute.

## Loop

Below, `excalidraw` means `<this skill's base directory>/scripts/excalidraw`.

1. Write a skeleton JSON array to a file in a temp directory.
2. `excalidraw render <name> <file.json>` writes `<name>.excalidraw` and `<name>.png` to
   `~/.local/share/excalidraw-skill/scenes/`, and prints warnings: partial overlaps between shapes
   or standalone text, and browser console errors such as arrow bindings to missing ids.
3. Read the PNG and fix what you see: clipped or cramped text, overlaps, low contrast, arrows that
   miss. Re-render with `--force` until it's clean. Never show a diagram you haven't looked at.
4. `excalidraw open <name>` opens the editor in the user's default browser. That takes focus and
   interrupts them, so do it only when they asked to see the diagram.
5. When the editor is already open, a re-render shows up there within about a second.
6. After the user edits in the browser, `excalidraw snapshot <name>` re-renders the saved scene to
   PNG so you can see their changes; the `.excalidraw` file holds the element data.

Scenes are shared by every agent, so `render` refuses to replace an existing scene unless you pass
`--force`. Even with `--force`, it refuses (exit code 3) if the scene changed since the last render
or snapshot, which usually means the user edited it. Then run `snapshot`, look at the PNG, keep their
changes in your next skeleton, and render again with `--force`. For a new diagram, pick a name no
existing scene uses (`list`).

Other commands: `list`, `stop` (stops the background server), `serve`, `selftest`, `typecheck`.
After changing `server.ts`, run `excalidraw stop`; the next command starts the new server.

Environment overrides: `EXCALIDRAW_SKILL_PORT`, `EXCALIDRAW_SKILL_DATA_DIR`,
`EXCALIDRAW_SKILL_APP_DIR`.

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
  attached when the user moves the shapes. Optional `label`, `strokeStyle:"dashed"`,
  `endArrowhead`/`startArrowhead`.
- Lines: `{"type":"line","x","y","points":[[0,0],[dx,dy]]}`.
- Frames: `{"type":"frame","children":["id1","id2"],"name"}`.
- `fontFamily`: 5 Excalifont (hand-drawn, default), 3 Cascadia (code), 6 Nunito, 2 Helvetica.
- No emoji; Excalidraw's fonts don't render them.

Readable defaults: body text 16 to 18, titles 28 to 32, at least 30px between boxes. Pastel fills
`#a5d8ff #b2f2bb #ffd8a8 #d0bfff #ffc9c9 #fff3bf #c3fae8 #f1f3f5`; strokes `#4a9eed #22c55e
#f59e0b #8b5cf6 #ef4444`; grey secondary text `#757575` (nothing lighter on white).

## Useful Diagrams
Unless told otherwise by the user, the goal is to drive an explanation visually.
By default, your tendency is to create diagrams that are very verbose, and not visually rich,
usually it feels like a text response broken down into colorful rectangles connected by arrows.

Think in terms of timelines, subjects, objects, changes, transformations, creating a consistant
simplified visual language.
