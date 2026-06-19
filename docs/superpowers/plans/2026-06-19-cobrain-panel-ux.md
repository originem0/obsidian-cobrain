# 面板与引用体验优化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引用进面板时隐式把源笔记小节喂给 LLM（方案 C）；输入框随内容自适应；面板简洁化并把内联样式迁到 `styles.css`（CSS 变量、跟随主题）。

**Architecture:** 纯函数 `extractContext`（quote.ts）取选区所在小节；`main.quoteSelection` 算出来源上下文交给 `ChatView.quoteIntoInput(text, ctx)` 暂存，`send()` 消费一次并传 `tutor.ask(history, text, ctx)`，tutor 作为 system 注入（RAG 查询不变）。UI：textarea 监听 `input` 自适应高度（CSS `max-height` 封顶），所有内联 `cssText` 改 `.cobrain-*` 类，新建 `styles.css`，`deploy.mjs` 加拷。

**Tech Stack:** TypeScript、Obsidian API、Jest、esbuild；Obsidian 自动加载插件目录的 `styles.css`。

## Global Constraints

- 不引入任何新依赖（`package.json` 的 `dependencies` 保持为空）。
- `npx tsc -noEmit -skipLibCheck` 必须零报错。
- 纯函数测试不得 import `obsidian`。
- 现有 35 个测试不得回归。
- 不改 RAG 检索逻辑——来源上下文只在 LLM 侧注入，`retrieveContext` 仍以 `userMsg` 检索。
- 视觉一律走 Obsidian 主题变量（`--background-*`/`--text-*`/`--interactive-accent`/`--background-modifier-border`），不自造配色。
- 提交信息用中文，结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；`main` 分支直接提交。

## 文件结构

| 文件 | 改动 |
|---|---|
| `src/util/quote.ts` | 加 `extractContext`（纯函数） |
| `src/util/quote.test.ts` | 加 `extractContext` 用例 |
| `src/tutor/tutor.ts` | `ask` 加 `sourceContext?` 参数 + 注入 |
| `src/ui/chatView.ts` | `pendingSourceContext` + `quoteIntoInput(text,ctx)` + `send` 消费 + `autoGrow` + 内联样式改 class |
| `src/main.ts` | import `extractContext`；`quoteSelection` 算并传来源上下文 |
| `styles.css` | 新建：`.cobrain-*` 样式 |
| `deploy.mjs` | 拷贝列表加 `styles.css` |

---

### Task 1: `extractContext` 纯函数（TDD）

**Files:** Modify `src/util/quote.ts`、`src/util/quote.test.ts`

**Interfaces:**
- Produces: `extractContext(lines: string[], fromLine: number, maxChars?: number): string`（默认 `maxChars=1800`）

- [ ] **Step 1: 追加失败测试**

在 `src/util/quote.test.ts` 顶部 import 改为 `import { buildQuote, findHeadingAbove, extractContext } from "./quote";`，并追加：

```ts
test("extractContext 取最近标题所在小节，到下一个同级标题前", () => {
  const lines = ["# A", "a1", "## B", "b1", "b2", "## C", "c1"];
  expect(extractContext(lines, 4)).toBe("## B\nb1\nb2");
});

test("extractContext 更深子标题不截断小节", () => {
  const lines = ["## B", "b1", "### B1", "x", "## C"];
  expect(extractContext(lines, 1)).toBe("## B\nb1\n### B1\nx");
});

test("extractContext 无标题取附近窗口", () => {
  expect(extractContext(["l0", "l1", "l2", "l3"], 1)).toBe("l0\nl1\nl2\nl3");
});

test("extractContext 超长取窗口并受 maxChars 限", () => {
  const big = Array.from({ length: 100 }, (_, i) => "行" + i);
  expect(extractContext(["# H", ...big], 50, 100).length).toBeLessThanOrEqual(100);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest src/util/quote.test.ts`
Expected: FAIL —— `extractContext` 未导出（`extractContext is not a function`）。

- [ ] **Step 3: 写实现**

在 `src/util/quote.ts` 末尾追加：

