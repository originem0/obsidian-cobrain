import { buildQuote, findHeadingAbove, extractContext } from "./quote";

test("buildQuote 单行 + 无标题", () => {
  expect(buildQuote("hello", "Note", null)).toBe("> hello\n> —— [[Note]]\n\n");
});

test("buildQuote 多行 + 标题", () => {
  expect(buildQuote("a\nb", "Note", "Sec")).toBe("> a\n> b\n> —— [[Note#Sec]]\n\n");
});

test("findHeadingAbove 返回最近的上方标题", () => {
  const lines = ["# 一级", "正文", "## 二级", "目标行", "更多"];
  expect(findHeadingAbove(lines, 3)).toBe("二级");
});

test("findHeadingAbove 无标题返回 null", () => {
  expect(findHeadingAbove(["正文", "再一行"], 1)).toBeNull();
});

test("findHeadingAbove 本行即标题也算", () => {
  expect(findHeadingAbove(["# 标题"], 0)).toBe("标题");
});

test("extractContext 取最近标题所在小节，到下一个同级标题前", () => {
  const lines = ["# A", "a1", "## B", "b1", "b2", "## C", "c1"];
  expect(extractContext(lines, 4)).toBe("## B\nb1\nb2");
});

test("extractContext 更深子标题不截断小节", () => {
  const lines = ["## B", "b1", "### B1", "x", "## C"];
  expect(extractContext(lines, 1)).toBe("## B\nb1\n### B1\nx");
});

test("extractContext 无标题取附近窗口", () => {
  expect(extractContext(["l0", "l1", "l2", "l3"], 1)).toBe("l0\nl1\nl2\nl3");
});

test("extractContext 超长取窗口并受 maxChars 限", () => {
  const big = Array.from({ length: 100 }, (_, i) => "行" + i);
  expect(extractContext(["# H", ...big], 50, 100).length).toBeLessThanOrEqual(100);
});
