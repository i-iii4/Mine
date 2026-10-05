import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  Columns2,
  Download,
  ExternalLink,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { ActionButton } from "@/components/ActionButton";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortalContainerProvider,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MenuIconSlot } from "@/components/ui/menu-icon-slot";
import type { Rgb } from "@/lib/colorLaw";
import { commandById } from "@/lib/commandRegistry";
import { cn } from "@/lib/utils";
import { describeFact, tokenLines, type Fact, type Readings } from "./textLadderData";

// The signal ladder of the dark theme (`/__text-ladder` on the dev server):
// app pieces drawn with the stylesheet's dark values, laid on a column that
// carries `data-theme="dark"`, so the stylesheet's ladder rule computes the
// steps inside it. Under each piece the page measures what it shows. Nothing
// here is used by the app.

type TokenMap = Record<string, string>;

const DARK_RULE = /^:root\[data-theme=["']?dark["']?\]$/;

/** Every custom property the stylesheet's dark rule sets. */
function darkTokenNames(): string[] {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && DARK_RULE.test(rule.selectorText.trim())) {
        for (const name of Array.from(rule.style)) {
          if (name.startsWith("--")) names.add(name);
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

/** The stylesheet's dark values, read by switching the root for the moment
 *  of the read and back. */
function readDarkTokens(): TokenMap {
  const names = darkTokenNames();
  const root = document.documentElement;
  const previous = root.getAttribute("data-theme");
  root.setAttribute("data-theme", "dark");
  const computed = getComputedStyle(root);
  const tokens: TokenMap = {};
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  if (previous === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", previous);
  return tokens;
}

function themeStyle(tokens: TokenMap): CSSProperties {
  // Custom properties have no keys in CSSProperties; these are custom
  // properties by construction.
  return { ...tokens, colorScheme: "dark" } as CSSProperties;
}

// ── Measuring the rendered colours ─────────────────────────────────────────

interface Sampler {
  /** Alpha of a CSS colour, 0..1; an unparsable colour reads as 0. */
  alpha(color: string): number;
  /** CSS colours painted bottom first, read back as one opaque pixel. */
  composite(layers: readonly string[]): Rgb | null;
}

function createSampler(): Sampler | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const paint = (color: string) => {
    // An unparsable colour leaves fillStyle as it was: start transparent.
    context.fillStyle = "rgba(0, 0, 0, 0)";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
  };
  const pixel = () => {
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a };
  };
  return {
    alpha(color) {
      context.clearRect(0, 0, 1, 1);
      paint(color);
      return pixel().a / 255;
    },
    composite(layers) {
      context.clearRect(0, 0, 1, 1);
      for (const layer of layers) paint(layer);
      const { r, g, b, a } = pixel();
      return a === 255 ? { r: r / 255, g: g / 255, b: b / 255 } : null;
    },
  };
}

/** The colour of a solid `linear-gradient(c, c)` layer: the state layer
 *  (`state-active`) paints itself that way. */
function gradientColor(image: string): string | null {
  const opening = "linear-gradient(";
  const start = image.indexOf(opening);
  if (start < 0) return null;
  const parts: string[] = [];
  let depth = 0;
  let from = start + opening.length;
  for (let index = from; index < image.length; index += 1) {
    const char = image[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) {
        parts.push(image.slice(from, index).trim());
        break;
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(image.slice(from, index).trim());
      from = index + 1;
    }
  }
  return parts.find((part) => !/^(to\s|[\d.]+(deg|turn|rad|grad)\b)/.test(part)) ?? null;
}

/** What lies under and on `from`, bottom first, down to the first opaque
 *  fill: the element's own fill and layer included. */
function layersUnder(from: Element, sampler: Sampler): string[] | null {
  const layers: string[] = [];
  for (let element: Element | null = from; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    const image = gradientColor(style.backgroundImage);
    if (image && sampler.alpha(image) > 0) layers.push(image);
    const alpha = sampler.alpha(style.backgroundColor);
    if (alpha > 0) layers.push(style.backgroundColor);
    if (alpha === 1) return layers.reverse();
  }
  return null;
}

/** What a probe reads: the visible fill, the text colour, a border side or
 *  the outline, each over what lies under it. */
type ProbeKind = "fill" | "text" | "border-bottom" | "border-right" | "outline";

function ink(style: CSSStyleDeclaration, kind: ProbeKind): string | null {
  switch (kind) {
    case "fill":
      return null;
    case "text":
      return style.color;
    case "border-bottom":
      return style.borderBottomColor;
    case "border-right":
      return style.borderRightColor;
    case "outline":
      return style.outlineColor;
  }
}

const PROBE_KINDS: ReadonlySet<string> = new Set(["fill", "text", "border-bottom", "border-right", "outline"]);

function isProbeKind(value: string | undefined): value is ProbeKind {
  return value !== undefined && PROBE_KINDS.has(value);
}

/** Every probe of a column. A probe marks an element (`data-probe`) or, with
 *  `data-probe-target`, an element inside it that the app's components draw
 *  and the page cannot tag. Null until every probe is in place. */
function measureColumn(root: HTMLElement, sampler: Sampler): Readings | null {
  const readings: Record<string, Rgb> = {};
  for (const holder of Array.from(root.querySelectorAll<HTMLElement>("[data-probe]"))) {
    const id = holder.dataset.probe;
    const kind = holder.dataset.probeKind;
    if (!id || !isProbeKind(kind)) return null;
    const selector = holder.dataset.probeTarget;
    const target = selector ? holder.querySelector(selector) : holder;
    if (!target) return null;
    const layers = layersUnder(target, sampler);
    if (!layers) return null;
    const top = ink(getComputedStyle(target), kind);
    const color = sampler.composite(top ? [...layers, top] : layers);
    if (!color) return null;
    readings[id] = color;
  }
  return readings;
}

/** Marks what a column measures. */
function probe(id: string, kind: ProbeKind, target?: string) {
  return { "data-probe": id, "data-probe-kind": kind, "data-probe-target": target };
}

/** A hidden stand-in in a text step, where the real text is drawn by the
 *  browser (a placeholder) and cannot be read. */
function TextProbe({ id, className }: { id: string; className: string }) {
  return <span hidden className={className} {...probe(id, "text")} />;
}

// ── Pieces of the app ──────────────────────────────────────────────────────

const ROW_PIECE = "rounded-1 border border-border";

function TabBarPiece() {
  const tab = "flex h-full min-w-0 items-center gap-2 px-3 text-sm";
  return (
    <div className="flex h-10 items-stretch border-b border-border bg-accent" {...probe("bar", "border-bottom")}>
      <span className="hidden" {...probe("barFill", "fill")} />
      <span className={cn(tab, "w-36 bg-chrome text-foreground")}>
        <span className="truncate">Mine. Длинное название</span>
      </span>
      <span className={cn(tab, "w-36 state-active text-foreground")} {...probe("tabHover", "fill")}>
        <span className="min-w-0 flex-1 truncate">Одежда</span>
        <X aria-hidden="true" className="size-[13px] shrink-0 text-muted-foreground" />
      </span>
      <span className={cn(tab, "w-36 text-muted-foreground hover:state-active hover:text-foreground")} {...probe("tabTitle", "text")}>
        <span className="truncate">Референсы</span>
      </span>
    </div>
  );
}

// An open menu laid out in the flow of its piece instead of floating: the
// popper's own position is overridden inside the host only.
const STATIC_MENU_CSS = `
[data-signal-menu-host] > [data-radix-popper-content-wrapper] {
  position: static !important;
  transform: none !important;
  min-width: 0 !important;
}
[data-signal-menu-host] > [data-radix-popper-content-wrapper] > [data-slot="dropdown-menu-content"] {
  max-height: none !important;
  animation: none !important;
}
`;

// The item under the pointer, drawn without the pointer: the classes the
// item takes on focus, applied directly.
const POINTED_ITEM_CLASS = "state-active text-foreground [&_svg:not([class*='text-'])]:text-foreground";

/** A menu shown open in the flow, so the page can read it. */
function StaticMenu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div className="grid justify-items-start gap-1">
      <DropdownMenuPortalContainerProvider container={host}>
        <DropdownMenu open={host !== null} modal={false}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align="start" {...probe("menu", "fill")}>
            {children}
          </DropdownMenuContent>
        </DropdownMenu>
      </DropdownMenuPortalContainerProvider>
      <div ref={setHost} data-signal-menu-host="" className="min-w-0 max-w-full" />
    </div>
  );
}

function SpaceMenuPiece() {
  return (
    <div className={cn(ROW_PIECE, "bg-chrome p-2")} {...probe("chrome", "fill")}>
      <StaticMenu
        trigger={
          <button
            type="button"
            className="state-active inline-flex h-7 max-w-full items-center gap-1 rounded-1 px-2 text-base text-foreground"
            {...probe("switcher", "fill")}
          >
            <span className="truncate">Mine. Длинное название</span>
            <ChevronDown aria-hidden="true" className="size-[13px] shrink-0" />
          </button>
        }
      >
        <div className="px-1 pb-1">
          <Input aria-label="Search spaces" placeholder="Search spaces..." className="h-8" />
          <TextProbe id="placeholder" className="text-tertiary-foreground" />
        </div>
        <div
          className={cn("flex h-8 items-center gap-1 rounded-1 px-2 text-base", POINTED_ITEM_CLASS)}
          {...probe("spaceRow", "fill")}
        >
          <span className="min-w-0 flex-1 truncate">irwin-contest-widget-prototype</span>
          {/* The row's actions are buttons of their own: their glyphs keep the
              secondary step on the highlighted row. */}
          <span className="inline-flex shrink-0 gap-1" {...probe("spaceRowIcons", "text", "svg")}>
            <Plus aria-hidden="true" className="size-[13px] text-muted-foreground" />
            <FolderOpen aria-hidden="true" className="size-[13px] text-muted-foreground" />
            <X aria-hidden="true" className="size-[13px] text-muted-foreground" />
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <MenuIconSlot>
            <FolderOpen className="size-[13px]" />
          </MenuIconSlot>
          Reveal in Finder
        </DropdownMenuItem>
        <DropdownMenuItem>
          <MenuIconSlot>
            <Plus className="size-[13px]" />
          </MenuIconSlot>
          Add space
        </DropdownMenuItem>
      </StaticMenu>
    </div>
  );
}

const SIDEBAR_ROWS: ReadonlyArray<{ name: string; count: number }> = [
  { name: "Красивый веб", count: 128 },
  { name: "Типографика", count: 56 },
  { name: "Одежда", count: 0 },
];

function SidebarPiece() {
  return (
    <div className="flex rounded-1 border border-border">
      <div className="min-w-0 flex-1 border-r border-sidebar-border bg-sidebar px-3" {...probe("sidebarLine", "border-right")}>
        <span className="hidden" {...probe("sidebar", "fill")} />
        {SIDEBAR_ROWS.map((row, index) => (
          <div
            key={row.name}
            className="group flex min-h-[var(--sidebar-row-height)] items-center pb-px font-sans text-base text-muted-foreground hover:text-foreground"
          >
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <span
              className="w-8 shrink-0 text-right font-mono text-sm text-muted-foreground group-hover:text-foreground"
              {...(index === 0 ? probe("count", "text") : {})}
            >
              {row.count}
            </span>
          </div>
        ))}
      </div>
      <div className="w-12 shrink-0 bg-background" />
    </div>
  );
}

interface ChromeGlyph {
  label: string;
  Icon: LucideIcon;
}

const CHROME_GLYPHS: readonly ChromeGlyph[] = [
  { label: "Hide Sidebar", Icon: Columns2 },
  { label: "Back", Icon: ChevronLeft },
  { label: "Search", Icon: Search },
  { label: "Card actions", Icon: MoreHorizontal },
];

/** A chrome icon button; `hovered` shows the hover look without the
 *  pointer: the open menu state, which by the rule looks the same. */
function ChromeIcon({ glyph, hovered = false, probeId }: { glyph: ChromeGlyph; hovered?: boolean; probeId?: string }) {
  const { Icon } = glyph;
  return (
    <Button
      type="button"
      variant="chrome"
      size="chrome-icon"
      aria-label={glyph.label}
      tooltip={false}
      data-state={hovered ? "open" : undefined}
      {...(probeId ? probe(probeId, hovered ? "fill" : "text", hovered ? "[data-plate]" : undefined) : {})}
    >
      <Icon />
    </Button>
  );
}

function ChromeIconsPiece() {
  return (
    <div className={cn(ROW_PIECE, "flex flex-wrap items-center gap-x-3 bg-chrome px-1 py-1")} {...probe("chromeIcons", "fill")}>
      {CHROME_GLYPHS.map((glyph, index) => (
        <span key={glyph.label} className="inline-flex">
          <ChromeIcon glyph={glyph} probeId={index === 0 ? "iconRest" : undefined} />
          <ChromeIcon glyph={glyph} hovered probeId={index === 0 ? "iconPlate" : undefined} />
        </span>
      ))}
    </div>
  );
}

function CardMenuPiece() {
  return (
    <div className={cn(ROW_PIECE, "bg-background p-2")}>
      <StaticMenu
        trigger={
          <Button type="button" variant="chrome" size="chrome-icon" aria-label="Card actions" tooltip={false}>
            <MoreHorizontal />
          </Button>
        }
      >
        <DropdownMenuItem className={POINTED_ITEM_CLASS} {...probe("itemHover", "fill")}>
          <MenuIconSlot>
            <ExternalLink className="size-[13px]" />
          </MenuIconSlot>
          Source
        </DropdownMenuItem>
        <DropdownMenuItem {...probe("itemIcon", "text", "svg")}>
          <MenuIconSlot>
            <Plus className="size-[13px]" />
          </MenuIconSlot>
          Connect
        </DropdownMenuItem>
        <DropdownMenuItem disabled {...probe("itemDisabled", "text")}>
          <MenuIconSlot>
            <Download className="size-[13px]" />
          </MenuIconSlot>
          Download Media
        </DropdownMenuItem>
      </StaticMenu>
    </div>
  );
}

function BottomPanelPiece() {
  const toggleSidebar = commandById("toggle-sidebar");
  const switchCollection = commandById("switch-collection");
  const settings = commandById("settings");
  return (
    <div className={cn(ROW_PIECE, "flex flex-wrap items-center gap-y-1 bg-accent px-2 py-1")} {...probe("panel", "fill")}>
      <span className="inline-flex" {...probe("keyLabel", "text", "[data-action-button] > span:last-child")}>
        <span className="inline-flex" {...probe("keyFace", "fill", "[data-action-button] > span:first-child")}>
          <ActionButton chrome hotkey={toggleSidebar.combo}>
            {toggleSidebar.name}
          </ActionButton>
        </span>
      </span>
      <span className="inline-flex" {...probe("refFrame", "outline", "[data-action-button] > span:first-child")}>
        <ActionButton chrome hotkey={switchCollection.combo} readOnly>
          {switchCollection.name}
        </ActionButton>
      </span>
      <span className="inline-flex" {...probe("selectedFace", "fill", "[data-action-button] > span:first-child")}>
        <ActionButton chrome hotkey={settings.combo} isSelected>
          {settings.name}
        </ActionButton>
      </span>
    </div>
  );
}

function FieldPiece() {
  return (
    <div className={cn(ROW_PIECE, "grid gap-2 bg-background p-2")} {...probe("page", "fill")}>
      <Input aria-label="Пустое поле" placeholder="Filter collections..." />
      <TextProbe id="fieldPlaceholder" className="text-tertiary-foreground" />
    </div>
  );
}

const CONNECTED_PILL_CLASS = cn(buttonVariants({ variant: "reference", size: "xs" }), "pointer-events-none h-6 font-mono font-normal");

function DisabledPiece() {
  return (
    <div className={cn(ROW_PIECE, "flex flex-wrap items-center gap-3 bg-sidebar p-2")} {...probe("disabledGround", "fill")}>
      <Button type="button" disabled {...probe("disabledFrame", "outline")}>
        Connect
      </Button>
      <span className="inline-flex" {...probe("disabledText", "text", "button")}>
        <Button type="button" variant="secondary" disabled>
          Switch collection
        </Button>
      </span>
      <span className="inline-flex" {...probe("pillText", "text", "span")}>
        <span className={CONNECTED_PILL_CLASS} {...probe("pillFrame", "outline")}>
          Connected
        </span>
      </span>
    </div>
  );
}

function FocusPiece() {
  return (
    <div className={cn(ROW_PIECE, "flex items-center gap-3 bg-background p-2")} {...probe("focusGround", "fill")}>
      <Button type="button" variant="secondary" className="outline-1 -outline-offset-1 outline-ring" {...probe("ring", "outline")}>
        Settings
      </Button>
      <Button type="button" variant="secondary">
        Display
      </Button>
    </div>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

interface Sample {
  id: string;
  title: string;
  facts: readonly Fact[];
  Piece: () => ReactNode;
}

const SAMPLES: readonly Sample[] = [
  {
    id: "tabs",
    title: "Полоса вкладок: вкладка под указателем, выбранная вкладка слева",
    Piece: TabBarPiece,
    facts: [
      { label: "подложка вкладки под указателем", probe: "tabHover", against: "barFill" },
      { label: "название обычной вкладки", probe: "tabTitle", against: "barFill", text: true },
      { label: "линия под полосой", probe: "bar", against: "barFill" },
    ],
  },
  {
    id: "space",
    title: "Пространство: меню открыто, строка под указателем",
    Piece: SpaceMenuPiece,
    facts: [
      { label: "кнопка с открытым меню", probe: "switcher", against: "chrome" },
      { label: "строка под указателем", probe: "spaceRow", against: "menu" },
      { label: "значки в строке", probe: "spaceRowIcons", against: "spaceRow", text: true },
      { label: "подсказка в поле поиска", probe: "placeholder", against: "menu", text: true },
    ],
  },
  {
    id: "sidebar",
    title: "Боковое меню: названия и числа коллекций, наведи на строку",
    Piece: SidebarPiece,
    facts: [
      { label: "числа и названия", probe: "count", against: "sidebar", text: true },
      { label: "линия бокового меню", probe: "sidebarLine", against: "sidebar" },
    ],
  },
  {
    id: "chrome",
    title: "Значки хрома: каждый дважды, в покое и при наведении",
    Piece: ChromeIconsPiece,
    facts: [
      { label: "подложка под значком при наведении", probe: "iconPlate", against: "chromeIcons" },
      { label: "значок в покое", probe: "iconRest", against: "chromeIcons", text: true },
    ],
  },
  {
    id: "menu",
    title: "Меню карточки: Source под указателем, Download Media недоступен",
    Piece: CardMenuPiece,
    facts: [
      { label: "пункт под указателем", probe: "itemHover", against: "menu" },
      { label: "значок пункта в покое", probe: "itemIcon", against: "menu", text: true },
      { label: "недоступный пункт", probe: "itemDisabled", against: "menu", text: true },
    ],
  },
  {
    id: "panel",
    title: "Нижняя панель: обычная клавиша, справочная Switch collection, выбранная Settings",
    Piece: BottomPanelPiece,
    facts: [
      { label: "подписи клавиш", probe: "keyLabel", against: "panel", text: true },
      { label: "рамка справочной клавиши", probe: "refFrame", against: "panel" },
      { label: "выбранная клавиша рядом с обычной", probe: "selectedFace", against: "keyFace" },
    ],
  },
  {
    id: "field",
    title: "Поле с подсказкой",
    Piece: FieldPiece,
    facts: [{ label: "подсказка в поле", probe: "fieldPlaceholder", against: "page", text: true }],
  },
  {
    id: "disabled",
    title: "Недоступные кнопки и пилюля Connected в боковом меню",
    Piece: DisabledPiece,
    facts: [
      { label: "рамка недоступной кнопки", probe: "disabledFrame", against: "disabledGround" },
      { label: "текст недоступной кнопки", probe: "disabledText", against: "disabledGround", text: true },
      { label: "текст пилюли Connected", probe: "pillText", against: "disabledGround", text: true },
      { label: "рамка пилюли Connected", probe: "pillFrame", against: "disabledGround" },
    ],
  },
  {
    id: "focus",
    title: "Фокус с клавиатуры: Settings в фокусе, Display без него",
    Piece: FocusPiece,
    facts: [{ label: "обводка фокуса", probe: "ring", against: "focusGround" }],
  },
];

function Column({ onMeasured, children }: { onMeasured: (readings: Readings) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sampler = createSampler();
    if (!sampler) return;
    let frame = 0;
    let attempts = 0;
    // An open menu mounts a frame or two after the column: try again until
    // every probe is in place.
    const attempt = () => {
      const root = ref.current;
      const readings = root ? measureColumn(root, sampler) : null;
      attempts += 1;
      if (readings) onMeasured(readings);
      else if (attempts < 120) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [onMeasured]);
  return (
    <div ref={ref} data-theme="dark" className="min-w-0 max-w-[600px] bg-background text-foreground">
      {children}
    </div>
  );
}

function SampleRow({ sample }: { sample: Sample }) {
  const [readings, setReadings] = useState<Readings | null>(null);
  const onMeasured = useCallback((value: Readings) => setReadings(value), []);
  const { Piece } = sample;
  return (
    <section className="grid gap-2" data-signal-sample={sample.id}>
      <h2 className="text-base text-foreground">{sample.title}</h2>
      <Column onMeasured={onMeasured}>
        <Piece />
      </Column>
      <div className="grid gap-0.5 text-sm" data-signal-caption={sample.id}>
        <p className="text-foreground">Что смотреть:</p>
        {sample.facts.map((fact) => (
          <p key={fact.probe} className="font-mono text-xs text-muted-foreground">
            {(readings && describeFact(fact, readings)) ?? `${fact.label}: измеряется`}
          </p>
        ))}
      </div>
    </section>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function TextLadderPage() {
  const [tokens] = useState<TokenMap>(readDarkTokens);
  const style = themeStyle(tokens);
  return (
    // The document never scrolls in this app (global.css): the page is its
    // own scrolling pane, dark as a whole.
    <div data-theme="dark" className="h-full overflow-y-auto overflow-x-hidden bg-background text-foreground" style={style}>
      <style>{STATIC_MENU_CSS}</style>
      <div className="grid gap-8" style={{ maxWidth: 1200, padding: "clamp(16px, 3vw, 24px)" }}>
        <header className="grid gap-2">
          <h1 className="text-lg text-foreground">Сигналы в тёмной теме</h1>
          <p className="text-sm text-muted-foreground">
            Светлая тема эталон, тёмная выведена из неё по форме сигнала: разница с фоном в тёмной теме равна светлой,
            делённой на 0,7 у линий, рамок и текста и на 0,51 у площадей (SPEC_COLOR_RULES.md).
          </p>
          <div className="grid gap-0.5 font-mono text-xs text-muted-foreground" data-signal-tokens="">
            {tokenLines(tokens).map((line) => (
              <p key={line.names.join(" ")}>
                {line.names.join(", ")}: {line.value || "не задан"}
              </p>
            ))}
          </div>
        </header>
        {SAMPLES.map((sample) => (
          <SampleRow key={sample.id} sample={sample} />
        ))}
      </div>
    </div>
  );
}
