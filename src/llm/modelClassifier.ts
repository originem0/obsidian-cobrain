export interface ModelGroups {
  chat: string[];
  image: string[];
  embed: string[];
}

export function classifyModels(ids: string[]): ModelGroups {
  const groups: ModelGroups = { chat: [], image: [], embed: [] };
  for (const id of ids) {
    const isEmbed =
      /embed|bge|gte|m3e|jina|nomic|nv-?embed|text-embedding|(^|[^a-z0-9])e5([^a-z0-9]|$)/i.test(id) &&
      !/rerank/i.test(id);
    const isImage = /gpt-image|dall[- ]?e|flux|stable-?diffusion|sd-?xl|sd3|seedream|kontext|imagen|midjourney/i.test(id);
    const isDefinitelyNotChat = /whisper|tts|audio|rerank|moderation|embed/i.test(id);

    if (isEmbed) groups.embed.push(id);
    if (isImage) groups.image.push(id);
    if (!isEmbed && !isImage && !isDefinitelyNotChat) groups.chat.push(id);
  }
  return groups;
}

// 确保 current 一定在候选列表里(不在则置顶),让下拉能选中当前已保存的值。
// 检测列表可能不含用户自定义/写法不同的已存模型,缺了它下拉会显示成别的项,与实际调用不符。
export function ensureCurrentOption(candidates: string[], current: string): string[] {
  if (!current) return candidates.slice();
  return candidates.includes(current) ? candidates.slice() : [current, ...candidates];
}
