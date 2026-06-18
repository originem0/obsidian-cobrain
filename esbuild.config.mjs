import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // obsidian/electron 由宿主提供；transformers 体积大但需打进 bundle
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
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
