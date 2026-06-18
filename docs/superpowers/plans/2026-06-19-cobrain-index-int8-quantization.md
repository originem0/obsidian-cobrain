# 索引 int8 量化压缩 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把向量索引的磁盘存储从 float64 JSON 改为 int8 量化（base64），索引体积 160MB → ~8–12MB，检索逻辑零改动。

**Architecture:** 只动存储层。`serialize` 时把已 L2 归一化的向量按 per-vector scale 对称量化成 int8 并 base64；`deserialize` 时反量化回 `number[]` 进内存。检索（`query`/`topK`/`dot`）继续在 float 内存向量上跑，不受影响。格式打 `v:2` 版本号并兼容旧 float64 entry，旧 `data.json` 自动迁移转换。

**Tech Stack:** TypeScript、Obsidian API、Jest（ts-jest）、esbuild。`btoa`/`atob`（Electron 渲染进程、Node 20、移动端 webview 均可用）。

## Global Constraints

- 不引入任何新依赖（`package.json` 的 `dependencies` 保持为空）。
- `npx tsc -noEmit -skipLibCheck` 必须零报错。
- 新增纯函数测试不得 import `obsidian`（测试环境无 obsidian 运行时）。
- 向量在 `ApiEmbedder` 侧已 L2 归一化——量化按此前提设计。
- 检索层 `query`/`topK`/`dot` 一行不改。
- 提交信息用中文，结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 沿用项目惯例在 `main` 分支直接提交。

---

### Task 1: 向量 int8 量化工具

**Files:**
- Create: `src/util/quantize.ts`
- Test: `src/util/quantize.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，输入 `number[]`）。
- Produces:
  - `quantizeVector(vec: number[]): { scale: number; q: string }`
  - `dequantizeVector(scale: number, q: string): number[]`
  - `interface QuantizedVector { scale: number; q: string }`

- [ ] **Step 1: 写失败测试**

Create `src/util/quantize.test.ts`:

```ts
import { quantizeVector, dequantizeVector } from "./quantize";

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

test("量化往返后 cosine 几乎不变（>0.999）", () => {
  const dim = 256;
  // 用确定性函数造向量，避免 Math.random 的不确定性
  const v = normalize(Array.from({ length: dim }, (_, i) => Math.sin(i * 0.7) + Math.cos(i * 0.13)));
  const { scale, q } = quantizeVector(v);
  const back = dequantizeVector(scale, q);
  expect(back.length).toBe(dim);
  expect(cosine(v, back)).toBeGreaterThan(0.999);
});

test("零向量量化不产生 NaN", () => {
  const v = new Array(16).fill(0);
  const { scale, q } = quantizeVector(v);
  expect(scale).toBe(0);
  const back = dequantizeVector(scale, q);
  expect(back).toEqual(new Array(16).fill(0));
  expect(back.some(Number.isNaN)).toBe(false);
});

