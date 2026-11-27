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

// Sample tasks and notes, so a preview shows a list in use rather than "Nothing to do". Only the
// previews have them: an imported template starts empty.
{
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/preview-data.json"), "utf8"));
  const now = Date.now();
  const files = {
    "glyx.todo": Object.fromEntries(Object.entries(sample["glyx.todo"]).map(([key, items]) => [
      key,
      items.map((it, i) => ({
        id: `sample${i}`,
        text: it.text,
        done: it.done,
        at: now - it.ago * 60_000,
        ...(it.done ? { doneAt: now - (it.ago - 20) * 60_000 } : {}),
      })),
    ])),
    "glyx.notes": Object.fromEntries(Object.entries(sample["glyx.notes"]).map(([key, text]) => [key, { text, at: now - 3_600_000 }])),
    // Habits keep the days they were done as day numbers (days since 1970 of the local date);
    // the sample says how many days ago, so the streaks end today whenever this runs.
    "glyx.habits": Object.fromEntries(Object.entries(sample["glyx.habits"]).map(([key, items]) => {
      const local = new Date(now);
      const today = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000;
      return [key, items.map((it, i) => ({
        id: `sample${i}`,
        name: it.name,
        ...(it.times ? { times: it.times } : {}),
        days: it.done.map((ago) => today - ago),
        from: today - 30,
        at: now - 3_600_000,
      }))];
    })),
  };
  fs.mkdirSync(path.join(configDir, "data"), { recursive: true });
  for (const [plugin, doc] of Object.entries(files)) fs.writeFileSync(path.join(configDir, "data", `${plugin}.json`), JSON.stringify(doc));
}

/** Previews show the window itself: normal mode, opaque, no tray or overlay labels. */
function writeConfig(cfg) {
  const { label, ...rest } = cfg;
  rest.window = { ...rest.window, mode: "normal", opacity: 1, backdrop: "none" };
  // Previews are public: keep the local session folders of the AI usage widget out of them.
  const widgets = (p) => [...(p.widgets || []), ...(p.columns || []).flatMap((c) => c.widgets || [])];
  for (const w of (rest.pages || []).flatMap(widgets)) {
    if (w.plugin === "glyx.ai-usage") w.config = { ...w.config, showSessions: false };
    // News photos belong to their publishers; the previews show headlines only.
    if (w.plugin === "glyx.rss") w.config = { ...w.config, showImages: false };
    // What is playing on this PC is nobody's business: an empty card rather than your music.
    if (w.plugin === "glyx.media") w.hidden = true;
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
  await evaluate("document.querySelectorAll('.appset, .drawer, .modal, .scrim, .gal, .lab, #toast > *').forEach((e) => e.remove())");
  // Nor the banner, which reports problems of this PC's Glyx (a plugin in the works that does not
  // load), not of the template. A resize makes the page fit the room it gives back.
  if (await evaluate("(() => { const b = document.getElementById('banner'); if (!b || b.hidden) return false; b.hidden = true; dispatchEvent(new Event('resize')); return true; })()")) await sleep(1500);
  // And no hover state from wherever the real mouse is: the window ignores the pointer from now
  // on (it may sit over the window while this runs), and the last one it saw is in a corner.
  await evaluate("document.getElementById('no-pointer') || document.head.insertAdjacentHTML('beforeend', '<style id=\"no-pointer\">html, body, iframe { pointer-events: none !important }</style>')");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1279, y: 799 });
  await scrub();
  // Pictures (release logos, weather icons) are still loading in some frames on a cold start.
  // A picture that failed (github.com/<owner>.png can take 10 s or answer 504) is asked for again,
  // up to three times; Releases hides a logo that failed, so it is shown again too.
  const sum = (values) => values.reduce((a, b) => a + (b || 0), 0);
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 40; i++) {
      if (!sum(await inFrames("[...document.images].filter((i) => i.currentSrc && !i.complete).length"))) break;
      await sleep(500);
    }
    if (round === 3) break;
    const retried = sum(await inFrames(`[...document.images].filter((i) => i.currentSrc && i.complete && !i.naturalWidth).map((i) => {
      const url = new URL(i.src);
      url.searchParams.set("retry", "${round + 1}");
      i.onload = () => (i.style.visibility = "");
      i.src = url.href;
    }).length`));
    if (!retried) break;
    await sleep(1000);
  }
  return before;
}

/** Evaluates `expression` in every plugin frame, in or out of the window's process. */
async function inFrames(expression) {
  const values = [];
  const frames = [];
  const walk = (node) => {
    if (node.frame.url.startsWith("http://plugin.localhost")) frames.push(node.frame.id);
    (node.childFrames || []).forEach(walk);
  };
  walk((await call("Page.getFrameTree")).frameTree);
  for (const frameId of frames) {
    const world = await call("Page.createIsolatedWorld", { frameId, worldName: "preview-wait" });
    if (world?.executionContextId) values.push((await call("Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true })).result?.value);
  }
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  for (const t of targets.filter((t) => t.type === "iframe" && t.url.startsWith("http://plugin.localhost"))) {
    const sock = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (sock.onopen = r));
    values.push(await new Promise((r) => {
      sock.onmessage = (m) => r(JSON.parse(m.data).result?.result?.value);
      sock.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    }));
    sock.close();
  }
  return values;
}

// Previews are public: the Network widget shows this PC's IP address, so every address in its
// frame becomes a stand-in, also when it redraws. Other widgets keep theirs (Monitor's 1.1.1.1).
const SCRUB = `(() => {
  const ip = /\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b|\\b(?:[0-9a-f]{1,4}:){2,7}:?[0-9a-f]{1,4}\\b/gi;
  const run = () => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode()); ) {
      const text = n.data.replace(ip, "192.168.1.20");
      if (text !== n.data) n.data = text;
    }
  };
  run();
  new MutationObserver(run).observe(document.body, { subtree: true, childList: true, characterData: true });
  return true;
})()`;
const PRIVATE = ["glyx.network"];

async function scrub() {
  const frames = [];
  const walk = (node) => {
    if (PRIVATE.some((id) => node.frame.url.includes(id))) frames.push(node.frame.id);
    (node.childFrames || []).forEach(walk);
  };
  walk((await call("Page.getFrameTree")).frameTree);
  for (const frameId of frames) {
    const world = await call("Page.createIsolatedWorld", { frameId, worldName: "preview-scrub" });
    if (world?.executionContextId) await call("Runtime.evaluate", { expression: SCRUB, contextId: world.executionContextId });
  }
  // Out-of-process frames are targets of their own.
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  for (const t of targets.filter((t) => t.type === "iframe" && PRIVATE.some((id) => t.url.includes(id)))) {
    const sock = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (sock.onopen = r));
    await new Promise((r) => {
      sock.onmessage = r;
      sock.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: SCRUB } }));
    });
    // Closing the socket would not undo the observer: it lives in the page.
    sock.close();
  }
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
  // Wide enough for its widgets and tall enough for all of them, whichever needs the larger crop.
  const box = await evaluate("(() => { const r = [...document.querySelectorAll('.widget')].map((w) => w.getBoundingClientRect()); return { right: Math.max(...r.map((b) => b.right)), bottom: Math.max(...r.map((b) => b.bottom)) }; })()");
  const width = box.right < 960 ? Math.min(1280, Math.max(640, Math.ceil(box.right) + 16, Math.ceil((box.bottom + 16) * 1.6))) : 1280;
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
