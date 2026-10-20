// Self-test: render a skeleton headlessly, then check the editor auto-saves edits and picks up
// files rewritten by the CLI while it is open. Run: node --disable-warning=ExperimentalWarning selftest.ts
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { BASE_URL, ROOT, pngPath, scenePath, seenPath } from "./config.ts";

const NAME = "selftest";
const cli = (args: string[], input?: string): string =>
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "cli.ts"), ...args], {
    encoding: "utf-8",
    input,
  });
const cliStatus = (args: string[], input?: string): number | null =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "cli.ts"), ...args], {
    encoding: "utf-8",
    input,
  }).status;

const twoBoxes = JSON.stringify([
  { type: "rectangle", id: "a", x: 0, y: 0, width: 160, height: 70, label: { text: "A" } },
  { type: "rectangle", id: "b", x: 300, y: 0, width: 160, height: 70, label: { text: "B" } },
  { type: "arrow", id: "ab", x: 0, y: 0, start: { id: "a" }, end: { id: "b" } },
]);
const oneBox = JSON.stringify([{ type: "ellipse", id: "c", x: 0, y: 0, width: 120, height: 80 }]);

async function savedCount(): Promise<number> {
  const parsed: unknown = JSON.parse(await fs.readFile(scenePath(NAME), "utf-8"));
  if (typeof parsed === "object" && parsed !== null && "elements" in parsed && Array.isArray(parsed.elements)) {
    return parsed.elements.length;
  }
  throw new Error("scene file has no elements array");
}

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
  if (!ok) {
    process.exitCode = 1;
  }
}

const shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "excalidraw-selftest-"));
const cleanup = async (): Promise<void> => {
  for (const file of [scenePath(NAME), pngPath(NAME), seenPath(NAME)]) {
    await fs.rm(file, { force: true });
  }
};
await cleanup();
console.log(cli(["render", NAME, "-"], twoBoxes).trim());
const initial = await savedCount();
check("render", initial === 5, `${initial} elements (2 boxes + 2 labels + arrow)`);
const plainRerun = cliStatus(["render", NAME, "-"], oneBox);
check("refuses to replace without --force", plainRerun === 3, `exit ${plainRerun}`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(m.text());
    }
  });
  await page.goto(`${BASE_URL}/?scene=${NAME}`);
  await page.waitForSelector("canvas.interactive", { timeout: 15000 });
  await page.waitForTimeout(1000);
  const shown = await page.evaluate(() => window.excalidrawEditorApi?.getSceneElements().length ?? -1);
  check("editor loads scene", shown === initial, `${shown} elements shown`);

  const afterLoad = cliStatus(["render", NAME, "-", "--force"], twoBoxes);
  check("opening the editor doesn't count as an edit", afterLoad === 0, `render --force exit ${afterLoad}`);
  await page.waitForTimeout(2500);

  await page.mouse.click(1000, 150);
  await page.keyboard.press("r");
  await page.mouse.move(800, 600);
  await page.mouse.down();
  await page.mouse.move(950, 700, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const afterEdit = await savedCount();
  check("editor auto-saves", afterEdit === initial + 1, `${afterEdit} elements on disk after drawing a rectangle`);

  const unseenEdit = cliStatus(["render", NAME, "-", "--force"], oneBox);
  check("refuses to replace unseen edits even with --force", unseenEdit === 3, `exit ${unseenEdit}`);
  cli(["snapshot", NAME]);
  cli(["render", NAME, "-", "--force"], oneBox);
  await page.waitForTimeout(2500);
  const reloaded = await page.evaluate(() => window.excalidrawEditorApi?.getSceneElements().length ?? -1);
  check("editor picks up re-render", reloaded === 1, `${reloaded} elements shown after CLI re-render`);
  await page.screenshot({ path: path.join(shotDir, "editor.png") });
  check("no browser errors", errors.length === 0, errors.join(" | ") || "none");
  console.log(`screenshot: ${path.join(shotDir, "editor.png")}`);
} finally {
  await browser.close();
  await cleanup();
}
