import { chunkMarkdown } from "./chunker";

test("空白内容返回空数组", () => {
  expect(chunkMarkdown("   \n\n")).toEqual([]);
});

test("按标题归属，并在超长时切分", () => {
  const md = `# 标题A\n段落一。\n\n## 标题B\n${"句子。".repeat(400)}`;
  const chunks = chunkMarkdown(md, 300);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks[0].heading).toBe("标题A");
  // 标题B 下内容超长 → 被切成多块
  const bChunks = chunks.filter(c => c.heading === "标题B");
  expect(bChunks.length).toBeGreaterThanOrEqual(2);
  bChunks.forEach(c => expect(c.text.length).toBeLessThanOrEqual(360));
});
