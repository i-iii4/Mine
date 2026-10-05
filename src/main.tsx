import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hydrateCommandOverrides, watchCommandOverrides } from "@/lib/shortcutOverrides";
import { applyTheme, getStoredTheme } from "@/lib/themeMode";
import { applyDesign, getStoredDesignMode } from "@/lib/designMode";
import { applyCardRadius, getStoredCardRadius } from "@/lib/cardRadius";
import { applyDensity, getStoredDensity } from "@/lib/density";
import { followWindowButtonStyle } from "@/lib/buttonStyle";
import {
  applyContentFont,
  applyInterfaceFont,
  getStoredContentFont,
  getStoredInterfaceFont,
} from "@/lib/fontChoice";
import { App } from "./App";
import { getVaultPath, recordStartupMilestone, reportNativeShellSmoke } from "@/lib/commands";
import { installControlCharGuard } from "@/lib/controlCharGuard";
import { scheduleAfterNextPaint } from "@/lib/startup";
import "./styles/global.css";

// A tab is a child page of its window, where the arrow keys can type stray
// control characters into fields (SPEC_TABS.md, В80): one guard for the page.
installControlCharGuard();

// Apply the stored theme and design variant before first paint (the settings
// window owns the controls; this window re-applies on "settings-changed").
applyTheme(getStoredTheme());
applyDesign(getStoredDesignMode());
applyCardRadius(getStoredCardRadius());
applyDensity(getStoredDensity());
applyInterfaceFont(getStoredInterfaceFont());
applyContentFont(getStoredContentFont());
// Dev button styles (src/lib/buttonStyle.ts): this window's style, then what
// the window's bar sends.
followWindowButtonStyle();
void recordStartupMilestone("frontend_entry").catch(() => {});

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] React render crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: "var(--foreground)", background: "var(--background)", minHeight: "100vh", fontFamily: "monospace" }}>
          <h1 style={{ color: "var(--destructive)", marginBottom: 16 }}>Render Error</h1>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.5 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, opacity: 0.6, marginTop: 16 }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{ marginTop: 24, padding: "8px 16px", cursor: "pointer", background: "#333", color: "#fff", border: "1px solid #555", borderRadius: 3 }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function StartupPaintReporter() {
  React.useEffect(() => scheduleAfterNextPaint(() => {
    void recordStartupMilestone("window_shell_painted").catch(() => {});
  }), []);
  return null;
}

// Shortcut overrides must be in place before the first keydown handler runs.
void hydrateCommandOverrides();
watchCommandOverrides();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found. Check index.html for div#root.");
}

const feedScrollAuditRoute =
  import.meta.env.DEV && window.location.pathname === "/__feed-scroll-audit";
const graphAuditRoute =
  import.meta.env.DEV && window.location.pathname === "/__graph-audit";
const coldSpaceAuditRoute =
  import.meta.env.DEV && window.location.pathname === "/__cold-space-audit";
const sidebarReorderAuditRoute =
  import.meta.env.DEV && window.location.pathname === "/__sidebar-reorder-audit";
// The versions of the sidebar's filter row, in a plain browser tab
// (settings, Top Bar Variants, without the app around it).
const topBarVariantsRoute =
  import.meta.env.DEV && window.location.pathname === "/__top-bar-variants";
// Buttons as they are and adapted to shadcn's secondary, outline and ghost.
const buttonsRoute = import.meta.env.DEV && window.location.pathname === "/__buttons";
// Approaches to button volume side by side in both themes.
const buttonDepthRoute = import.meta.env.DEV && window.location.pathname === "/__button-depth";
// Every button and icon the interface draws today, in both themes.
const uiInventoryRoute = import.meta.env.DEV && window.location.pathname === "/__ui-inventory";
// Icon candidates for the Connect buttons in their places, in both themes.
const connectIconsRoute = import.meta.env.DEV && window.location.pathname === "/__connect-icons";
// The signal ladder of the dark theme, measured.
const textLadderRoute = import.meta.env.DEV && window.location.pathname === "/__text-ladder";
// One slice of the window with macOS buttons and with the retro tile, in both themes.
const buttonsDecisionRoute = import.meta.env.DEV && window.location.pathname === "/__buttons-decision";
const nativeShellSmokeRoute = new URLSearchParams(window.location.search)
  .has("mine-native-shell-smoke");
const auditRoute = feedScrollAuditRoute
  ? "feed"
  : graphAuditRoute
    ? "graph"
    : coldSpaceAuditRoute
      ? "cold-space"
      : sidebarReorderAuditRoute
        ? "sidebar-reorder"
        : null;

type AuditTauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    convertFileSrc?: (filePath: string, protocol?: string) => string;
  };
};

