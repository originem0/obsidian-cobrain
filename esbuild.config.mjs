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
  platform: "node",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
});
if (prod) { await ctx.rebuild(); process.exit(0); }
else { await ctx.watch(); }
