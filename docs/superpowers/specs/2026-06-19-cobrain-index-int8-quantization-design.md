# Cobrain 索引 int8 量化压缩（方案 A）

> 设计文档 · 2026-06-19 · 工作流 #1（增量/分片索引）

## Context

测试 vault 仅 **273 篇** markdown 笔记，`data.json` 却达 **160 MB**。排查确认两层浪费叠加：

1. **Pretty-print**——Obsidian 的 `saveData` 以 2 空格缩进序列化，向量每个浮点数独占一行（实测向量片段确有换行缩进）。
2. **float64 全精度**——每个数约 20 字符（如 `-0.06462624741531367`，17 位有效数字），bge-m3 为 1024 维。

向量是绝对大头（≈150 MB+），笔记正文总量实测仅 **3.38 MB**（chunk 不重叠，约等于正文）。

上一轮已把 `persistIndex` 改为紧凑 `JSON.stringify`（去掉缩进，迁移后约省三成），但 float64 编码这个大头仍在。**根因是向量存储格式，而非"没分片"。** 273 篇规模下，分片是 YAGNI——把向量压到 int8 后整个索引约 8–12 MB，全量重写百毫秒级即可消除痛点。分片留待 vault 涨到上千篇后再做（另开工作流）。

## 目标 / 非目标

**目标**
- 索引体积 160 MB → 约 8–12 MB（向量 int8 base64 + 正文 3.4 MB），约 15× 改善。
- 单次持久化（全量重写）降到百毫秒级。
- 检索逻辑与精度基本不变（召回损失 < 2%）。
- 旧索引（`data.json.index` 或已迁移的 float64 `index.json`）自动兼容、无需用户手动重建。

**非目标（本次不做）**
- 分片 / 每文件独立索引文件 / 目录管理（YAGNI，留待上千篇规模）。
- 外部存储（IndexedDB/SQLite）。
- 移动端内存与 `isDesktopOnly`（属工作流 #3）。
- 检索算法改动（仍是内存暴力点积 topK）。

## 方案：磁盘 int8，内存 float

只改**存储层**，检索层一行不动。

- **内存**：`Entry.vector` 仍是 `number[]`（float）。`query`/`topK`/`dot` 零改动，检索精度与速度不变。
- **磁盘**：`serialize` 时把每个向量按 per-vector scale 对称量化成 int8 并 base64；`deserialize` 时反量化回 `number[]` 进内存。
- `text`/`heading`/`mtimes`/`hashes`/`embedModel` 照旧明文存储。

### 量化算法

向量在 `ApiEmbedder` 侧已做 L2 归一化。对称 per-vector 量化：

```
scale = max(|vᵢ|)              // 该向量的峰值
qᵢ    = clamp(round(vᵢ/scale × 127), -127, 127)   // 存为 int8
```

反量化：`vᵢ ≈ qᵢ / 127 × scale`。每个 entry 额外存一个 `scale`(number) 与 `q`(base64 字符串)。

**边界**：若 `scale === 0`（理论上的全零向量），跳过除法，`q` 全 0、反量化全 0，避免 `NaN`。

int8 编码为字节时用补码（`q & 0xff`），解码时还原符号（`b < 128 ? b : b-256`）。base64 用 `btoa/atob`（Electron 渲染进程与移动端 webview 均可用；`imageClient` 已在用 `atob`）。大数组分块 `String.fromCharCode` 防止爆栈（每向量 1024 字节，分块阈值 0x8000）。

### index.json 格式（v2）

```jsonc
{
  "v": 2,
  "embedModel": "BAAI/bge-m3",
  "entries": [
    { "path": "...", "chunkIdx": 0, "text": "...", "heading": "...",
      "scale": 0.0731, "q": "base64-of-int8-array" }
  ],
  "mtimes": { "a.md": 1718... },
  "hashes": { "a.md": "deadbeef" }
}
```

`embedModel` 由 `main.ts persistIndex` 拼接（不在 `VectorStore.serialize` 内），与现状一致。

### 兼容与迁移

`deserialize` 同时认两种 entry：
- 带 `q`（字符串）→ v2 新格式，反量化得 `vector`。
- 带 `vector`（数组）→ 旧 float64 格式，直接使用。

因此现存的 160 MB `data.json`（旧 float64）在下次重载时：`loadIndex` 迁移读入（旧格式分支）→ 内存得到 float 向量 → 下次 `persistIndex` 自动写成 v2 int8。**用户无需手动重建索引。** 已迁移成 float64 `index.json` 的情形同理，下次写自动转 v2。

## 改动范围

| 文件 | 改动 |
|---|---|
| `src/util/quantize.ts`（新） | `quantizeVector(vec)→{scale,q}`、`dequantizeVector(scale,q)→number[]`、`Int8↔base64`（纯函数，分块防爆栈） |
| `src/rag/vectorStore.ts` | `serialize` 量化每个向量并加 `v:2`；`deserialize` 反量化 + 兼容旧 `vector` 数组。`query`/`topK`/`dot` 不动 |
| `src/main.ts` | 无接口改动（`persistIndex`/`loadIndex` 仍走 serialize/deserialize）；确认 `IndexPayload` 类型随新 `serialize` 返回类型自动适配 |
| `src/util/quantize.test.ts`（新） | round-trip cosine 保持、零向量、base64 往返 |
| `src/rag/vectorStore.test.ts` | 量化序列化往返后 top-1 命中不变；旧 `vector` 数组格式 deserialize 兼容 |

## 测试计划

- **quantize round-trip**：随机归一化向量 `quantize→dequantize`，`cosine(原, 还原) > 0.999`。
- **零向量**：`scale=0` 不产生 `NaN`，反量化全 0。
- **base64 往返**：`Int8Array → base64 → Int8Array` 字节一致（含负值）。
- **VectorStore 往返**：`setFile → serialize → 新实例 deserialize → query`，top-1 路径与量化前一致。
- **旧格式兼容**：手构 `{entries:[{...,vector:[...]}], mtimes, hashes}`（无 `q`）→ deserialize → query 正常。
- 现有 20 个测试不回归。

## 验证

- `npm run build`（tsc + esbuild production 均过）。
- `npm test`（新增用例过、旧用例不回归）。
- 重载插件触发迁移后，确认 `index.json` 体积降到约 8–12 MB（vs 旧 160 MB）。
- 抽查检索质量：对同一 query，量化前后命中的笔记基本一致（「测试检索」命令）。

## 风险

- **int8 召回损失**：per-vector 对称量化，理论相对误差 ~1/127；cosine 聚合后召回损失 < 2%，模糊联想检索场景无感。若日后发现不可接受，可无缝切回 float32 base64（仅改 `quantize.ts` 与格式版本号）。
- **base64 体积膨胀 ~1.33×**：已计入 8–12 MB 估算。
