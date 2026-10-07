import { useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, MoreHorizontal, Plus, Settings2, X, type LucideIcon } from "lucide-react";
import { ActionButton } from "@/components/ActionButton";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { MineLogo } from "@/components/MineLogo";
import { SidebarToggleButton } from "@/components/SidebarToggleButton";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CONNECT_ACTION_BUTTON_CLASS, SIDEBAR_ROW_ACTION_BUTTON_PX } from "@/lib/appLayout";
import { commandById } from "@/lib/commandRegistry";
import { cn } from "@/lib/utils";
import { RETRO_DEPTH, type ButtonStyle, type Theme } from "./buttonsDecisionStyles";

// The decision page (`/__buttons-decision` on the dev server): the same slice
// of the window four times, light and dark, with macOS buttons and with the
// retro tile. Everything but the depth of the buttons is identical. Dev tool,
// nothing here is used by the app.

// Scale constants are equal in both themes; everything else on the root is
// copied into each cell so the themes sit side by side.
const SKIP_TOKEN_PREFIXES = ["--tw-", "--color-", "--font-", "--text-", "--spacing", "--radius", "--container", "--animate", "--ease", "--default-"];

/** Custom properties the stylesheet declares on the root, in any theme. */
function rootCustomProperties(): string[] {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && /:root|html/.test(rule.selectorText)) {
        for (const name of Array.from(rule.style)) {
          if (name.startsWith("--") && !SKIP_TOKEN_PREFIXES.some((prefix) => name.startsWith(prefix))) names.add(name);
        }
      }
      if ("cssRules" in rule && rule.cssRules) visit(rule.cssRules as CSSRuleList);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A sheet from another origin cannot be read; the app's own can.
    }
  }
  return [...names];
}

/** The root values of `theme`, read by switching the
 *  root for the moment of the read and back. */
