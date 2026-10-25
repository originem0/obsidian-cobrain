jest.mock("obsidian", () => ({
  Component: class {}, ItemView: class {}, FuzzySuggestModal: class {}, Modal: class {},
  PluginSettingTab: class {}, WorkspaceLeaf: class {}, TFile: class {}, Menu: class {}, Platform: { isMobile: false },
}), { virtual: true });
import { shouldSendOnEnter, nearBottom, sessionSignature } from "./chatView";
import { newSession } from "../chat/session";

const enter = (patch: Record<string, unknown> = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, ...patch });
test("手机回车换行，桌面回车发送；中文候选确认和组合输入均不发送", () => {
  expect(shouldSendOnEnter(enter(), true)).toBe(false);
  expect(shouldSendOnEnter(enter(), false)).toBe(true);
  expect(shouldSendOnEnter(enter({ ctrlKey: true }), true)).toBe(true);
  expect(shouldSendOnEnter(enter({ shiftKey: true }), false)).toBe(false);
  expect(shouldSendOnEnter(enter({ isComposing: true }), false)).toBe(false);
  expect(shouldSendOnEnter(enter({ keyCode: 229 }), false)).toBe(false);
  expect(shouldSendOnEnter(enter(), false, true)).toBe(false);
});
test("用户往回阅读时不处于跟随区间", () => {
  expect(nearBottom({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 })).toBe(true);
  expect(nearBottom({ scrollHeight: 2000, clientHeight: 600, scrollTop: 400 })).toBe(false);
});
test("保存去重会区分原文、材料范围和概念图，不因编辑草稿而误判已保存内容", () => {
  const session = newSession(); session.history.push({ role: "user", content: "原文" });
  const signature = sessionSignature(session);
  session.composer = "下一问尚未发送";
  expect(sessionSignature(session)).toBe(signature);
  session.materials.push({ id: "a", path: "a.md", kind: "document", origin: "external" });
  expect(sessionSignature(session)).not.toBe(signature);
});
