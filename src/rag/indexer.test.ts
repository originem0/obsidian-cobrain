jest.mock("obsidian", () => ({
  Notice: class {},
}), { virtual: true });

import { Indexer, shouldIndexPath } from "./indexer";
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
