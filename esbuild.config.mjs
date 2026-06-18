import esbuild from "esbuild";
import process from "process";
import path from "path";

const prod = process.argv[2] === "production";
// 强制打包 transformers 的 web 构建（onnxruntime-web/wasm）。否则在 Electron 渲染进程会落到
// node 构建 → 空壳 onnxruntime-node → InferenceSession 为 undefined。
const transformersWeb = path.resolve("node_modules/@huggingface/transformers/dist/transformers.web.js");
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
