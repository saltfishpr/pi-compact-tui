import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 判断当前是否处于子 subagent session 的加载/运行上下文中。
 * 供扩展 factory 顶部使用，避免子 session 再次注册本扩展造成递归。
 */
const childSessionContext = new AsyncLocalStorage<boolean>();

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}
