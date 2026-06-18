import { copyFile, mkdir } from "fs/promises";
import path from "path";

// 部署目标：测试 vault 的插件目录。换 vault 时改这里，或设 LT_VAULT_PLUGIN_DIR 环境变量覆盖。
// 用 Node 拷贝而非 shell `cp`：npm 在 Windows 默认用 cmd 跑脚本，cmd 没有 cp。
const dest =
  process.env.LT_VAULT_PLUGIN_DIR ||
  "D:/Learning/Notes/人生一串/.obsidian/plugins/cobrain";

await mkdir(dest, { recursive: true });
// 只拷构建产物与清单；data.json 是 vault 侧的用户数据（设置+索引），绝不覆盖
for (const f of ["main.js", "manifest.json"]) {
  await copyFile(f, path.join(dest, f));
  console.log(`[deploy] ${f} → ${dest}`);
}
