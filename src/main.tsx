import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme, getStoredTheme } from "@/lib/themeMode";
import { applyDesign, getStoredDesignMode } from "@/lib/designMode";
import { applyCardRadius, getStoredCardRadius } from "@/lib/cardRadius";
import {
  applyActionButtonStyle,
  getStoredActionButtonStyle,
} from "@/lib/actionButtonStyle";
import { applyDensity, getStoredDensity } from "@/lib/density";
import { App } from "./App";
import { getVaultPath, reportNativeShellSmoke } from "@/lib/commands";
import "./styles/global.css";

// Apply the stored theme and design variant before first paint (the settings
// window owns the controls; this window re-applies on "settings-changed").
applyTheme(getStoredTheme());
applyDesign(getStoredDesignMode());
applyCardRadius(getStoredCardRadius());
applyActionButtonStyle(getStoredActionButtonStyle());
applyDensity(getStoredDensity());

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
        <div style={{ padding: 40, color: "#e4e4e4", background: "#0c0c0c", minHeight: "100vh", fontFamily: "monospace" }}>
          <h1 style={{ color: "#ff4444", marginBottom: 16 }}>Render Error</h1>
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
    const graphCardMatch = normalizedPath.match(/\/graph-audit\/thumbs\/graph-card-(\d+)\.jpg$/);
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

  if (auditRoute) {
    return AuditRoute ? <AuditRoute /> : null;
  }

  return <App />;
}

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
        <Root />
      </TooltipProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
