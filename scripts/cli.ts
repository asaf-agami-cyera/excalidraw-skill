import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { openSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { BASE_URL, DATA_DIR, DIST_DIR, PORT, ROOT, SCENES_DIR, SERVER_LOG, SERVICE_NAME, pngPath, scenePath, seenPath } from "./config.ts";
import type { RenderInput, RenderOutput } from "./web/render-api.ts";

const USAGE = `excalidraw: draw Excalidraw diagrams locally, check them as PNG, and open them in the browser.

Usage:
  excalidraw render <name> <skeleton.json|-> [--force]
                                              Convert an element skeleton to a scene + PNG. Refuses to
                                              replace an existing scene without --force, and refuses
                                              even with --force if it was edited since the last
                                              render or snapshot.
  excalidraw snapshot <name>                  Re-render the saved scene (including browser edits) to PNG
                                              and mark its current state as seen
  excalidraw open <name>                      Open the scene in the browser editor (edits auto-save)
  excalidraw list                             List saved scenes
  excalidraw serve                            Run the local server in the foreground
  excalidraw stop                             Stop the background server

Scenes live in ${SCENES_DIR}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) {
      return false;
    }
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "service" in body && body.service === SERVICE_NAME) {
      return true;
    }
    throw new Error(`port ${PORT} is used by another program; set EXCALIDRAW_SKILL_PORT to a free port`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`port ${PORT}`)) {
      throw err;
    }
    return false;
  }
}

async function ensureBuilt(): Promise<void> {
  try {
    await fs.access(path.join(DIST_DIR, "app.js"));
  } catch {
    throw new Error(`web bundle missing; run the scripts/excalidraw wrapper, which installs and builds on first use`);
  }
}

async function ensureServer(): Promise<void> {
  await ensureBuilt();
  if (await serverUp()) {
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const log = openSync(SERVER_LOG, "a");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "server.ts")], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await serverUp()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`server did not start; see ${SERVER_LOG}`);
}

async function readInput(source: string): Promise<string> {
  if (source !== "-") {
    return fs.readFile(source, "utf-8");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Prefer an installed Google Chrome (no download needed); fall back to Playwright's own Chromium.
async function launchHeadless(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (chromeErr) {
    try {
      return await chromium.launch({ headless: true });
    } catch (bundledErr) {
      throw new Error(
        "no headless browser available. Install Google Chrome, or run " +
          `"npx --prefix ${ROOT} playwright install chromium --only-shell".\n` +
          `chrome: ${String(chromeErr)}\nplaywright chromium: ${String(bundledErr)}`,
      );
    }
  }
}

async function renderInBrowser(input: RenderInput): Promise<RenderOutput> {
  await ensureServer();
  const browser = await launchHeadless();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleErrors.push(`[browser ${msg.type()}] ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => consoleErrors.push(`[browser exception] ${err.message}`));
    await page.goto(`${BASE_URL}/?mode=render`);
    await page.waitForFunction(() => typeof window.excalidrawRender === "function");
    const output = await page.evaluate(async (arg) => {
      const fn = window.excalidrawRender;
      if (!fn) {
        const missing: RenderOutput = { ok: false, error: "render hook missing" };
        return missing;
      }
      return fn(arg);
    }, input);
    if (output.ok) {
      return { ...output, warnings: [...consoleErrors, ...output.warnings] };
    }
    return { ok: false, error: [output.error, ...consoleErrors].join("\n") };
  } finally {
    await browser.close();
  }
}

async function writeResult(name: string, output: RenderOutput, writeScene: boolean): Promise<boolean> {
  if (!output.ok) {
    console.error(`render failed:\n${output.error}`);
    return false;
  }
  await fs.mkdir(SCENES_DIR, { recursive: true });
  if (writeScene) {
    const target = scenePath(name);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, output.sceneJson);
    await fs.rename(tmp, target);
    console.log(`scene: ${target}`);
  }
  await fs.writeFile(seenPath(name), sceneFingerprint(output.sceneJson));
  await fs.writeFile(pngPath(name), Buffer.from(output.pngBase64, "base64"));
  console.log(`png:   ${pngPath(name)}`);
  if (output.warnings.length > 0) {
    console.log(`warnings (${output.warnings.length}):`);
    for (const warning of output.warnings) {
      console.log(`  - ${warning}`);
    }
  } else {
    console.log("warnings: none");
  }
  return true;
}

