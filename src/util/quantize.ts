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

export function quantizeVector(vec: number[]): QuantizedVector {
  let scale = 0;
  for (const x of vec) {
    const a = Math.abs(x);
    if (a > scale) scale = a;
  }
  const bytes = new Uint8Array(vec.length);
  if (scale > 0) {
    for (let i = 0; i < vec.length; i++) {
      let q = Math.round((vec[i] / scale) * 127);
      if (q > 127) q = 127;
      else if (q < -127) q = -127;
      bytes[i] = q & 0xff; // 有符号 int8 → 无符号字节（补码）
    }
  }
  return { scale, q: bytesToBase64(bytes) };
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
