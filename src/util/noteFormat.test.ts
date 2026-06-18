import { parseNote, sanitizeFilename } from "./noteFormat";

test("parseNote 提取标题与正文", () => {
  const { title, body } = parseNote("标题：函数式编程\n\n正文第一段。\n第二段。");
  expect(title).toBe("函数式编程");
  expect(body).toBe("正文第一段。\n第二段。");
});

test("parseNote 无标题行时回退默认标题、正文取整段", () => {
  const { title, body } = parseNote("没有标题行的正文。");
  expect(title).toBe("cobrain-note");
  expect(body).toBe("没有标题行的正文。");
});

test("sanitizeFilename 剥非法字符", () => {
  expect(sanitizeFilename('a/b:c*d?"<>|#^[]e')).toBe("abcde");
});

test("sanitizeFilename 空白回退默认名", () => {
  expect(sanitizeFilename("   ")).toBe("cobrain-note");
});

test("sanitizeFilename 截断到 60，给去重后缀留余量", () => {
  const base = sanitizeFilename("标题".repeat(50)); // 远超 60
  expect(base.length).toBe(60);
  // 拼上 ` ${Date.now()}.md` 后仍在常见文件名上限内
  expect(`${base} ${Date.now()}.md`.length).toBeLessThan(80);
});