function readThemeTokens(theme: Theme, names: readonly string[]): Record<string, string> {
  const root = document.documentElement;
  const previous = root.getAttribute("data-theme");
  root.setAttribute("data-theme", theme);
  const computed = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  if (previous === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", previous);
  return tokens;
}

const noop = () => undefined;

const chromeIcon = (label: string, Icon: LucideIcon | (() => ReactNode), props: Record<string, unknown> = {}) => (
  <Button type="button" variant="chrome" size="chrome-icon" aria-label={label} tooltip={false} {...props}>
    <Icon />
  </Button>
);

function TabBar() {
  const tab = "group/tab flex h-full w-36 min-w-0 items-center gap-1 pl-3 pr-1 text-sm";
  return (
    <div className="flex h-10 items-stretch border-b border-border bg-accent">
      <div className="flex shrink-0 items-center gap-1 pl-2 pr-1">
        <SidebarToggleButton collapsed={false} onToggle={noop} />
        {chromeIcon("Back", ChevronLeft)}
        {chromeIcon("Forward", ChevronRight)}
      </div>
      <div className={cn(tab, "bg-chrome text-foreground")}>
        <span className="min-w-0 flex-1 truncate">Mine</span>
        {chromeIcon("Close Tab", X)}
      </div>
      <div className={cn(tab, "text-muted-foreground hover:state-active hover:text-foreground")}>
        <span className="min-w-0 flex-1 truncate">Референсы</span>
      </div>
      <div className="flex items-center px-1">{chromeIcon("New Tab", Plus)}</div>
      <div className="ml-auto flex items-center pr-2">{chromeIcon("Mine settings", MineLogo)}</div>
    </div>
  );
}

const CONNECTED_PILL_CLASS = cn(buttonVariants({ variant: "reference", size: "xs" }), "pointer-events-none h-6 font-mono font-normal");

interface Row {
  name: string;
  end: ReactNode;
}

const ROWS: readonly Row[] = [
  {
    name: "Everything",
    end: (
      <span className={CONNECTED_PILL_CLASS} style={{ width: SIDEBAR_ROW_ACTION_BUTTON_PX }}>
        Connected
      </span>
    ),
  },
  {
    name: "Красивый веб",
    end: (
      <button type="button" className={CONNECT_ACTION_BUTTON_CLASS} style={{ width: SIDEBAR_ROW_ACTION_BUTTON_PX }}>
        Connect
      </button>
    ),
  },
  { name: "Типографика", end: <span className="font-mono text-sm">56</span> },
  { name: "Интерфейсы", end: <span className="font-mono text-sm">167</span> },
];

function Sidebar() {
  return (
    <div className="min-w-0 border-r border-sidebar-border bg-sidebar">
      <div className="flex h-10 items-center border-b border-border bg-sidebar">
        <div className="flex h-full min-w-0 shrink items-center pl-2 pr-1">
          <MenuTextTrigger label="Mine" showChevron />
        </div>
        <div aria-hidden="true" className="h-full w-px shrink-0 bg-border" />
        <Input
          aria-label="Filter collections"
          placeholder="Filter collections..."
          variant="ghost"
          className="h-full min-w-0 flex-1 rounded-0 bg-transparent px-3 py-0 font-mono text-sm text-muted-foreground placeholder:text-muted-foreground"
        />
        <div className="mr-2 flex shrink-0 items-center">
          <Button type="button" variant="chrome" size="chrome-icon" plate="raised" aria-label="New Collection" tooltip={false}>
            <Plus />
          </Button>
        </div>
      </div>
      {ROWS.map((row) => (
        <div
          key={row.name}
          className="group flex h-10 items-center gap-2 border-b border-sidebar-border px-3 font-sans text-base text-muted-foreground hover:text-foreground"
        >
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          <span className="flex shrink-0 justify-end">{row.end}</span>
        </div>
      ))}
    </div>
  );
}

const VIEW_OPTIONS = [
  { value: "grid", label: "Grid" },
  { value: "graph", label: "Graph" },
] as const;

const CARDS: ReadonlyArray<{ title: string; meta: string; image: string; buttons?: boolean }> = [
  { title: "Mac OS 9.2", meta: "apple.com", image: "/feed-scroll-audit/audit-0.svg" },
  { title: "NetHack.app", meta: "nethack.org", image: "/feed-scroll-audit/audit-2.svg", buttons: true },
  { title: "NCSA Mosaic", meta: "ncsa.illinois.edu", image: "/feed-scroll-audit/audit-4.svg" },
];

function Feed() {
  return (
    <div className="grid grid-cols-3 gap-2 bg-background p-2">
      {CARDS.map((card) => (
        <div key={card.title} className="relative min-w-0 overflow-hidden rounded-[var(--radius-card)] border border-border bg-card">
          <img src={card.image} alt="" className="block aspect-[4/3] w-full object-cover" />
          {card.buttons ? (
            <div className="absolute right-1.5 top-1.5 flex gap-1">
              <Button type="button" variant="raised" size="icon-xs" aria-label="Source" tooltip={false}>
                <ExternalLink />
              </Button>
              <Button type="button" variant="raised" size="icon-xs" aria-label="Connect" tooltip={false}>
                <Plus />
              </Button>
              <Button type="button" variant="raised" size="icon-xs" aria-label="Card actions" tooltip={false}>
                <MoreHorizontal />
              </Button>
            </div>
          ) : null}
          <div className="grid gap-0.5 px-2 py-1.5">
            <span className="truncate text-sm text-foreground">{card.title}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{card.meta}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Main() {
  return (
    <div className="flex min-w-0 flex-col bg-background">
      <div className="flex h-10 items-center gap-1 border-b border-border bg-chrome pl-2 pr-2">
        <MenuTextTrigger label="Everything" showChevron />
        <div className="ml-auto flex items-center gap-1">
          {chromeIcon("Display options", Settings2)}
          <Tabs value="grid" className="h-6 gap-0">
            <TabsList variant="chrome" aria-label="View mode">
              {VIEW_OPTIONS.map((option) => (
                <TabsTrigger key={option.value} value={option.value}>
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>
      <Feed />
    </div>
  );
}

function BottomPanel() {
  const toggleSidebar = commandById("toggle-sidebar");
  const switchCollection = commandById("switch-collection");
  return (
    <div className="flex h-9 items-center border-t border-border bg-accent px-1">
      <ActionButton chrome hotkey={toggleSidebar.combo} onClick={noop}>
        {toggleSidebar.name}
      </ActionButton>
      <ActionButton chrome hotkey={switchCollection.combo} readOnly>
        {switchCollection.name}
      </ActionButton>
      <ActionButton chrome hotkey="↵" isSelected onClick={noop}>
        Focus
      </ActionButton>
    </div>
  );
}

function Dialog() {
  return (
    <div className="ml-auto grid w-[340px] max-w-full gap-3 rounded-1 border border-border bg-popover p-4 text-popover-foreground shadow-lg">
      <div className="grid gap-1">
        <span className="text-base text-foreground">Delete 2 elements?</span>
        <span className="text-sm text-muted-foreground">Their files go to the Trash.</span>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary">Cancel</Button>
        <Button type="button">Keep One</Button>
        <Button type="button" variant="destructive">Delete</Button>
      </div>
    </div>
  );
}

const STYLE_TITLE: Readonly<Record<ButtonStyle, string>> = { macos: "macOS", retro: "Ретро-плитка" };
const THEME_TITLE: Readonly<Record<Theme, string>> = { light: "светлая тема", dark: "тёмная тема" };

function Cell({ style, theme, tokens }: { style: ButtonStyle; theme: Theme; tokens: Record<string, string> }) {
  // Custom properties have no keys in CSSProperties; these are custom
  // properties by construction.
  const depth = style === "retro" ? { "--button-depth": RETRO_DEPTH[theme] } : {};
  const cellStyle = { ...tokens, ...depth, colorScheme: theme } as CSSProperties;
  return (
    <figure className="grid min-w-0 content-start gap-2">
      <figcaption className="text-sm text-muted-foreground">
        {STYLE_TITLE[style]}, {THEME_TITLE[theme]}
      </figcaption>
      <div
        data-theme={theme}
        data-buttons-style={style}
        className="grid min-w-0 gap-3 rounded-1 border border-border bg-background p-3 text-foreground"
        style={cellStyle}
      >
        <div className="min-w-0 overflow-hidden rounded-1 border border-border">
          <TabBar />
          <div className="grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <Sidebar />
            <Main />
          </div>
          <BottomPanel />
        </div>
        <Dialog />
      </div>
    </figure>
  );
}

const THEMES: readonly Theme[] = ["light", "dark"];
const STYLES: readonly ButtonStyle[] = ["macos", "retro"];

export function ButtonsDecisionPage() {
  const [tokens] = useState(() => {
    const names = rootCustomProperties();
    return { light: readThemeTokens("light", names), dark: readThemeTokens("dark", names) };
  });
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-background text-foreground">
      <div className="grid max-w-[1400px] gap-6 p-4 sm:p-6">
        <header className="grid gap-1">
          <h1 className="text-lg text-foreground">Кнопки: macOS или ретро</h1>
          <p className="text-sm text-muted-foreground">Всё на странице одинаковое, различаются только кнопки.</p>
        </header>
        {THEMES.map((theme) => (
          <div key={theme} className="grid gap-4 min-[1100px]:grid-cols-2">
            {STYLES.map((style) => (
              <Cell key={style} style={style} theme={theme} tokens={tokens[theme]} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
