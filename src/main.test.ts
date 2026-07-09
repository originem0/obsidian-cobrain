jest.mock("obsidian", () => ({
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  DropdownComponent: class {},
  Notice: class {},
  TFile: class {},
  Modal: class {
    contentEl = { empty: jest.fn(), createEl: jest.fn(), createDiv: jest.fn() };
    constructor(public app: unknown) {}
    open() {}
    close() {}
    onClose() {}
  },
  App: class {},
  ItemView: class {},
  WorkspaceLeaf: class {},
  MarkdownRenderer: { render: jest.fn() },
  Menu: class {},
  Platform: { isMobile: false },
  debounce: (fn: unknown) => fn,
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}), { virtual: true });

import { normalizeChatDrafts } from "./main";

test("normalizeChatDrafts 只恢复合法槽位和 user/assistant 消息，并保留已保存笔记状态", () => {
  const out = normalizeChatDrafts({
    1: {
      history: [
        { role: "user", content: "问题" },
        { role: "system", content: "不该恢复" },
        { role: "assistant", content: "回答" },
        { role: "user", content: 123 },
      ],
      sources: ["a.md", 7, "b.md"],
      lastMermaid: "```mermaid\ngraph TD\n```",
      lastImageEmbed: "![[img.png]]",
      lastSavedNote: { stateSignature: "abc", path: "note.md", savedAt: 100 },
      savedAt: 200,
    },
    4: {
      history: [{ role: "user", content: "越界槽位" }],
    },
    bad: {
      history: [{ role: "user", content: "非法键" }],
    },
  });

  expect(Object.keys(out)).toEqual(["1"]);
  expect(out[1].history).toEqual([
    { role: "user", content: "问题" },
    { role: "assistant", content: "回答" },
  ]);
  expect(out[1].sources).toEqual(["a.md", "b.md"]);
  expect(out[1].lastMermaid).toBe("```mermaid\ngraph TD\n```");
  expect(out[1].lastImageEmbed).toBe("![[img.png]]");
  expect(out[1].lastSavedNote).toEqual({ stateSignature: "abc", path: "note.md", savedAt: 100 });
  expect(out[1].savedAt).toBe(200);
});

test("normalizeChatDrafts 限制草稿历史长度，避免 data.json 被长对话撑爆", () => {
  const history = Array.from({ length: 90 }, (_, i) => ({ role: "user", content: `m${i}` }));

  const out = normalizeChatDrafts({ 1: { history } });

  expect(out[1].history.length).toBe(80);
  expect(out[1].history[0].content).toBe("m10");
  expect(out[1].history[79].content).toBe("m89");
});

test("normalizeChatDrafts 恢复滚动摘要，历史截断时覆盖边界随之平移", () => {
  const history = Array.from({ length: 90 }, (_, i) => ({ role: "user", content: `m${i}` }));

  const out = normalizeChatDrafts({
    1: { history, contextSummary: { text: "早期讨论的摘要", coveredCount: 40 } },
    2: { history: [{ role: "user", content: "x" }], contextSummary: { text: "  ", coveredCount: 3 } },
    3: { history: [{ role: "user", content: "x" }], contextSummary: { text: "t", coveredCount: -1 } },
  });

  // 90 条截成 80、丢了前 10 条：coveredCount 40 → 30，摘要覆盖边界仍指向同一条消息
  expect(out[1].contextSummary).toEqual({ text: "早期讨论的摘要", coveredCount: 30 });
  expect(out[2].contextSummary).toBeNull(); // 空白文本不算有效摘要
  expect(out[3].contextSummary).toBeNull(); // 非法 coveredCount 丢弃
});
