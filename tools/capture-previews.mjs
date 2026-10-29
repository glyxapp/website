// Captures catalog/previews/*.jpg from a real Glyx: every template as a full window, every
// widget and widget source on its own. Runs a second, isolated Glyx (a dev build) with its own
// config folder, so the user's dashboard is never touched.
//
//   node tools/capture-previews.mjs <path to a debug glyx.exe> [only-id ...]
//
// Needs Python with PyYAML (as tools/build.py does). Run tools/build.py afterwards.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 9334;
const exe = process.argv[2];
const only = new Set(process.argv.slice(3));
if (!exe || !fs.existsSync(exe)) {
  console.error("usage: node tools/capture-previews.mjs <glyx.exe> [only-id ...]");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = path.join(ROOT, "catalog/previews");
fs.mkdirSync(out, { recursive: true });

// An empty config folder and WebView2 profile, plus the widget sources from sources/.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "glyx-capture-"));
const configDir = path.join(work, "config");
fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
for (const id of fs.readdirSync(path.join(ROOT, "sources"))) {
  fs.cpSync(path.join(ROOT, "sources", id), path.join(configDir, "plugins", id), { recursive: true });
}
const configFile = path.join(configDir, "glyx.json");

/** Previews show the window itself: normal mode, opaque, no tray or overlay labels. */
function writeConfig(cfg) {
  const { label, ...rest } = cfg;
  rest.window = { ...rest.window, mode: "normal", opacity: 1, backdrop: "none" };
  // Previews are public: keep the local session folders of the AI usage widget out of them.
  for (const w of (rest.pages || []).flatMap((p) => (p.columns || []).flatMap((c) => c.widgets || []))) {
    if (w.plugin === "glyx.ai-usage") w.config = { ...w.config, showSessions: false };
    // News photos belong to their publishers; the previews show headlines only.
    if (w.plugin === "glyx.rss") w.config = { ...w.config, showImages: false };
  }
  fs.writeFileSync(configFile, JSON.stringify(rest, null, 2));
}
const yamlToJson = (file) =>
  JSON.parse(execFileSync("python", ["-c", "import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1],encoding='utf-8'))))", file], { encoding: "utf8" }));

writeConfig({ pages: [{ name: "Preview", columns: [] }] });
const app = spawn(exe, [], {
  env: {
    ...process.env,
    GLYX_CONFIG_DIR: configDir,
    WEBVIEW2_USER_DATA_FOLDER: path.join(work, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: "ignore",
});

// Chrome DevTools Protocol on the Glyx window.
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  await sleep(1000);
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
}
if (!ws) throw new Error("Glyx did not start");
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
};
const call = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

/** Writes the config, waits for Glyx to reload it and for the widgets to show data. */
async function show(cfg, settle) {
  const before = await evaluate("document.querySelectorAll('.widget').length + ':' + performance.now()");
  writeConfig(cfg);
  await sleep(1500);
  for (let i = 0; i < 30; i++) {
    const loading = await evaluate("[...document.querySelectorAll('.widget')].filter(w => w.dataset.status === 'loading').length");
    if (loading === 0) break;
    await sleep(500);
  }
  await sleep(settle);
  // Nothing but the dashboard: close Settings, drawers or dialogs if anything opened them.
  await evaluate("document.querySelectorAll('.appset, .drawer, .modal, .scrim, .gal').forEach((e) => e.remove())");
  // And no hover state from wherever the real mouse is.
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1279, y: 799 });
  return before;
}

async function shoot(file, clip) {
  const params = { format: "jpeg", quality: 82, captureBeyondViewport: false };
  if (clip) params.clip = { ...clip, scale: 1 };
  const { data } = await call("Page.captureScreenshot", params);
  fs.writeFileSync(path.join(out, file), Buffer.from(data, "base64"));
  console.log("saved", file);
}

const src = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/catalog.src.json"), "utf8"));
const want = (id) => !only.size || only.has(id);

for (const t of src.templates.filter((t) => want(t.id))) {
  await show(yamlToJson(path.join(ROOT, "catalog/templates", `${t.id}.yml`)), 20000);
  // A narrow template is cropped to its widgets (keeping 16:10) instead of showing empty space.
  const right = await evaluate("Math.max(...[...document.querySelectorAll('.widget')].map((w) => w.getBoundingClientRect().right))");
  const width = right < 960 ? Math.max(640, Math.ceil(right) + 16) : 1280;
  await shoot(`template-${t.id}.jpg`, width < 1280 ? { x: 0, y: 0, width, height: Math.round(width / 1.6) } : null);
}

/** One widget alone in a medium column, captured with a small margin. */
async function widget(file, w, theme) {
  await show({ theme: { preset: theme || "dark" }, pages: [{ name: "Preview", columns: [{ size: "medium", widgets: [w] }] }] }, 4000);
  const r = await evaluate("(() => { const b = document.querySelector('.widget').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()");
  const pad = 12;
  await shoot(file, { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: Math.min(r.height, 560) + 2 * pad });
}

for (const w of src.widgets.filter((w) => want(w.id))) {
  await widget(`widget-${w.id}.jpg`, JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/widgets", `${w.id}.json`), "utf8")));
}
for (const s of src.sources.filter((s) => want(s.id))) {
  await widget(`source-${s.id}.jpg`, { plugin: s.id });
}

app.kill();
await sleep(1000);
// WebView2 may hold its profile a moment longer; the folder is in the temp dir either way.
try {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch {}
process.exit(0);
