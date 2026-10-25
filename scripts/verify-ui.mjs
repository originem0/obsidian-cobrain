import { build } from "esbuild";
import { readFile, writeFile, mkdir, mkdtemp, access } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".audit", "ui");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "tests/browser/harness.ts")], bundle: true, format: "esm", target: "chrome110",
  outfile: path.join(output, "harness.js"),
  plugins: [{ name: "obsidian-browser-host", setup(builder) { builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "tests/browser/obsidian.ts") })); } }],
});
const candidates = [process.env.COBRAIN_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
let browserPath;
for (const candidate of candidates) { try { await access(candidate); browserPath = candidate; break; } catch {} }
if (!browserPath) throw new Error("Chrome/Edge not found. Set COBRAIN_CHROME to an existing browser; no packages are downloaded.");
const server = createServer(async (request, response) => {
  const routes = {
    "/": ["tests/browser/host.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/harness.js": [".audit/ui/harness.js", "text/javascript; charset=utf-8"],
  };
  const route = routes[request.url];
  if (!route) { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { "Content-Type": route[1] }); response.end(await readFile(path.join(root, route[0]))); }
  catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(path.join(output, "profile-"));
const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "about:blank"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let browserLog = "";
browser.stderr.on("data", data => { browserLog = (browserLog + data).slice(-5000); });
browser.stdout.on("data", () => {});
let socket;
try {
  let port;
  const deadline = Date.now() + 15000;
  while (!port) {
    if (browser.exitCode !== null) throw new Error(`Browser exited: ${browserLog}`);
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
    catch { if (Date.now() > deadline) throw new Error(`DevTools startup timed out: ${browserLog}`); await new Promise(r => setTimeout(r, 100)); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === "page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map(), exceptions = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.id) {
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  const readyDeadline = Date.now() + 10000;
  while (!await evaluate("window.uiReady === true")) {
    if (Date.now() > readyDeadline) throw new Error(`UI did not start: ${JSON.stringify(exceptions)}`);
    await new Promise(r => setTimeout(r, 100));
  }
  const checks = await evaluate("window.runTests()");
  await evaluate("window.seedScreenshot()");
  const layouts = [];
  for (const size of [
    { name: "mobile-320", width: 320, height: 640, mobile: true },
    { name: "mobile-390", width: 390, height: 844, mobile: true },
    { name: "mobile-keyboard", width: 320, height: 360, mobile: true },
    { name: "desktop-480", width: 480, height: 900, mobile: false },
    { name: "mobile-dark", width: 390, height: 844, mobile: true, dark: true },
  ]) {
    await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
    await evaluate(`window.setMobile(${size.mobile}); document.body.classList.toggle("dark", ${!!size.dark});`);
    await new Promise(r => setTimeout(r, 80));
    const layout = await evaluate("window.layout()");
    if (layout.overflow || !layout.composerVisible || layout.inputWidth < 150 || layout.sendHeight < 44) throw new Error(`${size.name} layout failed: ${JSON.stringify(layout)}`);
    layouts.push({ name: size.name, ...layout });
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path.join(output, `${size.name}.png`), Buffer.from(shot.data, "base64"));
  }
  const settingsLayouts = [];
  for (const size of [
    { name: "settings-desktop", width: 1000, height: 720, mobile: false },
    { name: "settings-mobile", width: 390, height: 844, mobile: true },
    { name: "settings-small", width: 320, height: 360, mobile: true },
    { name: "settings-constrained", width: 480, height: 640, mobile: false, constrained: true },
  ]) {
    await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
    await evaluate(`window.setMobile(${size.mobile}); window.openSettingsTest(${!!size.constrained});`);
    const target = await evaluate("window.settingsScrollTarget()");
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...target, deltaX: 0, deltaY: 600 });
    await new Promise(r => setTimeout(r, 100));
    const layout = await evaluate("window.settingsLayout()");
    settingsLayouts.push({ name: size.name, ...layout });
    console.log(`${size.name}: ${JSON.stringify(layout)}`);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path.join(output, `${size.name}.png`), Buffer.from(shot.data, "base64"));
    if (!layout.wheelMoved || !layout.canScroll || !layout.lastControlVisible || !layout.controlsFit || layout.openPanels !== 9) throw new Error(`${size.name} settings layout failed: ${JSON.stringify(layout)}`);
    await evaluate("window.closeSettingsTest()");
  }
  if (exceptions.length) throw new Error(`Browser exceptions: ${JSON.stringify(exceptions)}`);
  const report = { checks, layouts, settingsLayouts, note: "Actual view/settings/store/Tutor in a browser-only Obsidian host adapter; device sizes and reduced keyboard viewport are emulated, not a physical phone." };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await send("Browser.close").catch(() => {});
} finally {
  socket?.close();
  if (browser.exitCode === null) browser.kill();
  server.close();
}
