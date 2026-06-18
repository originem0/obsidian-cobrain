# Obsidian 学习导师插件 — Plan 1：RAG 基础 Implementation Plan

> 历史快照（2026-06-18）。本项目已演进为 **Cobrain（创作副脑）**。本文档保留作过程记录，当前设计以 `README.md` 及 design 文档「演进」小节为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭好"本地嵌入 + 自建向量库 + 语义检索 vault"的基础，产出一个能用调试命令独立验证的语义检索能力（给一段查询 → 返回 vault 中最相关的笔记片段）。

**Architecture:** 独立 Obsidian 插件（TS）。本地 transformers.js 算嵌入（可插拔 `Embedder` 接口），自建向量库 + cosine 检索（向量 L2 归一化后点积即 cosine），索引持久化到插件 data。本计划**不含 UI/导师**，只把检索闭环跑通。导师对话与笔记/概念图/配图三命令在 Plan 2。

**Tech Stack:** TypeScript、Obsidian Plugin API、esbuild、`@huggingface/transformers`（本地 ONNX 嵌入，wasm 后端）、Jest + ts-jest（仅测纯函数）。

**约束：** 密钥只存插件设置，**绝不写进任何提交的文件**。`isDesktopOnly: true`（本地 ONNX 需桌面端）。中文 vault → 默认嵌入模型用多语种 `Xenova/multilingual-e5-small`，并按 e5 规范给文档加 `passage: `、给查询加 `query: ` 前缀。

---

### Task 1: 插件脚手架 + 构建/测试链路

**Files:**
- Create: `manifest.json`, `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `jest.config.js`, `.gitignore`, `src/main.ts`

- [ ] **Step 1: 写 `manifest.json`**

```json
{
  "id": "learning-tutor",
  "name": "Learning Tutor",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "懂你 vault 的对话式学习导师：RAG 检索 + 概念图 + 配图。",
  "author": "samsara",
  "isDesktopOnly": true
}
```

- [ ] **Step 2: 写 `package.json`**

```json
{
  "name": "obsidian-learning-tutor",
  "version": "0.1.0",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "test": "jest"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.12.0",
    "esbuild": "^0.21.5",
    "jest": "^29.7.0",
    "obsidian": "^1.5.7",
    "ts-jest": "^29.1.4",
    "typescript": "^5.4.5"
  },
  "dependencies": {
    "@huggingface/transformers": "^3.0.2"
  }
}
```

- [ ] **Step 3: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "module": "ESNext",
    "target": "ES2020",
    "moduleResolution": "node",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: 写 `jest.config.js`**

```js
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/src/**/*.test.ts"],
};
```

- [ ] **Step 5: 写 `esbuild.config.mjs`**

```js
import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // obsidian/electron 由宿主提供；transformers 体积大但需打进 bundle
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  platform: "node",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
});
if (prod) { await ctx.rebuild(); process.exit(0); }
else { await ctx.watch(); }
```

- [ ] **Step 6: 写 `.gitignore`**

```
node_modules/
main.js
*.map
data.json
.DS_Store
```

> 注：`data.json`（插件运行时数据，含密钥与向量索引）被忽略，确保密钥与索引不入库。

- [ ] **Step 7: 写最小 `src/main.ts`**

```ts
import { Plugin, Notice } from "obsidian";

export default class LearningTutorPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "lt-hello",
      name: "LT: Hello（脚手架自检）",
      callback: () => new Notice("Learning Tutor 已加载"),
    });
    console.log("Learning Tutor loaded");
  }
  onunload() {
    console.log("Learning Tutor unloaded");
  }
}
```

- [ ] **Step 8: 安装依赖并构建**

Run: `cd /d/Development/Apps/obsidian-learning-tutor && npm install && npm run build`
Expected: 生成 `main.js`，无类型错误。

- [ ] **Step 9: 在测试 vault 中手动验证加载**

把仓库软链/复制到某个测试 vault 的 `.obsidian/plugins/learning-tutor/`（需 `manifest.json` + `main.js`），在 Obsidian 设置里启用插件，命令面板执行 “LT: Hello”。
Expected: 弹出 “Learning Tutor 已加载”；控制台打印 `Learning Tutor loaded`。

- [ ] **Step 10: 提交**

```bash
git add manifest.json package.json tsconfig.json jest.config.js esbuild.config.mjs .gitignore src/main.ts
git commit -m "feat: 插件脚手架 + 构建/测试链路"
```

---

### Task 2: 向量数学工具（纯函数，TDD）

**Files:**
- Create: `src/rag/vectorMath.ts`
- Test: `src/rag/vectorMath.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { dot, topK } from "./vectorMath";