// Identifies the element state of a scene. Excalidraw bumps an element's `version` on every edit,
// and the editor re-saving an unchanged scene keeps the versions, so this ignores no-op saves.
function sceneFingerprint(sceneJson: string): string {
  const parsed: unknown = JSON.parse(sceneJson);
  if (typeof parsed !== "object" || parsed === null || !("elements" in parsed) || !Array.isArray(parsed.elements)) {
    throw new Error("scene has no elements array");
  }
  const entries: string[] = [];
  for (const el of parsed.elements) {
    if (typeof el === "object" && el !== null && "id" in el && "version" in el) {
      const deleted = "isDeleted" in el && el.isDeleted === true;
      entries.push(`${String(el.id)}:${String(el.version)}:${deleted ? "d" : ""}`);
    }
  }
  return entries.sort().join("\n");
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

// Shared by every agent, so never replace a scene by accident, and never replace edits nobody
// has looked at.
async function overwriteRefusal(name: string, force: boolean): Promise<string | null> {
  const current = await readOptional(scenePath(name));
  if (current === null) {
    return null;
  }
  if (!force) {
    return `scene "${name}" already exists. Pick another name, or pass --force to replace it.`;
  }
  const seen = await readOptional(seenPath(name));
  if (seen !== sceneFingerprint(current)) {
    return (
      `scene "${name}" changed since it was last rendered or snapshotted (probably edited by Asaf in the browser). ` +
      `Run "excalidraw snapshot ${name}" and look at the edits first, then render again with --force.`
    );
  }
  return null;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "render": {
      const force = args.includes("--force");
      const [name, source] = args.filter((arg) => arg !== "--force");
      if (!name || !source) {
        console.error(USAGE);
        return 2;
      }
      const refusal = await overwriteRefusal(name, force);
      if (refusal) {
        console.error(refusal);
        return 3;
      }
      const parsed: unknown = JSON.parse(await readInput(source));
      return (await writeResult(name, await renderInBrowser({ kind: "skeleton", elements: parsed }), true)) ? 0 : 1;
    }
    case "snapshot": {
      const [name] = args;
      if (!name) {
        console.error(USAGE);
        return 2;
      }
      const sceneJson = await fs.readFile(scenePath(name), "utf-8");
      return (await writeResult(name, await renderInBrowser({ kind: "scene", sceneJson }), false)) ? 0 : 1;
    }
    case "open": {
      const [name] = args;
      if (!name) {
        console.error(USAGE);
        return 2;
      }
      await fs.access(scenePath(name));
      await ensureServer();
      const url = `${BASE_URL}/?scene=${encodeURIComponent(name)}`;
      const [opener, ...openerArgs] =
        process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
      const child = spawn(opener ?? "open", openerArgs, { stdio: "inherit" });
      const code = await new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(null));
        child.on("close", resolve);
      });
      console.log(code === 0 ? `opened ${url}` : `could not launch a browser; open ${url} manually`);
      return code ?? 1;
    }
    case "list": {
      const entries = await fs.readdir(SCENES_DIR).catch(() => []);
      for (const entry of entries.filter((e) => e.endsWith(".excalidraw")).sort()) {
        console.log(entry.replace(/\.excalidraw$/, ""));
      }
      return 0;
    }
    case "serve": {
      await ensureBuilt();
      await import("./server.ts");
      return new Promise<number>(() => {});
    }
    case "stop": {
      if (!(await serverUp())) {
        console.log("server not running");
        return 0;
      }
      await fetch(`${BASE_URL}/api/shutdown`, { method: "POST" });
      console.log("server stopped");
      return 0;
    }
    default:
      console.log(USAGE);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
