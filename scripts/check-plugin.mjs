import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 源码与 manifest 内容规则由 eslint-plugin-obsidianmd 检查（npm run lint），与社区目录自动审核一致。
// 这里只检查 lint 覆盖不到的发布一致性：版本号、最低版本映射、依赖锁定和目录要求的仓库文件。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = name => readFileSync(path.join(root, name), "utf8");
const readJson = name => JSON.parse(read(name));
const manifest = readJson("manifest.json"), pkg = readJson("package.json"), lock = readJson("package-lock.json"), versions = readJson("versions.json");
const errors = [];
const semver = /^\d+\.\d+\.\d+$/;

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) errors.push("manifest.id must be a valid community plugin ID");
for (const key of ["version", "minAppVersion"]) if (!semver.test(manifest[key])) errors.push(`manifest.${key} must use x.y.z`);
if (manifest.version !== pkg.version || pkg.version !== lock.version || pkg.version !== lock.packages?.[""]?.version) errors.push("manifest, package and lockfile versions must match");
if (versions[manifest.version] !== manifest.minAppVersion) errors.push("versions.json must record the current minimum app version");
for (const group of ["dependencies", "devDependencies"]) {
  if (JSON.stringify(pkg[group] ?? {}) !== JSON.stringify(lock.packages?.[""]?.[group] ?? {})) errors.push(`${group} must match the lockfile root`);
}
for (const name of ["README.md", "LICENSE", "styles.css"]) if (!existsSync(path.join(root, name))) errors.push(`${name} is required in this repository`);
// 目录要求英文说明；0.6.0 改写 README 时曾丢掉英文段落，评分卡随即报缺失。
if (existsSync(path.join(root, "README.md")) && !/^## English\b/m.test(read("README.md"))) errors.push("README.md must keep an \"## English\" section");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Release metadata checks passed (${manifest.id} ${manifest.version}, Obsidian ${manifest.minAppVersion}+).`);
