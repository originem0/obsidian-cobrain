// 笔记相关的纯文本处理：刻意不 import obsidian，以便 jest 直接单测（测试环境没有 obsidian 运行时）。

// 从「笔记综述」LLM 输出里解析标题 + 正文。约定首个 `标题：xxx` 行给标题，其余为正文。
// LLM 不照格式时回退默认标题，正文取整段。
export function parseNote(
  reply: string,
  fallbackTitle = "cobrain-note",
): { title: string; body: string } {
  const m = reply.match(/^标题[：:]\s*(.+)$/m);
  const title = m ? m[1].trim() : fallbackTitle;
  const body = reply.replace(/^标题[：:]\s*.+$/m, "").trim();
  return { title, body };
}

// 文件名净化：剥掉文件系统 / Obsidian 不接受的字符并截断。空则回退默认名。
// 默认截到 60：给调用方可能追加的去重后缀（` ${Date.now()}`，约 14 字符）留出余量，
// 避免拼接后超出常见文件名长度上限（旧实现截 80 再拼后缀可达 ~94）。
export function sanitizeFilename(name: string, maxLen = 60): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim().slice(0, maxLen) || "cobrain-note";
}

export function formatWikiLink(path: string, heading?: string): string {
  const cleanPath = path.replace(/\.md$/i, "");
  const aliasBase = cleanPath.split("/").pop() || cleanPath;
  const safeHeading = heading?.replace(/\|/g, " ").trim();
  const target = safeHeading ? `${cleanPath}#${safeHeading}` : cleanPath;
  const alias = safeHeading ? `${aliasBase} › ${safeHeading}` : aliasBase;
  return `[[${target}|${alias}]]`;
}

// 旧提示词会让模型自己生成 `## 相关`，而 saveNote 会用真实 sources 再追加一次。
// 只剥掉末尾的相关区，避免误删正文中间讨论「相关」概念的段落。
export function stripTrailingRelatedSection(markdown: string): string {
  const lines = markdown.trimEnd().split(/\r?\n/);
  let lastH2 = -1;
  let relatedH2 = -1;
  lines.forEach((line, i) => {
    if (/^##\s+.+\s*$/.test(line.trim())) {
      lastH2 = i;
      if (/^##\s+相关\s*$/.test(line.trim())) relatedH2 = i;
    }
  });
  if (relatedH2 >= 0 && relatedH2 === lastH2) {
    return lines.slice(0, relatedH2).join("\n").trimEnd();
  }
  return markdown.trimEnd();
}
