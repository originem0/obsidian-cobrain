// 给 Promise 加超时。注意：Obsidian 的 requestUrl 不接受 AbortSignal、无法真正中止，
// 所以超时只是让调用方提前 reject、把 UI 锁（busy / Notice）释放掉，
// 底层 HTTP 请求仍会在后台默默跑完。这是 requestUrl 的固有限制，不是 bug。
export function withTimeout<T>(p: Promise<T>, ms: number, label = "请求"): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error(`${label}超时（约 ${Math.round(ms / 1000)} 秒无响应）`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) window.clearTimeout(timer);
  }) as Promise<T>;
}
