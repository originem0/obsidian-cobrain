import { App, normalizePath } from "obsidian";
import { formatWikiLink, sanitizeFilename, stripTrailingRelatedSection } from "./util/noteFormat";
import type { CobrainSettings } from "./settings";

export interface NotePayload {
  title: string;
  body: string;
  sources: string[];
  mermaid?: string | null;
  conversation?: string | null; // 原始问题（appendConversation 开启时把用户提问附在末尾）
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const normalized = normalizePath(folder);
  const parts = normalized.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
  }
}

// 摘要与完整会话分别保存，并标明 AI 参与，避免再次检索时被当作用户原有立场。
export async function saveNote(app: App, settings: CobrainSettings, p: NotePayload): Promise<string> {
  const folder = normalizePath(settings.noteFolder || "cobrain-note");
  await ensureFolder(app, folder);

  const date = new Date().toISOString().slice(0, 10);
  // 标签来自设置（中/英文逗号分隔）；空则不写 tags
  const tags = (settings.noteTags || "").split(/[，,]/).map(t => t.trim()).filter(Boolean);
  const body = stripTrailingRelatedSection(p.body);
  const parts: string[] = ["---", `date: ${date}`];
  if (tags.length) parts.push(`tags: ${JSON.stringify(tags)}`);
  parts.push("status: seedling", "cobrain_generated: true", "cobrain_kind: summary");
  parts.push("---", "", `# ${p.title}`, "", body, "");
  if (p.mermaid) parts.push(p.mermaid, "");
  if (p.sources?.length) {
    parts.push("## 相关", "");
    for (const s of p.sources) parts.push(`- ${formatWikiLink(s)}`);
  }
  if (p.conversation) {
    parts.push("", "## 原始问题", "", p.conversation);
  }
  const content = parts.join("\n");

  const base = sanitizeFilename(p.title);
  let path = `${folder}/${base}.md`;
  if (app.vault.getAbstractFileByPath(path)) path = `${folder}/${base} ${Date.now()}.md`;
  await app.vault.create(path, content);
  return path;
}

export async function saveConversation(app: App, settings: CobrainSettings, title: string, markdown: string): Promise<string> {
  const folder = normalizePath(`${settings.noteFolder || "cobrain-note"}/会话记录`);
  await ensureFolder(app, folder);
  const path = `${folder}/${sanitizeFilename(title)} ${Date.now()}.md`;
  await app.vault.create(path, `---\ncobrain_generated: true\ncobrain_kind: conversation\n---\n\n${markdown}`);
  return path;
}
