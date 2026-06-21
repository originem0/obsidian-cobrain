# Cobrain 跨设备使用（桌面 + 移动端）

> 设计文档 · 2026-06-19 · 工作流 #3（移动端启用）。状态更新：已提交 Obsidian 官方社区插件上架申请，审核中。

## Context

`manifest.json` 现为 `isDesktopOnly: true`——这是早年用 transformers.js 本地嵌入的遗留；云端 API 化之后代码已无任何 Node/Electron 依赖、也无 iOS 不支持的 lookbehind 正则（grep 已核实），`requestUrl`/`adapter`/`Modal`/`ItemView` 全是跨平台 API。#1 把索引从 160 MB 砍到约 10 MB 后，移动端解析/内存也不再是坎。

用户诉求是**在自己的桌面 + 平板/手机上都能用、换设备能装上**。早期判断是 BRAT 或 vault 文件同步已够用；现在已提交 Obsidian 官方社区插件申请，安装路径改为“审核通过后优先社区插件，审核前继续手动 / BRAT / vault 同步”。

用户的多设备同步方式是 **iCloud/Dropbox/OneDrive 等文件级同步整个 vault 文件夹**，默认会把 `.obsidian/plugins/cobrain/`（插件代码 + 10 MB `index.json`）一起带到移动端。这是本设计的关键前提。

## 目标 / 非目标

**目标**
- 一份代码同时跑桌面与移动端（摘 `isDesktopOnly`）。
- 移动端作为**只读检索消费者**：直接读桌面建好、随 vault 同步过来的索引做检索，不在移动端做后台重嵌。
- 移动端**绝不写 `index.json`**（数据安全，见下"风险"），杜绝同步冲突与索引互冲。
- 桌面端行为完全不变，且是唯一的索引写入方。
- 文档化跨设备工作流与注意事项。

**非目标（YAGNI / 留作后续）**
- 社区插件审核之外的发布自动化（例如自动生成 Release、自动提交版本更新 PR）。
- 移动端 UI 重排版（聊天面板内联样式在小屏上的适配）。
- 把 BRAT/Release 发布做成代码或脚本（属操作步骤，仅写进 README）。
- 多个桌面端并发写索引的冲突处理（假定单一桌面端为写入方）。
- 移动端即时索引（移动端新建/改的笔记，待桌面端重建后才进检索——这是接受的取舍）。

## 设计

### ① 开启移动端
`manifest.json` 的 `isDesktopOnly` 由 `true` 改为 `false`。无其它 manifest 改动。

### ② 移动端 = 只读检索，绝不写索引
用 Obsidian 的 `Platform.isMobile`（`obsidian.d.ts` 已确认）做平台分支。`main.ts` 三处守卫：

1. **不注册自动重嵌**：`onload` 里 `this.app.vault.on("modify", …)`（`main.ts:66`）与 `on("delete", …)`（`main.ts:69`）这两个触发 `scheduleReindex`/索引更新的监听，在 `Platform.isMobile` 时**不注册**。
   - 理由：否则移动端每改一篇笔记都会走蜂窝网打嵌入接口（费流量/电/钱），并重写 10 MB 索引引发同步churn。

2. **`persistIndex()` 在移动端 no-op**：方法开头 `if (Platform.isMobile) return;`（守卫所有写索引路径——手动重建、嵌入模型变更、`loadIndex` 的 `needsRewrite` 回写等）。
   - 理由不只是省事，更是堵一条**真实数据损坏链**：文件同步非原子，若 `index.json` 与 `data.json` 到达移动端有时间差、`embedModel` 一时对不上，#1 的 `loadIndex`（`main.ts:157`）会"清空索引并 `persistIndex` 回写"。移动端若把这个空索引写回去，文件同步会把**桌面端的索引也覆盖掉**。移动端只读 = 这条链彻底断。

3. **重建索引命令在移动端给提示并返回**：重建命令回调（`main.ts:54`）在 `Platform.isMobile` 时 `new Notice("移动端为只读检索，索引请在桌面端重建")` 后 `return`，不进入 `reindexAll`（避免白白消耗嵌入调用）。

**检索/对话路径不受影响**：查询只读索引 + 每次搜索 1 次查询嵌入（便宜），移动端正常工作；存为笔记会写 `.md`（笔记内容随 vault 同步），但不写索引、也不触发重嵌。

### ③ 桌面端
完全不变。仍是唯一的索引写入方——单写入方在文件同步下天然无冲突。

### ④ 换设备安装与同步（文档，非代码）
写进 README 的"跨设备使用"小节：
- 官方社区插件审核通过后，每台设备直接从社区插件安装；审核通过前，文件同步仍可把 `.obsidian/plugins/cobrain/` 带到新设备。
- 移动端 Obsidian 需**重启/强退**才会加载新同步来的 `main.js`。
- 索引**只在桌面端重建**；移动端只读检索，移动端新建的笔记待下次桌面端重建后才可被检索到。
- 兜底：若 iCloud/Dropbox 同步 `.obsidian` 的大量小文件偶发冲突，可改用 **BRAT**（从 GitHub 仓库 `originem0/obsidian-cobrain` 安装代码，移动端亦支持、可自动更新），索引仍走 vault 同步。

## 边界与风险

- **空索引回传（已由 ②.2 封堵）**：移动端绝不写 `index.json`，故 `loadIndex` 在移动端即便因模型不匹配清空，也只影响该会话内存，不落盘、不回传污染桌面索引。
- **跨设备 `embedModel` 一致性**：查询嵌入须与索引同模型，否则 `VectorStore` 维度守卫抛错。`embedModel` 在 `settings`（`data.json`）里随同步一致，正常情况两端一致。
- **`data.json` 设置冲突**：两端都可能改设置 → 理论上文件同步冲突，但文件极小（约 3 KB）、改动罕见，风险低；不在本次处理。
- **移动端索引时效**：移动端新建/编辑的笔记，在桌面端下次重建索引前不在检索结果里——接受的取舍（桌面主力写、移动端查旧念头）。

## 测试计划

- `Platform.isMobile` 分支依赖 Obsidian 运行时，jest 无法直接测（测试环境无 obsidian）；不为它硬凑假测试。
- 现有桌面端测试不回归（`npm test`）。
- 桌面端行为不变，靠 `tsc` + 现有测试 + `npm run build` 守住。
- 移动端行为靠用户在平板/手机上手动冒烟验证（见下）。

## 验证

- `npm run build`（tsc + esbuild production）过。
- `npm test` 现有用例不回归。
- 桌面端重载：行为与之前一致（自动重嵌、手动重建、检索、存笔记均正常）。
- 移动端手动冒烟（同步插件到平板/手机后）：
  - 插件能在移动端加载、面板可开。
  - 能搜到桌面端已索引的笔记（检索命中合理）。
  - 在移动端编辑笔记**不触发**嵌入请求、**不改写** `index.json`（看文件 mtime）。
  - 运行"重建索引"应得到"只读检索"提示且不消耗嵌入调用。
  - 回到桌面端：`index.json` 未被移动端覆盖/清空，检索照常。
