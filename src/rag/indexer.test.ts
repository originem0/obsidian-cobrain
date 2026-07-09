jest.mock("obsidian", () => ({
  Notice: class {
    setMessage() { return this; }
    hide() {}
  },
}), { virtual: true });

import { Indexer, shouldIndexPath, REINDEX_CONCURRENCY } from "./indexer";
import { VectorStore } from "./vectorStore";

test("shouldIndexPath 排除配置目录和隐藏目录片段，但默认不排除 cobrain-note", () => {
  const settings = { indexExcludeFolders: "Templates\nArchive" };

  expect(shouldIndexPath("notes/a.md", settings)).toBe(true);
  expect(shouldIndexPath("cobrain-note/a.md", settings)).toBe(true);
  expect(shouldIndexPath("Templates/a.md", settings)).toBe(false);
  expect(shouldIndexPath("Archive/old/a.md", settings)).toBe(false);
  expect(shouldIndexPath("notes/.draft/a.md", settings)).toBe(false);
});

test("shouldIndexPath 仍允许用户显式排除 cobrain-note", () => {
  expect(shouldIndexPath("cobrain-note/a.md", { indexExcludeFolders: "cobrain-note" })).toBe(false);
});

test("Indexer onModify 成功后更新 store、持久化分片和状态", async () => {
  const store = new VectorStore();
  const app = {
    vault: {
      cachedRead: jest.fn(async () => "# 标题\n\n正文内容"),
    },
  };
  const embedder = {
    embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  };
  const persist = {
    saveFile: jest.fn(async () => undefined),
    removeFile: jest.fn(async () => undefined),
  };
  const indexer = new Indexer(app as any, embedder as any, store, { indexExcludeFolders: "" });

  await indexer.onModify({ path: "a.md", stat: { mtime: 123 } } as any, persist as any);

  expect(app.vault.cachedRead).toHaveBeenCalled();
  expect(embedder.embedDocuments).toHaveBeenCalled();
  expect(persist.saveFile).toHaveBeenCalledWith("a.md");
  expect(store.allPaths()).toEqual(["a.md"]);
  expect(store.entryCount()).toBeGreaterThan(0);
  const status = indexer.getStatus();
  expect(status.running).toBe(false);
  expect(status.lastChangedAt).toEqual(expect.any(Number));
  expect(status.failures).toEqual([]);
});

test("Indexer 记录失败，并在同一路径成功变更后清掉失败", () => {
  const indexer = new Indexer({} as any, {} as any, new VectorStore(), { indexExcludeFolders: "" });

  indexer.recordFailure("a.md", new Error("嵌入失败"));
  expect(indexer.getStatus().failures).toEqual([
    { path: "a.md", message: "嵌入失败", at: expect.any(Number) },
  ]);

  indexer.recordChange("a.md");
  const status = indexer.getStatus();
  expect(status.lastChangedAt).toEqual(expect.any(Number));
  expect(status.failures).toEqual([]);
});

function fullReindexFixture(fileCount: number, embedDocuments: jest.Mock) {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `f${i}.md`,
    extension: "md",
    stat: { mtime: i + 1 },
  }));
  const store = new VectorStore();
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: jest.fn(async (f: { path: string }) => `# 标题\n\n正文 ${f.path}`),
    },
  };
  const persist = {
    saveFile: jest.fn(async () => undefined),
    removeFile: jest.fn(async () => undefined),
    finalize: jest.fn(async () => undefined),
  };
  const indexer = new Indexer(app as any, { embedDocuments } as any, store, { indexExcludeFolders: "" });
  return { indexer, store, persist };
}

test("reindexAll 文件间并发跑，且并发度不超过上限", async () => {
  let inFlight = 0;
  let peak = 0;
  const embedDocuments = jest.fn(async (texts: string[]) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5)); // 模拟嵌入 API 网络往返
    inFlight--;
    return texts.map(() => [1, 0]);
  });
  const { indexer, store, persist } = fullReindexFixture(12, embedDocuments);

  await indexer.reindexAll(persist as any, "embed-model");

  expect(peak).toBeGreaterThan(1); // 真的在并发，不是串行
  expect(peak).toBeLessThanOrEqual(REINDEX_CONCURRENCY); // 不超上限，不打爆端点限流
  expect(store.allPaths()).toHaveLength(12);
  expect(persist.finalize).toHaveBeenCalledWith("embed-model");
  expect(indexer.getStatus().running).toBe(false);
});

test("reindexAll 并发下单篇失败不拖垮整轮，失败被记录、其余照常入索引", async () => {
  const embedDocuments = jest.fn(async (texts: string[]) => {
    await new Promise(r => setTimeout(r, 2));
    if (texts.some(t => t.includes("f3.md"))) throw new Error("嵌入 API 抖动");
    return texts.map(() => [1, 0]);
  });
  const { indexer, store, persist } = fullReindexFixture(8, embedDocuments);

  await indexer.reindexAll(persist as any, "embed-model");

  expect(store.allPaths()).toHaveLength(7);
  expect(store.allPaths()).not.toContain("f3.md");
  expect(indexer.getStatus().failures).toEqual([
    { path: "f3.md", message: "嵌入 API 抖动", at: expect.any(Number) },
  ]);
  expect(persist.finalize).toHaveBeenCalled(); // 整轮仍然收尾
});
