# Cobrain 选中即引用（Quote selection into Cobrain）

> 设计文档 · 2026-06-19 · 功能：阅读/编辑文档时选中文本，一键带路径+内容引用进副脑

## Context

读文档（中文或英文皆可）时常对某句/某段有疑问，想拿去问副脑。现状只能手动复制粘贴，还丢了来源。需求：**选中文本 → 一键引用进 Cobrain，自动带上来源路径与原文，免复制粘贴**。

经核实，Obsidian 在**有 editor 的模式**（实时预览 Live Preview / 源码）下提供完整能力：`editor-menu` 事件（`obsidian.d.ts:8128`）、`editorCallback`（:1794）、`editor.getSelection()`（:2450）、`MetadataCache.fileToLinktext`（:4431）。功能与语言无关——`getSelection()` 抓什么是什么，英文/中文/代码一视同仁；只要用户配置的嵌入模型支持多语言、跨语言，英文引文也能撞出 vault 里相关（含中文）笔记。

## 目标 / 非目标

**目标**
- 在编辑模式（Live Preview / 源码）下，选中文本后经**右键菜单**或**命令（可绑快捷键）**把引用送进 Cobrain。
- 引用自动携带**来源链接（`[[路径#最近标题]]`）+ 原文**，预填进对话面板输入框，光标落在其后，用户接着打疑问、照常发送。
- 复用现有发送 / 检索（RAG）/ 存笔记管线，不改其逻辑。

**非目标（YAGNI）**
- 纯阅读模式（Reading view，无 editor，只能读 DOM 选区、映射不回源码/标题）——本次不做。
- 结构化引用 chip / 多引用累积 / 独立上下文注入（已选方案 A：预填输入框）。
- 改动 `tutor.ask` / 检索 / 存笔记逻辑（引用作为用户消息文本的一部分，自然流经现有管线）。
- 代码块内 `#` 误判为标题的精确处理（“找最近标题”用简单上扫，少数误判可接受）。

## 设计

### ① 两个入口，共用一个动作（都仅编辑模式生效）
- **右键菜单**：`registerEvent(this.app.workspace.on("editor-menu", (menu, editor, ctx) => { ... }))`——仅当 `editor.getSelection().trim()` 非空时 `menu.addItem(...)` 加「引用进 Cobrain」（图标 `brain`），点击调用共享动作 `quoteSelection(editor, ctx)`。
- **命令**：`addCommand({ id: "cobrain-quote-selection", name: "Cobrain: 引用选中文本", editorCallback: (editor, ctx) => this.quoteSelection(editor, ctx) })`。可在 Obsidian 快捷键里自绑。

### ② 取数据（`quoteSelection(editor, ctx)`，在 main.ts）
- `const sel = editor.getSelection();` 空白 → `new Notice("先选中一段文字")` 返回（命令路径会遇到；菜单项本就只在非空时出现）。
- `const file = ctx.file;` 无 → Notice 返回。
- 来源链接文本：`const linktext = this.app.metadataCache.fileToLinktext(file, "", true);`（省 `.md`、最短唯一）。
- 最近标题：`const lines = editor.getValue().split("\n"); const fromLine = editor.getCursor("from").line; const heading = findHeadingAbove(lines, fromLine);`
- `const quote = buildQuote(sel, linktext, heading);`

### ③ 注入面板（预填，不自动发）
- `const view = await this.activateChatView();`（`activateChatView` 改为返回 `ChatView | null`：reveal 后取 `getLeavesOfType(VIEW_TYPE_COBRAIN_CHAT)[0]?.view`）。
- `view?.quoteIntoInput(quote);`

`ChatView.quoteIntoInput(text: string)`：
```ts
quoteIntoInput(text: string): void {
  // 若已打了字，引用插在前面、保留你的字；光标停在引用之后
  this.inputEl.value = text + this.inputEl.value;
  this.inputEl.focus();
  const pos = text.length;
  this.inputEl.setSelectionRange(pos, pos);
}
```

**预填格式**（按确认：纯 `> 引文`，来源链接放尾部，无前导说明句）：
```
> 选中的第一行
> 选中的第二行
> —— [[路径#标题]]

```
（多行引文逐行 `> `；最后一行是 `> —— [[来源]]` 归属；末尾空行处停光标。无标题时链接为 `[[路径]]`。）

发送后：现有 `send()` 把（引用 + 疑问）作为用户消息走 RAG + LLM。`[[路径]]` 天然进对话；配合「附原始问题」，存笔记时来源链接落进「## 原始问题」，溯源闭环。

### ④ 纯函数（`src/util/quote.ts`，obsidian-free，可单测）
```ts
// 选区逐行 blockquote + 尾部来源链接；末尾留空行供用户接着打疑问。
export function buildQuote(selection: string, linktext: string, heading: string | null): string {
  const quoted = selection.split("\n").map(l => "> " + l).join("\n");
  const target = heading ? `${linktext}#${heading}` : linktext;
  return `${quoted}\n> —— [[${target}]]\n\n`;
}

// 从 fromLine 起向上找最近的 ATX 标题文本（找不到返回 null）。简单上扫，不处理代码围栏内的 #。
export function findHeadingAbove(lines: string[], fromLine: number): string | null {
  for (let i = Math.min(fromLine, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(/^#{1,6}\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}
```

## 测试计划

`src/util/quote.test.ts`（纯函数，不 import obsidian）：
- `buildQuote` 单行：`buildQuote("hello", "Note", null)` → `"> hello\n> —— [[Note]]\n\n"`。
- `buildQuote` 多行 + 标题：`buildQuote("a\nb", "Note", "Sec")` → `"> a\n> b\n> —— [[Note#Sec]]\n\n"`。
- `findHeadingAbove`：标题在选区上方 → 返回最近一个；无标题 → `null`；多个标题取最近（最靠近 fromLine 的）。

`editor-menu` / 命令 / `quoteIntoInput` 依赖 Obsidian 运行时，不单测；靠手动冒烟。

## 验证

- `npm run build`（tsc + esbuild production）过；`npm test` 新增用例过、旧用例不回归。
- `npm run deploy` 后手动冒烟：
  - 实时预览里选一段**英文**，右键 →「引用进 Cobrain」→ 面板打开、输入框预填 `> 英文…\n> —— [[来源#标题]]`，光标在其后；打个中文疑问 → 发送 → 正常回答、命中相关旧笔记。
  - 源码模式同样可用；命令（绑快捷键）同样可用。
  - 选区为空跑命令 → Notice 提示。
  - 存为笔记（开「附原始问题」）→ 笔记「## 原始问题」里带 `[[来源]]` 双链。

## 风险 / 不在范围

- **纯阅读模式不可用**（无 editor）——已在非目标声明；用户主要用实时预览/源码，影响小。
- **最近标题简单上扫**：选区上方代码块里的 `#` 可能被误当标题（少见，可接受；如需精确可后续复用 chunker 的围栏识别）。
- **链接格式假定 wikilink**（`[[...]]`，与 vault 现状一致）；若改用 Markdown 链接偏好，可改走 `fileManager.generateMarkdownLink`。
- 多设备：本功能纯交互、不写索引，移动端（编辑模式）同样可用，无额外同步影响。
