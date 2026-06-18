import esbuild from "esbuild";
import process from "process";
import path from "path";
import { readFile, writeFile, copyFile } from "fs/promises";

const prod = process.argv[2] === "production";
// 强制打包 transformers 的 web 构建（onnxruntime-web/wasm）。否则在 Electron 渲染进程会落到
// node 构建 → 空壳 onnxruntime-node → InferenceSession 为 undefined。
const transformersWeb = path.resolve("node_modules/@huggingface/transformers/dist/transformers.web.js");

// Electron 渲染进程里 process.release.name==='node' 为真，transformers 因此误判为 Node、
// 走 onnxruntime-node 分支（设备白名单 dml/cpu，后端为空壳）。打包时把这个判断替换成 false，
// 强制走 onnxruntime-web(wasm)。dist web 构建未压缩，字符串原样保留。
const forceTransformersWebEnv = {
  name: "force-transformers-web-env",
  setup(build) {
    build.onLoad({ filter: /transformers\.web\.js$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      const needle = "process?.release?.name === 'node'";
      let patched = src.split(needle).join("false");
      const n = (src.length - patched.length) / (needle.length - "false".length);
      if (n === 0) throw new Error("[force-web] 未找到 node 检测字符串，transformers 版本可能已变");
      // 强制 onnxruntime-web 单线程：否则加载多线程 wasm glue，其 import('worker_threads') 在渲染进程解析失败
      const proxyLine = "ONNX_ENV.wasm.proxy = false";
      if (!patched.includes(proxyLine)) throw new Error("[force-web] 未找到 ONNX_ENV.wasm.proxy，无法注入 numThreads");
      patched = patched.replace(proxyLine, proxyLine + "; ONNX_ENV.wasm.numThreads = 1");
      console.log(`[force-web] IS_NODE_ENV→false（${n} 处）；已注入 wasm.numThreads=1`);
      return { contents: patched, loader: "js" };
    });
  },
};

// 把 onnxruntime-web 的 wasm glue patch 成纯浏览器模式（杜绝 worker_threads），与 .wasm 一起
// 输出到项目根，随插件分发；运行时由插件读成 blob URL 喂给 onnxruntime-web（见 main.ts）。
async function prepareOrtAssets() {
  const dist = "node_modules/@huggingface/transformers/dist";
  const glueName = "ort-wasm-simd-threaded.jsep.mjs";
  const wasmName = "ort-wasm-simd-threaded.jsep.wasm";
  const orig = await readFile(path.join(dist, glueName), "utf8");
  const glue = orig
    .split("typeof globalThis.process?.versions?.node == 'string'").join("false")
    .split('require("worker_threads")').join("({})")
    .split("import('worker_threads')").join("Promise.resolve({})");
  if (glue === orig) throw new Error("[ort-assets] glue patch 未命中，transformers 版本可能已变");
  await writeFile(glueName, glue);
  await copyFile(path.join(dist, wasmName), wasmName);
  console.log("[ort-assets] 已输出 patched glue + wasm 到项目根");
}
await prepareOrtAssets();

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // obsidian/electron 由宿主提供；transformers 体积大但需打进 bundle
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  alias: {
    // 强制 transformers 用 web 构建（见上方 transformersWeb），走 onnxruntime-web
    "@huggingface/transformers": transformersWeb,
    // 兜底：任何对 onnxruntime-node 的引用也指向 web
    "onnxruntime-node": "onnxruntime-web",
  },
  plugins: [forceTransformersWebEnv],
  format: "cjs",
  target: "es2020",
  // transformers.js 走 onnxruntime-web(wasm)：onnxruntime-node 的原生 .node 绑定无法被 esbuild 打包；
  // 且 Obsidian 渲染进程是 Chromium，browser 平台适配 wasm 后端。wasm 与模型首次运行时从 CDN 下载。
  platform: "browser",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
});
if (prod) { await ctx.rebuild(); process.exit(0); }
else { await ctx.watch(); }
