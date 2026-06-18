import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

// 纯 TS 插件打包。嵌入早已改走云端 API（ApiEmbedder），不再依赖 transformers.js/onnxruntime-web，
// 故无需任何 wasm 处理或 web 构建 patch（曾经那套已随本提交删除）。
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // obsidian/electron 由宿主提供，标记为 external 不打进 bundle
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  platform: "browser",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
});
if (prod) { await ctx.rebuild(); process.exit(0); }
else { await ctx.watch(); }
