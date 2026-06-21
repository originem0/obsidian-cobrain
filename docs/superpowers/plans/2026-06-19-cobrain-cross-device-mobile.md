# 跨设备私用（移动端启用）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 摘掉 `isDesktopOnly` 让 Cobrain 桌面 + 移动端通用，并让移动端只读检索、绝不写索引。

**Architecture:** `manifest.json` 一个开关 + `src/main.ts` 三处 `Platform.isMobile` 守卫（移动端不注册自动重嵌、`persistIndex()` no-op、「重建索引」命令提示返回）+ `README.md` 跨设备文档。桌面端逻辑零改动，仍是唯一的索引写入方。

**Tech Stack:** TypeScript、Obsidian API（`Platform`，`obsidian.d.ts:4823`）、esbuild、Jest。

## Global Constraints

- 不引入任何新依赖（`package.json` 的 `dependencies` 保持为空）。
- `npx tsc -noEmit -skipLibCheck` 必须零报错。
- `Platform.isMobile` 分支依赖 Obsidian 运行时，jest 测不了；**不为它硬凑假测试**（逻辑只是单个布尔判断，无可提取的纯逻辑）。
- 现有 30 个测试不得回归。
- 桌面端行为不得改变（仅在 `Platform.isMobile` 为真时分流）。
- 提交信息用中文，结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 沿用项目惯例在 `main` 分支直接提交。

---

## 文件结构

| 文件 | 改动 |
|---|---|
| `manifest.json` | `isDesktopOnly: true → false` |
| `src/main.ts` | import `Platform`；3 处移动端守卫（重建命令 / 自动重嵌注册 / `persistIndex`） |
| `README.md` | 头部「桌面端」→「桌面 + 移动端」；新增「跨设备使用」小节；页脚 |

无新增文件、无新增测试（见 Global Constraints）。

---

### Task 1: 移动端启用 + 只读守卫 + README

**Files:**
- Modify: `manifest.json`（`isDesktopOnly`）
- Modify: `src/main.ts:1`（import）、`src/main.ts:51-55`（重建命令）、`src/main.ts:66-75`（自动重嵌注册）、`src/main.ts:102-105`（`persistIndex`）
- Modify: `README.md:5`、`README.md` 新增小节、`README.md:59`
- Test: 无（`Platform` 分支不可单测）

**Interfaces:**
- Consumes: `Platform`（来自 `obsidian`，`const Platform.isMobile: boolean`）。
- Produces: 无新导出。行为契约：`Platform.isMobile` 为真时，插件不注册 `vault.on("modify"/"delete")` 自动重嵌、`persistIndex()` 立即返回不写盘、「重建索引」命令仅弹 Notice。

- [ ] **Step 1: `manifest.json` 开启移动端**

把 `manifest.json` 中：

```json
  "isDesktopOnly": true
```

改为：

```json
  "isDesktopOnly": false
```

- [ ] **Step 2: `main.ts` 导入 `Platform`**

`src/main.ts:1`，把：

```ts
import { Plugin, Notice, TFile, Modal, App, normalizePath, debounce } from "obsidian";
```

改为：

```ts
import { Plugin, Notice, TFile, Modal, App, normalizePath, debounce, Platform } from "obsidian";
```

- [ ] **Step 3: 「重建索引」命令在移动端提示返回**

`src/main.ts:51-55`，把：

```ts
    this.addCommand({
      id: "cobrain-reindex",
      name: "Cobrain: 重建索引",
      callback: () => this.indexer.reindexAll(() => this.persistIndex()),
    });
```

替换为：

```ts
    this.addCommand({
      id: "cobrain-reindex",
      name: "Cobrain: 重建索引",
      callback: () => {
        // 移动端为只读检索：不重建（避免蜂窝网重嵌 + 改写索引引发同步冲突），索引在桌面端建。
        if (Platform.isMobile) { new Notice("移动端为只读检索，索引请在桌面端重建"); return; }
        this.indexer.reindexAll(() => this.persistIndex());
      },
    });
```

- [ ] **Step 4: 移动端不注册自动重嵌（modify / delete）**

