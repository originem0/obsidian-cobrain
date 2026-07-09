import { CancelledError, makeCancellable } from "./cancellable";

test("cancel() 让 result 立即以 CancelledError 拒绝（底层仍挂起）", async () => {
  const never = new Promise<string>(() => undefined);
  const { result, cancel } = makeCancellable(never);

  cancel();

  await expect(result).rejects.toBeInstanceOf(CancelledError);
});

test("底层先完成则正常返回，之后 cancel 是 no-op", async () => {
  const { result, cancel } = makeCancellable(Promise.resolve("ok"));

  await expect(result).resolves.toBe("ok");
  expect(() => cancel()).not.toThrow();
});

test("取消后底层迟到的拒绝被竞速吸收，不产生未处理拒绝", async () => {
  let rejectLate!: (e: Error) => void;
  const p = new Promise<string>((_, reject) => { rejectLate = reject; });
  const { result, cancel } = makeCancellable(p);

  cancel();
  await expect(result).rejects.toBeInstanceOf(CancelledError);
  rejectLate(new Error("迟到的失败")); // race 已订阅 p，这里不该炸测试进程

  await new Promise(r => setTimeout(r, 0));
});
