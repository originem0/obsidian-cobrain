# Cobrain 索引分片（per-note shards）

> 设计文档 · 2026-06-19 · 工作流 #6：把单一 index.json 拆成每篇笔记一个小分片，根治大文件同步失败 + 写放大

## Context

索引现为单一 `index.json`（量化后 ~10MB，随 vault 增长，274 篇 4723 chunk）。两个结构性问题：① 桌面端每改一篇笔记就**整文件重写**整份索引（写放大）；② 用 Remotely Save / OneDrive 同步这个**大单文件**不稳，已出现 `size not matched`，且文件只会越来越大。但移动端检索（Cobrain 的命根子）依赖这份索引同步过去，不能简单"不同步"。

解法：索引拆成 `index/` 目录下**每篇笔记一个小分片**。检索（内存 `query`/`topK`）零改动；只动持久化层。已核实 `DataAdapter` 提供 `list`/`read`/`write`/`remove`/`mkdir`/`rmdir`（`obsidian.d.ts`）。

已定方案（brainstorming）：**每篇一个分片**（非 N 篇打包——打包会请回写放大且有扩展悬崖）；**64 位哈希文件名**（非可读路径——路径含 `/`/中文/特殊字符，做文件名跨平台 + 经 OneDrive 同步不安全；可读性损失用"分片内存 path"补）。

## 目标 / 非目标

**目标**
- 索引存为 `…/cobrain/index/<hash64(笔记路径)>.json`，每篇一个；外加 `…/cobrain/index/meta.json`（`{ v:3, embedModel }`）。
- 改一篇只写它那个分片（消灭写放大）；删一篇删它的分片。
- 一次性迁移：旧 `index.json` → 分片 + meta → 删旧文件。
- 移动端沿用 #3 只读：读全部分片做检索，所有写入 no-op。
- 检索 / 对话 / 重建索引命令等行为对用户不变。

**非目标（YAGNI）**
- N 篇打包 / 动态再平衡（上万篇时再说）。
- 可读路径文件名。
- 改检索算法、量化格式（分片内沿用 v2 的 int8 `{scale,q}`）。
- 改 `deploy.mjs`（索引是 vault 侧数据，不随构建分发）。

## 设计

### ① 分片布局
- `index/<hash64(path)>.json` = 单篇笔记：`{ path, mtime, hash, entries: [{ chunkIdx, text, heading, scale, q }] }`。
- `index/meta.json` = `{ v: 3, embedModel }`。**刻意不用 `_` 前缀**（你 Remotely Save 排除 `_`/`.` 开头）——`index/`、`<hex>.json`、`meta.json` 都不以 `.`/`_` 开头，走现有 `^\.obsidian/` 允许规则正常同步。
- `hash64`：两遍不同种子的 32 位 FNV-1a 拼成 16-hex，碰撞在任何现实规模可忽略（堵掉"撞了悄悄丢一篇"）。

### ② 读 / 写
- **加载**（`IndexStore.load()`）：
  - `index/` 存在 → `list` 列出 `*.json`（除 `meta.json`），逐个 `read` → `store.deserializeFile(payload)` 合并进同一内存 store；读 `meta.json` 取 `embedModel`。
  - 否则旧 `index.json` 存在 → **迁移**：读入 `store.deserialize(整份)` → `saveAll()` 写出分片 + meta → `remove` 旧 `index.json`。
  - 都没有 → 空索引。
- **改一篇**（`saveFile(path)`）：`store.serializeFile(path)` 得单篇 payload；有内容 → 写 `index/<hash64>.json`；无内容 → 删该分片。
- **删一篇**（`removeFile(path)`）：删 `index/<hash64>.json`。
- **全量**（`saveAll()`）：`mkdir index/`；对 `store.allPaths()` 逐个 `saveFile`；写 `meta.json`；**清孤儿**：`list` 现有分片，删掉不对应任何当前笔记的 `<hex>.json`。
- **换嵌入模型**：`load()` 比对 `meta.embedModel` 与 `settings.embedModel`，不一致 → 清空 store + 删 `index/` 全部分片 + Notice 提示重建。

### ③ 移动端（沿用 #3 只读）
`IndexStore` 的所有写方法（`saveFile`/`removeFile`/`saveAll`/写 meta）在 `Platform.isMobile` 时直接 return。移动端只 `load()` 读分片做检索，绝不写——杜绝双写冲突与"空索引回传"。

### ④ 代码组织
- 新 `src/rag/indexStore.ts`：持久化层（`load`/`saveFile`/`removeFile`/`saveAll`/`clearAll` + 迁移 + `index/` 目录解析 + 移动端守卫），用 `app.vault.adapter`。
- `src/util/hash.ts`：加 `fnv1a64(str): string`（纯函数，可测）。
- `src/rag/vectorStore.ts`：加 `serializeFile(path): {path,mtime,hash,entries} | null` 与 `deserializeFile(payload)`（单篇，**纯函数可测**）；保留现有 `serialize`/`deserialize`（迁移读整份用）。
- `src/rag/indexer.ts`：`reindexAll` 由"周期性整份 `onSave`"改为"每索引一篇就写它的分片"，结束写 meta + 清孤儿；`onModify`/`onDelete` 仍由 `main` 在其后调 `saveFile`/`removeFile`。
- `src/main.ts`：用 `IndexStore` 取代 `indexPath`/`loadIndex`/`persistIndex`；`scheduleReindex`/删除监听/重建命令改调分片写；移动端守卫沿用。

### ⑤ 同步收尾
- 迁移后本地旧 `index.json` 已删；**OneDrive 上那份陈旧的 27MB `index.json` 你手动删一次**（治标那步），之后只剩 `index/` 一堆小文件同步。

## 测试计划
- `src/util/hash.test.ts`：`fnv1a64` 确定性、定长 16-hex、不同输入不同。
- `src/rag/vectorStore.test.ts`：`serializeFile` 取单篇（量化、不含其它笔记条目）；`serializeFile`→`deserializeFile` 往返后该篇 top-1 命中不变；无条目的笔记 `serializeFile` 返回 null。
- `IndexStore` 依赖 adapter，不单测；靠 tsc/build + 手动冒烟（含迁移）。
- 现有 39 个测试不回归。

## 验证
- `npm run build` 过；`npm test` 新增用例过、旧不回归。
- `LT_VAULT_PLUGIN_DIR=… npm run deploy` 后在 Obsidian：
  - 重载 → 旧 `index.json` 迁成 `index/` 一堆分片 + `meta.json`，旧文件消失；检索照常。
  - 改一篇笔记 → 只有它对应的那个 `<hex>.json` 的 mtime 变（其余不动）。
  - 删一篇 → 对应分片消失。
  - 「重建索引」→ 分片全量重写、孤儿清掉。
  - Remotely Save 同步 `index/` 不再报 `size not matched`；移动端同步后能检索（读分片，不重嵌）。

## 风险
- **文件数**：274+ 个小文件随 vault 增长；首次迁移与首次全量同步稍慢（逐文件）。个人 vault 规模可接受;上万篇再考虑打包。
- **迁移幂等**：`load()` 优先认 `index/`；若旧 `index.json` 因同步回流再现，仍以 `index/` 为准并清掉它。
- **孤儿分片**：笔记改名/删除遗留的 `<hex>.json` 由 `saveAll` 的孤儿清理兜底（重建索引时清）。
