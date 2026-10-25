import { Retriever } from "./retriever";
import { VectorStore } from "./vectorStore";
import { allowedIndexPath, type IndexScopeSettings } from "./scope";

test("白名单默认留空不会索引，排除项和隐藏目录优先", () => {
  const settings = { indexEnabled: true, indexIncludeFolders: "自己的笔记", indexExcludeFolders: "自己的笔记/私人" };
  expect(allowedIndexPath("自己的笔记/a.md", settings)).toBe(true);
  expect(allowedIndexPath("别人的笔记/a.md", settings)).toBe(false);
  expect(allowedIndexPath("自己的笔记/私人/a.md", settings)).toBe(false);
  expect(allowedIndexPath("自己的笔记/.hidden/a.md", settings)).toBe(false);
  expect(allowedIndexPath("a.md", { ...settings, indexIncludeFolders: "" })).toBe(false);
});
test("未明确检索范围或未启用索引，不调用嵌入端点", async () => {
  const embed = { embedQuery: jest.fn(async () => [1, 0]), embedDocuments: jest.fn() };
  const settings = { indexEnabled: true, indexIncludeFolders: ".", indexExcludeFolders: "", retrievalMinScore: 0 };
  const retriever = new Retriever(embed, new VectorStore(), settings);
  expect(await retriever.retrieve("问题")).toEqual([]);
  settings.indexEnabled = false;
  expect(await retriever.retrieve("问题", 8, { mode: "vault" })).toEqual([]);
  expect(embed.embedQuery).not.toHaveBeenCalled();
});
test("先限制候选范围再取 top-k，旧索引中的排除材料立即失效", async () => {
  const store = new VectorStore();
  store.setFile("外部/无关.md", 1, [{ text: "分数最高", heading: "", vector: [1, 0] }]);
  store.setFile("自己/a.md", 1, [{ text: "范围内的内容", heading: "", vector: [0.8, 0.2] }]);
  const settings = { indexEnabled: true, indexIncludeFolders: ".", indexExcludeFolders: "", retrievalMinScore: 0 };
  const retriever = new Retriever({ embedQuery: async () => [1, 0], embedDocuments: jest.fn() }, store, settings);
  expect((await retriever.retrieve("问题", 1, { mode: "folders", folders: ["自己"] }))[0].path).toBe("自己/a.md");
  settings.indexExcludeFolders = "外部";
  expect((await retriever.retrieve("问题", 1, { mode: "vault" }))[0].path).toBe("自己/a.md");
});
test("嵌入请求在途时收窄范围，返回结果仍按新范围过滤", async () => {
  const store = new VectorStore(); store.setFile("外部/a.md", 1, [{ text: "旧材料", heading: "", vector: [1, 0] }]);
  let done!: (v: number[]) => void;
  const settings = { indexEnabled: true, indexIncludeFolders: ".", indexExcludeFolders: "", retrievalMinScore: 0 };
  const retriever = new Retriever({ embedQuery: () => new Promise<number[]>(r => { done = r; }), embedDocuments: jest.fn() }, store, settings);
  const pending = retriever.retrieve("问题", 8, { mode: "vault" });
  settings.indexIncludeFolders = "自己"; done([1, 0]);
  expect(await pending).toEqual([]);
});
