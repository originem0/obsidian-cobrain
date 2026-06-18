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
