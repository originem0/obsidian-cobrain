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

test("代码围栏内的 # 注释不被当作标题切块", () => {
  const md = [
    "# 真标题",
    "正文一句。",
    "",
    "```python",
    "# 这是注释，不是标题",
    "x = 1",
    "```",
    "结尾一句。",
  ].join("\n");
  const chunks = chunkMarkdown(md, 1000);
  // 全部内容都应归在「真标题」下，不该因代码注释另起一节
  expect(chunks.every(c => c.heading === "真标题")).toBe(true);
  // 注释行作为代码内容被保留
  expect(chunks.some(c => c.text.includes("# 这是注释"))).toBe(true);
});
