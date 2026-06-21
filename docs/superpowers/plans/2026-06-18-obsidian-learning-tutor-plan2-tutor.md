# Obsidian 学习导师插件 — Plan 2：导师体验 Implementation Plan

> 历史快照（2026-06-18）。本项目已演进为 **Cobrain（创作副脑）**——定位从「学习导师」转向「助产士」。本文档保留作过程记录，当前设计以 `README.md` 及 design 文档「演进」小节为准。

> **For agentic workers:** 子代理在用户代理上稳定 429，故本计划内联执行（参照 Plan 1 的方式）：逐任务实现 → 构建 → 部署到测试 vault → 提交。

**Goal:** 在 Plan 1 的检索之上，做出「对话式学习导师」：聊天面板里跟导师讨论一个主题，导师**检索你的 vault**（按已知水平讲、连接旧笔记），并在你**显式命令**下产出结构化笔记、Mermaid 概念图、gpt-image-2 配图。

**Architecture（基于 Plan 1 现状）:** 复用 `Retriever`（语义检索）。新增：LLM 聊天客户端（OpenAI 兼容 `/chat/completions`，端点和模型由用户显式配置，`requestUrl` 非流式）、导师控制器（系统提示词 + 检索注入）、侧栏聊天面板（ItemView）、三个显式命令（存笔记 / 概念图 / 配图）。视觉分工：Mermaid 概念图为主、配图为辅。密钥仍只存本地 data.json。

**Tech Stack:** TypeScript、Obsidian（ItemView/Modal/requestUrl）、esbuild、Jest（仅纯函数）。

---

### P2-T1：LLM 聊天客户端

**Files:** Create `src/llm/chatClient.ts`

- OpenAI 兼容 `POST {base}/chat/completions`，经 `requestUrl`（免 CORS、异步不卡）。
- `export interface ChatMsg { role: "system"|"user"|"assistant"; content: string }`
- `class ChatClient { constructor(baseUrl, apiKey, model) ; async chat(messages: ChatMsg[]): Promise<string> }`
- 非 200 抛带状态码与响应片段的错误。返回 `json.choices[0].message.content`。
- 验证：构建通过 + Obsidian 内手测（建一个临时命令调用 `chat([{role:"user",content:"你好"}])` 看返回）。

### P2-T2：导师控制器

**Files:** Create `src/tutor/tutor.ts`

- `class Tutor { constructor(retriever: Retriever, chat: ChatClient) }`
- `async ask(history: ChatMsg[], userMsg: string): Promise<{ reply: string; sources: string[] }>`：
  1. `retriever.retrieve(userMsg, 6)` 取相关笔记片段；
  2. 组装系统提示词（导师人设：拆解概念、按我已知水平讲、引用检索到的笔记、苏格拉底式追问、中文）；
  3. 把检索片段作为 `context` 注入（system 或单独 user 段，标注来源 path）；
  4. `chat([system, ...history, {user: userMsg}])` → reply；
  5. 返回 reply + sources（命中的 path 去重）。
- 系统提示词写成可改的常量（`TUTOR_SYSTEM`）。
- 验证：纯函数部分（提示词/上下文拼装）可抽出单测；整体 Obsidian 内手测。

### P2-T3：聊天面板（ItemView 侧栏）

**Files:** Create `src/ui/chatView.ts`；Modify `src/main.ts`

- `class ChatView extends ItemView`（`VIEW_TYPE = "lt-chat"`）：消息列表（区分 user/assistant，assistant 用 `MarkdownRenderer.render` 以渲染 Mermaid/嵌图）、底部输入框 + 发送、顶部命令按钮区（存笔记 / 概念图 / 配图）。
- main.ts：`registerView` + ribbon 图标 + 命令「LT: 打开导师」激活右侧栏视图。
- 发送 → `tutor.ask` → 追加 assistant 消息（Markdown 渲染）。底部显示来源 path。
- 验证：Obsidian 内手测对话往返 + 来源显示。

### P2-T4：存为笔记

**Files:** Modify `src/ui/chatView.ts`；Create `src/notes/noteWriter.ts`

- `noteWriter.saveNote(app, settings, { topic, body, sources, mermaid?, imageEmbeds? })`：
  - 生成 markdown：frontmatter（`created`、`tags: [学习导师]`、`source-chat`）+ 正文 + 概念图(若有) + 配图嵌入(若有) + `## 相关` 下 `[[path]]` 双链（来自 sources）；
  - 写入 `settings.noteFolder`，文件名取 topic（清洗非法字符），冲突加时间戳；不覆盖。
- 「存笔记」按钮：让导师把当前对话**综述成一篇结构化笔记**（不是聊天记录原文），再 saveNote。
- 验证：手测生成的笔记结构 + 双链可点。

### P2-T5：概念图（Mermaid）

**Files:** Modify `src/tutor/tutor.ts`、`src/ui/chatView.ts`

- `tutor.conceptMap(topic, context): Promise<string>`：提示 LLM 产出 Mermaid（`graph TD`：焦点问题→概念→带标签的关系），只返回 mermaid 代码块。
- 校验：确保是 ` ```mermaid ` 包裹；简单语法检查（含 `graph`/`flowchart`）。失败则原样展示并提示。
- 「概念图」按钮：对当前主题生成 → 作为 assistant 消息（Markdown 渲染出图）+ 可并入存笔记。
- 验证：手测渲染。

### P2-T6：配图（gpt-image-2）

**Files:** Create `src/image/imageClient.ts`；Modify `src/ui/chatView.ts`

- `imageClient.generate(prompt): Promise<ArrayBuffer>`：`POST {imageBase}/images/generations`（`requestUrl`），model=gpt-image-2，取 b64/url → 二进制。
- 「配图」按钮：弹框让用户输入/确认要配图的**概念**；用"视觉隐喻"提示词模板生成 → 存到 `settings.attachmentFolder/lt-<时间>.png` → 在对话/笔记里嵌 `![[...]]`。
- 仅显式触发（控成本）。失败回退纯文字提示。
- 验证：手测出图 + 嵌入。

### P2-T7：聊天 / 图像模型检测（扩展设置）

**Files:** Modify `src/settings.ts`、`src/rag/apiEmbedder.ts`（或新 `src/llm/detect.ts`）

- 复用嵌入检测的模式：给 chat（`/chat/completions` 发一条极短 prompt 测 200）和 image 端点加「检测」按钮 + 下拉。
- chat 候选过滤偏宽松（大多是聊天模型）；image 检测从简（列 /models 含 image/gpt-image 的，不实际烧图，仅列出）。
- 验证：手测检测+下拉。

---

## 范围边界（v1 之后再说）
间隔重复/复习、多模型对比、流式输出、TTS。先把「对话→检索接地→存成带图带链的笔记」这条主线在面板里跑顺。
