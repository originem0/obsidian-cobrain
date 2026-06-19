// FNV-1a 32 位哈希：给文件内容算个稳定指纹，用来跳过「内容没变」的重嵌。
// 非加密用途；32 位偶发碰撞最坏只是漏掉一次重嵌（到下次改动再嵌），可接受。
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// 64 位路径哈希：两条 FNV-1a 用「不同乘子」并行，拼成 16-hex。用作索引分片文件名。
// 用不同乘子(而非仅不同种子)才真正独立——同长度字符串的差值不会同时抵消，碰撞才降到 64 位级。
export function fnv1a64(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000199);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
