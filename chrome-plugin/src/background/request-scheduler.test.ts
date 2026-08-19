import { describe, expect, it, vi } from "vitest";
import { ModelRequestError } from "./openai-compatible-adapter";
import {
  RequestScheduler,
  type RunTask,
  type ScheduledRequest,
  type SchedulerSleep,
  type SchedulerPriority,
} from "./request-scheduler";

interface Input {
  id: number;
  tokens: number;
}

function task(
  id: number,
  overrides: Partial<ScheduledRequest<Input>> = {},
): ScheduledRequest<Input> {
  return {
    cacheKey: `key-${id}`,
    documentId: "document-1",
    priority: "visible-core",
    sentenceCount: 1,
    input: { id, tokens: 500 },
    ...overrides,
  };
}

describe("request scheduler", () => {
  it("returns the same Promise for duplicate cache keys", () => {
    const scheduler = new RequestScheduler<Input, number>({
      runTask: (request) => Promise.resolve(request.input.id),
    });
    const first = scheduler.schedule(task(1));
    const duplicate = scheduler.schedule(task(2, { cacheKey: "key-1" }));
    expect(duplicate).toBe(first);
  });

  it("does not share cancellation ownership for equal cache keys in different documents", async () => {
    const runTask = vi.fn(
      (request: ScheduledRequest<Input>, signal: AbortSignal) =>
        new Promise<number>((resolve, reject) => {
          if (request.documentId === "document-2") {
            resolve(request.input.id);
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const scheduler = new RequestScheduler<Input, number>({ runTask });
    const first = scheduler.schedule(task(1));
    const otherDocument = scheduler.schedule(
      task(2, { cacheKey: "key-1", documentId: "document-2" }),
    );
    expect(otherDocument).not.toBe(first);

    scheduler.cancelDocument("document-1");

    await expect(first).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(otherDocument).resolves.toBe(2);
  });

  it("rejects a single request that already exceeds the per-request caps", async () => {
    const runTask = vi.fn<RunTask<Input, number>>().mockResolvedValue(1);
    const scheduler = new RequestScheduler<Input, number>({
      runTask,
      estimateTokens: ({ input }) => input.tokens,
    });

    await expect(scheduler.schedule(task(1, { sentenceCount: 7 }))).rejects.toMatchObject({
      code: "SENTENCE_TOO_LONG",
    });
    await expect(
      scheduler.schedule(task(2, { input: { id: 2, tokens: 4_001 } })),
    ).rejects.toMatchObject({ code: "SENTENCE_TOO_LONG" });
    expect(runTask).not.toHaveBeenCalled();
  });

  it("dispatches queued work in documented priority order", async () => {
    const seen: SchedulerPriority[] = [];
    const scheduler = new RequestScheduler<Input, number>({
      runTask: (request) => {
        seen.push(request.priority);
        return Promise.resolve(request.input.id);
      },
    });
    scheduler.pause();
    const requests = [
      scheduler.schedule(task(1, { priority: "prefetch-core" })),
      scheduler.schedule(task(2, { priority: "visible-core" })),
      scheduler.schedule(task(3, { priority: "detail-click" })),
      scheduler.schedule(task(4, { priority: "user-retry" })),
    ];
    scheduler.resume();
    await Promise.all(requests);
    expect(seen).toEqual(["user-retry", "detail-click", "visible-core", "prefetch-core"]);
  });

  it("uses Retry-After for 429 and exponential delays plus jitter for 5xx", async () => {
    const sleep = vi.fn<SchedulerSleep>().mockResolvedValue(undefined);
    const rateFetch = vi
      .fn<RunTask<Input, number>>()
      .mockRejectedValueOnce(
        new ModelRequestError("RATE_LIMITED", "slow down", true, { retryAfterMs: 2_500 }),
      )
      .mockResolvedValueOnce(1);
    const rateScheduler = new RequestScheduler<Input, number>({ runTask: rateFetch, sleep });
    await expect(rateScheduler.schedule(task(1))).resolves.toBe(1);
    expect(sleep).toHaveBeenCalledWith(2_500, expect.any(AbortSignal));

    sleep.mockClear();
    const serverFetch = vi
      .fn<RunTask<Input, number>>()
      .mockRejectedValueOnce(
        new ModelRequestError("NETWORK_ERROR", "server", true, { status: 500 }),
      )
      .mockRejectedValueOnce(
        new ModelRequestError("NETWORK_ERROR", "server", true, { status: 503 }),
      )
      .mockResolvedValueOnce(2);
    const serverScheduler = new RequestScheduler<Input, number>({
      runTask: serverFetch,
      sleep,
      jitter: () => 25,
    });
    await expect(serverScheduler.schedule(task(2))).resolves.toBe(2);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([525, 1_025]);
  });

  it("does not retry authentication failures", async () => {
    const runTask = vi
      .fn()
      .mockRejectedValue(new ModelRequestError("AUTH_FAILED", "bad key", false));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const scheduler = new RequestScheduler<Input, number>({ runTask, sleep });
    await expect(scheduler.schedule(task(1))).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("cancels only matching queued and running document work", async () => {
    const runTask = vi.fn(
      (request: ScheduledRequest<Input>, signal: AbortSignal) =>
        new Promise<number>((resolve, reject) => {
          if (request.documentId === "other-document") {
            resolve(request.input.id);
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error("Aborted"));
            },
            { once: true },
          );
        }),
    );
    const scheduler = new RequestScheduler<Input, number>({ runTask, concurrency: 1 });
    const running = scheduler.schedule(task(1));
    const queued = scheduler.schedule(task(2));
    const unrelated = scheduler.schedule(task(3, { documentId: "other-document" }));
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1));

    scheduler.cancelDocument("document-1");

    await expect(running).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(queued).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await expect(unrelated).resolves.toBe(3);
  });

  it("honors cancellation that races an already-resolved running fetch", async () => {
    const scheduler = new RequestScheduler<Input, number>({
      runTask: () => Promise.resolve(1),
    });
    const running = scheduler.schedule(task(1));
    scheduler.cancelDocument("document-1");
    await expect(running).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });

  it("settles each request as its own task finishes instead of waiting for siblings", async () => {
    const releases = new Map<number, () => void>();
    const runTask = vi.fn(
      (request: ScheduledRequest<Input>) =>
        new Promise<number>((resolve) =>
          releases.set(request.input.id, () => resolve(request.input.id)),
        ),
    );
    const scheduler = new RequestScheduler<Input, number>({ runTask });

    const first = scheduler.schedule(task(1));
    const second = scheduler.schedule(task(2));
    await vi.waitFor(() => expect(releases.size).toBe(2));

    releases.get(2)!();

    await expect(second).resolves.toBe(2);
    let firstSettled = false;
    void first.then(() => (firstSettled = true));
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    releases.get(1)!();
    await expect(first).resolves.toBe(1);
  });

  it("retries only the request that failed, never its concurrent siblings", async () => {
    const attempts = new Map<number, number>();
    const runTask = vi.fn((request: ScheduledRequest<Input>) => {
      const id = request.input.id;
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (id === 1 && attempt === 1) {
        return Promise.reject(
          new ModelRequestError("RATE_LIMITED", "slow down", true, { retryAfterMs: 10 }),
        );
      }
      return Promise.resolve(id);
    });
    const scheduler = new RequestScheduler<Input, number>({
      runTask,
      sleep: () => Promise.resolve(),
    });

    await expect(
      Promise.all([scheduler.schedule(task(1)), scheduler.schedule(task(2))]),
    ).resolves.toEqual([1, 2]);
    expect(attempts.get(1)).toBe(2);
    expect(attempts.get(2)).toBe(1);
  });

  it("treats concurrency as the number of live tasks", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const runTask = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return 0;
    });
    const scheduler = new RequestScheduler<Input, number>({ runTask, concurrency: 3 });

    const results = Array.from({ length: 7 }, (_, id) => scheduler.schedule(task(id)));
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(3));
    expect(maximumActive).toBe(3);

    while (releases.length > 0) releases.shift()!();
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(6));
    while (releases.length > 0) releases.shift()!();
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(7));
    while (releases.length > 0) releases.shift()!();
    await expect(Promise.all(results)).resolves.toHaveLength(7);
  });

  it("keeps a slot free for interactive work while background prefetch runs", async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const runTask = vi.fn(async (request: ScheduledRequest<Input>) => {
      started.push(request.input.id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return request.input.id;
    });
    const scheduler = new RequestScheduler<Input, number>({ runTask, concurrency: 2 });

    void scheduler.schedule(task(1, { priority: "prefetch-detail" }));
    void scheduler.schedule(task(2, { priority: "prefetch-detail" }));
    await vi.waitFor(() => expect(started).toEqual([1]));
    await Promise.resolve();
    expect(started).toEqual([1]);

    void scheduler.schedule(task(3, { priority: "visible-core" }));
    await vi.waitFor(() => expect(started).toEqual([1, 3]));

    while (releases.length > 0) releases.shift()!();
  });

  // 优先级排序保证交互项永远排在背景项之前，所以队首被上限挡住时其后不可能藏着
  // 交互项——无需扫描跳过。但只剩背景工作时不能停摆：必须逐个放行到排空。
  it("still drains a background-only queue one request at a time", async () => {
    const releases: Array<() => void> = [];
    const runTask = vi.fn(async (request: ScheduledRequest<Input>) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return request.input.id;
    });
    const scheduler = new RequestScheduler<Input, number>({ runTask, concurrency: 2 });

    const pending = [0, 1, 2].map((id) =>
      scheduler.schedule(task(id, { priority: "prefetch-detail" })),
    );

    for (const expected of [1, 2, 3]) {
      await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(expected));
      while (releases.length > 0) releases.shift()!();
    }
    await expect(Promise.all(pending)).resolves.toEqual([0, 1, 2]);
  });

  it("honours an explicit backgroundConcurrency", async () => {
    let activeBackground = 0;
    let maximumBackground = 0;
    const releases: Array<() => void> = [];
    const runTask = vi.fn(async (request: ScheduledRequest<Input>) => {
      activeBackground += 1;
      maximumBackground = Math.max(maximumBackground, activeBackground);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeBackground -= 1;
      return request.input.id;
    });
    const scheduler = new RequestScheduler<Input, number>({
      runTask,
      concurrency: 4,
      backgroundConcurrency: 2,
    });

    for (let id = 0; id < 4; id += 1) {
      void scheduler.schedule(task(id, { priority: "prefetch-core" }));
    }
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(maximumBackground).toBe(2);

    while (releases.length > 0) releases.shift()!();
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(4));
    while (releases.length > 0) releases.shift()!();
  });

  it("runs a queue-jumping request ahead of same-priority work queued before it", async () => {
    const order: number[] = [];
    const scheduler = new RequestScheduler<Input, number>({
      concurrency: 1,
      runTask: (request) => {
        order.push(request.input.id);
        return Promise.resolve(request.input.id);
      },
    });

    scheduler.pause();
    const requests = [
      scheduler.schedule(task(1)),
      scheduler.schedule(task(2)),
      scheduler.schedule(task(3, { jumpQueue: true })),
    ];
    scheduler.resume();
    await Promise.all(requests);

    expect(order).toEqual([3, 1, 2]);
  });

  it("does not let a queue-jumping request outrank a higher priority", async () => {
    const order: string[] = [];
    const scheduler = new RequestScheduler<Input, number>({
      concurrency: 1,
      runTask: (request) => {
        order.push(request.priority);
        return Promise.resolve(request.input.id);
      },
    });

    scheduler.pause();
    const requests = [
      scheduler.schedule(task(1, { priority: "prefetch-detail", jumpQueue: true })),
      scheduler.schedule(task(2, { priority: "detail-click" })),
    ];
    scheduler.resume();
    await Promise.all(requests);

    expect(order).toEqual(["detail-click", "prefetch-detail"]);
  });

  it("runs prefetch-detail requests after every other priority", async () => {
    const order: string[] = [];
    const scheduler = new RequestScheduler<string, string>({
      concurrency: 1,
      runTask: (request) => {
        order.push(request.input);
        return Promise.resolve(request.input);
      },
    });
    const request = (cacheKey: string, priority: SchedulerPriority) =>
      scheduler.schedule({
        cacheKey,
        documentId: "doc",
        priority,
        sentenceCount: 1,
        input: cacheKey,
      });

    scheduler.pause();
    const requests = [
      request("p-detail", "prefetch-detail"),
      request("p-core", "prefetch-core"),
      request("click", "detail-click"),
    ];
    scheduler.resume();
    await Promise.all(requests);
    expect(order.indexOf("p-detail")).toBeGreaterThan(order.indexOf("p-core"));
    expect(order.indexOf("p-core")).toBeGreaterThan(order.indexOf("click"));
  });
});
