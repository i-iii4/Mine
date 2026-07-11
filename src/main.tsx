import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme, getStoredTheme } from "@/lib/themeMode";
import { applyDesign, getStoredDesignMode } from "@/lib/designMode";
import { App } from "./App";
import "./styles/global.css";

// Apply the stored theme and design variant before first paint (the settings
// window owns the controls; this window re-applies on "settings-changed").
applyTheme(getStoredTheme());
applyDesign(getStoredDesignMode());

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
const auditRoute = feedScrollAuditRoute ? "feed" : graphAuditRoute ? "graph" : null;

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
        : await import("./dev/GraphAuditRoute");
      if (!cancelled) {
        setAuditRoute(() => (
          "FeedScrollAuditRoute" in module
            ? module.FeedScrollAuditRoute
            : module.GraphAuditRoute
        ));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (auditRoute) {
    return AuditRoute ? <AuditRoute /> : null;
  }

  return <App />;
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
