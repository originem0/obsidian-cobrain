import { buildQuote, findHeadingAbove } from "./quote";

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