```ts
// 取 fromLine 所在「小节」文本喂给 LLM 作上下文：最近标题(含本行)→ 下一个同级/更高级标题前；
// 无标题则取 fromLine 附近窗口；整体超 maxChars 则取以 fromLine 为中心的窗口。纯函数，可测。
export function extractContext(lines: string[], fromLine: number, maxChars = 1800): string {
  const n = lines.length;
  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  const from = clamp(fromLine);
  let headingLine = -1;
  let level = 0;
  for (let i = from; i >= 0; i--) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m) { headingLine = i; level = m[1].length; break; }
  }
  let start: number;
  let end: number;
  if (headingLine >= 0) {
    start = headingLine;
    end = n - 1;
    for (let i = headingLine + 1; i < n; i++) {
      const m = lines[i].match(/^(#{1,6})\s+/);
      if (m && m[1].length <= level) { end = i - 1; break; }
    }
  } else {
    start = clamp(from - 10);
    end = clamp(from + 10);
  }
  let text = lines.slice(start, end + 1).join("\n").trim();
  if (text.length > maxChars) {
    text = lines.slice(clamp(from - 12), clamp(from + 12) + 1).join("\n").trim();
    if (text.length > maxChars) text = text.slice(0, maxChars);
  }
  return text;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/util/quote.test.ts`
Expected: PASS（含原 5 + 新 4 = 9 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/util/quote.ts src/util/quote.test.ts
git commit -m "feat(quote): extractContext 取选区所在小节（工作流 #5）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: tutor.ask 接收来源上下文

**Files:** Modify `src/tutor/tutor.ts:33-44`

**Interfaces:**
- Produces: `Tutor.ask(history: ChatMsg[], userMsg: string, sourceContext?: string)`（注入为 system，RAG 不变）

- [ ] **Step 1: 改 `ask`**

把 `src/tutor/tutor.ts` 的 `ask` 方法整体替换为：

```ts
  async ask(history: ChatMsg[], userMsg: string, sourceContext?: string): Promise<{ reply: string; sources: string[]; related: QueryHit[] }> {
    const { context, sources, hits } = await this.retrieveContext(userMsg);
    const messages: ChatMsg[] = [
      { role: "system", content: this.settings.tutorPrompt },
      ...(context ? [{ role: "system" as const, content: context }] : []),
      ...(sourceContext
        ? [{ role: "system" as const, content: "用户正在读的来源片段（据此理解他选中/提问的上下文）：\n" + sourceContext }]
        : []),
      ...history,
      { role: "user", content: userMsg },
    ];
    const reply = await this.chat.chat(messages);
    // related = 检索命中的原始片段，交给 UI 显式呈现（第二大脑「联想」），而非只喂给模型
    return { reply, sources, related: hits };
  }
```

- [ ] **Step 2: typecheck**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 退出码 0（`chatView.send` 当前只传两参，可选第三参不破坏）。

- [ ] **Step 3: 提交**

