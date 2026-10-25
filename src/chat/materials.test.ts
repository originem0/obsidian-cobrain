jest.mock("obsidian", () => ({ TFile: class {} }), { virtual: true });
import { TFile } from "obsidian";
import { readMaterials, selectDocumentText, formatMaterials } from "./materials";
import type { MaterialReference } from "./session";

const ref: MaterialReference = { id: "doc:a", path: "a.md", kind: "document", origin: "unknown" };
test("当前编辑器尚未落盘的内容优先于磁盘或旧索引", async () => {
  const file = Object.assign(new TFile(), { path: "a.md" });
  const read = jest.fn(async () => "旧内容");
  const app: any = { vault: { getAbstractFileByPath: () => file, read }, metadataCache: { getFileCache: () => ({ frontmatter: { author: "别人" } }) }, workspace: { activeEditor: { file, editor: { getValue: () => "刚编辑的新内容" } } } };
  const result = await readMaterials(app, [ref]);
  expect(result[0].text).toBe("刚编辑的新内容"); expect(result[0].author).toBe("别人"); expect(read).not.toHaveBeenCalled();
});
test("选区保留引用快照，源文件删除也不会把选文变成全文", async () => {
  const app: any = { vault: { getAbstractFileByPath: () => null }, workspace: {}, metadataCache: {} };
  const result = await readMaterials(app, [{ ...ref, kind: "selection", text: "当时选中的原文" }]);
  expect(result[0].text).toBe("当时选中的原文");
  await expect(readMaterials(app, [ref])).rejects.toThrow("已移动或删除");
});
test("长文在文内找问题相关段落，末尾的相关内容不会被开头截断吞掉", () => {
  const text = Array.from({ length: 50 }, (_, i) => `## 普通小节${i}\n\n${"无关铺垫".repeat(80)}\n`).join("\n") + "\n## 黑天鹅结论\n\n黑天鹅结论是有些风险无法从历史频率推断。";
  const result = selectDocumentText(text, "解释黑天鹅结论", 1800);
  expect(result.excerpted).toBe(true); expect(result.text).toContain("无法从历史频率推断");
});
test("多篇长短不均的文档总量能放下时，全部原文都保留", () => {
  const long = "完整长文".repeat(1000);
  const result = formatMaterials([{ reference: ref, text: long }, { reference: { ...ref, id: "b", path: "b.md" }, text: "短文" }], "问题", 12000);
  expect(result.excerpted).toEqual([]); expect(result.text).toContain(long);
});


test("只有标题的长大纲仍会提取相关原文，不会只剩节选提示", () => {
  const outline = Array.from({ length: 300 }, (_, i) => `## 一般概念${i}`).join("\n") + "\n## 不可替代的关键命题";
  expect(selectDocumentText(outline, "不可替代的关键命题", 700).text).toContain("不可替代的关键命题");
});
