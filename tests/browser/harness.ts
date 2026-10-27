import { ChatView } from "../../src/ui/chatView";
import { Tutor } from "../../src/tutor/tutor";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { newSession, ChatSession } from "../../src/chat/session";
import { SessionStore } from "../../src/chat/sessionStore";
import { Platform, TFile, Notice } from "obsidian";
import "./settings";

const w = window as any;
const docs = new Map<string, string>([
  ["阅读/因果推断.md", "# 因果推断\n\n相关性说明两个现象一起出现。因果关系需要说明干预一个因素后，另一个因素会怎样变化。\n\n作者认为，需要结合机制、反例与干预来判断因果。"],
  ["外部/另一篇文章.md", "这是另一位作者的文章。"],
]);
const files = new Map<string, string>(), folders = new Set<string>();
const adapter: any = {
  exists: async (p: string) => files.has(p) || folders.has(p), mkdir: async (p: string) => { folders.add(p); },
  list: async (p: string) => ({ files: [...files.keys()].filter(k => k.startsWith(p + "/")), folders: [] }),
  read: async (p: string) => { if (!files.has(p)) throw new Error("missing"); return files.get(p)!; },
  write: async (p: string, value: string) => { files.set(p, value); }, remove: async (p: string) => { files.delete(p); },
};
const file = (path: string) => docs.has(path) ? new TFile(path) : null;
let activePath = "阅读/因果推断.md";
const app: any = {
  vault: {
    adapter, getAbstractFileByPath: (path: string) => file(path) ?? (folders.has(path) ? {} : null), getMarkdownFiles: () => [...docs.keys()].map(path => new TFile(path)),
    read: async (f: TFile) => docs.get(f.path), createFolder: async (path: string) => { folders.add(path); },
    create: async (path: string, content: string) => { if (docs.has(path)) throw new Error("exists"); docs.set(path, content); return new TFile(path); },
  },
  metadataCache: { getFileCache: () => ({ frontmatter: { author: "材料原作者" } }) },
  workspace: { requestSaveLayout: () => undefined, activeEditor: null, openLinkText: async () => undefined },
};
let responseMode = "immediate", failSave = false;
const modelCalls: any[] = [], errors: string[] = [];
const chat = { chat: async (messages: any[], opts: any = {}) => {
  modelCalls.push({ messages, opts });
  if (messages[0].content.startsWith("维护一段长对话")) return "已有讨论围绕因果推断展开，用户尚未认可原作者的全部结论。";
  if (responseMode === "hold") return new Promise<string>((resolve, reject) => { w.pendingModel = { emit: (text: string) => opts.onDelta?.(text), resolve, reject }; });
  if (messages.at(-1).content.includes("整理值得保存")) return "标题：因果关系需要什么证据\n原作者强调干预和机制。用户正在追问这些条件是否充分，这一点还需要检验。";
  const text = "原作者把相关性和因果关系区分开了。这里值得追问的是，机制解释是否足以排除共同原因。\n\n例如，观察到两件事经常同时出现，还不能确定改变其中一件就会改变另一件。我们需要看看干预、反例和替代解释分别支持了什么。\n\n你可以先从文章中的一个具体例子出发，检验它排除了哪些解释，又留下了哪些解释。";
  opts.onDelta?.(text); return text;
} };
const sessions = new SessionStore(adapter, "plugin/sessions");
await sessions.init();
const runningSessions = new Map<string, symbol>();
const plugin: any = {
  acquireSessionRequest: (id: string) => { if (runningSessions.has(id)) return null; const token = Symbol(); runningSessions.set(id, token); return () => { if (runningSessions.get(id) === token) runningSessions.delete(id); }; },
  app, sessions, settings: { ...DEFAULT_SETTINGS, llmBaseUrl: "test", llmKey: "test", llmModel: "test" },
  tutor: new Tutor(chat as any, { ...DEFAULT_SETTINGS }),
  currentDocument: () => file(activePath), documentReference: (f: TFile) => ({ id: `document:${f.path}`, path: f.path, kind: "document", origin: "unknown" }),
  persistSession: async (session: ChatSession) => {
    if (failSave && session.history.at(-1)?.role === "assistant") { failSave = false; throw new Error("模拟磁盘写入失败"); }
    session.updatedAt = Date.now(); if (session.title === "新对话" && session.history[0]) session.title = session.history[0].content.slice(0, 30);
    await sessions.save(session);
  },
  rememberSession: async () => undefined, chatConfigProblem: () => null,
  reportError: (e: any) => errors.push(e.message), openPluginSettings: () => undefined,
  searchNotes: async (_query: string, scope: any) => { w.searchCalls++; return scope.mode === "vault" || scope.folders?.includes("外部") ? [{ path: "外部/另一篇文章.md", text: "另一位作者的观点", score: 0.9 }] : []; },
  openSession: async (id: string, preferred: ChatView) => preferred.openSession(await sessions.get(id)),
  startConversation: async (preferred: ChatView) => {
    const session = newSession([plugin.documentReference(file(activePath))]); await sessions.save(session); await preferred.openSession(session);
  },
  deleteSession: async (id: string) => sessions.delete(id),
};
const host = document.getElementById("host")!;
const view = new ChatView({ app, contentEl: host } as any, plugin);
await view.onOpen();
const initial = newSession([plugin.documentReference(file(activePath))]);
initial.title = "因果关系需要什么证据";
initial.history = [{ role: "user", content: "这篇文章里，相关性和因果关系的区别是什么？" }, { role: "assistant", content: "原作者认为，相关性描述共同出现，因果关系需要进一步解释干预后的变化。\n\n我们可以沿着这条区分，检查文中的例子是否排除了共同原因。" }];
await sessions.save(initial); await view.openSession(initial);
w.searchCalls = 0;
const tick = () => new Promise(r => setTimeout(r, 15));
async function until(test: () => boolean, label: string) { const end = Date.now() + 5000; while (!test()) { if (Date.now() > end) throw new Error(`Timeout: ${label}`); await tick(); } }
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function input(text: string) { const field = host.querySelector("textarea")!; field.value = text; field.dispatchEvent(new Event("input")); return field; }
function click(label: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === label || b.textContent === label); if (!button) throw new Error(`Missing button: ${label}`); button.click(); }

