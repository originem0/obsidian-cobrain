import { copyFile, mkdir } from "fs/promises";
import path from "path";

// 部署目标：测试 vault 的插件目录。必须显式设置，避免把构建产物误拷到旧 vault。
// 用 Node 拷贝而非 shell `cp`：npm 在 Windows 默认用 cmd 跑脚本，cmd 没有 cp。
const dest = process.env.LT_VAULT_PLUGIN_DIR;

if (!dest) {
  throw new Error("请先设置 LT_VAULT_PLUGIN_DIR，指向目标 vault 的插件目录，例如 <vault>/.obsidian/plugins/cobrain");
}

const resolvedDest = path.resolve(dest);
const parts = resolvedDest.split(path.sep).map(p => p.toLowerCase());
if (
  parts.at(-1) !== "cobrain" ||
  parts.at(-2) !== "plugins" ||
  parts.at(-3) !== ".obsidian"
) {
  throw new Error(`拒绝部署到非 Cobrain 插件目录：${resolvedDest}`);
}

await mkdir(dest, { recursive: true });
// 只拷构建产物与清单；data.json 是 vault 侧的用户数据（设置+索引），绝不覆盖
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(f, path.join(resolvedDest, f));
  console.log(`[deploy] ${f} → ${resolvedDest}`);
}
