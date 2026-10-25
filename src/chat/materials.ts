import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { MaterialReference, MaterialOrigin } from "./session";
import { estimateTokens } from "./context";
import { chunkMarkdown } from "../rag/chunker";
import { formatWikiLink } from "../util/noteFormat";

export interface MaterialDocument {
  reference: MaterialReference;
  text: string;
  author?: string;
  source?: string;
}
export const ORIGIN_LABELS: Record<MaterialOrigin, string> = {
  unknown: "作者归属未确认，不代表用户的立场", self: "用户明确标注为自己的笔记",
  external: "外部材料，不代表用户认可其中的观点", generated: "AI 整理材料，未经用户确认的推论不代表用户立场",
};

export async function readMaterials(app: App, references: MaterialReference[]): Promise<MaterialDocument[]> {
  return Promise.all(references.map(async reference => {
    const file = app.vault.getAbstractFileByPath(reference.path);
    if (reference.kind === "document" && !(file instanceof TFile)) {
      throw new Error(`讨论文档已移动或删除：${reference.path}。请在材料范围中重新选择。`);
    }
    const meta = file instanceof TFile ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const active = app.workspace.activeEditor;
    // 当前编辑器可能还没落盘；其它附加文档直接读 vault，避免移动端依赖旧索引快照。
    const text = reference.kind === "selection" ? reference.text ?? ""
      : active?.file?.path === reference.path && active.editor
        ? active.editor.getValue() : await app.vault.read(file as TFile);
    const origin = reference.origin === "unknown" && meta?.cobrain_generated === true ? "generated" : reference.origin;
    const author = Array.isArray(meta?.author) ? meta.author.join("、") : meta?.author;
    return {
      reference: { ...reference, origin }, text,
      author: typeof author === "string" ? author : undefined,
      source: typeof meta?.source === "string" ? meta.source : undefined,
    };
  }));
}

function terms(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
  return new Set(tokens.flatMap(t => /^[a-z0-9_]/.test(t) ? [t] : Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2))));
}
function fitText(text: string, budget: number): string {
  let used = 0, end = 0;
  for (const c of text) {
    used += c.charCodeAt(0) < 128 ? 1 / 3 : 2;
    if (used > budget - 40) break;
    end += c.length;
  }
  return text.slice(0, end) + (end < text.length ? "\n[本片段后续内容未附入]" : "");
}

export function selectDocumentText(text: string, query: string, budget: number): { text: string; excerpted: boolean } {
  if (estimateTokens(text) <= budget) return { text, excerpted: false };
  const structured = chunkMarkdown(text, 700);
  const chunks = structured.length ? structured : (text.match(/[\s\S]{1,700}/g) ?? []).map(part => ({ text: part, heading: "" }));
  const queryTerms = terms(query);
  const ranked = chunks.map((chunk, index) => {
    const tokens = terms(`${chunk.heading}\n${chunk.text}`);
    let score = index === 0 ? 0.5 : 0;
    for (const term of queryTerms) if (tokens.has(term)) score++;
    return { chunk, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: { index: number; text: string }[] = [];
  let left = Math.max(0, budget - 100);
  for (const { chunk, index } of ranked) {
    const body = `${chunk.heading ? `小节：${chunk.heading}\n` : ""}${chunk.text}`;
    const cost = estimateTokens(body) + 15;
    if (cost <= left) { chosen.push({ index, text: body }); left -= cost; }
    else if (!chosen.length && left > 80) { chosen.push({ index, text: fitText(body, left) }); left = 0; }
  }
  return {
    text: "[材料较长，本轮仅附文内相关节选；未附入的部分不可据此推断。]\n"
      + chosen.sort((a, b) => a.index - b.index).map(c => c.text).join("\n\n[中间内容省略]\n\n"),
    excerpted: true,
  };
}

export function formatMaterials(documents: MaterialDocument[], query: string, budget: number): { text: string; excerpted: string[]; sources: string[] } {
  if (!documents.length) return { text: "", excerpted: [], sources: [] };
  const perDocument = Math.floor(budget / documents.length) - 200;
  if (perDocument < 256) throw new Error("附加材料过多，请减少文档数量，或在高级设置中增加对话输入预算。");
  const allFit = documents.reduce((n, d) => n + estimateTokens(d.text) + 200, 0) <= budget;
  const excerpted: string[] = [];
  const text = documents.map(doc => {
    const selected = selectDocumentText(doc.text, query, allFit ? estimateTokens(doc.text) + 100 : perDocument);
    if (selected.excerpted) excerpted.push(doc.reference.path);
    return [
      `来源：${formatWikiLink(doc.reference.path, doc.reference.heading)}`,
      `材料类型：${doc.reference.kind === "selection" ? "用户明确选中的原文快照" : "会话固定的文档，本轮读取最新内容"}`,
      `归属：${ORIGIN_LABELS[doc.reference.origin]}`,
      ...(doc.author ? [`文档标注作者：${doc.author}`] : []),
      ...(doc.source ? [`文档标注出处：${doc.source}`] : []), selected.text,
    ].join("\n");
  }).join("\n\n---\n\n");
  return { text, excerpted, sources: [...new Set(documents.map(d => d.reference.path))] };
}
