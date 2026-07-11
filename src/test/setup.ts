import "@testing-library/jest-dom/vitest";

// Startup tracing is useful in the desktop console but overwhelms Vitest's
// result stream. Warnings and errors remain untouched.
vi.spyOn(console, "info").mockImplementation(() => undefined);

// Mock ResizeObserver for components that measure their layout in tests.
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock scrollIntoView for keyboard navigation in virtualized UI.
Element.prototype.scrollIntoView = vi.fn();

// JSDOM intentionally omits media playback and Canvas 2D. Production behavior
// is covered by Playwright; unit tests need deterministic no-op platform APIs
// so expected capability gaps do not drown actionable warnings.
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  // JSDOM's native placeholder returns undefined after logging. Preserve that
  // synchronous contract without the log; playback-specific tests override it.
  value: vi.fn(() => undefined),
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: vi.fn(function getContext(this: HTMLCanvasElement, contextId: string) {
    if (contextId !== "2d") return null;
    return {
      canvas: this,
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      textAlign: "start",
      textBaseline: "alphabetic",
      measureText: (text: string) => ({ width: text.length * 7.5 }),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      arcTo: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      clearRect: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      putImageData: vi.fn(),
    };
  }),
});

// Mock @tauri-apps/api/core — all invoke calls return empty by default.
// Individual tests override via vi.mocked(invoke).mockResolvedValue().
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

// Mock @tauri-apps/api/event — bridge Tauri events onto window CustomEvents
// so tests can drive listener-based flows.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    const wrapped: EventListener = (domEvent) => {
      const customEvent = domEvent as CustomEvent;
      void handler(customEvent.detail);
    };
    window.addEventListener(event, wrapped);
    return () => window.removeEventListener(event, wrapped);
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    startDragging: vi.fn(async () => {}),
    setBackgroundColor: vi.fn(async () => {}),
  })),
}));

vi.mock("@tauri-apps/api/app", () => ({
  setTheme: vi.fn(async () => {}),
}));

// Mock @tauri-apps/plugin-dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));
