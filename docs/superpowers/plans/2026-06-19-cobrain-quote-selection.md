# 选中即引用进 Cobrain 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 编辑模式下选中文本，经右键菜单或命令把「来源链接 + 原文」预填进 Cobrain 输入框，免复制粘贴。

**Architecture:** 纯函数（`buildQuote`/`findHeadingAbove`，obsidian-free，可单测）抽到 `src/util/quote.ts`；`main.ts` 注册 `editor-menu` 事件 + 一条 `editorCallback` 命令，共用私有方法 `quoteSelection(editor, ctx)`：取选区 + `fileToLinktext` + 最近标题 → 激活面板 → 调 `ChatView.quoteIntoInput()` 预填输入框。复用现有发送/检索/存笔记管线，零改动。

**Tech Stack:** TypeScript、Obsidian API（`editor-menu` 事件、`editorCallback`、`Editor.getSelection/getCursor/getValue`、`MetadataCache.fileToLinktext`、`Menu`/`MenuItem`、`Platform`）、Jest、esbuild。

## Global Constraints

- 不引入任何新依赖（`package.json` 的 `dependencies` 保持为空）。
- `npx tsc -noEmit -skipLibCheck` 必须零报错。
- 纯函数测试不得 import `obsidian`（测试环境无 obsidian 运行时）。
- 现有 30 个测试不得回归。
- 不改 `tutor.ask` / 检索 / 存笔记逻辑——引用作为用户消息文本，自然流经现有管线。
- 入口不按平台门控：编辑模式（含移动端编辑模式）都可用；纯阅读模式无 editor，自然不触发。
- 提交信息用中文，结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 沿用项目惯例在 `main` 分支直接提交。

## 文件结构

| 文件 | 改动 |
|---|---|
| `src/util/quote.ts` | 新建：`buildQuote` + `findHeadingAbove`（纯函数） |
| `src/util/quote.test.ts` | 新建：上述两函数单测 |
| `src/ui/chatView.ts` | 加 public 方法 `quoteIntoInput(text)` |
| `src/main.ts` | import；`activateChatView` 返回 `ChatView \| null`；加 `quoteSelection`；加命令 + `editor-menu` 注册 |

---

### Task 1: 引用纯函数 `src/util/quote.ts`（TDD）

**Files:**
- Create: `src/util/quote.ts`
- Test: `src/util/quote.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，输入字符串/数组）。
- Produces:
  - `buildQuote(selection: string, linktext: string, heading: string | null): string`
  - `findHeadingAbove(lines: string[], fromLine: number): string | null`

- [ ] **Step 1: 写失败测试**

Create `src/util/quote.test.ts`:

```ts
import { buildQuote, findHeadingAbove } from "./quote";

test("buildQuote 单行 + 无标题", () => {
  expect(buildQuote("hello", "Note", null)).toBe("> hello\n> —— [[Note]]\n\n");
});

test("buildQuote 多行 + 标题", () => {
  expect(buildQuote("a\nb", "Note", "Sec")).toBe("> a\n> b\n> —— [[Note#Sec]]\n\n");
});

test("findHeadingAbove 返回最近的上方标题", () => {
  const lines = ["# 一级", "正文", "## 二级", "目标行", "更多"];
  expect(findHeadingAbove(lines, 3)).toBe("二级");
});

test("findHeadingAbove 无标题返回 null", () => {
  expect(findHeadingAbove(["正文", "再一行"], 1)).toBeNull();
});

