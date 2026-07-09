// 「停止」的取消语义，从 chatView 抽出以便单测。
// 与真实错误区分：CancelledError 不显示报错气泡。
export class CancelledError extends Error {
  constructor() { super("已停止"); }
}

// 把一次等待包成可取消：cancel() 让 result 立即以 CancelledError reject（UI 解锁）。
// 底层可中止的（fetch + AbortSignal）由调用方另行 abort；不可中止的（requestUrl）则只是放弃结果。
export function makeCancellable<T>(p: Promise<T>): { result: Promise<T>; cancel: () => void } {
  let rejectCancel!: (e: Error) => void;
  const cancelPromise = new Promise<never>((_, reject) => { rejectCancel = reject; });
  return {
    result: Promise.race([p, cancelPromise]),
    cancel: () => rejectCancel(new CancelledError()),
  };
}
