# 索引分片 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单一 `index.json` 拆成 `index/<hash64(path)>.json` 每篇一个分片 + `index/meta.json`，根治大文件同步失败与整份写放大；检索零改动、移动端只读、旧文件一次性迁移。

**Architecture:** 新 `IndexStore`(用 adapter)负责分片读写/迁移/移动端守卫；`VectorStore` 加单篇 `serializeFile`/`deserializeFile`(纯函数);`hash` 加 `fnv1a64`(分片名);`Indexer.reindexAll` 改为每篇即时落分片 + 结束写 meta/清孤儿；`main`/`settings` 用 `IndexStore` 取代 `loadIndex`/`persistIndex`。

**Tech Stack:** TypeScript、Obsidian `DataAdapter`(`list`/`read`/`write`/`remove`/`mkdir`/`rmdir`)、`Platform`、Jest、esbuild。

## Global Constraints

- 不引入新依赖；`npx tsc -noEmit -skipLibCheck` 零报错；现有 39 测试不回归。
- 纯函数测试不 import `obsidian`。
- 检索层 `query`/`topK`/`dot` 一行不改；量化格式沿用 v2 的 `{scale,q}`。
- 移动端只读：`IndexStore` 所有写方法 `Platform.isMobile` 时 no-op。
- `index/` 内文件名不以 `.`/`_` 开头(避开 Remotely Save 排除)。
- 不动 `deploy.mjs`(索引是 vault 数据，不随构建分发)。
- 提交中文 + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；`main` 直接提交。

## 文件结构

| 文件 | 改动 |
|---|---|
| `src/util/hash.ts` | 加 `fnv1a64`(不动现有 `fnv1a`) |
| `src/util/hash.test.ts` | 加 `fnv1a64` 用例 |
| `src/rag/vectorStore.ts` | 加 `serializeFile`/`deserializeFile`(保留 `serialize`/`deserialize`) |
| `src/rag/vectorStore.test.ts` | 加单篇往返用例 |
| `src/rag/indexStore.ts` | **新建**：分片持久化层 |
| `src/rag/indexer.ts` | `reindexAll(persist, embedModel)` 改每篇落分片 |
| `src/main.ts` | 用 `IndexStore` 取代 `loadIndex`/`persistIndex`/`indexPath` |
| `src/settings.ts` | 换模型清空改调 `indexStore.clearAll()` |

---

### Task 1: `fnv1a64`（hash.ts，TDD）

**Files:** Modify `src/util/hash.ts`、`src/util/hash.test.ts`
**Interfaces:** Produces `fnv1a64(str: string): string`（16-hex）

- [ ] **Step 1: 追加失败测试**

`src/util/hash.test.ts` 顶部 import 改 `import { fnv1a, fnv1a64 } from "./hash";`，追加：
```ts
test("fnv1a64 确定性 + 定长 16-hex", () => {
  const h = fnv1a64("Explore/哲学/存在主义.md");
  expect(h).toBe(fnv1a64("Explore/哲学/存在主义.md"));
  expect(h).toMatch(/^[0-9a-f]{16}$/);
});

test("fnv1a64 不同输入不同（含同长度）", () => {
  expect(fnv1a64("a.md")).not.toBe(fnv1a64("b.md"));
  expect(fnv1a64("note1.md")).not.toBe(fnv1a64("note2.md"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest src/util/hash.test.ts`
Expected: FAIL —— `fnv1a64 is not a function`。

- [ ] **Step 3: 写实现**

`src/util/hash.ts` 末尾追加：
```ts
// 64 位路径哈希：两条 FNV-1a 用「不同乘子」并行，拼成 16-hex。用作索引分片文件名。
// 用不同乘子(而非仅不同种子)才真正独立——同长度字符串的差值不会同时抵消，碰撞才降到 64 位级。
export function fnv1a64(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000199);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/util/hash.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/util/hash.ts src/util/hash.test.ts
git commit -m "feat(rag): fnv1a64 路径哈希（索引分片文件名 · 工作流 #6）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `serializeFile`/`deserializeFile`（vectorStore.ts，TDD）

**Files:** Modify `src/rag/vectorStore.ts`、`src/rag/vectorStore.test.ts`
**Interfaces:**
- `VectorStore.serializeFile(path): { path; mtime; hash; entries: Omit<StoredEntry,"path">[] } | null`
- `VectorStore.deserializeFile(payload: { path; mtime?; hash?; entries?: unknown[] }): void`

- [ ] **Step 1: 追加失败测试**

`src/rag/vectorStore.test.ts` 末尾追加：
```ts
test("serializeFile 取单篇（量化、不含其它笔记、无则 null）", () => {
  const s = new VectorStore();
  s.setFile("a.md", 1, [{ text: "猫", heading: "", vector: [0.6, 0.8] }]);
  s.setHash("a.md", "h1");
  s.setFile("b.md", 2, [{ text: "狗", heading: "", vector: [0.8, 0.6] }]);
  const sf = s.serializeFile("a.md")!;
  expect(sf.path).toBe("a.md");
  expect(sf.mtime).toBe(1);
  expect(sf.hash).toBe("h1");
  expect(sf.entries.length).toBe(1);
  expect(typeof sf.entries[0].q).toBe("string");
  expect((sf.entries[0] as any).path).toBeUndefined();
  expect(s.serializeFile("missing.md")).toBeNull();
});