test("findHeadingAbove 本行即标题也算", () => {
  expect(findHeadingAbove(["# 标题"], 0)).toBe("标题");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest src/util/quote.test.ts`
Expected: FAIL —— `Cannot find module './quote'`。

- [ ] **Step 3: 写实现**

Create `src/util/quote.ts`:

```ts
// 选中文本 → 引用块：逐行 blockquote + 尾部来源链接，末尾留空行供用户接着打疑问。
// 纯函数，不 import obsidian，便于 jest 直接单测。
export function buildQuote(selection: string, linktext: string, heading: string | null): string {
  const quoted = selection.split("\n").map(l => "> " + l).join("\n");
  const target = heading ? `${linktext}#${heading}` : linktext;
  return `${quoted}\n> —— [[${target}]]\n\n`;
}

// 从 fromLine 起向上找最近的 ATX 标题文本（含本行；找不到返回 null）。
// 简单上扫，不处理代码围栏内的 #（少见，可接受）。
export function findHeadingAbove(lines: string[], fromLine: number): string | null {
  for (let i = Math.min(fromLine, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(/^#{1,6}\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/util/quote.test.ts`
Expected: PASS（5 个用例全过）。

- [ ] **Step 5: 提交**

```bash
git add src/util/quote.ts src/util/quote.test.ts
git commit -m "feat(quote): 引用纯函数 buildQuote/findHeadingAbove（工作流 #4）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: UI 接线（chatView + main.ts）

**Files:**
- Modify: `src/ui/chatView.ts`（加 `quoteIntoInput`，在 `release()` 之后）
- Modify: `src/main.ts:1`（import obsidian 类型）、`:10` 后（import quote 工具）、`:61-68` 后（加命令）、`:83` 后（加 editor-menu）、`:190-198`（`activateChatView` 改返回 + 加 `quoteSelection`）

**Interfaces:**
- Consumes: `buildQuote`、`findHeadingAbove`（Task 1）；`ChatView`、`VIEW_TYPE_COBRAIN_CHAT`（已有）。
- Produces:
  - `ChatView.quoteIntoInput(text: string): void`（public）
  - `CobrainPlugin.activateChatView(): Promise<ChatView | null>`（由 void 改为返回 view）
  - `CobrainPlugin.quoteSelection(editor: Editor, ctx: MarkdownFileInfo): Promise<void>`（private）

- [ ] **Step 1: chatView 加 `quoteIntoInput`**

在 `src/ui/chatView.ts` 的 `release()` 方法之后插入（`quoteIntoInput` 须为 public，main 会调用）：

找到：
```ts
  private release(): void {
    this.busy = false;
    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
  }
```
替换为：
```ts
  private release(): void {
    this.busy = false;
    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
  }

  // 把"引用"(来源链接 + 原文)预填进输入框：已有内容则插在前面、保留你的字；光标停在引用之后。
  quoteIntoInput(text: string): void {
    this.inputEl.value = text + this.inputEl.value;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
  }
```

- [ ] **Step 2: main.ts —— import**

`src/main.ts:1`，把：
```ts
import { Plugin, Notice, TFile, Modal, App, normalizePath, debounce, Platform } from "obsidian";
```
改为：
```ts
import { Plugin, Notice, TFile, Modal, App, normalizePath, debounce, Platform, Editor, MarkdownFileInfo } from "obsidian";
```
并在 `import { ImageClient } from "./llm/imageClient";`（:10）之后加一行：
```ts
import { buildQuote, findHeadingAbove } from "./util/quote";
```

- [ ] **Step 3: main.ts —— 加命令**

找到 `cobrain-test-retrieval` 命令块（:61-68）：
```ts
    this.addCommand({
      id: "cobrain-test-retrieval",
      name: "Cobrain: 测试检索",
      callback: () => new QueryModal(this.app, async (q) => {
        const hits = await this.retriever.retrieve(q, 8);
        new ResultsModal(this.app, q, hits).open();
      }).open(),
    });
```
在其后插入：
```ts

    this.addCommand({
      id: "cobrain-quote-selection",
      name: "Cobrain: 引用选中文本",
      editorCallback: (editor, ctx) => void this.quoteSelection(editor, ctx),
    });
```

- [ ] **Step 4: main.ts —— 注册 editor-menu**

找到 onload 末尾的事件块收尾 + `console.log`（:83-85）：
```ts
      }));
    }

    console.log("Cobrain loaded");
```
替换为：
```ts
      }));
    }

    // 选中文本 → 引用进 Cobrain（右键菜单；仅编辑模式有 editor 时出现，移动端编辑模式同样可用）
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, ctx) => {
      if (!editor.getSelection().trim()) return;
      menu.addItem(item =>
        item.setTitle("引用进 Cobrain").setIcon("brain").onClick(() => void this.quoteSelection(editor, ctx)),
      );
    }));

    console.log("Cobrain loaded");
```

- [ ] **Step 5: main.ts —— `activateChatView` 改返回 + 加 `quoteSelection`**

找到 `activateChatView`（:190-198）：
```ts
  async activateChatView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_COBRAIN_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_COBRAIN_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
  }
