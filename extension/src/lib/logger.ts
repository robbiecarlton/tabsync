import type { KeyValueStore } from './store';

export const LOG_KEY = 'debugLog';
export const LOG_LIMIT = 50;

export interface LogLine {
  at: number;
  message: string;
}

export type Log = (message: string) => void;

/**
 * Keeps the last LOG_LIMIT lines in storage for the options page's debug section. Writes are
 * chained so lines are never lost to concurrent read-modify-write.
 */
export function createLogger(store: KeyValueStore, now: () => number = Date.now): Log {
  let chain = Promise.resolve();
  return (message) => {
    const line = { at: now(), message };
    console.log(`[tabsync] ${message}`);
    chain = chain
      .then(async () => {
        const lines = (await store.get<LogLine[]>(LOG_KEY)) ?? [];
        await store.set({ [LOG_KEY]: [...lines, line].slice(-LOG_LIMIT) });
      })
      .catch(() => {});
  };
}