test("serializeFile→deserializeFile 往返：命中与 mtime 保留", () => {
  const s = new VectorStore();
  s.setFile("a.md", 7, [{ text: "猫", heading: "H", vector: [0.6, 0.8] }]);
  const s2 = new VectorStore();
  s2.deserializeFile(s.serializeFile("a.md")!);
  const hit = s2.query([0.6, 0.8], 1)[0];
  expect(hit.text).toBe("猫");
  expect(hit.heading).toBe("H");
  expect(s2.getMtime("a.md")).toBe(7);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest src/rag/vectorStore.test.ts`
Expected: FAIL —— `serializeFile is not a function`。

- [ ] **Step 3: 写实现**

`src/rag/vectorStore.ts`，在 `deserialize(...)` 方法之后、`allPaths()` 之前插入：
```ts
  // 单篇分片序列化：entries 省去 path(在顶层)以减小体积；该篇无条目返回 null。
  serializeFile(path: string): { path: string; mtime: number; hash: string; entries: Omit<StoredEntry, "path">[] } | null {
    const es = this.entries.filter(e => e.path === path);
    if (!es.length) return null;
    const entries = es.map(e => {
      const { scale, q } = quantizeVector(e.vector);
      return { chunkIdx: e.chunkIdx, text: e.text, heading: e.heading, scale, q };
    });
    return { path, mtime: this.mtimes[path] ?? 0, hash: this.hashes[path] ?? "", entries };
  }

  // 把单篇分片合并进 store(追加条目 + 设 mtime/hash)。兼容 q(量化) 与 vector(旧)。
  deserializeFile(payload: { path: string; mtime?: number; hash?: string; entries?: unknown[] }): void {
    const path = payload.path;
    const raw = (payload.entries ?? []) as Array<Record<string, unknown>>;
    for (const e of raw) {
      this.entries.push({
        path,
        chunkIdx: e.chunkIdx as number,
        text: e.text as string,
        heading: e.heading as string,
        vector: typeof e.q === "string" ? dequantizeVector(e.scale as number, e.q) : ((e.vector as number[]) ?? []),
      });
    }
    if (payload.mtime != null) this.mtimes[path] = payload.mtime;
    if (payload.hash != null) this.hashes[path] = payload.hash;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/rag/vectorStore.test.ts`
Expected: PASS（含原有 + 新 2 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/rag/vectorStore.ts src/rag/vectorStore.test.ts
git commit -m "feat(rag): VectorStore 单篇分片序列化 serializeFile/deserializeFile" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `IndexStore` 分片持久化层（新建）

**Files:** Create `src/rag/indexStore.ts`
**Interfaces:**
- Consumes: `VectorStore.serializeFile`/`deserializeFile`/`deserialize`/`allPaths`（Task 2）；`fnv1a64`（Task 1）。
- Produces: `class IndexStore { constructor(app, manifest, store); load(): Promise<string|undefined>; saveFile(path); removeFile(path); saveMeta(embedModel); saveAll(embedModel?); finalize(embedModel); clearAll() }`

- [ ] **Step 1: 写 `src/rag/indexStore.ts`**

```ts
import { App, PluginManifest, Platform, normalizePath } from "obsidian";
import { VectorStore } from "./vectorStore";
import { fnv1a64 } from "../util/hash";

// 索引分片持久化：index/<hash64(path)>.json 每篇一片 + index/meta.json({v,embedModel})。
// 改一篇只写它的分片(消灭整份重写)；移动端只读——所有写方法 no-op，杜绝双写冲突。
const META = "meta.json";
const SHARD_V = 3;

export class IndexStore {
  constructor(private app: App, private manifest: PluginManifest, private store: VectorStore) {}

  private get adapter() { return this.app.vault.adapter; }
  private base(): string { return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`; }
  private dir(): string { return normalizePath(`${this.base()}/index`); }
  private metaPath(): string { return normalizePath(`${this.dir()}/${META}`); }
  private legacyPath(): string { return normalizePath(`${this.base()}/index.json`); }
  private shardName(path: string): string { return `${fnv1a64(path)}.json`; }
  private shardPath(path: string): string { return normalizePath(`${this.dir()}/${this.shardName(path)}`); }

  // 启动加载：优先 index/ 分片；否则迁移旧 index.json；返回存储的 embedModel(换模型检测用)。
  async load(): Promise<string | undefined> {
    if (await this.adapter.exists(this.dir())) {
      let embedModel: string | undefined;
      const listed = await this.adapter.list(this.dir());
      for (const f of listed.files) {
        const name = f.split("/").pop() ?? "";
        if (name === META) {
          try { embedModel = JSON.parse(await this.adapter.read(f)).embedModel || undefined; } catch { /* 坏 meta 忽略 */ }
          continue;
        }
        if (!name.endsWith(".json")) continue;
        try { this.store.deserializeFile(JSON.parse(await this.adapter.read(f))); }
        catch (e) { console.error("Cobrain: 分片解析失败", f, e); }
      }
      // 同步可能把旧单文件 index.json 带回来：以 index/ 为准，清掉它
      if (await this.adapter.exists(this.legacyPath())) await this.adapter.remove(this.legacyPath()).catch(() => {});
      return embedModel;
    }
    // 迁移：旧单文件 index.json → 分片(首次加载一次性)。早于 #1 的 data.json.index 不再处理(那类装机早已迁移)。
    if (await this.adapter.exists(this.legacyPath())) {
      try {
        const payload = JSON.parse(await this.adapter.read(this.legacyPath()));
        this.store.deserialize(payload);
        const embedModel = payload.embedModel as string | undefined;
        await this.saveAll(embedModel);
        await this.adapter.remove(this.legacyPath()).catch(() => {});
        console.log("Cobrain: 已把 index.json 迁移为分片");
        return embedModel;
      } catch (e) {
        console.error("Cobrain: 旧 index.json 迁移失败，按空索引处理", e);
      }
    }
    return undefined;
  }

  async saveFile(path: string): Promise<void> {
    if (Platform.isMobile) return;
    const sf = this.store.serializeFile(path);
    if (!sf) { await this.removeFile(path); return; }
    await this.adapter.mkdir(this.dir()).catch(() => {});
    await this.adapter.write(this.shardPath(path), JSON.stringify(sf));
  }

  async removeFile(path: string): Promise<void> {
    if (Platform.isMobile) return;
    const p = this.shardPath(path);
    if (await this.adapter.exists(p)) await this.adapter.remove(p).catch(() => {});
  }

  async saveMeta(embedModel: string): Promise<void> {
    if (Platform.isMobile) return;
    await this.adapter.mkdir(this.dir()).catch(() => {});
    await this.adapter.write(this.metaPath(), JSON.stringify({ v: SHARD_V, embedModel }));
  }

  // 全量写出所有分片 + meta + 清孤儿(迁移用)。
  async saveAll(embedModel?: string): Promise<void> {
    if (Platform.isMobile) return;
    await this.adapter.mkdir(this.dir()).catch(() => {});
    const wanted = new Set<string>([META]);
    for (const path of this.store.allPaths()) {
      const sf = this.store.serializeFile(path);
      if (!sf) continue;
      const name = this.shardName(path);
      wanted.add(name);
      await this.adapter.write(normalizePath(`${this.dir()}/${name}`), JSON.stringify(sf));
    }
    await this.adapter.write(this.metaPath(), JSON.stringify({ v: SHARD_V, embedModel: embedModel ?? "" }));
    await this.sweep(wanted);
  }

  // 重建结束：写 meta + 清掉当前笔记集合之外的孤儿分片(改名/旧残留)。
  async finalize(embedModel: string): Promise<void> {
    if (Platform.isMobile) return;
    const wanted = new Set<string>([META]);
    for (const path of this.store.allPaths()) wanted.add(this.shardName(path));
    await this.saveMeta(embedModel);
    await this.sweep(wanted);
  }

  private async sweep(wanted: Set<string>): Promise<void> {
    if (!(await this.adapter.exists(this.dir()))) return;
    const listed = await this.adapter.list(this.dir());
    for (const f of listed.files) {
      const name = f.split("/").pop() ?? "";
      if (name.endsWith(".json") && !wanted.has(name)) await this.adapter.remove(f).catch(() => {});
    }
  }

  // 换嵌入模型/清空：删掉整个 index/（store 已在外层 deserialize(null)）。
  async clearAll(): Promise<void> {
    if (Platform.isMobile) return;
    if (await this.adapter.exists(this.dir())) await this.adapter.rmdir(this.dir(), true).catch(() => {});
  }
}
```

- [ ] **Step 2: typecheck（模块独立编译）**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 退出码 0（此时 IndexStore 已可编译，尚未被引用）。

- [ ] **Step 3: 提交**

```bash
git add src/rag/indexStore.ts
git commit -m "feat(rag): IndexStore 分片持久化层（load/saveFile/finalize/clearAll + 迁移 + 移动端只读）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 接线（indexer / main / settings）

**Files:** Modify `src/rag/indexer.ts`、`src/main.ts`、`src/settings.ts`
**Interfaces:**
- Consumes: `IndexStore`（Task 3）。
- Produces: `Indexer.reindexAll(persist: IndexStore, embedModel: string)`；`CobrainPlugin.indexStore: IndexStore`（public，settings 用）。

- [ ] **Step 1: indexer.ts —— reindexAll 改每篇落分片**

`src/rag/indexer.ts` 顶部加 import：
```ts
import { IndexStore } from "./indexStore";
```
把 `reindexAll(...)` 整体替换为：
```ts
  // 全量：跳过 mtime 未变的文件；删除已不存在文件的分片；每篇即时落分片(崩溃不丢进度)，结束写 meta + 清孤儿。
  async reindexAll(persist: IndexStore, embedModel: string): Promise<void> {
    if (this.running) { new Notice("索引正在进行中，请稍候…"); return; }
    this.running = true;
    const files = this.app.vault.getMarkdownFiles();
    const present = new Set(files.map(f => f.path));
    for (const p of this.store.allPaths()) {
      if (!present.has(p)) { this.store.removeFile(p); await persist.removeFile(p); }
    }
    let done = 0;
    let failed = 0;
    const notice = new Notice("索引中… 0/" + files.length, 0);
    try {
      for (const f of files) {
        if (this.store.getMtime(f.path) !== f.stat.mtime) {
          try {
            await this.indexFile(f);
            await persist.saveFile(f.path);
          } catch (e) {
            // 单篇失败(如嵌入 API 抖动)不中断整轮；记数继续，结束时汇报
            failed++;
            console.error(`索引失败：${f.path}`, e);
          }
        }
        done++;
        notice.setMessage(`索引中… ${done}/${files.length}`);
      }
      await persist.finalize(embedModel);
      new Notice(
        failed ? `索引完成：${files.length} 篇，${failed} 篇失败（见控制台）` : `索引完成：${files.length} 篇`,
      );
    } finally {
      notice.hide();
      this.running = false;
    }
  }
```

- [ ] **Step 2: main.ts —— import + 字段**

`src/main.ts:11` 后加：
```ts
import { IndexStore } from "./rag/indexStore";
```
在 `image!: ImageClient;`（:20）后加字段：
```ts
  indexStore!: IndexStore;
```

- [ ] **Step 3: main.ts —— onload 用 IndexStore 加载**

把 `:33-34`：
```ts
    // 索引从独立的 index.json 加载（旧版本塞在 data.json 里的会在此一次性迁移过来）
    await this.loadIndex();
```
替换为：
```ts
    // 索引从 index/ 分片加载（旧 index.json 会在此一次性迁移为分片）
    this.indexStore = new IndexStore(this.app, this.manifest, this.store);
    const storedModel = await this.indexStore.load();
    if (storedModel && storedModel !== this.settings.embedModel) {
      // 换过嵌入模型 → 维度/空间不兼容，清空待重建
      this.store.deserialize(null);
      await this.indexStore.clearAll();
      new Notice("嵌入模型已变更，旧索引已清空，请重新「Cobrain: 重建索引」");
    }
```

- [ ] **Step 4: main.ts —— 重建命令**

把 `:58` 的 `this.indexer.reindexAll(() => this.persistIndex());` 替换为：
```ts
        this.indexer.reindexAll(this.indexStore, this.settings.embedModel);
```

- [ ] **Step 5: main.ts —— 删除监听写分片**

把 `:88` 的 `this.persistIndex();` 替换为：
```ts
        this.indexStore.removeFile(f.path);
```

- [ ] **Step 6: main.ts —— scheduleReindex 写分片**

把 `:197` 的 `.then(() => this.persistIndex())` 替换为：
```ts
          .then(() => this.indexStore.saveFile(file.path))
```

- [ ] **Step 7: main.ts —— 删除 persistIndex / indexPath / loadIndex**

删除 `:123-184`（从 `// 索引独立持久化到插件目录的 index.json…` 注释到 `loadIndex` 方法结束 `}`，含 `persistIndex`、`indexPath`、`loadIndex` 三个方法）。把 `:112` 的注释改为：
```ts
  // data.json 现在只存设置；向量索引在 index/ 分片里（见 IndexStore）。
```

- [ ] **Step 8: settings.ts —— 换模型清空改调 clearAll**

`src/settings.ts` 的嵌入模型下拉 onChange 里，把：
```ts
            this.plugin.store.deserialize(null);
            await this.plugin.persistIndex();
```
替换为：
```ts
            this.plugin.store.deserialize(null);
            await this.plugin.indexStore.clearAll();
```

- [ ] **Step 9: 校验**

Run: `npx tsc -noEmit -skipLibCheck && npx jest 2>&1 | tail -4 && npm run build 2>&1 | tail -3`
Expected: tsc 0；jest `Tests: 43 passed, 43 total`（原 39 + Task1 2 + Task2 2）；build 0。

- [ ] **Step 10: 提交**

```bash
git add src/rag/indexer.ts src/main.ts src/settings.ts
git commit -m "feat(rag): 索引改用分片持久化（IndexStore 接线，移除整份 persistIndex）" -m "- reindexAll 每篇落分片 + 结束写 meta/清孤儿；改/删一篇只写/删它的分片
- main 用 IndexStore.load 迁移+加载；settings 换模型走 clearAll" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 集成验证 + 手动冒烟（含迁移）

**Files:** 无代码改动。

- [ ] **Step 1: build + test**

Run: `npm run build && npm test`
Expected: build 0；`Tests: 43 passed, 43 total`。

- [ ] **Step 2: 部署**

Run: `LT_VAULT_PLUGIN_DIR="D:/Learning/Notes/人生一串/.obsidian/plugins/cobrain" npm run deploy`
Expected: 拷 `main.js`/`manifest.json`/`styles.css`。

- [ ] **Step 3: 手动冒烟（Obsidian，需人工）**

1. 重载 Cobrain → 插件目录出现 `index/` 一堆 `<hex>.json` + `meta.json`，旧 `index.json` 消失；检索照常。
2. 改一篇笔记 → 只有它对应的那个 `<hex>.json` mtime 变(其余不动)；删一篇 → 对应分片消失。
3. 「Cobrain: 重建索引」→ 分片全量重写、孤儿清掉、`meta.json` 更新。
4. Remotely Save 同步 `index/`(把旧 27MB 远端 `index.json` 手删一次)→ 不再 `size not matched`；移动端同步后能检索(读分片、不重嵌)。
5. 设置页换嵌入模型 → `index/` 被清空、提示重建。

> Step 3 需人工。

---

## Self-Review

**Spec coverage：** 分片布局/meta(无下划线) → Task 3。每篇写/删/全量+清孤儿 → Task 3 + Task 4 Step 1。迁移 → Task 3 load。移动端只读 → Task 3 各写方法 + Step 守卫。换模型清空 → Task 4 Step 3/8。检索零改动 → 未碰 query。测试(fnv1a64 / serializeFile 往返) → Task 1/2。✓

**Placeholder scan：** 无 TBD；各步含完整代码与预期。✓

**Type consistency：** `fnv1a64(str):string`(Task1)→IndexStore.shardName 用；`serializeFile/deserializeFile`(Task2)→IndexStore saveFile/saveAll/load 用；`reindexAll(persist:IndexStore, embedModel:string)`(Task4 Step1)↔ main 调用(Step4)一致；`indexStore` 公有字段(Step2)↔ settings 用(Step8)一致；移除 `persistIndex`(Step7)后无残留调用(Step4/5/6/8 已全部替换)。✓
