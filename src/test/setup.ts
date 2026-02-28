import "@testing-library/jest-dom/vitest";

// Mock ResizeObserver — required by cmdk (command palette)
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock scrollIntoView — used by cmdk for item focus
Element.prototype.scrollIntoView = vi.fn();

// Mock @tauri-apps/api/core — all invoke calls return empty by default.
// Individual tests override via vi.mocked(invoke).mockResolvedValue().
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

// Mock @tauri-apps/api/event — listen returns a no-op unlisten.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// Mock @tauri-apps/plugin-dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));
