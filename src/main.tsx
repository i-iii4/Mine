import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App";
import "./styles/global.css";

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

type FeedScrollAuditTauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    convertFileSrc?: (filePath: string, protocol?: string) => string;
  };
};

function installFeedScrollAuditTauriMocks() {
  const tauriWindow = window as FeedScrollAuditTauriWindow;
  tauriWindow.__TAURI_INTERNALS__ = tauriWindow.__TAURI_INTERNALS__ ?? {};
  tauriWindow.__TAURI_INTERNALS__.convertFileSrc = (filePath, protocol = "asset") => {
    const normalizedPath = filePath.startsWith("//") ? filePath.slice(1) : filePath;
    if (normalizedPath.startsWith("/feed-scroll-audit/")) {
      return normalizedPath;
    }
    return `${protocol}://localhost/${encodeURIComponent(normalizedPath)}`;
  };
}

function Root() {
  const [FeedScrollAuditRoute, setFeedScrollAuditRoute] =
    React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    if (!feedScrollAuditRoute) return;
    let cancelled = false;
    void (async () => {
      installFeedScrollAuditTauriMocks();
      const module = await import("./dev/FeedScrollAuditRoute");
      if (!cancelled) {
        setFeedScrollAuditRoute(() => module.FeedScrollAuditRoute);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (feedScrollAuditRoute) {
    return FeedScrollAuditRoute ? <FeedScrollAuditRoute /> : null;
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
