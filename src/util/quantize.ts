// 向量 int8 量化：把已 L2 归一化的 float 向量压成每维 1 字节，磁盘体积约降一个数量级。
// 仅用于存储；读回后反量化为 number[]，检索逻辑不受影响。per-vector 对称量化，召回损失 <2%。

export interface QuantizedVector {
  scale: number; // 该向量峰值 max(|vᵢ|)，反量化用
  q: string;     // base64 编码的 Int8Array（每维一个有符号字节，补码存为无符号）
}

// String.fromCharCode 一次喂太多会爆栈，按 32K 字节分块。
const CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 量化为内存表示：Int8Array（每维一个有符号字节）+ scale（峰值 max|vᵢ|）。
// 运行时索引直接持有 Int8Array 而非 float64，内存约降 8 倍；检索用 dotQuantized 在 int8 上算分。
export function quantizeToBytes(vec: number[]): { scale: number; bytes: Int8Array } {
  let scale = 0;
  for (const x of vec) {
    const a = Math.abs(x);
    if (a > scale) scale = a;
  }
  const bytes = new Int8Array(vec.length);
  if (scale > 0) {
    for (let i = 0; i < vec.length; i++) {
      let q = Math.round((vec[i] / scale) * 127);
      if (q > 127) q = 127;
      else if (q < -127) q = -127;
      bytes[i] = q; // Int8Array 自动按有符号存储
    }
  }
  return { scale, bytes };
}

// Int8Array ↔ base64（磁盘存储）：换个视图看同一段字节，复用上面的 Uint8 编解码。
export function int8ToBase64(bytes: Int8Array): string {
  return bytesToBase64(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}
export function int8FromBase64(q: string): Int8Array {
  const u = base64ToBytes(q);
  return new Int8Array(u.buffer, u.byteOffset, u.length);
}

export function quantizeVector(vec: number[]): QuantizedVector {
  const { scale, bytes } = quantizeToBytes(vec);
  return { scale, q: int8ToBase64(bytes) };
}

// 查询(float)·量化向量(int8 + scale) 的点积 = scale/127 · Σ(query_j·bytes_j)。
// 与「先 dequantize 再点积」数值等价，故评分与 minScore 语义不变；省去运行时反量化与 float64 常驻。
export function dotQuantized(query: number[], bytes: Int8Array, scale: number): number {
  if (scale === 0) return 0;
  let s = 0;
  const n = Math.min(query.length, bytes.length);
  for (let i = 0; i < n; i++) s += query[i] * bytes[i];
  return (s / 127) * scale;
}

export function dequantizeVector(scale: number, q: string): number[] {
  const bytes = base64ToBytes(q);
  const out = new Array<number>(bytes.length);
  if (scale === 0) {
    out.fill(0);
    return out;
  }
  for (let i = 0; i < bytes.length; i++) {
    const signed = bytes[i] < 128 ? bytes[i] : bytes[i] - 256; // 无符号字节 → 有符号
    out[i] = (signed / 127) * scale;
  }
  return out;
}
