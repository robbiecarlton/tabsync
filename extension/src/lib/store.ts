/** Minimal async key-value store; chrome.storage.local in the extension, a Map in tests. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export class ChromeStore implements KeyValueStore {
  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.local) {}

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.area.get(key);
    return result[key] as T | undefined;
  }

  set(values: Record<string, unknown>): Promise<void> {
    return this.area.set(values);
  }

  remove(keys: string[]): Promise<void> {
    return this.area.remove(keys);
  }
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    // Round-trip through JSON like chrome.storage does, so tests can't share references.
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
  }

  async set(values: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(values)) this.data.set(k, JSON.parse(JSON.stringify(v)));
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.data.delete(k);
  }
}