```
替换为：
```ts
  async activateChatView(): Promise<ChatView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_COBRAIN_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_COBRAIN_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  // 选中文本 → 引用进 Cobrain：取选区 + 来源链接 + 最近标题，预填进对话面板输入框（不自动发）。
  private async quoteSelection(editor: Editor, ctx: MarkdownFileInfo): Promise<void> {
    const sel = editor.getSelection();
    if (!sel.trim()) { new Notice("先选中一段文字"); return; }
    const file = ctx.file;
    if (!file) { new Notice("无法确定来源文件"); return; }
    const linktext = this.app.metadataCache.fileToLinktext(file, "", true);
    const lines = editor.getValue().split("\n");
    const heading = findHeadingAbove(lines, editor.getCursor("from").line);
    const view = await this.activateChatView();
    view?.quoteIntoInput(buildQuote(sel, linktext, heading));
  }
```

- [ ] **Step 6: 校验**

Run: `npx tsc -noEmit -skipLibCheck && npx jest 2>&1 | tail -4 && npm run build 2>&1 | tail -3`
Expected: tsc 退出码 0；jest `Tests: 35 passed, 35 total`（原 30 + Task 1 的 5）；build 退出码 0。

- [ ] **Step 7: 提交**

```bash
git add src/ui/chatView.ts src/main.ts
git commit -m "feat(quote): 右键/命令把选中文本引用进 Cobrain（预填输入框）" -m "- editor-menu「引用进 Cobrain」+ 命令 cobrain-quote-selection
- quoteSelection 取选区+来源+最近标题；activateChatView 返回 view；ChatView.quoteIntoInput 预填" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 集成验证 + 手动冒烟

**Files:** 无代码改动。

- [ ] **Step 1: 全量构建**

Run: `npm run build`
Expected: tsc + esbuild production 均退出码 0，生成 `main.js`。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: `Tests: 35 passed, 35 total`，无回归。

- [ ] **Step 3: 部署到测试 vault**

Run: `npm run deploy`
Expected: `main.js` + `manifest.json` 拷入测试 vault。

- [ ] **Step 4: 手动冒烟（在 Obsidian 中，需人工）**

1. 实时预览里选一段**英文**，右键 →「引用进 Cobrain」→ 面板打开、输入框预填 `> 英文…` 多行 + `> —— [[来源#标题]]`，光标停在其后。
2. 接着打一句中文疑问 → 发送 → 正常回答；下方「你写过的」能撞出相关旧笔记。
3. 源码模式重复一次；用命令面板「Cobrain: 引用选中文本」（或绑快捷键）重复一次。
4. 不选中直接跑命令 → Notice「先选中一段文字」。
5. 存为笔记（开「附原始问题」）→ 笔记「## 原始问题」里带 `[[来源]]` 双链。

> Step 4 需人工在 Obsidian 完成；前 3 步可自动执行。

---

## Self-Review

**Spec coverage（对照 spec）：**
- 两个入口（右键菜单 + 命令）→ Task 2 Step 3/4。✓
- 取选区 + 来源链接 + 最近标题 → Task 2 Step 5 `quoteSelection` + Task 1 `findHeadingAbove`。✓
- 注入面板预填（不自动发）→ Task 2 Step 1 `quoteIntoInput` + Step 5 `activateChatView` 返回 view。✓
- 预填格式（纯 `> 引文` + 尾部 `> —— [[链接]]`）→ Task 1 `buildQuote`。✓
- 编辑模式（含移动端）生效、不门控平台 → editor-menu/命令未包 `Platform.isMobile`。✓
- 不改检索/存笔记/tutor → 仅新增入口与预填，未碰 `tutor.ask`/`saveNote`。✓
- 测试（buildQuote/findHeadingAbove）→ Task 1 五用例。✓

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整 old→new；命令含预期输出。✓

**Type consistency:** `buildQuote(selection, linktext, heading)` / `findHeadingAbove(lines, fromLine)` 签名在 Task 1 定义、Task 2 调用一致；`quoteSelection(editor: Editor, ctx: MarkdownFileInfo)` 的 `ctx` 接收 `editorCallback`/`editor-menu` 传来的 `MarkdownView | MarkdownFileInfo`（均 assignable 到 `MarkdownFileInfo`，后者有 `get file(): TFile | null`）；`activateChatView` 改 `Promise<ChatView | null>`，现有调用方（ribbon、open 命令）忽略返回值不受影响；`quoteIntoInput` 为 public，main 经 `view?.` 调用。✓
