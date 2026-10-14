// The browser and the helper around background.js in tests. Each chrome.*
// call the worker makes has the signature the worker calls it with and the
// answer it reads, so a test sets an answer without casting the mock.
import { vi, type Mock } from "vitest";

/** A message as the worker sends and receives it. */
export type Message = Record<string, unknown>;

/** A tab as the fake browser reports it. */
export interface FakeTab {
  id: number;
  url?: string;
  title?: string;
  windowId?: number;
  active?: boolean;
  discarded?: boolean;
}

/** Who sent a runtime message, as far as the worker reads it. */
export interface FakeSender {
  url?: string;
  frameId?: number;
  tab?: FakeTab;
}

/** A script the worker asks the browser to run in a tab. */
export interface FakeInjection {
  target: { tabId: number; frameIds?: number[]; allFrames?: boolean };
  world?: string;
  files?: string[];
  func?: (...args: never[]) => unknown;
  args?: unknown[];
}

/** What one frame gave back from an injection. */
export interface FakeInjectionResult {
  frameId?: number;
  result?: unknown;
}

/** A window the worker lists to find the folder setup page. */
export interface FakeWindow {
  id: number;
  tabs: Array<{ url: string }>;
}

export type StorageGet = (keys: string | null) => Promise<Record<string, unknown>>;
export type StorageSet = (items: Record<string, unknown>) => Promise<void>;
export type StorageRemove = (keys: string | string[]) => Promise<void>;
/** `reply` is the callback the worker passes, or the options of the promise form (`{ frameId }`). */
export type TabsSendMessage = (tabId: number, message: Message, reply?: unknown) => unknown;
export type TabsGet = (tabId: number) => Promise<FakeTab | null>;
export type TabsQuery = (query: { url?: string[]; active?: boolean; windowId?: number }) => Promise<FakeTab[]>;
export type CaptureVisibleTab = (windowId: number | undefined, options: unknown, callback: (dataUrl: string) => void) => void;
export type ExecuteScript = (injection: FakeInjection) => Promise<FakeInjectionResult[]>;
export type GetContexts = (filter: unknown) => Promise<unknown[]>;
export type WindowsGetAll = (options: unknown, callback?: (windows: FakeWindow[]) => void) => Promise<FakeWindow[]>;

/** `chrome.runtime.lastError` while a callback runs. */
export interface LastError {
  message: string;
}

/** A storage area as the worker uses it. */
export interface FakeStorageArea {
  get: Mock<StorageGet>;
  set: Mock<StorageSet>;
  remove: Mock<StorageRemove>;
}

/** An empty storage area: reads find nothing, writes keep nothing. */
export function fakeStorageArea(): FakeStorageArea {
  return {
    get: vi.fn<StorageGet>(async () => ({})),
    set: vi.fn<StorageSet>(async () => undefined),
    remove: vi.fn<StorageRemove>(async () => undefined),
  };
}

/** Make `area` keep its values in `store`, like the browser: every read is a copy, `null` reads all. */
export function keepIn(area: FakeStorageArea, store: Map<string, unknown>): void {
  area.get.mockImplementation(async (key) => key === null
    ? Object.fromEntries([...store].map(([name, value]) => [name, structuredClone(value)]))
    : { [key]: structuredClone(store.get(key)) });
  area.set.mockImplementation(async (values) => {
    for (const [name, value] of Object.entries(values)) store.set(name, structuredClone(value));
  });
  area.remove.mockImplementation(async (keys) => {
    for (const name of [keys].flat()) store.delete(name);
  });
}

/** A chrome.* event: the test receives what the worker registers on it. */
export function eventSink<Listener>(register?: (listener: Listener) => void) {
  return { addListener: vi.fn((listener: Listener) => { register?.(listener); }) };
}

function isCallback(value: unknown): value is (response: unknown) => void {
  return typeof value === "function";
}

/** Answer a browser call through its callback, when the worker passed one. */
export function replyTo(reply: unknown, response: unknown): void {
  if (isCallback(reply)) reply(response);
}

/** `value`, or a failure that names what is missing. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

/** The part of `source` from the line `start` begins up to `end`, both of which must be there. */
export function sourceSection(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`background.js has no section from "${start}" to "${end}"`);
  return source.slice(from, to);
}