`src/main.ts:66-75`，把：

```ts
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "md") this.scheduleReindex(f);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      // 文件在防抖窗口内被删：清掉待嵌入定时器，否则会把已删文件重新嵌回索引
      const t = this.modifyTimers.get(f.path);
      if (t) { clearTimeout(t); this.modifyTimers.delete(f.path); }
      this.indexer.onDelete(f.path);
      this.persistIndex();
    }));
```

替换为：

```ts
    // 移动端只读：不注册自动重嵌（否则每改一篇笔记都走蜂窝网打嵌入接口，并重写 10MB 索引引发同步冲突）。
    // 索引只在桌面端建，移动端读同步过来的索引做检索。
    if (!Platform.isMobile) {
      this.registerEvent(this.app.vault.on("modify", (f) => {
        if (f instanceof TFile && f.extension === "md") this.scheduleReindex(f);
      }));
      this.registerEvent(this.app.vault.on("delete", (f) => {
        // 文件在防抖窗口内被删：清掉待嵌入定时器，否则会把已删文件重新嵌回索引
        const t = this.modifyTimers.get(f.path);
        if (t) { clearTimeout(t); this.modifyTimers.delete(f.path); }
        this.indexer.onDelete(f.path);
        this.persistIndex();
      }));
    }
```

- [ ] **Step 5: `persistIndex()` 在移动端 no-op（数据安全关键）**

`src/main.ts:102-105`，把：

```ts
  async persistIndex(): Promise<void> {
    const payload = { ...this.store.serialize(), embedModel: this.settings.embedModel };
    await this.app.vault.adapter.write(this.indexPath(), JSON.stringify(payload));
  }
```

替换为：

```ts
  async persistIndex(): Promise<void> {
    // 移动端绝不写索引：堵住「文件同步非原子 → loadIndex 误判模型不符清空 → 空索引回传覆盖桌面索引」这条数据损坏链，
    // 也避免两端并发写 10MB 文件产生同步冲突。这是 §2 守卫里最关键的一条（兜住所有写索引路径，含 loadIndex 的 needsRewrite 回写）。
    if (Platform.isMobile) return;
    const payload = { ...this.store.serialize(), embedModel: this.settings.embedModel };
    await this.app.vault.adapter.write(this.indexPath(), JSON.stringify(payload));
  }
```

> 说明：`loadIndex` 里 `if (needsRewrite) await this.persistIndex()`（`main.ts:157`）会因此在移动端变 no-op——这正是我们要的（移动端即便因瞬时模型不符在内存里清空索引，也不落盘、不回传污染桌面索引）。`loadIndex` 的旧版 `data.json` 迁移分支在移动端实际不会触发（`index.json` 已随 vault 同步存在，走 `exists` 分支），无需额外守卫。

- [ ] **Step 6: 更新 `README.md`**

6a. `README.md:5`，把：

```
一个独立的 Obsidian 插件（TypeScript，桌面端）。它把你写过的笔记当作喂给 AI 的「前知识」，对话时：
```

改为：

```
一个独立的 Obsidian 插件（TypeScript，桌面 + 移动端）。它把你写过的笔记当作喂给 AI 的「前知识」，对话时：
```

6b. 在「## 安装（手动 / 自用）」小节末尾（`README.md:31` 那行 `开发：...` 之后）、`## 配置` 之前，插入新小节：

```markdown

## 跨设备使用（桌面 + 移动端）

Cobrain 桌面端与移动端通用（一份代码，`isDesktopOnly: false`）。多设备协作的约定：

- **桌面端是唯一的索引写入方**：自动重嵌（编辑后防抖）与「重建索引」都在桌面端进行。
- **移动端只读检索**：移动端不做后台重嵌、绝不改写 `index.json`（在移动端运行「重建索引」只会提示「请在桌面端重建」）。它读的是随 vault 同步过来、桌面端建好的索引。
- **换设备安装**：已提交 Obsidian 官方社区插件申请。审核通过后，每台设备直接从社区插件安装；审核通过前，可继续用 vault 同步 `.obsidian/plugins/cobrain/` 或 BRAT 安装。移动端 Obsidian 需**重启/强退**才会加载新同步来的 `main.js`。
- **注意**：移动端新建/编辑的笔记，要等桌面端下次「重建索引」后才进入检索结果。
- **兜底**：若文件同步 `.obsidian` 偶发小文件冲突，可改用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 从 GitHub 仓库安装/更新插件代码（移动端亦支持），索引仍走 vault 同步。
```

