import { App, normalizePath } from "obsidian";
import { formatWikiLink, sanitizeFilename, stripTrailingRelatedSection } from "./util/noteFormat";
import type { CobrainSettings } from "./settings";

export interface NotePayload {
  title: string;
  body: string;
  sources: string[];
  mermaid?: string | null;
  imageEmbed?: string | null;
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

// 把导师综述 + 概念图 + 配图 + 相关笔记双链写成一篇结构化笔记，返回路径。
export async function saveNote(app: App, settings: CobrainSettings, p: NotePayload): Promise<string> {
  const folder = normalizePath(settings.noteFolder || "cobrain-note");
  await ensureFolder(app, folder);

  const date = new Date().toISOString().slice(0, 10);
  // 标签来自设置（中/英文逗号分隔）；空则不写 tags
  const tags = (settings.noteTags || "").split(/[，,]/).map(t => t.trim()).filter(Boolean);
  const body = stripTrailingRelatedSection(p.body);
  const parts: string[] = ["---", `date: ${date}`];
  if (tags.length) parts.push(`tags: [${tags.join(", ")}]`);
  parts.push("status: seedling");
  parts.push("---", "", `# ${p.title}`, "", body, "");
  if (p.mermaid) parts.push(p.mermaid, "");
  if (p.imageEmbed) parts.push(p.imageEmbed, "");
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

// 保存配图到附件目录，返回 vault 相对路径（供 ![[path]] 嵌入）。
export async function saveImage(app: App, settings: CobrainSettings, buf: ArrayBuffer): Promise<string> {
  const folder = normalizePath(settings.attachmentFolder || "cobrain-note/附件");
  await ensureFolder(app, folder);
  const path = `${folder}/cobrain-${Date.now()}.png`;
  await app.vault.createBinary(path, buf);
  return path;
}