```bash
git add src/tutor/tutor.ts
git commit -m "feat(tutor): ask 可接收来源上下文并作 system 注入（RAG 查询不变）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 面板重排（上下文接线 + 输入框自适应 + styles.css）

**Files:**
- Create: `styles.css`
- Modify: `src/ui/chatView.ts`（`onOpen`/`makeBtn`/`addBubble`/`addRelatedBlock`/`quoteIntoInput`/`send` + 新 `autoGrow` + 新字段 `pendingSourceContext`）
- Modify: `src/main.ts`（import `extractContext`；`quoteSelection` 算并传）
- Modify: `deploy.mjs`（拷贝列表加 `styles.css`）

**Interfaces:**
- Consumes: `extractContext`（Task 1）；`Tutor.ask(.., sourceContext?)`（Task 2）。
- Produces: `ChatView.quoteIntoInput(text: string, sourceContext?: string): void`（签名扩展，向后兼容）。

- [ ] **Step 1: 新建 `styles.css`（repo 根）**

```css
/* Cobrain 对话面板：作用域类 + Obsidian 主题变量，深浅主题自动适配 */
.cobrain-root { display: flex; flex-direction: column; height: 100%; }
.cobrain-messages { flex: 1; overflow-y: auto; padding: 8px 10px; }
.cobrain-welcome { color: var(--text-muted); padding: 6px 4px 10px; font-size: 0.88em; line-height: 1.5; }
.cobrain-bar { display: flex; gap: 6px; padding: 6px 10px; flex-wrap: wrap; border-top: 1px solid var(--background-modifier-border); }
.cobrain-bar button { font-size: 0.82em; padding: 2px 10px; }
.cobrain-inputrow { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--background-modifier-border); align-items: flex-end; }
.cobrain-input { flex: 1; resize: none; min-height: 2.2em; max-height: 40vh; overflow-y: auto; }
.cobrain-bubble { margin: 8px 0; padding: 8px 10px; border-radius: 8px; }
.cobrain-bubble-user { background: var(--background-secondary); }
.cobrain-bubble-ai { background: var(--background-primary-alt); }
.cobrain-who { font-size: 0.7em; color: var(--text-faint); margin-bottom: 4px; }
.cobrain-srcline { font-size: 0.7em; color: var(--text-faint); margin-top: 6px; }
.cobrain-related { margin: 8px 0; padding: 6px 10px; border-left: 2px solid var(--interactive-accent); background: var(--background-secondary); border-radius: 4px; }
.cobrain-related-head { font-size: 0.7em; color: var(--text-muted); margin-bottom: 4px; }
.cobrain-related-item { margin: 4px 0; cursor: pointer; }
.cobrain-related-title { font-size: 0.85em; color: var(--text-accent); }
.cobrain-related-snippet { font-size: 0.78em; color: var(--text-faint); }
```

- [ ] **Step 2: chatView —— 加字段 `pendingSourceContext`**

`src/ui/chatView.ts`，在 `private busy = false; ...` 那行之后加：
```ts
  private pendingSourceContext: string | null = null; // 引用带来的源笔记小节，只喂给紧接着的那一问
```

- [ ] **Step 3: chatView —— 重写 `onOpen`（class + 自适应输入框 + 精简开场白）**

把 `onOpen` 整体替换为：
```ts
  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cobrain-root");

    this.messagesEl = root.createDiv({ cls: "cobrain-messages" });
    this.messagesEl.createDiv({
      cls: "cobrain-welcome",
      text: "聊你正在想的——我会翻出你写过的相关旧笔记摊到眼前，并回抛问题逼你自己想。下方：概念图 / 配图 / 存为笔记。",
    });

    const bar = root.createDiv({ cls: "cobrain-bar" });
    this.makeBtn(bar, "概念图", () => void this.doConceptMap());
    this.makeBtn(bar, "配图", () => this.doImage());
    this.makeBtn(bar, "存为笔记", () => void this.doSaveNote());

    const iw = root.createDiv({ cls: "cobrain-inputrow" });
    this.inputEl = iw.createEl("textarea", {
      cls: "cobrain-input",
      attr: { rows: "1", placeholder: "问副脑…（Enter 发送，Shift+Enter 换行）" },
    });
    this.sendBtn = iw.createEl("button", { text: "发送" });
    this.sendBtn.onclick = () => void this.send();
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    this.autoGrow();
  }

  // 输入框随内容长高；上限与滚动由 CSS（.cobrain-input 的 max-height/overflow）封顶。
  private autoGrow(): void {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = this.inputEl.scrollHeight + "px";
  }
```

- [ ] **Step 4: chatView —— `makeBtn` 去内联**

把 `makeBtn` 替换为：
```ts
  private makeBtn(parent: HTMLElement, text: string, fn: () => void): void {
    const b = parent.createEl("button", { text });
    b.onclick = fn;
  }
