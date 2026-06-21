jest.mock("obsidian", () => ({
  Notice: class {},
}), { virtual: true });

import { shouldIndexPath } from "./indexer";

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