test("含负值往返：每维误差不超过量化步长", () => {
  const v = normalize([-1, -0.5, 0, 0.5, 1, -0.9, 0.3]);
  const { scale, q } = quantizeVector(v);
  const back = dequantizeVector(scale, q);
  expect(back.length).toBe(v.length);
  for (let i = 0; i < v.length; i++) {
    expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(scale / 127 + 1e-9);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest src/util/quantize.test.ts`
Expected: FAIL —— `Cannot find module './quantize'`（实现文件还没建）。

- [ ] **Step 3: 写实现**

Create `src/util/quantize.ts`:

```ts
// 向量 int8 量化：把已 L2 归一化的 float 向量压成每维 1 字节，磁盘体积约降一个数量级。
// 仅用于存储；读回后反量化为 number[]，检索逻辑不受影响。per-vector 对称量化，召回损失 <2%。

export interface QuantizedVector {
  scale: number; // 该向量峰值 max(|vᵢ|)，反量化用
  q: string;     // base64 编码的 Int8Array（每维一个有符号字节，补码存为无符号）
}

// String.fromCharCode 一次喂太多会爆栈，按 32K 字节分块。
const CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function quantizeVector(vec: number[]): QuantizedVector {
  let scale = 0;
  for (const x of vec) {
    const a = Math.abs(x);
    if (a > scale) scale = a;
  }
  const bytes = new Uint8Array(vec.length);
  if (scale > 0) {
    for (let i = 0; i < vec.length; i++) {
      let q = Math.round((vec[i] / scale) * 127);
      if (q > 127) q = 127;
      else if (q < -127) q = -127;
      bytes[i] = q & 0xff; // 有符号 int8 → 无符号字节（补码）
    }
  }
  return { scale, q: bytesToBase64(bytes) };
}

export function dequantizeVector(scale: number, q: string): number[] {
  const bytes = base64ToBytes(q);
  const out = new Array<number>(bytes.length);
  if (scale === 0) {
    out.fill(0);
    return out;
  }
  for (let i = 0; i < bytes.length; i++) {
    const signed = bytes[i] < 128 ? bytes[i] : bytes[i] - 256; // 无符号字节 → 有符号
    out[i] = (signed / 127) * scale;
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest src/util/quantize.test.ts`
Expected: PASS（3 个用例全过）。

- [ ] **Step 5: 提交**

```bash
git add src/util/quantize.ts src/util/quantize.test.ts
git commit -m "feat(rag): 向量 int8 量化工具（per-vector scale + base64）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: VectorStore 改用量化存储 + 兼容旧格式

**Files:**
- Modify: `src/rag/vectorStore.ts`（`serialize`/`deserialize` + 新增 `StoredEntry` 接口 + import）
- Modify: `src/main.ts`（`loadIndex` 里的 `IndexPayload` 类型放宽为 `IndexFile`）
- Test: `src/rag/vectorStore.test.ts`（追加 3 个用例）

**Interfaces:**
- Consumes: `quantizeVector`、`dequantizeVector`（Task 1）。
- Produces:
  - `VectorStore.serialize(): { v: number; entries: StoredEntry[]; mtimes: Record<string,number>; hashes: Record<string,string> }`
  - `VectorStore.deserialize(data: { entries?: unknown[]; mtimes?: Record<string,number>; hashes?: Record<string,string> } | null): void`（认 `q` 新格式与 `vector` 旧格式）

- [ ] **Step 1: 追加失败测试**

在 `src/rag/vectorStore.test.ts` 末尾追加：

```ts
test("serialize 输出 int8 量化格式（v2，entry 含 q 不含 vector）", () => {
  const s = new VectorStore();
  s.setFile("a.md", 1, [{ text: "x", heading: "", vector: [0.6, 0.8] }]);
  const out = s.serialize() as any;
  expect(out.v).toBe(2);
  expect(typeof out.entries[0].q).toBe("string");
  expect(typeof out.entries[0].scale).toBe("number");
  expect(out.entries[0].vector).toBeUndefined();
});

test("量化序列化往返：top-1 命中不变", () => {
  const s = new VectorStore();
  s.setFile("a.md", 1, [
    { text: "猫", heading: "", vector: [0.6, 0.8] },
    { text: "狗", heading: "", vector: [0.8, 0.6] },
  ]);
  s.setFile("b.md", 1, [{ text: "车", heading: "", vector: [-0.7, 0.71] }]);
  const before = s.query([0.6, 0.8], 1)[0];
  const s2 = new VectorStore();
  s2.deserialize(s.serialize());
  const after = s2.query([0.6, 0.8], 1)[0];
  expect(after.path).toBe(before.path);
  expect(after.text).toBe(before.text);
});

test("兼容旧 float64 格式（entry 带 vector 数组、无 q）", () => {
  const s = new VectorStore();
  s.deserialize({
    entries: [{ path: "a.md", chunkIdx: 0, text: "猫", heading: "", vector: [1, 0] }],
    mtimes: { "a.md": 1 },
    hashes: {},
  });
  const hits = s.query([1, 0], 1);
  expect(hits[0].text).toBe("猫");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest src/rag/vectorStore.test.ts`
Expected: FAIL —— 「serialize 输出 int8 量化格式」用例失败（旧 `serialize` 返回的 entry 仍带 `vector` 数组、无 `v`/`q`）。

- [ ] **Step 3: 改 VectorStore**

在 `src/rag/vectorStore.ts` 顶部，`import { topK } from "./vectorMath";` 之后加：

```ts
import { quantizeVector, dequantizeVector } from "../util/quantize";
```

在 `interface Entry {...}` 附近（`ChunkInput` 之后）加磁盘格式接口：

```ts
// 磁盘存储格式：向量量化为 int8(base64)，体积约为 float64 JSON 的 1/15
interface StoredEntry { path: string; chunkIdx: number; text: string; heading: string; scale: number; q: string; }
```

把现有 `serialize`/`deserialize` 整体替换为：

```ts
  serialize(): { v: number; entries: StoredEntry[]; mtimes: Record<string, number>; hashes: Record<string, string> } {
    const entries = this.entries.map((e): StoredEntry => {
      const { scale, q } = quantizeVector(e.vector);
      return { path: e.path, chunkIdx: e.chunkIdx, text: e.text, heading: e.heading, scale, q };
    });
    return { v: 2, entries, mtimes: this.mtimes, hashes: this.hashes };
  }

  // 兼容两种 entry：带 q(base64) 是 v2 量化格式，反量化回 float；带 vector(数组) 是旧 float64，直接用。
  deserialize(
    data: { entries?: unknown[]; mtimes?: Record<string, number>; hashes?: Record<string, string> } | null,
  ): void {
    const raw = (data?.entries ?? []) as Array<Record<string, unknown>>;
    this.entries = raw.map((e): Entry => ({
      path: e.path as string,
      chunkIdx: e.chunkIdx as number,
      text: e.text as string,
      heading: e.heading as string,
      vector:
        typeof e.q === "string"
          ? dequantizeVector(e.scale as number, e.q)
          : ((e.vector as number[]) ?? []),
    }));
    this.mtimes = data?.mtimes ?? {};
    this.hashes = data?.hashes ?? {};
  }
```

- [ ] **Step 4: 收口 main.ts 类型**

`src/main.ts` 的 `loadIndex` 里，`serialize` 返回类型变了（新增 `v` 字段），旧的 `IndexPayload = ReturnType<...>` 会与迁移分支（旧 `data.index` 无 `v`）冲突。替换该类型定义。

找到（在 `loadIndex` 方法内）:

```ts
    type IndexPayload = ReturnType<VectorStore["serialize"]> & { embedModel?: string };
    const path = this.indexPath();
    let payload: IndexPayload | null = null;
```

替换为:

```ts
    // 宽松结构：既能装下 v2 序列化输出，也能装下迁移自旧 data.json.index 的旧格式
    type IndexFile = {
      v?: number;
      entries?: unknown[];
      mtimes?: Record<string, number>;
      hashes?: Record<string, string>;
      embedModel?: string;
    };
    const path = this.indexPath();
    let payload: IndexFile | null = null;
```

`loadIndex` 其余逻辑不变（`payload?.embedModel`、`this.store.deserialize(payload ?? null)` 均与新类型兼容）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx jest src/rag/vectorStore.test.ts`
Expected: PASS（含新增 3 个用例与原有用例，无回归）。

- [ ] **Step 6: 全量 typecheck**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 退出码 0，无输出。

- [ ] **Step 7: 提交**

```bash
git add src/rag/vectorStore.ts src/rag/vectorStore.test.ts src/main.ts
git commit -m "feat(rag): 索引存储改为 int8 量化（v2，兼容旧 float64 自动迁移）" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 集成验证

**Files:** 无代码改动（构建 + 运行时验证）。

- [ ] **Step 1: 全量构建**

Run: `npm run build`
Expected: `tsc` 与 `esbuild ... production` 均退出码 0，生成 `main.js`。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部用例 PASS（原 20 个 + Task 1 的 3 个 + Task 2 的 3 个 ≈ 26 个），无回归。

- [ ] **Step 3: 部署到测试 vault**

Run: `npm run deploy`
Expected: `main.js` + `manifest.json` 拷入测试 vault（`data.json` 不动）。

- [ ] **Step 4: 手动验证迁移与体积（在 Obsidian 中）**

1. 在 Obsidian 里禁用再启用 Cobrain（触发 `loadIndex` 迁移）。
2. 确认插件目录下生成 `index.json`、`data.json` 收缩到仅含 `settings`。
3. 确认 `index.json` 体积约 8–12MB（vs 旧 160MB）。
4. 跑「Cobrain: 测试检索」，对几个 query 抽查命中的笔记与量化前基本一致（语义相关、无明显退化）。

> 说明：Step 4 需人工在 Obsidian 内完成；前 3 步可自动执行。若迁移后体积或检索质量异常，回到 Task 1/2 检查量化公式与反量化分支。

---

## Self-Review

**Spec coverage（对照 spec 各节）：**
- 磁盘 int8 / 内存 float → Task 2 `serialize`/`deserialize`。✓
- 量化算法（per-vector scale、scale=0 边界、补码、分块 base64）→ Task 1。✓
- index.json v2 格式 → Task 2 `serialize` 返回 `v:2` + `StoredEntry`。✓
- 兼容与迁移（旧 `vector` 数组、旧 `data.json.index`）→ Task 2 `deserialize` 双分支 + main `IndexFile` 放宽；迁移路径复用既有 `loadIndex`（上一批已实现）。✓
- 测试计划（round-trip cosine、零向量、base64 往返、往返 top-1、旧格式兼容）→ Task 1 三测 + Task 2 三测。✓
- 验证（build/test/体积/检索质量）→ Task 3。✓

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整代码；命令含预期输出。✓

**Type consistency:** `quantizeVector`/`dequantizeVector` 签名在 Task 1 定义、Task 2 import 一致；`StoredEntry` 字段（scale/q）与 `quantizeVector` 返回一致；`deserialize` 参数放宽与 main `IndexFile` 兼容；`serialize` 新增 `v` 已在 main 类型收口（Step 4）处理。✓