test("dot 计算点积", () => {
  expect(dot([1, 0, 1], [1, 2, 3])).toBe(4);
});

test("topK 按点积降序取前 k", () => {
  const items = [
    { id: "a", vector: [1, 0] },
    { id: "b", vector: [0, 1] },
    { id: "c", vector: [0.9, 0.1] },
  ];
  const res = topK([1, 0], items, 2);
  expect(res.map(r => r.id)).toEqual(["a", "c"]);
  expect(res[0].score).toBeCloseTo(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- vectorMath`
Expected: FAIL（`Cannot find module './vectorMath'`）。

- [ ] **Step 3: 写实现**

```ts
export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface Scored { id: string; score: number; }

// 约定：所有向量已 L2 归一化，故点积 == cosine 相似度
export function topK(
  query: number[],
  items: { id: string; vector: number[] }[],
  k: number
): Scored[] {
  return items
    .map(it => ({ id: it.id, score: dot(query, it.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- vectorMath`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/rag/vectorMath.ts src/rag/vectorMath.test.ts
git commit -m "feat: 向量点积与 topK 检索（带单测）"
```

---

### Task 3: Markdown 分块器（纯函数，TDD）

**Files:**
- Create: `src/rag/chunker.ts`
- Test: `src/rag/chunker.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { chunkMarkdown } from "./chunker";

test("空白内容返回空数组", () => {
  expect(chunkMarkdown("   \n\n")).toEqual([]);
});

test("按标题归属，并在超长时切分", () => {
  const md = `# 标题A\n段落一。\n\n## 标题B\n${"句子。".repeat(400)}`;
  const chunks = chunkMarkdown(md, 300);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks[0].heading).toBe("标题A");
  // 标题B 下内容超长 → 被切成多块，且每块不超过上限太多
  const bChunks = chunks.filter(c => c.heading === "标题B");
  expect(bChunks.length).toBeGreaterThanOrEqual(2);
  bChunks.forEach(c => expect(c.text.length).toBeLessThanOrEqual(360));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- chunker`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
export interface Chunk { text: string; heading: string; }

// 策略：按 ATX 标题分节 → 节内按段落累积到 ~maxChars 一块；过长段落硬切。
export function chunkMarkdown(content: string, maxChars = 1000): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let heading = "";
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    if (text.length <= maxChars) {
      chunks.push({ text, heading });
      return;
    }
    for (let i = 0; i < text.length; i += maxChars) {
      const piece = text.slice(i, i + maxChars).trim();
      if (piece) chunks.push({ text: piece, heading });
    }
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      heading = m[2].trim();
      continue;
    }
    if (line.trim() === "") {
      // 段落边界：若已接近上限就 flush
      if (buf.join("\n").length >= maxChars) flush();
      else buf.push("");
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- chunker`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/rag/chunker.ts src/rag/chunker.test.ts
git commit -m "feat: Markdown 按标题/段落分块（带单测）"
```

---

### Task 4: Embedder 接口 + 本地 transformers.js 实现

**Files:**
- Create: `src/rag/embedder.ts`（接口）, `src/rag/localEmbedder.ts`（实现）

> 说明：transformers.js 的本地模型加载依赖 Obsidian 运行时（Electron），无法在 Jest/node 里轻量单测，故本任务用**构建 + Obsidian 内手测**验证，不写单测。

- [ ] **Step 1: 写接口 `src/rag/embedder.ts`**

```ts
export interface Embedder {
  // 文档侧批量嵌入（实现内部按需加 "passage: " 前缀）
  embedDocuments(texts: string[]): Promise<number[][]>;
  // 查询侧（按需加 "query: " 前缀）
  embedQuery(text: string): Promise<number[]>;
  readonly dim: number | null;
}
```

- [ ] **Step 2: 写 `src/rag/localEmbedder.ts`**

```ts
import { pipeline, env } from "@huggingface/transformers";
import type { Embedder } from "./embedder";

// e5 系列要求文档/查询分别加前缀；非 e5 模型设 useE5Prefix=false。
export class LocalEmbedder implements Embedder {
  private extractor: any = null;
  private loading: Promise<void> | null = null;
  dim: number | null = null;

  constructor(
    private modelId = "Xenova/multilingual-e5-small",
    private useE5Prefix = true
  ) {
    // 允许从 HF CDN 拉取模型；首次使用时下载并缓存
    env.allowRemoteModels = true;
  }

  private async ensure(): Promise<void> {
    if (this.extractor) return;
    if (!this.loading) {
      this.loading = (async () => {
        this.extractor = await pipeline("feature-extraction", this.modelId);
      })();
    }
    await this.loading;
  }

  private async embedOne(text: string): Promise<number[]> {
    await this.ensure();
    const res = await this.extractor(text, { pooling: "mean", normalize: true });
    const vec = Array.from(res.data as Float32Array);
    this.dim = vec.length;
    return vec;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) {
      out.push(await this.embedOne(this.useE5Prefix ? `passage: ${t}` : t));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedOne(this.useE5Prefix ? `query: ${text}` : text);
  }
}
```

- [ ] **Step 3: 构建确认能打进 bundle**

Run: `cd /d/Development/Apps/obsidian-learning-tutor && npm run build`
Expected: 构建成功生成 `main.js`。
若 esbuild 因 `onnxruntime-node` 报错：在 `esbuild.config.mjs` 的 `external` 加 `"onnxruntime-node"`，改用 wasm 后端（transformers.js 默认在 Electron 渲染进程可用 wasm）。把这一处理记进 README。

- [ ] **Step 4: 临时自检嵌入（手测）**

在 `src/main.ts` 的 `onload` 临时加一个命令调用 `new LocalEmbedder().embedQuery("测试")` 并 `console.log(vec.length)`；构建、重载、执行。
Expected: 首次会下载模型（约 20–50MB，控制台有进度），随后打印维度（multilingual-e5-small 为 384）。验证后删除该临时命令。

- [ ] **Step 5: 提交**

```bash
git add src/rag/embedder.ts src/rag/localEmbedder.ts
git commit -m "feat: 本地 transformers.js 嵌入器（e5 前缀，可插拔接口）"
```

---

### Task 5: 向量库（持久化 + 检索）

**Files:**
- Create: `src/rag/vectorStore.ts`
- Test: `src/rag/vectorStore.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { VectorStore } from "./vectorStore";

test("增删查与序列化", () => {
  const s = new VectorStore();
  s.setFile("a.md", 100, [
    { text: "猫", heading: "", vector: [1, 0] },
    { text: "狗", heading: "", vector: [0.8, 0.2] },
  ]);
  s.setFile("b.md", 100, [{ text: "汽车", heading: "", vector: [0, 1] }]);

  const hits = s.query([1, 0], 2);
  expect(hits[0].path).toBe("a.md");
  expect(hits.length).toBe(2);

  // 重设同一文件应替换旧块
  s.setFile("a.md", 200, [{ text: "鱼", heading: "", vector: [0, 1] }]);
  expect(s.query([1, 0], 5).filter(h => h.path === "a.md").length).toBe(1);

  // 序列化往返
  const json = s.serialize();
  const s2 = new VectorStore();
  s2.deserialize(json);
  expect(s2.query([0, 1], 1)[0].text).toBeDefined();

  // mtime 查询
  expect(s.getMtime("a.md")).toBe(200);
  s.removeFile("a.md");
  expect(s.getMtime("a.md")).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- vectorStore`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
import { topK } from "./vectorMath";

export interface Entry { path: string; chunkIdx: number; text: string; heading: string; vector: number[]; }
export interface QueryHit { path: string; text: string; heading: string; score: number; }
interface ChunkInput { text: string; heading: string; vector: number[]; }

export class VectorStore {
  private entries: Entry[] = [];
  private mtimes: Record<string, number> = {};

  setFile(path: string, mtime: number, chunks: ChunkInput[]): void {
    this.removeFile(path);
    chunks.forEach((c, i) =>
      this.entries.push({ path, chunkIdx: i, text: c.text, heading: c.heading, vector: c.vector })
    );
    this.mtimes[path] = mtime;
  }

  removeFile(path: string): void {
    this.entries = this.entries.filter(e => e.path !== path);
    delete this.mtimes[path];
  }

  getMtime(path: string): number | null {
    return path in this.mtimes ? this.mtimes[path] : null;
  }

  query(vector: number[], k: number): QueryHit[] {
    const scored = topK(
      vector,
      this.entries.map(e => ({ id: `${e.path}#${e.chunkIdx}`, vector: e.vector })),
      k
    );
    return scored.map(s => {
      const e = this.entries.find(x => `${x.path}#${x.chunkIdx}` === s.id)!;
      return { path: e.path, text: e.text, heading: e.heading, score: s.score };
    });
  }

  serialize(): { entries: Entry[]; mtimes: Record<string, number> } {
    return { entries: this.entries, mtimes: this.mtimes };
  }

  deserialize(data: { entries: Entry[]; mtimes: Record<string, number> } | null): void {
    this.entries = data?.entries ?? [];
    this.mtimes = data?.mtimes ?? {};
  }

  allPaths(): string[] { return Object.keys(this.mtimes); }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- vectorStore`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/rag/vectorStore.ts src/rag/vectorStore.test.ts
git commit -m "feat: 自建向量库（增删查 + 持久化序列化，带单测）"
```

---

### Task 6: 设置（数据模型 + 设置页）

**Files:**
- Create: `src/settings.ts`
- Modify: `src/main.ts`

> 设置一次配齐（含 Plan 2 要用的 chat/image 字段），避免二次开页。密钥仅存本地 `data.json`（已 gitignore）。

- [ ] **Step 1: 写 `src/settings.ts`**

```ts
import { App, PluginSettingTab, Setting } from "obsidian";
import type LearningTutorPlugin from "./main";

export interface LTSettings {
  llmBaseUrl: string;
  llmKey: string;
  llmModel: string;
  imageBaseUrl: string;
  imageKey: string;
  imageModel: string;
  embedModel: string;
  noteFolder: string;
  attachmentFolder: string;
}

export const DEFAULT_SETTINGS: LTSettings = {
  llmBaseUrl: "https://wududu.edu.kg/v1",
  llmKey: "",
  llmModel: "z-ai/glm-5.1",
  imageBaseUrl: "https://freeapi.dgbmc.top/v1",
  imageKey: "",
  imageModel: "gpt-image-2",
  embedModel: "Xenova/multilingual-e5-small",
  noteFolder: "学习导师",
  attachmentFolder: "学习导师/附件",
};

export class LTSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LearningTutorPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    const text = (name: string, desc: string, key: keyof LTSettings, ph = "") =>
      new Setting(containerEl).setName(name).setDesc(desc).addText(t =>
        t.setPlaceholder(ph).setValue(s[key]).onChange(async v => {
          s[key] = v.trim() as any;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "文本 LLM（对话）" });
    text("Base URL", "OpenAI 兼容端点", "llmBaseUrl");
    text("API Key", "仅存本地，不入库", "llmKey", "sk-...");
    text("Model", "", "llmModel");

    containerEl.createEl("h3", { text: "图像（gpt-image-2）" });
    text("Base URL", "OpenAI 兼容端点", "imageBaseUrl");
    text("API Key", "仅存本地，不入库", "imageKey", "sk-...");
    text("Model", "", "imageModel");

    containerEl.createEl("h3", { text: "嵌入与目录" });
    text("本地嵌入模型", "transformers.js 模型 id", "embedModel");
    text("笔记目录", "存为笔记的目标目录", "noteFolder");
    text("附件目录", "配图保存目录", "attachmentFolder");
  }
}
```

- [ ] **Step 2: 在 `src/main.ts` 接入设置（替换整个文件）**

```ts
import { Plugin, Notice } from "obsidian";
import { LTSettings, DEFAULT_SETTINGS, LTSettingTab } from "./settings";

export default class LearningTutorPlugin extends Plugin {
  settings: LTSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new LTSettingTab(this.app, this));
    this.addCommand({
      id: "lt-hello",
      name: "LT: Hello（脚手架自检）",
      callback: () => new Notice("Learning Tutor 已加载"),
    });
    console.log("Learning Tutor loaded");
  }

  onunload() { console.log("Learning Tutor unloaded"); }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() { await this.saveData(this.settings); }
}
```

> 注意：`saveData` 会把整个 settings + （后续）索引写进 `data.json`。密钥因此只落本地、已被 gitignore。

- [ ] **Step 3: 构建 + 手测**

Run: `npm run build`，重载 Obsidian，打开插件设置页。
Expected: 看到三组设置；填入两个 key 后重开设置页值仍在（已持久化）。

- [ ] **Step 4: 提交**

```bash
git add src/settings.ts src/main.ts
git commit -m "feat: 设置数据模型与设置页（密钥仅存本地）"
```

---

### Task 7: 索引器（vault → 分块 → 嵌入 → 入库；增量更新）

**Files:**
- Create: `src/rag/indexer.ts`
- Modify: `src/main.ts`

> 依赖 Obsidian Vault API，用构建 + 手测验证。

- [ ] **Step 1: 写 `src/rag/indexer.ts`**

```ts
import { App, TFile, Notice } from "obsidian";
import type { Embedder } from "./embedder";
import { VectorStore } from "./vectorStore";
import { chunkMarkdown } from "./chunker";

export class Indexer {
  constructor(
    private app: App,
    private embedder: Embedder,
    private store: VectorStore
  ) {}

  private async indexFile(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) { this.store.removeFile(file.path); return; }
    const vectors = await this.embedder.embedDocuments(chunks.map(c => c.text));
    this.store.setFile(
      file.path,
      file.stat.mtime,
      chunks.map((c, i) => ({ text: c.text, heading: c.heading, vector: vectors[i] }))
    );
  }

  // 全量：跳过 mtime 未变的文件；清理已删除文件
  async reindexAll(onSave: () => Promise<void>): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const present = new Set(files.map(f => f.path));
    for (const p of this.store.allPaths()) {
      if (!present.has(p)) this.store.removeFile(p);
    }
    let done = 0;
    const notice = new Notice("索引中… 0/" + files.length, 0);
    for (const f of files) {
      if (this.store.getMtime(f.path) !== f.stat.mtime) {
        await this.indexFile(f);
      }
      done++;
      if (done % 5 === 0 || done === files.length) {
        notice.setMessage(`索引中… ${done}/${files.length}`);
        await onSave(); // 周期性持久化，防中断丢进度
      }
    }
    notice.hide();
    new Notice(`索引完成：${files.length} 篇`);
  }

  // 增量：单文件变更/删除
  async onModify(file: TFile): Promise<void> { await this.indexFile(file); }
  onDelete(path: string): void { this.store.removeFile(path); }
}
```

- [ ] **Step 2: 在 `src/main.ts` 接入索引器与事件（在 onload 内、设置加载后追加）**

```ts
// 顶部 import 追加：
// import { TFile } from "obsidian";
// import { LocalEmbedder } from "./rag/localEmbedder";
// import { VectorStore } from "./rag/vectorStore";
// import { Indexer } from "./rag/indexer";

// 在类内新增字段：
//   embedder: LocalEmbedder; store: VectorStore; indexer: Indexer;

// onload 内（loadSettings 之后）：
this.store = new VectorStore();
this.store.deserialize((await this.loadData())?.index ?? null);
this.embedder = new LocalEmbedder(this.settings.embedModel);
this.indexer = new Indexer(this.app, this.embedder, this.store);

this.addCommand({
  id: "lt-reindex",
  name: "LT: 重建索引",
  callback: () => this.indexer.reindexAll(() => this.persistIndex()),
});

this.registerEvent(this.app.vault.on("modify", (f) => {
  if (f instanceof TFile && f.extension === "md")
    this.indexer.onModify(f).then(() => this.persistIndex());
}));
this.registerEvent(this.app.vault.on("delete", (f) => {
  this.indexer.onDelete(f.path); this.persistIndex();
}));
```

并新增方法（与 saveSettings 同级），把索引并入 data.json：

```ts
async persistIndex() {
  const data = (await this.loadData()) ?? {};
  data.index = this.store.serialize();
  await this.saveData(Object.assign(data, this.settings));
}
```

> 设计说明：`data.json` 同时存 settings 与 `index`。`loadSettings` 用 `Object.assign(DEFAULT, loadData())` 兼容（`index` 字段被忽略）；`persistIndex` 合并写回。

- [ ] **Step 3: 构建 + 手测**

Run: `npm run build`，重载；在测试 vault 放几篇中文笔记，执行 “LT: 重建索引”。
Expected: 进度通知 0/N→N/N，完成提示；`data.json` 出现 `index.entries`（向量数组）。改其中一篇再保存，控制台/行为表明该篇被增量重嵌。

- [ ] **Step 4: 提交**

```bash
git add src/rag/indexer.ts src/main.ts
git commit -m "feat: vault 索引器（分块嵌入入库 + 增量更新 + 持久化）"
```

---

### Task 8: 检索器 + 调试命令（端到端验证）

**Files:**
- Create: `src/rag/retriever.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 写 `src/rag/retriever.ts`**

```ts
import type { Embedder } from "./embedder";
import { VectorStore, QueryHit } from "./vectorStore";

export class Retriever {
  constructor(private embedder: Embedder, private store: VectorStore) {}

  async retrieve(query: string, k = 6): Promise<QueryHit[]> {
    const qv = await this.embedder.embedQuery(query);
    return this.store.query(qv, k);
  }
}
```

- [ ] **Step 2: 在 `src/main.ts` 加调试命令 + 查询输入 Modal**

```ts
// import 追加：import { Modal, App } from "obsidian";
//            import { Retriever } from "./rag/retriever";
// 类字段：retriever: Retriever;
// onload 内（indexer 之后）：
this.retriever = new Retriever(this.embedder, this.store);
this.addCommand({
  id: "lt-test-retrieval",
  name: "LT: 测试检索",
  callback: () => new QueryModal(this.app, async (q) => {
    const hits = await this.retriever.retrieve(q);
    console.log("检索结果：", hits);
    new Notice(hits.map(h => `${h.score.toFixed(2)} ${h.path}`).join("\n") || "无命中");
  }).open(),
});
```

在文件底部追加 Modal 类：

```ts
class QueryModal extends Modal {
  constructor(app: App, private onSubmit: (q: string) => void) { super(app); }
  onOpen() {
    this.contentEl.createEl("h3", { text: "测试检索" });
    const input = this.contentEl.createEl("input", { type: "text" });
    input.style.width = "100%";
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) { this.close(); this.onSubmit(input.value.trim()); }
    });
  }
  onClose() { this.contentEl.empty(); }
}
```

- [ ] **Step 3: 构建 + 端到端手测**

Run: `npm run build`，重载；先 “LT: 重建索引”，再 “LT: 测试检索”，输入一个与某篇笔记语义相关但用词不同的查询（如笔记讲“绵延/时间”，查询输入“柏格森对时间的看法”）。
Expected: Notice/控制台返回该相关笔记，分数最高；语义检索生效（非关键词匹配）。

- [ ] **Step 4: 提交**

```bash
git add src/rag/retriever.ts src/main.ts
git commit -m "feat: 语义检索器 + 调试命令（RAG 端到端打通）"
```

---

## 自检（plan vs spec）

- **spec 需求 4（RAG 闭环-输入侧）**：Task 5–8 覆盖（本地嵌入 + 自建向量库 + 检索）。✅ 输出侧（写回笔记）属 Plan 2。
- **spec 需求 4（自建向量库 / 本地嵌入）**：Task 4–5。✅
- **隐私（嵌入本地）**：Task 4 本地嵌入，笔记内容不外发。✅
- **密钥不入库**：Task 1 `.gitignore` 含 `data.json`；Task 6 密钥存 data.json。✅
- **可插拔 embedder**：Task 4 接口 + 实现分离。✅
- **占位扫描**：无 TODO；transformers.js 打包风险点已在 Task 4 Step 3 给出具体处置。✅
- **类型一致性**：`Embedder.embedDocuments/embedQuery`、`VectorStore.setFile/query/serialize/getMtime`、`Retriever.retrieve` 在各任务间签名一致。✅

## 范围边界（留给 Plan 2）

导师对话面板、系统提示词（拆解/按水平讲/苏格拉底）、`存为笔记`/`概念图`(Mermaid)/`配图`(gpt-image-2) 三命令、LLM 客户端、图像客户端——均在 Plan 2，构建在本计划的 `Retriever` 之上。
