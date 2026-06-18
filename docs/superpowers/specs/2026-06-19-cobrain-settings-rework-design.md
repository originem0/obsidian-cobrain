# Cobrain 设置页重做（检测 + 测试 + 折叠重排）

> 设计文档 · 2026-06-19 · 工作流 #2

## Context

当前设置页（`src/settings.ts`）三个痛点：

1. **模型靠手填**——三套 OpenAI 兼容端点（文本/图像/嵌入）中只有嵌入有「检测」按钮，chat/image 的 model 全靠用户手敲，不知道端点上到底有哪些可用。
2. **填完不知对错**——填完 URL/Key/Model 后没有任何验证，要等真正调用（对话/出图/检索）才报错。免费代理还常虚标模型，`/models` 列出的未必真能调。
3. **一长列 `h3` 平铺**——信息密度高、无分组折叠；且 `h3` 顶层标题不符合 Obsidian 上架指南。

目标是把"检测模型→下拉选"和"测可用性"补齐到三套端点，并把信息架构重排为可折叠分区。

## 目标 / 非目标

**目标**
- 三套端点都能「检测」列出 `/models` 并下拉选择，免手填。
- 「测可用性」做真实调用验证，但按成本分级（见下）。
- 设置页重排为可折叠分区，每区标题带连通状态灯。
- 顺带满足上架合规：以折叠 `summary` 作标题，去掉 `h3` 顶层标题。

**非目标（YAGNI）**
- URL 预设 / datalist（各人端点不同，价值低）。
- 连通状态持久化（会话级 UI 态即可）。
- image 自动可用性测试（出图 ~1 分钟且花钱）。
- 改动 `CobrainSettings` 字段（model 仍存 `llmModel/imageModel/embedModel`）。
- 索引 / 对话 / 出图等运行时逻辑（本次只动设置页与端点探测）。

## 设计

### ① 布局与折叠

- 每个区用原生 `<details><summary>`（无依赖）。`summary` = 区标题 + 右侧**状态灯**。
- 三套端点折叠区结构完全统一；其下「概念图 / 笔记 / 提示词」各成折叠区。
- 状态灯为会话级 UI 态，不入库：`● 已连通`（绿）/ `○ 未测`（灰）/ `✗ 失败`（红）。每次打开设置页默认「未测」，点测试/检测后亮。
- 去掉所有 `h3`（`summary` 即标题）。

### ② 检测模型

- 通用 `listModels(baseUrl, apiKey)`：GET `/models` → `string[]`（id 列表）。
- `classifyModels(ids)` 纯函数按名字启发式分三类：
  - **embed**：`/embed|bge|gte|m3e|jina|nomic|nv-?embed|text-embedding|(^|[^a-z0-9])e5([^a-z0-9]|$)/i`，排除 `rerank`。
  - **image**：`/gpt-image|dall[- ]?e|flux|stable-?diffusion|sd-?xl|sd3|seedream|kontext|imagen|midjourney/i`。
  - **chat**：其余，且排除明显非对话（`/whisper|tts|audio|rerank|moderation|embed/i`）。
- 各 section 用对应类填下拉。**兜底**：某类过滤结果为空时，下拉退回显示全部 `/models`（让用户自己挑），并提示"未识别出该类模型，已列出全部"。
- **embed** 区的检测沿用现有 `detectEmbeddingModels`（名字筛 + 真实试嵌入 + 维度），比纯名字分类更准。
- 没检测过时，下拉只含当前已保存的 model 值（兜底，不至于空）。

### ③ 测可用性（分成本）

- **chat**：「测试」按钮 → `testChat(baseUrl, apiKey, model)` 发 `messages:[{role:"user",content:"hi"}], max_tokens:1` → HTTP 200 即亮绿 + 延迟 ms；非 200 亮红 + 错误前 200 字。走已有 `withTimeout`（沿用 90s）。
- **embed**：「检测」即真实试嵌入，等于已测；状态灯据检测结果亮（检测到 ≥1 可用 → 绿）。
- **image**：不设自动测；状态灯停「未测」，旁注"用『配图』功能实测"。

### ④ 代码组织

- 新 `src/llm/probe.ts`，集中端点探测：
  - `listModels(baseUrl: string, apiKey: string): Promise<string[]>`
  - `classifyModels(ids: string[]): { chat: string[]; image: string[]; embed: string[] }`（纯函数）
  - `testChat(baseUrl: string, apiKey: string, model: string): Promise<{ ok: boolean; ms: number; error?: string }>`
  - `detectEmbeddingModels(baseUrl, apiKey): Promise<{ id: string; dim: number }[]>`（从 `apiEmbedder.ts` 移来集中；`apiEmbedder.ts` 改为从 `probe.ts` re-export 或直接引用，`settings.ts` 的 import 路径同步）
- `settings.ts`：
  - `collapsible(container, title): { body: HTMLElement; status: HTMLElement }` —— 造 `<details><summary>`，返回内容容器与状态灯元素。
  - `renderEndpointSection(container, { label, kind, urlKey, keyKey, modelKey })` —— 渲染一套端点（URL + Key + 检测→下拉 + 测试→状态），三套复用。`kind: "chat" | "image" | "embed"` 决定检测过滤与测试方式。
  - 检测结果缓存为 tab 实例字段 `detected: { chat: string[]; image: string[]; embed: {id,dim}[] }`。
- `CobrainSettings` 不变。

### ⑤ 边界与错误

- 检测/测试前校验对应 URL + Key 非空，否则 Notice 提示。
- `/models` 非 200 或返回空 → Notice"未取到模型列表"，下拉退回当前值。
- 检测/测试进行中：按钮 `setDisabled(true)` + loading 文案，结束恢复。
- embed 模型下拉 `onChange` 仍触发"清空索引 + 提示重建"（保留现有逻辑，`main.ts:156-164`）。
- 状态灯样式用内联（与现状一致，不引 styles.css；上架合规以"去 h3"为主，样式迁移留作后续）。

## 测试计划

- `classifyModels` 纯函数单测（`src/llm/probe.test.ts`）：给混合 id 列表（含 `glm-4`、`gpt-image-1`、`bge-m3`、`whisper-1`、`text-embedding-3` 等），断言各归对应类、`whisper/rerank` 不进 chat、空输入返回三个空数组。
- `listModels`/`testChat`/`detectEmbeddingModels` 依赖网络，不单测。
- 现有测试不回归。

## 验证

- `npm run build`（tsc + esbuild production）过。
- `npm test`（新增 `classifyModels` 用例过，旧用例不回归）。
- `npm run deploy` 后在 Obsidian 手动冒烟：
  - 三套端点区可折叠；填好 URL+Key 后「检测」列出模型、下拉可选并保存。
  - chat「测试」对真端点亮绿+延迟、对错端点亮红。
  - embed「检测」亮绿 + 维度；image 区无自动测、提示用配图实测。
  - 切换 embed 模型仍提示清空索引。
  - 命令面板/设置页无残留 `h3` 顶层标题。

## 风险

- **名字启发式分类不全**：某些端点 model 命名不规律，可能漏分类 → 兜底"列出全部"覆盖，用户仍可手选。
- **chat 测试发真实请求**：极短（max_tokens:1）成本可忽略，但仍是一次真实调用——只在用户点「测试」时触发，不自动。