```

- [ ] **Step 5: chatView —— `addBubble` 改 class**

把 `addBubble` 替换为：
```ts
  private addBubble(role: "user" | "assistant", text: string, sources?: string[]): HTMLElement {
    const b = this.messagesEl.createDiv({ cls: `cobrain-bubble cobrain-bubble-${role === "user" ? "user" : "ai"}` });
    b.createDiv({ cls: "cobrain-who", text: role === "user" ? "你" : "副脑" });
    const body = b.createDiv();
    if (role === "assistant") void MarkdownRenderer.render(this.app, text, body, "", this);
    else body.setText(text);
    if (sources?.length) {
      b.createDiv({ cls: "cobrain-srcline", text: "来源：" + sources.map(p => p.split("/").pop()).join("、") });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return b;
  }
```

- [ ] **Step 6: chatView —— `addRelatedBlock` 改 class**

把 `addRelatedBlock` 替换为：
```ts
  // 把检索命中的旧笔记显式列出来、可点开——让 vault 主动「撞」你（第二大脑「联想」）
  private addRelatedBlock(hits: QueryHit[]): void {
    if (!hits.length) return;
    const seen = new Set<string>();
    const uniq = hits.filter(h => {
      if (seen.has(h.path)) return false;
      seen.add(h.path);
      return true;
    });
    const wrap = this.messagesEl.createDiv({ cls: "cobrain-related" });
    wrap.createDiv({ cls: "cobrain-related-head", text: "你写过的（点开撞一撞）" });
    uniq.slice(0, 5).forEach(h => {
      const item = wrap.createDiv({ cls: "cobrain-related-item" });
      const title = (h.path.split("/").pop() ?? h.path).replace(/\.md$/, "") + (h.heading ? " › " + h.heading : "");
      item.createDiv({ cls: "cobrain-related-title", text: title });
      item.createDiv({ cls: "cobrain-related-snippet", text: h.text.slice(0, 80) + (h.text.length > 80 ? "…" : "") });
      item.onclick = () => this.app.workspace.openLinkText(h.path, "", false);
    });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
```

- [ ] **Step 7: chatView —— `quoteIntoInput` 接收并暂存来源上下文**

把 `quoteIntoInput` 替换为：
```ts
  // 把"引用"(来源链接 + 原文)预填进输入框；来源上下文暂存，喂给紧接着的那一问。
  quoteIntoInput(text: string, sourceContext?: string): void {
    this.pendingSourceContext = sourceContext ?? null;
    this.inputEl.value = text + this.inputEl.value;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
    this.autoGrow();
    this.inputEl.scrollTop = 0; // 引用在顶部，确保可见
  }
```

- [ ] **Step 8: chatView —— `send` 消费来源上下文 + 复位高度**

把 `send` 方法体开头到 `tutor.ask` 调用处改为消费 `pendingSourceContext`。整体替换 `send` 为：
```ts
  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.acquire()) return;
    const sourceContext = this.pendingSourceContext; // 消费一次：仅这一问带来源上下文
    this.pendingSourceContext = null;
    this.inputEl.value = "";
    this.autoGrow();
    this.addBubble("user", text);
    const thinking = this.addBubble("assistant", "思考中…");
    try {
      const { reply, sources, related } = await this.plugin.tutor.ask(this.history, text, sourceContext ?? undefined);
      thinking.remove();
      // 先把你自己写过的相关旧笔记摊到眼前（第二大脑「联想」），再看导师的回应
      this.addRelatedBlock(related);
      this.addBubble("assistant", reply);
      sources.forEach(s => this.sources.add(s));
      this.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
      if (this.history.length > 20) this.history = this.history.slice(-20);
    } catch (e) {
      thinking.remove();
      this.addBubble("assistant", "出错了：" + errMsg(e));
    } finally {
      this.release();
      this.inputEl.focus();
    }
  }
