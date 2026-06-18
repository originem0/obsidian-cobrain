import { App, normalizePath } from "obsidian";
import type { LTSettings } from "./settings";

export interface NotePayload {
  title: string;
  body: string;
  sources: string[];
  mermaid?: string | null;
  imageEmbed?: string | null;
  conversation?: string | null; // 原始对话（appendConversation 开启时附在末尾）
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim().slice(0, 80) || "学习笔记";
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!app.vault.getAbstractFileByPath(folder)) {
    await app.vault.createFolder(folder).catch(() => {});
  }
}

// 把导师综述 + 概念图 + 配图 + 相关笔记双链写成一篇结构化笔记，返回路径。
export async function saveNote(app: App, settings: LTSettings, p: NotePayload): Promise<string> {
  const folder = normalizePath(settings.noteFolder || "学习导师");
  await ensureFolder(app, folder);

  const date = new Date().toISOString().slice(0, 10);
  // 标签来自设置（中/英文逗号分隔）；空则不写 tags
  const tags = (settings.noteTags || "").split(/[，,]/).map(t => t.trim()).filter(Boolean);
  const parts: string[] = ["---", `created: ${date}`];
  if (tags.length) parts.push(`tags: [${tags.join(", ")}]`);
  parts.push("---", "", `# ${p.title}`, "", p.body, "");
  if (p.mermaid) parts.push(p.mermaid, "");
  if (p.imageEmbed) parts.push(p.imageEmbed, "");
  if (p.sources?.length) {
    parts.push("## 相关笔记", "");
    for (const s of p.sources) parts.push(`- [[${s.replace(/\.md$/, "")}]]`);
  }
  if (p.conversation) {
    parts.push("", "## 原始对话", "", p.conversation);
  }
  const content = parts.join("\n");

  let path = `${folder}/${sanitize(p.title)}.md`;
  if (app.vault.getAbstractFileByPath(path)) path = `${folder}/${sanitize(p.title)} ${Date.now()}.md`;
  await app.vault.create(path, content);
  return path;
}

// 保存配图到附件目录，返回 vault 相对路径（供 ![[path]] 嵌入）。
export async function saveImage(app: App, settings: LTSettings, buf: ArrayBuffer): Promise<string> {
  const folder = normalizePath(settings.attachmentFolder || "学习导师/附件");
  await ensureFolder(app, folder);
  const path = `${folder}/lt-${Date.now()}.png`;
  await app.vault.createBinary(path, buf);
  return path;
}
