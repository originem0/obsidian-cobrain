# Cobrain 面板与引用体验优化

> 设计文档 · 2026-06-19 · 工作流 #5：引用上下文（隐式喂源笔记）+ 输入框自适应 + 面板简洁化（迁 styles.css）

## Context

引用功能（工作流 #4）只带「选中文 + 标题链接」，单句对 LLM 可能偏薄；面板全内联 `cssText`，输入框定高 `rows=2`，多行引用预填后看不全。本工作流三块：① 引用进面板时**隐式读源笔记**，把选区所在小节作为「来源上下文」喂给 LLM（输入框仍只显示精简引用，方案 C）；② 输入框随内容自适应高度；③ 面板简洁化，内联样式迁到 `styles.css`（CSS 变量、跟随主题）。

已核实：`deploy.mjs` 仅拷 `main.js`/`manifest.json`（需加拷 `styles.css`）；`tutor.ask(history, userMsg)` 把 RAG 上下文作为 `system` 消息注入（加 `sourceContext` 参数顺理成章）；`esbuild` 只打 `main.js`，`styles.css` 由 Obsidian 自动从插件目录加载。

## 目标 / 非目标

**目标**
- 引用进面板时 Cobrain 读源笔记，把**选区所在小节**作为来源上下文喂给 LLM；输入框仍只显示精简 `> 引文 + 链接`。
- 输入框随内容自适应高度（到上限内部滚动），多行引用可见；发送后复位。
- 面板简洁化（开场白精简、间距统一、标签/按钮克制），内联样式迁 `styles.css`，用 CSS 变量跟随 Obsidian 主题（深浅自适配）。

**非目标（YAGNI）**
- 不改 RAG 检索逻辑——来源上下文只在 LLM 侧加，不进检索查询。
- 不引入新依赖；不重做对话/概念图/配图/存笔记的功能逻辑（只动呈现 + 引用上下文）。
- 纯阅读模式仍不支持引用（沿用工作流 #4）。

## 设计

### ① 引用上下文（方案 C·隐式喂源笔记）

- 新纯函数（并入 `src/util/quote.ts`，obsidian-free，可测）：
  ```ts
  // 取 fromLine 所在「小节」文本喂给 LLM 作上下文：最近标题(含本行)→ 下一个同级/更高级标题前；
  // 无标题则取 fromLine 附近窗口；整体超 maxChars 则取以 fromLine 为中心的窗口。
  export function extractContext(lines: string[], fromLine: number, maxChars?: number): string;
  ```
- `main.ts` 的 `quoteSelection`（已有 `lines`、`fromLine`）：`const sourceContext = extractContext(lines, editor.getCursor("from").line);`，传 `view.quoteIntoInput(quote, sourceContext)`。
- `chatView.ts`：
  - 加 `private pendingSourceContext: string | null = null;`
  - `quoteIntoInput(text: string, sourceContext?: string)`：`this.pendingSourceContext = sourceContext ?? null;` + 预填（同 #4）。
  - `send()`：`const ctx = this.pendingSourceContext; this.pendingSourceContext = null;`（先清，避免异常残留）→ `this.plugin.tutor.ask(this.history, text, ctx ?? undefined)`。**只消费这一问**，后续追问不再带（上下文已在 history）。
- `tutor.ts` 的 `ask(history, userMsg, sourceContext?: string)`：在 messages 中、RAG context 之后、`history` 之前插入：
  ```ts
  ...(sourceContext ? [{ role: "system" as const,
    content: "用户正在读的来源片段（据此理解他选中/提问的上下文）：\n" + sourceContext }] : []),
  ```
  `retrieveContext` 仍以 `userMsg` 检索（引文已在 `userMsg` 里，不被来源上下文稀释）。

### ② 输入框自适应

- `chatView.ts` onOpen 的 textarea：去掉对固定 `rows=2` 的依赖，加 `input` 监听做自适应：
  ```ts
  const autoGrow = () => { this.inputEl.style.height = "auto"; this.inputEl.style.height = this.inputEl.scrollHeight + "px"; };
  this.inputEl.addEventListener("input", autoGrow);
  ```
  上限与滚动交给 CSS（`.cobrain-input { max-height: 40vh; overflow-y: auto; }`）——内联 `height` 由 `max-height` 封顶、超出内部滚动。
- `quoteIntoInput` 预填后调用 `autoGrow()` 并把光标/滚动置于引用之后（多行引用即刻可见）。
- `send()` 清空输入后 `autoGrow()` 复位回单行高。
- `autoGrow` 提为类方法或闭包，供 onOpen / quoteIntoInput / send 复用。

### ③ 简洁化 + 迁 styles.css

- 新建 `styles.css`（repo 根，Obsidian 自动加载），全部用 `.cobrain-*` 作用域类 + CSS 变量（`var(--background-primary/-alt/-secondary)`、`var(--text-normal/-muted/-error)`、`var(--interactive-accent)`、`var(--background-modifier-border)`）。
- `chatView.ts`：把 onOpen / addBubble / addRelatedBlock 里的内联 `cssText` 改为 `el.addClass("cobrain-...")`（保留必要的动态行为，如 `disabled`）。
- 简洁化要点：
  - 开场白精简为一句（如「聊你正在想的——我会翻出你写过的相关旧笔记，并回抛问题逼你自己想。」），不再大段。
  - 统一间距（8/12px）、留白克制；气泡圆角与背景走主题变量；「你 / 副脑」标签更小更淡。
  - 按钮条（概念图 / 配图 / 存为笔记）更克制；「相关笔记」块用更轻的左边框强调。
  - 视觉一律跟随主题变量，不自造配色；深浅色自动适配。
- `deploy.mjs`：拷贝列表 `["main.js", "manifest.json"]` → 加 `"styles.css"`。

## 测试计划

- `src/util/quote.test.ts` 追加 `extractContext` 用例：① 有标题取该小节（到下一个同级标题前）；② 无标题取附近窗口；③ 小节超 `maxChars` 时取中心窗口、长度受限；④ 多级标题：在下一个 `≤` 当前级别的标题处截断，更深的子标题不截断。
- 自适应 / 样式 / `ask` 注入依赖 Obsidian 运行时或纯视觉，不单测；靠 `tsc` + `build` + 手动冒烟。
- 现有 35 个测试不回归。

## 验证

- `npm run build`（tsc + esbuild production）过；`npm test` 新增用例过、旧不回归。
- `npm run deploy` 后确认 `styles.css` 也拷进了测试 vault 插件目录。
- 手动冒烟：
  - 选一段引用 → 输入框只显示精简 `> 引文 + 链接`，且随内容自适应、看得全；发送 → 回答明显带上了那段上下文（问「这句指什么」能答到周边）。
  - 普通追问不重复带来源；存为笔记仍正常。
  - 面板观感：开场白简洁、间距舒服；切换深 / 浅主题颜色都正常跟随、不破。
  - 改 `styles.css` 里一个颜色 → deploy → 重载，确认样式确实生效（验证 styles.css 已分发）。

## 风险

- `extractContext` 小节边界靠 ATX 标题，代码围栏内 `#` 可能误判（少见，窗口兜底，可接受）。
- 来源上下文增大 LLM 输入（已 cap ≈1800 字），免费代理对长输入可能更慢/更易 429——只在引用那一问发生，可接受。
- `styles.css` 若未随分发到位，面板会丢样式：`deploy.mjs` 已加拷；日后若上架，GitHub Release 也须带 `styles.css`（记一笔）。