```

- [ ] **Step 9: main.ts —— import + `quoteSelection` 算并传来源上下文**

`src/main.ts`，把 `import { buildQuote, findHeadingAbove } from "./util/quote";` 改为：
```ts
import { buildQuote, findHeadingAbove, extractContext } from "./util/quote";
```
并把 `quoteSelection` 替换为：
```ts
  // 选中文本 → 引用进 Cobrain：取选区 + 来源链接 + 最近标题 + 所在小节，预填进面板（不自动发）。
  private async quoteSelection(editor: Editor, ctx: MarkdownFileInfo): Promise<void> {
    const sel = editor.getSelection();
    if (!sel.trim()) { new Notice("先选中一段文字"); return; }
    const file = ctx.file;
    if (!file) { new Notice("无法确定来源文件"); return; }
    const linktext = this.app.metadataCache.fileToLinktext(file, "", true);
    const lines = editor.getValue().split("\n");
    const fromLine = editor.getCursor("from").line;
    const heading = findHeadingAbove(lines, fromLine);
    const sourceContext = extractContext(lines, fromLine);
    const view = await this.activateChatView();
    view?.quoteIntoInput(buildQuote(sel, linktext, heading), sourceContext);
  }
```

- [ ] **Step 10: deploy.mjs —— 拷 styles.css**

`deploy.mjs`，把：
```js
for (const f of ["main.js", "manifest.json"]) {
```
改为：
```js
for (const f of ["main.js", "manifest.json", "styles.css"]) {
```

- [ ] **Step 11: 校验**

Run: `npx tsc -noEmit -skipLibCheck && npx jest 2>&1 | tail -4 && npm run build 2>&1 | tail -3`
Expected: tsc 0；jest `Tests: 39 passed, 39 total`（原 35 + Task 1 的 4）；build 0。

- [ ] **Step 12: 提交**

```bash
git add src/ui/chatView.ts src/main.ts styles.css deploy.mjs
git commit -m "feat(ui): 引用喂源笔记上下文 + 输入框自适应 + 面板简洁化迁 styles.css" -m "- quoteSelection 算所在小节 → quoteIntoInput 暂存 → send 消费传 tutor.ask
- textarea 随内容自适应（CSS max-height 封顶）；内联样式迁 .cobrain-* 类、跟随主题
- deploy.mjs 加拷 styles.css" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 集成验证 + 手动冒烟

**Files:** 无代码改动。

- [ ] **Step 1: 全量 build + test**

Run: `npm run build && npm test`
Expected: build 0；`Tests: 39 passed, 39 total`。

- [ ] **Step 2: 部署 + 确认 styles.css 到位**

Run: `npm run deploy`
Expected: 输出含 `[deploy] styles.css → …`；测试 vault 插件目录里出现 `styles.css`。

- [ ] **Step 3: 手动冒烟（Obsidian，需人工）**

1. 选段引用 → 输入框只显示精简 `> 引文 + 链接`，且随内容自适应、看得全；发送 → 回答明显带上那段上下文（问「这句指什么」能答到周边）。
2. 普通追问不再带来源（上下文已在 history）；存为笔记仍正常。
3. 面板观感：开场白简洁、间距舒服；切换深 / 浅主题颜色都正常跟随、不破。
4. 改 `styles.css` 一个颜色 → `npm run deploy` → 重载，确认生效（验证 styles.css 已分发）。

> Step 3 需人工；前 2 步可自动。

---

## Self-Review

**Spec coverage：**
- 引用上下文 C（extractContext / quoteSelection 算并传 / pendingSourceContext 暂存消费 / tutor.ask 注入 / RAG 不变）→ Task 1 + Task 2 + Task 3 Step 2/7/8/9。✓
- 输入框自适应（autoGrow + CSS max-height）→ Task 3 Step 1/3/7/8。✓
- 简洁化 + styles.css（新建 + class 迁移 + 精简开场白 + deploy 加拷）→ Task 3 Step 1/3-6/10。✓
- 测试（extractContext）→ Task 1。✓

**Placeholder scan:** 无 TBD/TODO；代码步骤均含完整代码；命令含预期输出。✓

**Type consistency:** `extractContext(lines, fromLine, maxChars?)` 在 Task 1 定义、Task 3 Step 9 调用一致；`ask(history, userMsg, sourceContext?)` 在 Task 2 定义、Task 3 Step 8 调用一致；`quoteIntoInput(text, sourceContext?)` 在 Task 3 Step 7 定义、Step 9 调用一致；`autoGrow` 在 Step 3 定义、Step 7/8 调用；`pendingSourceContext` 字段在 Step 2 加、Step 7/8 用。✓
