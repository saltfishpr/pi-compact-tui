/** 用于代表上下文状态的指纹值，比较其变化以判断是否活跃。 */
type IdleHash = string | number | boolean;

const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const POLL_MS = 1_000;

/**
 * 通过对上下文进行轮询采样，判断目标是否进入 idle 状态。
 *
 * 工作流程：
 * 1. 调用 {@link watch} 后开始周期性采样 {@link computeStateHash}；
 * 2. 若在 `idleMs` 时间内 hash 未变化，则进入 idle，触发 `enter` 回调；
 * 3. 调用 {@link wake} 可强制唤醒并触发 `wake` 回调。
 *
 * @typeParam T 调用方传入的上下文类型。
 */
export class IdleListener<T> {
  private state: "active" | "watching" | "idle" = "active";
  private computeStateHash: (ctx: T) => IdleHash;
  private lastStateHash: IdleHash | undefined;

  private idleMs: number;
  private pollMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  private enterCallbacks: Set<(ctx: T) => void> = new Set();
  private wakeCallbacks: Set<(ctx: T) => void> = new Set();

  /**
   * @param computeStateHash 计算上下文状态指纹的函数，返回值变化即视为有活动。
   * @param idleMs 进入 idle 所需的静默时长（毫秒）。
   * @param pollMs 轮询采样间隔（毫秒）。
   */
  constructor(computeStateHash: (ctx: T) => IdleHash, idleMs: number = DEFAULT_IDLE_MS, pollMs: number = POLL_MS) {
    this.computeStateHash = computeStateHash;
    this.idleMs = idleMs;
    this.pollMs = pollMs;
  }

  /**
   * 注册 idle 进入或唤醒事件的监听器。
   *
   * @returns 用于取消注册的函数。
   */
  on(event: "enter" | "wake", callback: (ctx: T) => void): () => void {
    const callbackSet = event === "enter" ? this.enterCallbacks : this.wakeCallbacks;
    callbackSet.add(callback);

    return () => callbackSet.delete(callback);
  }

  /**
   * 开始监视给定上下文的活跃状态。
   *
   * 已处于 idle 状态时不会重新启动监视，需先调用 {@link wake}。
   */
  watch(ctx: T): void {
    if (this.state === "idle") return;

    this.stop();
    this.state = "watching";

    this.lastStateHash = this.computeStateHash(ctx);
    this.reset(ctx);

    this.pollTimer = setInterval(() => {
      const current = this.computeStateHash(ctx);
      if (current === this.lastStateHash) return;

      this.lastStateHash = current;
      this.reset(ctx);
    }, this.pollMs);
  }

  /**
   * 立即将监听器置为 idle 并触发 `enter` 回调。
   *
   * 已处于 idle 时为幂等操作。
   */
  enter(ctx: T): void {
    if (this.state === "idle") return;

    this.stop();
    this.state = "idle";

    this.enterCallbacks.forEach((callback) => callback(ctx));
  }

  /**
   * 唤醒监听器并触发 `wake` 回调。
   *
   * 与 {@link enter} 不同，每次调用都会触发回调，即便当前已是 active 状态，
   * 以便调用方在外部捕获到活动信号时统一处理。
   */
  wake(ctx: T): void {
    this.stop();
    this.state = "active";

    this.wakeCallbacks.forEach((callback) => callback(ctx));
  }

  /** 释放定时器与已注册的回调，监听器之后应被丢弃。 */
  dispose(): void {
    this.stop();
    this.state = "active";

    this.enterCallbacks.clear();
    this.wakeCallbacks.clear();
  }

  // 重新计时 idle 倒计时；在检测到活动或开始监视时调用。
  private reset(ctx: T): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.enter(ctx);
    }, this.idleMs);
  }

  // 同时清理 idle 倒计时与轮询定时器。
  private stop(): void {
    this.clearIdleTimer();
    this.clearPollTimer();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;

    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearPollTimer(): void {
    if (!this.pollTimer) return;

    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