6c. `README.md:59` 页脚，把：

```
个人自用项目，desktop only，WIP。
```

改为：

```
个人自用项目，桌面 + 移动端，WIP。
```

- [ ] **Step 7: 校验（tsc + jest + production build）**

Run: `npx tsc -noEmit -skipLibCheck && npx jest 2>&1 | tail -4 && npm run build 2>&1 | tail -3`
Expected: tsc 退出码 0；jest `Tests: 30 passed, 30 total`（无回归）；build 退出码 0（生成 `main.js`）。

- [ ] **Step 8: 提交**

```bash
git add manifest.json src/main.ts README.md
git commit -m "feat(mobile): 启用移动端 + 移动端只读索引守卫（工作流 #3）" -m "- isDesktopOnly false：一份代码桌面+移动端通用
- 移动端不注册自动重嵌、persistIndex no-op、重建命令提示返回
- 桌面端为唯一索引写入方；README 增跨设备使用说明" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 集成验证 + 移动端手动冒烟

**Files:** 无代码改动（构建 + 部署 + 人工验证）。

- [ ] **Step 1: 全量构建**

Run: `npm run build`
Expected: `tsc` 与 `esbuild ... production` 均退出码 0，生成 `main.js`。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: `Tests: 30 passed, 30 total`，无回归。

- [ ] **Step 3: 部署到测试 vault**

Run: `npm run deploy`
Expected: `main.js` + `manifest.json` 拷入测试 vault（`data.json`/`index.json` 不动）。

- [ ] **Step 4: 桌面端回归冒烟（在 Obsidian 中）**

1. 重载 Cobrain。编辑一篇笔记 → 约 2.5s 后仍会自动重嵌（桌面行为不变）。
2. 跑「Cobrain: 重建索引」→ 正常重建、`index.json` 更新。
3. 检索/对话正常。

- [ ] **Step 5: 移动端手动冒烟（同步插件到平板/手机后，需人工）**

1. 插件能在移动端加载、面板可开。
2. 能搜到桌面端已索引的笔记（检索命中合理）。
3. 在移动端编辑笔记 → **不触发**嵌入请求、**不改写** `index.json`（看文件 mtime）。
4. 在移动端运行「Cobrain: 重建索引」→ 得到「移动端为只读检索」提示，且不消耗嵌入调用。
5. 回桌面端：`index.json` 未被移动端覆盖/清空，检索照常。

> Step 4 可在桌面端自动/手动完成；Step 5 需人工在移动端完成。若移动端检索异常或索引被改写，回到 Task 1 检查 `Platform.isMobile` 三处守卫。

---

## Self-Review

**Spec coverage（对照 spec 各节）：**
- ① 开启移动端 → Task 1 Step 1（`isDesktopOnly: false`）。✓
- ② 不注册自动重嵌 → Step 4；`persistIndex` no-op → Step 5；重建命令提示返回 → Step 3。✓
- ② 检索/对话只读路径不受影响 → 未改 query/retriever/chat（仅 gate 写路径）。✓
- ③ 桌面端不变 → 所有改动都在 `Platform.isMobile` 真分支内，桌面走原路径。✓
- ④ 换设备安装与同步（文档）→ Step 6b 的 README 小节。✓
- 测试计划（不硬凑假测试、现有不回归）→ Global Constraints + Task 1 Step 7 + Task 2 Step 2。✓
- 验证（build/test/桌面回归/移动冒烟）→ Task 2。✓

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整 old→new；命令含预期输出。✓

**Type consistency:** 仅新增 `Platform`（值导入，非类型）；三处守卫均用 `Platform.isMobile: boolean`，签名一致；未改任何函数签名（`persistIndex(): Promise<void>` 不变，仅加前置 return）。✓
