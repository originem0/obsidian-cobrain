jest.mock("obsidian", () => ({
  Plugin: class {
    app: any; manifest: any;
    constructor(app: any, manifest: any) { this.app = app; this.manifest = manifest; }
    loadData = jest.fn(async () => ({})); saveData = jest.fn(async () => undefined);
    addSettingTab = jest.fn(); registerView = jest.fn(); registerEvent = jest.fn(); addRibbonIcon = jest.fn(); addCommand = jest.fn();
  },
  PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {}, TFolder: class {},
  Component: class {}, Modal: class {}, FuzzySuggestModal: class {}, Menu: class {},
  ItemView: class { constructor(public leaf: any) {} }, WorkspaceLeaf: class {}, MarkdownRenderer: {},
  Platform: { isMobile: false }, debounce: (fn: any) => Object.assign(fn, { cancel: jest.fn() }),
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
}), { virtual: true });
import { App, TFile, Platform } from "obsidian";
import CobrainPlugin from "./main";
import { ChatView } from "./ui/chatView";
import { IndexStore } from "./rag/indexStore";

(globalThis as any).window = globalThis;
async function fixture(data: unknown = {}) {
  const files = new Map<string, string>(); const folders = new Set<string>(); const leaves: any[] = [];
  const docA = Object.assign(new TFile(), { path: "自己/a.md", extension: "md" });
  const docB = Object.assign(new TFile(), { path: "外部/b.md", extension: "md" });
  let active = docA;
  const events: Record<string, (...args: any[]) => unknown> = {};
  const vaultEvents: Record<string, (...args: any[]) => unknown> = {};
  const adapter = {
    exists: async (p: string) => files.has(p) || folders.has(p), mkdir: async (p: string) => { folders.add(p); },
    read: async (p: string) => files.get(p)!, write: async (p: string, s: string) => { files.set(p, s); },
    remove: async (p: string) => { files.delete(p); }, list: async (p: string) => ({ files: [...files.keys()].filter(f => f.startsWith(p + "/")), folders: [] }),
  };
  const app: any = {
    vault: { adapter, configDir: ".obsidian", on: (name: string, cb: (...args: any[]) => unknown) => { vaultEvents[name] = cb; return {}; }, getAbstractFileByPath: (path: string) => [docA, docB].find(f => f.path === path) ?? null },
    workspace: {
      on: (name: string, cb: (...args: any[]) => unknown) => { events[name] = cb; return {}; },
      onLayoutReady: (cb: () => void) => cb(), detachLeavesOfType: jest.fn(), getActiveFile: () => active,
      iterateAllLeaves: (cb: (leaf: any) => void) => leaves.forEach(cb), revealLeaf: jest.fn(async () => undefined),
      getRightLeaf: jest.fn(() => {
        const leaf: any = { app, view: null, setViewState: jest.fn(async () => {
          leaf.view = new ChatView(leaf, plugin);
          leaf.view.openSession = async (session: unknown) => { leaf.view.session = session; };
        }) };
        leaves.push(leaf); return leaf;
      }),
    },
  };
  const plugin = new CobrainPlugin(app as App, { id: "cobrain", dir: ".obsidian/plugins/cobrain" } as any);
  (plugin.loadData as jest.Mock).mockResolvedValue(data);
  await plugin.onload();
  return { plugin, app, leaves, files, docA, docB, events, vaultEvents, activate: (file: typeof docA) => { active = file; events["file-open"]?.(file); } };
}
afterEach(() => { (Platform as any).isMobile = false; jest.restoreAllMocks(); });
test("普通启动和新建会话不加载向量索引", async () => {
  const load = jest.spyOn(IndexStore.prototype, "load");
  const { plugin } = await fixture(); await plugin.createSession();
  expect(load).not.toHaveBeenCalled();
  expect(plugin.settings.indexEnabled).toBe(false);
});
test("桌面可以新开超过三个独立会话和面板", async () => {
  const { plugin, leaves } = await fixture();
  for (let i = 0; i < 6; i++) await plugin.openNewChatView();
  expect(leaves).toHaveLength(6);
  expect(new Set(leaves.map(l => l.view.sessionId)).size).toBe(6);
  expect(plugin.sessions.list()).toHaveLength(6);
});
test("手机复用一个界面，历史会话数量不受面板数量限制", async () => {
  (Platform as any).isMobile = true;
  const { plugin, leaves } = await fixture();
  for (let i = 0; i < 5; i++) await plugin.openNewChatView();
  expect(leaves).toHaveLength(1);
  expect(plugin.sessions.list()).toHaveLength(5);
});
test("切换文档不会偷换已有会话范围，新会话使用新的当前文档", async () => {
  const { plugin, docB, activate } = await fixture();
  const first = await plugin.createSession(); activate(docB);
  expect(first.materials[0].path).toBe("自己/a.md");
  const second = await plugin.createSession(); expect(second.materials[0].path).toBe("外部/b.md");
});
test("旧草稿只迁移一次；删除迁移会话后重启不会复活", async () => {
  const raw = { chatDrafts: { 1: { history: [{ role: "user", content: "旧提问" }] } } };
  const { plugin } = await fixture(raw);
  expect(plugin.sessions.has("legacy-1")).toBe(true);
  await plugin.deleteSession("legacy-1");
  const saved = (plugin.saveData as jest.Mock).mock.calls.at(-1)![0];
  expect(saved.sessionsMigrated).toBe(true);
  expect(saved.chatDrafts).toEqual(raw.chatDrafts);
});


test("同一会话的请求互斥，旧清理回调不会释放新请求", async () => {
  const { plugin } = await fixture();
  const release1 = plugin.acquireSessionRequest("one")!;
  expect(plugin.acquireSessionRequest("one")).toBeNull();
  release1(); const release2 = plugin.acquireSessionRequest("one")!;
  release1(); expect(plugin.acquireSessionRequest("one")).toBeNull();
  release2(); expect(plugin.acquireSessionRequest("one")).not.toBeNull();
});
test("删除目录会清除该目录的全部旧索引，保留其它目录", async () => {
  const { plugin, vaultEvents } = await fixture();
  plugin.settings.indexEnabled = true; plugin.settings.indexIncludeFolders = ".";
  (plugin as any).indexReady = Promise.resolve();
  plugin.store.setFile("自己/a.md", 1, [{ text: "a", heading: "", vector: [1, 0] }]);
  plugin.store.setFile("外部/b.md", 1, [{ text: "b", heading: "", vector: [0, 1] }]);
  vaultEvents.delete({ path: "自己" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(plugin.store.allPaths()).toEqual(["外部/b.md"]);
});


test("删除一个打开的会话后，关联面板切换到仍存在的会话", async () => {
  const { plugin, leaves } = await fixture();
  await plugin.openNewChatView();
  const id = leaves[0].view.sessionId;
  await plugin.deleteSession(id);
  expect(plugin.sessions.has(id)).toBe(false);
  expect(leaves[0].view.sessionId).not.toBe(id);
  expect(plugin.sessions.has(leaves[0].view.sessionId)).toBe(true);
});
