import type { ChatMsg } from "../llm/chatClient";

export type MaterialOrigin = "unknown" | "self" | "external" | "generated";
export interface MaterialReference {
  id: string;
  path: string;
  kind: "document" | "selection";
  origin: MaterialOrigin;
  text?: string;
  heading?: string;
}
export interface ContextSummaryState { text: string; coveredCount: number; }
export interface SavedNoteState { stateSignature: string; path: string; savedAt: number; }
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  history: ChatMsg[];
  materials: MaterialReference[];
  composer: string;
  sources: string[];
  contextSummary: ContextSummaryState | null;
  lastMermaid: string | null;
  lastSavedNote: SavedNoteState | null;
}
export type SessionInfo = Pick<ChatSession, "id" | "title" | "createdAt" | "updatedAt">;

export function validSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}
export function newSession(materials: MaterialReference[] = []): ChatSession {
  const now = Date.now();
  return {
    id: `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    title: "新对话", createdAt: now, updatedAt: now,
    history: [], materials, composer: "", sources: [], contextSummary: null,
    lastMermaid: null, lastSavedNote: null,
  };
}
export function normalizeSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!validSessionId(r.id) || !Array.isArray(r.history)) return null;
  const history = r.history.flatMap((m): ChatMsg[] => {
    if (!m || typeof m !== "object") return [];
    return (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
      ? [{ role: m.role, content: m.content }] : [];
  });
  const materials: MaterialReference[] = [];
  for (const m of Array.isArray(r.materials) ? r.materials : []) {
    if (!m || typeof m.path !== "string" || !m.path || typeof m.id !== "string") continue;
    if (m.kind !== "document" && m.kind !== "selection") continue;
    if (m.kind === "selection" && typeof m.text !== "string") continue;
    if (materials.some(item => item.id === m.id)) continue;
    materials.push({
      id: m.id, path: m.path, kind: m.kind,
      origin: ["self", "external", "generated"].includes(m.origin) ? m.origin : "unknown",
      ...(typeof m.text === "string" ? { text: m.text } : {}),
      ...(typeof m.heading === "string" ? { heading: m.heading } : {}),
    });
  }
  const s = r.contextSummary as ContextSummaryState | null;
  const saved = r.lastSavedNote as SavedNoteState | null;
  return {
    id: r.id, title: typeof r.title === "string" && r.title.trim() ? r.title : "未命名对话",
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
    history, materials, composer: typeof r.composer === "string" ? r.composer : "",
    sources: Array.isArray(r.sources) ? r.sources.filter((p): p is string => typeof p === "string") : [],
    contextSummary: history.length === r.history.length && s && typeof s.text === "string" && s.text.trim()
      && Number.isInteger(s.coveredCount) && s.coveredCount >= 0 && s.coveredCount <= history.length
      ? { text: s.text, coveredCount: s.coveredCount } : null,
    lastMermaid: typeof r.lastMermaid === "string" ? r.lastMermaid : null,
    lastSavedNote: saved && typeof saved.path === "string" && typeof saved.stateSignature === "string"
      && typeof saved.savedAt === "number" ? saved : null,
  };
}

// 旧槽位只作为迁移来源，绝不再次按 80 条裁剪。原来已被旧版本删掉的原文无法还原。
export function migrateLegacyDrafts(raw: unknown): ChatSession[] {
  if (!raw || typeof raw !== "object") return [];
  const sessions: ChatSession[] = [];
  for (const [slot, value] of Object.entries(raw)) {
    if (!/^\d+$/.test(slot) || !value || typeof value !== "object") continue;
    const r = value as Record<string, unknown>;
    const session = normalizeSession({ ...r, id: `legacy-${slot}`, title: `原对话 ${slot}`, updatedAt: r.savedAt });
    if (!session?.history.length) continue;
    if (typeof r.lastImageEmbed === "string" && r.lastImageEmbed) {
      session.history.push({ role: "assistant", content: `原会话附件\n\n${r.lastImageEmbed}` });
    }
    sessions.push(session);
  }
  return sessions;
}

export function conversationMarkdown(session: ChatSession): string {
  const origins: Record<MaterialOrigin, string> = { unknown: "归属未确认", self: "我的笔记", external: "外部材料", generated: "AI 整理" };
  const materialList = session.materials.flatMap(m => [
    `- [[${m.path.replace(/\.md$/i, "")}]] · ${origins[m.origin]}${m.kind === "selection" ? " · 选区快照" : ""}`,
    ...(m.kind === "selection" ? ["", ...(m.text ?? "").split("\n").map(line => `> ${line}`), ""] : []),
  ]);
  return [
    `# ${session.title}`, "",
    ...(materialList.length ? ["## 讨论材料", "", ...materialList, ""] : []),
    ...session.history.flatMap(m => [`## ${m.role === "user" ? "我" : "副脑"}`, "", m.content, ""]),
  ].join("\n");
}