function installAuditTauriMocks() {
  const tauriWindow = window as AuditTauriWindow;
  tauriWindow.__TAURI_INTERNALS__ = tauriWindow.__TAURI_INTERNALS__ ?? {};
  tauriWindow.__TAURI_INTERNALS__.convertFileSrc = (filePath, protocol = "asset") => {
    const normalizedPath = filePath.startsWith("//") ? filePath.slice(1) : filePath;
    if (normalizedPath.startsWith("/feed-scroll-audit/")) {
      return normalizedPath;
    }
    const graphCardMatch = normalizedPath.match(/\/graph-audit\/thumbs\/graph-card-(\d+)(?:\.(?:micro|zoom|preview-\d+))?\.jpg$/);
    if (graphCardMatch) {
      const assetIndex = Number(graphCardMatch[1]) % 6;
      return `/feed-scroll-audit/audit-${assetIndex}.svg`;
    }
    if (auditRoute === "cold-space") {
      return `/__cold-space-asset?path=${encodeURIComponent(normalizedPath)}`;
    }
    return `${protocol}://localhost/${encodeURIComponent(normalizedPath)}`;
  };
}

function Root() {
  const [AuditRoute, setAuditRoute] =
    React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    if (!auditRoute) return;
    let cancelled = false;
    void (async () => {
      installAuditTauriMocks();
      const module = auditRoute === "feed"
        ? await import("./dev/FeedScrollAuditRoute")
        : auditRoute === "graph"
          ? await import("./dev/GraphAuditRoute")
          : auditRoute === "sidebar-reorder"
            ? await import("./dev/SidebarReorderAuditRoute")
            : await import("./dev/ColdSpaceAuditRoute");
      if (!cancelled) {
        setAuditRoute(() => (
          "FeedScrollAuditRoute" in module
            ? module.FeedScrollAuditRoute
            : "GraphAuditRoute" in module
              ? module.GraphAuditRoute
              : "SidebarReorderAuditRoute" in module
                ? module.SidebarReorderAuditRoute
                : module.ColdSpaceAuditRoute
        ));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (nativeShellSmokeRoute) {
    return <NativeShellSmokeRoute />;
  }

  if (buttonsRoute) {
    return (
      <React.Suspense fallback={null}>
        <ButtonAdaptationPage />
      </React.Suspense>
    );
  }

  if (buttonDepthRoute) {
    return (
      <React.Suspense fallback={null}>
        <ButtonDepthPage />
      </React.Suspense>
    );
  }

  if (uiInventoryRoute) {
    return (
      <React.Suspense fallback={null}>
        <UiInventoryPage />
      </React.Suspense>
    );
  }

  if (connectIconsRoute) {
    return (
      <React.Suspense fallback={null}>
        <ConnectIconsPage />
      </React.Suspense>
    );
  }

  if (textLadderRoute) {
    return (
      <React.Suspense fallback={null}>
        <TextLadderPage />
      </React.Suspense>
    );
  }

  if (buttonsDecisionRoute) {
    return (
      <React.Suspense fallback={null}>
        <ButtonsDecisionPage />
      </React.Suspense>
    );
  }

  if (topBarVariantsRoute) {
    return (
      <React.Suspense fallback={null}>
        <TopBarVariantsPage />
      </React.Suspense>
    );
  }

  if (auditRoute) {
    return AuditRoute ? <AuditRoute /> : null;
  }

  return <App />;
}

const ButtonAdaptationPage = React.lazy(async () => {
  const mod = await import("./dev/ButtonAdaptationPage");
  return { default: mod.ButtonAdaptationPage };
});

const ButtonDepthPage = React.lazy(async () => {
  const mod = await import("./dev/ButtonDepthPage");
  return { default: mod.ButtonDepthPage };
});

const UiInventoryPage = React.lazy(async () => {
  const mod = await import("./dev/UiInventoryPage");
  return { default: mod.UiInventoryPage };
});

const ConnectIconsPage = React.lazy(async () => {
  const mod = await import("./dev/ConnectIconsPage");
  return { default: mod.ConnectIconsPage };
});

const TextLadderPage = React.lazy(async () => {
  const mod = await import("./dev/TextLadderPage");
  return { default: mod.TextLadderPage };
});

const ButtonsDecisionPage = React.lazy(async () => {
  const mod = await import("./dev/ButtonsDecisionPage");
  return { default: mod.ButtonsDecisionPage };
});

const TopBarVariantsPage = React.lazy(async () => {
  const mod = await import("./settings/TopBarVariants");
  return { default: mod.TopBarVariantsPage };
});

function NativeShellSmokeRoute() {
  const [status, setStatus] = React.useState("running");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      let vaultPath: string | null = null;
      let reportStatus = "ok";
      try {
        vaultPath = await getVaultPath();
      } catch (error) {
        reportStatus = `get_vault_path failed: ${String(error)}`;
      }
      await reportNativeShellSmoke({
        status: reportStatus,
        vault_path: vaultPath,
        location: window.location.href,
        user_agent: window.navigator.userAgent,
        timestamp_ms: Date.now(),
      });
      if (!cancelled) setStatus(reportStatus);
    })().catch((error) => {
      if (!cancelled) setStatus(`failed: ${String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <div data-native-shell-smoke={status}>{status}</div>;
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <StartupPaintReporter />
        <Root />
      </TooltipProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