w.uiReady = true;
w.qa = { view, plugin, modelCalls, files, docs, errors, Notice };
w.layout = () => {
  const field = host.querySelector("textarea")!.getBoundingClientRect(), send = host.querySelector(".cobrain-send")!.getBoundingClientRect();
  return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
    composerVisible: field.top >= 0 && field.bottom <= innerHeight && send.right <= innerWidth,
    inputWidth: field.width, sendHeight: send.height, bodyButtons: [...host.querySelectorAll("button")].filter(el => getComputedStyle(el).display !== "none").map(el => el.getAttribute("aria-label") || el.textContent) };
};
w.runTests = async () => {
  const passed: string[] = [];
  const field = input("移动端回车不会误发");
  const enter = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }); field.dispatchEvent(enter);
  assert(!enter.defaultPrevented && (view as any).session.history.length === 2, "Mobile Enter submitted");
  Platform.isMobile = false;
  const composing = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true }); field.dispatchEvent(composing);
  assert(!composing.defaultPrevented, "IME confirmation submitted"); Platform.isMobile = true;
  passed.push("mobile newline and IME guard");
  input("继续解释机制和干预的区别"); click("发送");
  await until(() => !(view as any).busy && (view as any).session.history.length === 4, "first response");
  assert(w.searchCalls === 0 && modelCalls.length === 1, "Default conversation triggered retrieval");
  assert(modelCalls[0].messages.some((m: any) => m.content.includes("干预一个因素")), "Document missing from context");
  passed.push("document context without search");
  click("更多操作"); click("手动查找其它资料");
  const searchField = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  searchField.value = "原作者";
  document.querySelector<HTMLInputElement>('input[aria-label="要搜索的目录，逗号分隔"]')!.value = "外部";
  click("搜索"); await until(() => !!document.querySelector(".cobrain-search-result"), "manual search");
  assert((view as any).session.materials.length === 1 && modelCalls.length === 1, "Search results were auto-injected");
  const selected = document.querySelector<HTMLInputElement>('.cobrain-search-result input[type="checkbox"]')!;
  selected.checked = true; selected.dispatchEvent(new Event("change")); click("添加所选文档（1）");
  assert((view as any).session.materials.length === 2 && modelCalls.length === 1, "Explicit selection failed");
  (host.querySelector(".cobrain-scope-button") as HTMLButtonElement).click();
  const origin = document.querySelector<HTMLSelectElement>(".cobrain-material-controls select")!;
  origin.value = "external"; origin.dispatchEvent(new Event("change"));
  click("从本会话移除 外部/另一篇文章.md"); click("完成");
  assert((view as any).session.materials.length === 1 && (view as any).session.materials[0].origin === "external", "Material controls failed");
  passed.push("manual scoped search requires explicit selection and supports origin/removal");
  responseMode = "hold"; input("给一个更具体的例子"); click("发送");
  await until(() => !!w.pendingModel, "pending response");
  const pending = w.pendingModel, original = (view as any).session;
  const mirrorHost = document.createElement("div"); mirrorHost.style.display = "none"; document.body.appendChild(mirrorHost);
  const mirror = new ChatView({ app, contentEl: mirrorHost } as any, plugin);
  await mirror.onOpen(); await mirror.openSession(original);
  const beforeConcurrentSend = original.history.length;
  (mirror as any).inputEl.value = "同一会话不允许并发追加问题";
  await (mirror as any).send();
  assert(original.history.length === beforeConcurrentSend, "Concurrent view changed in-flight history");
  await mirror.onClose(); mirror.unload(); mirrorHost.remove();
  passed.push("a mirrored session cannot interleave concurrent requests");
  pending.emit("已流出的回答部分"); input("等待期间写下的下一问");
  assert(!field.disabled, "Composer disabled during response");
  await plugin.startConversation(view);
  assert(original.history.at(-1).content === "已流出的回答部分", "Partial reply lost on switch");
  assert((view as any).session.history.length === 0, "New session polluted");
  pending.emit("迟到内容不得串入新会话"); pending.resolve("迟到的完整回答"); await tick();
  assert((view as any).session.history.length === 0, "Late completion crossed sessions");
  await view.openSession(original);
  assert(field.value === "等待期间写下的下一问", "Composer draft lost");
  passed.push("stop, preserve partial reply and draft, isolate late results");
  responseMode = "immediate";
  const long = newSession([plugin.documentReference(file(activePath))]); long.title = "长对话验证";
  long.history = Array.from({ length: 140 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `完整记录编号 ${i}\n` + "这是一段保留下来的讨论材料。".repeat(10) }));
  await sessions.save(long); await view.openSession(long);
  assert(host.querySelectorAll("[data-history-index]").length === 60, "Long history rendered without bounds");
  click("显示更早的记录（还有 80 条）"); await until(() => host.querySelectorAll("[data-history-index]").length === 100, "older history");
  passed.push("full history with bounded initial rendering and older-page loading");
  click("更多操作");
  const menu = [...document.querySelectorAll("[role=menuitem]")].map(el => el.textContent);
  assert(!menu.some(text => text?.includes("配图")), "Image action remains");
  click("导出完整会话"); await until(() => [...docs.keys()].some(p => p.includes("会话记录")), "full export");
  const exported = [...docs.entries()].find(([path]) => path.includes("会话记录"))![1];
  assert(exported.includes("完整记录编号 0") && exported.includes("完整记录编号 139"), "Full export truncated");
  passed.push("image-free menu and complete transcript export");
  responseMode = "hold"; w.pendingModel = null; input("不要打断我往回读"); click("发送"); await until(() => !!w.pendingModel, "scroll request");
  const scroller = host.querySelector(".cobrain-messages")!;
  scroller.scrollTop = 300; scroller.dispatchEvent(new Event("scroll"));
  const scrollBefore = scroller.scrollTop;
  const reader = document.getElementById("reader-focus")!; reader.focus();
  w.pendingModel.emit("流式的一部分"); w.pendingModel.resolve("完整回答".repeat(60));
  await until(() => !(view as any).busy, "scroll finish");
  assert(Math.abs(scroller.scrollTop - scrollBefore) < 5, "Completion forced scrolling");
  assert(document.activeElement === reader, "Completion forced focus");
  passed.push("stream completion preserves reading position and focus");
  // 一次提问只应增加提问和一条回答；保存失败后重试不能把回答追加两次。
  const expected = long.history.length + 2;
  responseMode = "immediate"; input("保存失败不能重复追加回答"); failSave = true; click("发送");
  await until(() => !(view as any).busy && long.history.length === expected, "save retry");
  assert(long.history.length === expected, "Save failure duplicated reply");
  passed.push("storage error does not duplicate reply");
  click("更多操作"); click("整理为笔记");
  await until(() => !!document.querySelector(".cobrain-save-modal"), "summary preview");
  assert(document.querySelectorAll(".cobrain-save-modal input[type=checkbox]").length === 1, "Image option remains in save dialog");
  activePath = "外部/另一篇文章.md";
  await plugin.startConversation(view);
  const preview = document.querySelector<HTMLTextAreaElement>(".cobrain-note-preview")!; preview.value = "用户审阅后的判断，保留原作者的归属。";
  click("保存笔记"); await until(() => [...docs.values()].some(content => content.includes("用户审阅后的判断")), "save reviewed note");
  const savedNote = [...docs.values()].find(content => content.includes("用户审阅后的判断"))!;
  assert(savedNote.includes("阅读/因果推断") && !savedNote.includes("外部/另一篇文章"), "Save mixed in new session sources");
  passed.push("editable summary snapshot survives session switch and keeps original sources");
  // 另一台设备已在同一会话追加问答：在内容过期的面板上发送，应先接上外部记录，不另存副本。
  const stale = (view as any).session as ChatSession, count = sessions.list().length;
  const stored = JSON.parse(files.get(`plugin/sessions/${stale.id}.json`)!) as ChatSession & { clock: Record<string, number> };
  stored.history.push({ role: "user", content: "另一台设备上的追问" }, { role: "assistant", content: "另一台设备收到的回答" });
  stored.clock = { ...stored.clock, "device-other": 1 };
  files.set(`plugin/sessions/${stale.id}.json`, JSON.stringify(stored));
  input("在旧面板上继续问"); click("发送");
  await until(() => !(view as any).busy && stale.history.length === stored.history.length + 2, "catch up before sending");
  assert(stale.history[stored.history.length - 1].content === "另一台设备收到的回答" && stale.history.at(-2)?.content === "在旧面板上继续问", "Stale panel did not catch up before sending");
  assert(sessions.list().length === count && host.textContent?.includes("另一台设备收到的回答"), "Stale panel forked or did not render the caught-up reply");
  passed.push("stale panel catches up with another device before sending");
  assert(errors.length === 0, `Unexpected errors: ${errors.join(", ")}`);
  return { passed, modelCalls: modelCalls.length, sessions: sessions.list().length };
};
w.seedScreenshot = async () => {
  for (const el of document.querySelectorAll(".modal-container, .menu")) el.remove();
  responseMode = "immediate";
  const preview = { ...initial, id: "preview", history: initial.history.slice(0, 2), composer: "" };
  await sessions.save(preview); await view.openSession(preview); input("");
  document.getElementById("reader-focus")!.blur(); (document.activeElement as HTMLElement)?.blur();
  (view as any).scrollToBottom(); await tick();
};

w.setMobile = (value: boolean) => { Platform.isMobile = value; document.body.classList.toggle("is-mobile", value); };
