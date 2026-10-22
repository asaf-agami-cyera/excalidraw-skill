import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DIST_DIR, EXCALIDRAW_ASSETS_DIR, PORT, SCENES_DIR, SERVICE_NAME, WEB_DIR, isSceneName, pngPath, scenePath } from "./config.ts";
import type { SceneSummary } from "./web/render-api.ts";

const MAX_BODY_BYTES = 50 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), CONTENT_TYPES[".json"]);
}

async function sendStatic(res: http.ServerResponse, baseDir: string, relative: string): Promise<void> {
  const resolved = path.resolve(baseDir, relative);
  if (!resolved.startsWith(baseDir + path.sep)) {
    send(res, 403, "forbidden");
    return;
  }
  try {
    const body = await fs.readFile(resolved);
    send(res, 200, body, CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream");
  } catch {
    send(res, 404, "not found");
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function sceneMtime(name: string): Promise<number | null> {
  return fileMtime(scenePath(name));
}

async function fileMtime(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

async function listScenes(): Promise<SceneSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(SCENES_DIR);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const names = entries
    .filter((entry) => entry.endsWith(".excalidraw"))
    .map((entry) => entry.slice(0, -".excalidraw".length))
    .filter(isSceneName);
  const scenes = await Promise.all(
    names.map(async (name): Promise<SceneSummary | null> => {
      const mtime = await sceneMtime(name);
      return mtime === null ? null : { name, mtime, pngMtime: await fileMtime(pngPath(name)) };
    }),
  );
  return scenes.filter((scene) => scene !== null).sort((a, b) => b.mtime - a.mtime);
}

async function handleScene(req: http.IncomingMessage, res: http.ServerResponse, name: string, suffix: string): Promise<void> {
  if (!isSceneName(name)) {
    sendJson(res, 400, { error: "invalid scene name" });
    return;
  }
  if (req.method === "GET" && suffix === "/mtime") {
    sendJson(res, 200, { mtime: await sceneMtime(name) });
    return;
  }
  if (req.method === "GET" && suffix === "/png") {
    try {
      send(res, 200, await fs.readFile(pngPath(name)), CONTENT_TYPES[".png"]);
    } catch {
      send(res, 404, "not found");
    }
    return;
  }
  if (req.method === "GET" && suffix === "") {
    try {
      const body = await fs.readFile(scenePath(name), "utf-8");
      res.setHeader("X-Scene-Mtime", String(await sceneMtime(name)));
      send(res, 200, body, CONTENT_TYPES[".json"]);
    } catch {
      sendJson(res, 404, { error: `scene "${name}" not found` });
    }
    return;
  }
  if (req.method === "PUT" && suffix === "") {
    const body = await readBody(req);
    JSON.parse(body);
    await fs.mkdir(SCENES_DIR, { recursive: true });
    const target = scenePath(name);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, target);
    sendJson(res, 200, { mtime: await sceneMtime(name) });
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  if (pathname === "/" || pathname === "/index.html") {
    await sendStatic(res, WEB_DIR, "index.html");
    return;
  }
  if (pathname.startsWith("/dist/")) {
    await sendStatic(res, DIST_DIR, decodeURIComponent(pathname.slice("/dist/".length)));
    return;
  }
  if (pathname.startsWith("/assets/")) {
    await sendStatic(res, EXCALIDRAW_ASSETS_DIR, decodeURIComponent(pathname.slice("/assets/".length)));
    return;
  }
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: SERVICE_NAME, pid: process.pid });
    return;
  }
  if (pathname === "/api/shutdown" && req.method === "POST") {
    res.on("finish", () => process.exit(0));
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/api/scenes" && req.method === "GET") {
    sendJson(res, 200, await listScenes());
    return;
  }
  const sceneMatch = /^\/api\/scenes\/([^/]+)(\/mtime|\/png)?$/.exec(pathname);
  if (sceneMatch) {
    await handleScene(req, res, decodeURIComponent(sceneMatch[1] ?? ""), sceneMatch[2] ?? "");
    return;
  }
  send(res, 404, "not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error(`${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: String(err) });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`excalidraw-local server listening on http://127.0.0.1:${PORT} (pid ${process.pid})`);
});
