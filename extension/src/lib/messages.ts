import type { ConflictChoice, HistoryView, StatusView } from './engine';
import type { LogLine } from './logger';
import type { ApplyMode } from './reconcile';
import type { Settings } from './state';

/** Requests from the popup/options page to the background worker, and their results. */
export interface MessageMap {
  status: { request: { type: 'status' }; result: StatusView };
  syncNow: { request: { type: 'syncNow' }; result: StatusView };
  pull: { request: { type: 'pull' }; result: StatusView };
  apply: {
    request: { type: 'apply'; mode: ApplyMode; closeSurplusWindows: boolean };
    result: StatusView;
  };
  resolve: { request: { type: 'resolve'; choice: ConflictChoice }; result: StatusView };
  history: { request: { type: 'history' }; result: HistoryView };
  restore: {
    request: { type: 'restore'; snapshotId: string; mode: ApplyMode; closeSurplusWindows: boolean };
    result: StatusView;
  };
  createProfile: { request: { type: 'createProfile' }; result: { secret: string } };
  joinProfile: { request: { type: 'joinProfile'; secret: string }; result: null };
  revealSecret: { request: { type: 'revealSecret' }; result: string | null };
  disconnect: { request: { type: 'disconnect' }; result: null };
  updateSettings: {
    request: {
      type: 'updateSettings';
      patch: Partial<Pick<Settings, 'serverUrl' | 'deviceName' | 'applyMode'>>;
    };
    result: Settings;
  };
  debugLog: { request: { type: 'debugLog' }; result: LogLine[] };
}

export type MessageType = keyof MessageMap;
export type Request = MessageMap[MessageType]['request'];
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/** Sends a request to the background worker; rejects with the worker's error message. */
export async function send<K extends MessageType>(
  request: MessageMap[K]['request'],
): Promise<MessageMap[K]['result']> {
  const reply = (await chrome.runtime.sendMessage(request)) as
    Reply<MessageMap[K]['result']> | undefined;
  if (!reply) throw new Error('The background worker did not respond');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
