import { useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle,
  AppWindow,
  Camera,
  Check,
  CheckIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronRightIcon,
  Cloud,
  CloudDownload,
  Columns2,
  Copy,
  Crop,
  Download,
  Edit3,
  Expand,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Minimize2,
  Minus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Unlink,
  X,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { ActionButton } from "@/components/ActionButton";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { MineLogo } from "@/components/MineLogo";
import { SidebarToggleButton } from "@/components/SidebarToggleButton";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CONNECT_ACTION_BUTTON_CLASS, SIDEBAR_ROW_ACTION_BUTTON_PX } from "@/lib/appLayout";
import { cn } from "@/lib/utils";

// Every button and icon the interface draws today, in both themes side by
// side (`/__ui-inventory` on the dev server). The samples are the app's own
// components and classes, so the page shows the current look; the inventory
// itself was read from the code on 04.10.2026 and lists where each is used.

type Theme = "light" | "dark";

// Scale constants are equal in both themes; everything else on the root is
// copied into each panel so light and dark sit next to each other.
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

/** The stylesheet's root values for `theme`, read by switching the root for
 *  the moment of the read and back. The button style chosen in the logo menu
 *  stays as it is, so the page shows the look in use. */
function readThemeTokens(theme: Theme, names: readonly string[]): CSSProperties {
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
  // Custom properties have no keys in CSSProperties; these are custom
  // properties by construction.
  return { ...tokens, colorScheme: theme } as CSSProperties;
}

interface Sample {
  /** What it is, in a few words. */
  name: string;
  /** Variant, size and glyph size. */
  spec: string;
  /** Where the interface uses it. */
  where: string;
  /** The app's zone class it sits on: sets the background and `--surface`. */
  zone: string;
  render: () => ReactNode;
}

interface Group {
  title: string;
  samples: readonly Sample[];
}

const noop = () => undefined;

const chromeIcon = (label: string, Icon: LucideIcon | (() => ReactNode), props: Record<string, unknown> = {}) => (
  <Button type="button" variant="chrome" size="chrome-icon" aria-label={label} tooltip={false} {...props}>
    <Icon />
  </Button>
);

const connectPlaque = (label: string, detach = false) => (
  <button
    type="button"
    className={cn(CONNECT_ACTION_BUTTON_CLASS, detach && "text-detach")}
    style={{ width: SIDEBAR_ROW_ACTION_BUTTON_PX }}
  >
    {label}
  </button>
);

const VIEW_OPTIONS = [
  { value: "grid", label: "Grid" },
  { value: "graph", label: "Graph" },
] as const;

const GROUPS: readonly Group[] = [
  {
    title: "Хром: значки",
    samples: [
      {
        name: "Боковое меню",
        spec: "chrome, chrome-icon 24 px, значок 13 px",
        where: "Полоса вкладок, слева после светофоров",
        zone: "bg-chrome",
        render: () => <SidebarToggleButton collapsed={false} onToggle={noop} />,
      },
      {
        name: "Назад и вперёд",
        spec: "chrome, chrome-icon 24 px, значок 13 px",
        where: "Полоса вкладок",
        zone: "bg-chrome",
        render: () => (
          <div className="flex">
            {chromeIcon("Back", ChevronLeft)}
            {chromeIcon("Forward", ChevronRight)}
          </div>
        ),
      },
      {
        name: "Закрыть вкладку, новая вкладка",
        spec: "chrome, chrome-icon 24 px, значок 13 px",
        where: "Полоса вкладок: крестик на вкладке и плюс после вкладок",
        zone: "bg-chrome",
        render: () => (
          <div className="flex">
            {chromeIcon("Close Tab", X)}
            {chromeIcon("New Tab", Plus)}
          </div>
        ),
      },
      {
        name: "Меню логотипа: в покое и открыто",
        spec: "chrome, chrome-icon 24 px, логотип 16 px",
        where: "Полоса вкладок, справа",
        zone: "bg-chrome",
        render: () => (
          <div className="flex gap-1">
            {chromeIcon("Mine settings", MineLogo)}
            {chromeIcon("Mine settings", MineLogo, { "data-state": "open" })}
          </div>
        ),
      },
      {
        name: "Поиск коллекций, очистка, новая коллекция",
        spec: "chrome-icon 24 px: объёмная, при наведении, объёмная",
        where: "Ряд фильтра над таблицей коллекций",
        zone: "bg-chrome",
        render: () => (
          <div className="flex gap-1">
            {chromeIcon("Filter collections", Search, { plate: "raised" })}
            {chromeIcon("Clear", X)}
            {chromeIcon("New Collection", Plus, { plate: "raised" })}
          </div>
        ),
      },
      {
        name: "Вид ленты, действия карточки, закрыть",
        spec: "chrome, chrome-icon 24 px, значок 13 px",
        where: "Ряд страницы: Display, ⋯ открытой карточки, крестик открытой карточки",
        zone: "bg-chrome",
        render: () => (
          <div className="flex gap-1">
            {chromeIcon("Display options", Settings2)}
            {chromeIcon("Card actions", MoreHorizontal)}
            {chromeIcon("Card actions", MoreHorizontal, { "data-state": "open" })}
            <ChromeCloseButton tooltip={false} />
          </div>
        ),
      },
      {
        name: "Новая коллекция в ряду страницы",
        spec: "chrome, chrome-icon 24 px, значок 13 px",
        where: "Ряд страницы, когда боковое меню скрыто",
        zone: "bg-chrome",
        render: () => chromeIcon("New Collection", Plus),
      },
    ],
  },
  {
    title: "Хром: текст и переключатели",
    samples: [
      {
        name: "Пространство и коллекция",
        spec: "текстовая подсветка, моноширинный 12 px, шеврон 13 px",
        where: "Верхний ряд: выбор пространства и коллекции",
        zone: "bg-chrome",
        render: () => (
          <div className="flex h-6 items-center gap-1">
            <MenuTextTrigger label="Mine" showChevron />
            <MenuTextTrigger label="Everything" showChevron data-state="open" />
          </div>
        ),
      },
      {
        name: "Вид: Grid и Graph",
        spec: "вкладки chrome, подложка всегда",
        where: "Ряд страницы справа, рядом с Display",
        zone: "bg-chrome",
        render: () => (
          <Tabs value="grid" className="h-6 gap-0">
            <TabsList variant="chrome" plate="always" aria-label="View mode">
              {VIEW_OPTIONS.map((option) => (
                <TabsTrigger key={option.value} value={option.value}>{option.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ),
      },
      {
        name: "Вид: Grid и Graph, ряд внизу",
        spec: "сегменты chrome",
        where: "Ряд метаданных, когда он стоит внизу окна",
        zone: "bg-chrome",
        render: () => <SegmentedControl chrome value="grid" options={[...VIEW_OPTIONS]} onChange={noop} aria-label="View mode" />,
      },
    ],
  },
  {
    title: "Карточка",
    samples: [
      {
        name: "Source, действия, Connect",
        spec: "raised, icon-xs 24 px, значок 13 px",
        where: "Кнопки карточки в ленте при наведении",
        zone: "bg-card",
        render: () => (
          <div className="flex gap-1">
            <Button type="button" variant="raised" size="icon-xs" aria-label="Source" tooltip={false}><ExternalLink /></Button>
            <Button type="button" variant="raised" size="icon-xs" aria-label="Card actions" tooltip={false}><MoreHorizontal /></Button>
            <Button type="button" variant="raised" size="icon-xs" aria-label="Card actions" tooltip={false} data-state="open"><MoreHorizontal /></Button>
            <Button type="button" variant="raised" size="icon-xs" aria-label="Connect" tooltip={false}><Plus /></Button>
          </div>
        ),
      },
      {
        name: "Source и Connect с текстом",
        spec: "default, 32 px, значок 13 px",
        where: "Ряд действий открытой карточки",
        zone: "bg-card",
        render: () => (
          <div className="flex gap-2">
            <Button type="button">Source<ExternalLink className="size-[13px]" /></Button>
            <Button type="button">Connect<Plus className="size-[13px]" /></Button>
          </div>
        ),
      },
      {
        name: "Медиа: развернуть и действия",
        spec: "default, icon 32 px, значок 13 px",
        where: "Картинка в открытой карточке",
        zone: "bg-card",
        render: () => (
          <div className="flex gap-1">
            <Button type="button" size="icon" aria-label="Expand image" tooltip={false}><Expand /></Button>
            <Button type="button" size="icon" aria-label="Media actions" tooltip={false}><MoreHorizontal /></Button>
            <Button type="button" size="icon" aria-label="Media actions" tooltip={false} data-state="open"><MoreHorizontal /></Button>
          </div>
        ),
      },
      {
        name: "Выделенный текст статьи",
        spec: "default xs 24 px, destructive xs, ghost icon 32 px",
        where: "Панель над выделенным текстом в открытой статье",
        zone: "bg-card",
        render: () => (
          <div className="flex items-center gap-1">
            <Button type="button" size="xs">New Element</Button>
            <Button type="button" size="xs" variant="destructive">Delete</Button>
            <Button type="button" size="icon" variant="ghost" aria-label="Clear text selection" tooltip={false}><X /></Button>
          </div>
        ),
      },
    ],
  },
  {
    title: "Плашка Connect",
    samples: [
      {
        name: "Connect, Connected, Disconnect",
        spec: "объёмная плашка 84 × 24 px, текст 12 px",
        where: "Строки коллекций в боковом меню",
        zone: "bg-sidebar",
        render: () => (
          <div className="flex gap-2">
            {connectPlaque("Connect")}
            {connectPlaque("Connected")}
            {connectPlaque("Disconnect", true)}
          </div>
        ),
      },
      {
        name: "Те же в выборе коллекций",
        spec: "объёмная плашка 84 × 24 px",
        where: "Меню Connect у карточки и в открытой карточке",
        zone: "bg-popover",
        render: () => (
          <div className="flex gap-2">
            {connectPlaque("Connect")}
            {connectPlaque("Connected")}
          </div>
        ),
      },
    ],
  },
  {
    title: "Нижняя панель",
    samples: [
      {
        name: "Клавиша с действием, справочная, выбранная",
        spec: "default xs 20 px моноширинный; справочная reference",
        where: "Нижняя панель окна",
        zone: "bg-chrome",
        render: () => (
          <div className="flex items-center">
            <ActionButton chrome hotkey="⌃⌘S" onClick={noop}>Sidebar</ActionButton>
            <ActionButton chrome hotkey="⌘K" readOnly>Switch</ActionButton>
            <ActionButton chrome hotkey="↵" isSelected onClick={noop}>Open</ActionButton>
          </div>
        ),
      },
    ],
  },
  {
    title: "Текстовые кнопки",
    samples: [
      {
        name: "Подтвердить, отменить, недоступно",
        spec: "default и secondary, 32 px; default disabled",
        where: "Диалоги: новая коллекция, переименование, слияние, импорт; экраны пространства",
        zone: "bg-popover",
        render: () => (
          <div className="flex gap-2">
            <Button type="button" variant="secondary">Cancel</Button>
            <Button type="button">Create</Button>
            <Button type="button" disabled>Create</Button>
          </div>
        ),
      },
      {
        name: "Удалить",
        spec: "destructive, 32 px",
        where: "Настройки: удаление медиа без карточек",
        zone: "bg-background",
        render: () => <Button type="button" variant="destructive">Delete</Button>,
      },
      {
        name: "Отмена в предупреждении",
        spec: "ghost с текстом, 32 px",
        where: "Предупреждения об удалении; импорт Are.na",
        zone: "bg-popover",
        render: () => <Button type="button" variant="ghost">Cancel</Button>,
      },
      {
        name: "Малые",
        spec: "default и secondary sm, 28 px",
        where: "Пометка первой карточки, рекомендация iCloud, экран недоступной папки, видео YouTube",
        zone: "bg-popover",
        render: () => (
          <div className="flex gap-2">
            <Button type="button" size="sm">Got it</Button>
            <Button type="button" size="sm" variant="secondary">Choose Folder</Button>
          </div>
        ),
      },
      {
        name: "Самые малые",
        spec: "default, secondary, destructive, ghost xs, 24 px, текст 12 px",
        where: "Действия выделенных карточек, конфликты имён, граф, импорт",
        zone: "bg-chrome",
        render: () => (
          <div className="flex items-center gap-2">
            <Button type="button" size="xs">Connect</Button>
            <Button type="button" size="xs" variant="secondary">Keep Both</Button>
            <Button type="button" size="xs" variant="destructive">Delete</Button>
            <Button type="button" size="xs" variant="ghost">Select All</Button>
          </div>
        ),
      },
      {
        name: "Сочетание клавиш и сброс",
        spec: "default xs 20 px моноширинный; secondary xs",
        where: "Настройки: сочетания клавиш",
        zone: "bg-background",
        render: () => (
          <div className="flex items-center gap-2">
            <Button type="button" size="xs" className="h-5 min-w-12 font-mono font-normal text-muted-foreground">⌘F</Button>
            <Button type="button" size="xs" variant="secondary" className="h-5">Reset</Button>
          </div>
        ),
      },
      {
        name: "Переключатель в настройках",
        spec: "сегменты, обычный размер",
        where: "Настройки: тема и углы карточек",
        zone: "bg-background",
        render: () => (
          <SegmentedControl
            value="system"
            options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "System" }]}
            onChange={noop}
            aria-label="Theme"
          />
        ),
      },
    ],
  },
  {
    title: "Значки без подложки",
    samples: [
      {
        name: "Просмотр картинки",
        spec: "ghost, icon 32 px, значок 13 px",
        where: "Полноэкранный просмотр: уменьшить, увеличить, копировать, свернуть",
        zone: "bg-background",
        render: () => (
          <div className="flex">
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" tooltip={false}><Minus /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" tooltip={false}><Plus /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Copy media" tooltip={false}><Copy /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Collapse" tooltip={false}><Minimize2 /></Button>
          </div>
        ),
      },
      {
        name: "Строка пространства, уведомление",
        spec: "ghost, icon-xs 24 px, значок 13 px",
        where: "Меню пространств: открыть, показать в Finder, убрать; крестик уведомления",
        zone: "bg-popover",
        render: () => (
          <div className="flex">
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Open in New Tab" tooltip={false}><Plus /></Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Reveal in Finder" tooltip={false}><FolderOpen /></Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove" tooltip={false}><X /></Button>
          </div>
        ),
      },
      {
        name: "Действия выделенных карточек",
        spec: "default, icon-xs 24 px; ghost icon 32 px",
        where: "Панель выделения: меню и сброс выделения",
        zone: "bg-chrome",
        render: () => (
          <div className="flex items-center gap-1">
            <Button type="button" size="icon-xs" aria-label="Selection actions" tooltip={false}><MoreHorizontal /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Clear selection" tooltip={false}><X /></Button>
          </div>
        ),
      },
    ],
  },
  {
    title: "Клиппер",
    samples: [
      {
        name: "Save",
        spec: "default clipper, 40 px; недоступна, пока сохранять нечего",
        where: "Клиппер, низ панели",
        zone: "bg-background",
        render: () => (
          <div className="grid w-[260px] gap-2">
            <Button type="button" size="clipper" className="w-full">Save</Button>
            <Button type="button" size="clipper" className="w-full" disabled>Save</Button>
          </div>
        ),
      },
      {
        name: "Снимок и меню",
        spec: "default sm 28 px; ghost icon-xs 24 px",
        where: "Клиппер: переснять, обрезать, меню панели",
        zone: "bg-background",
        render: () => (
          <div className="flex items-center gap-2">
            <Button type="button" size="sm"><Camera />Retake</Button>
            <Button type="button" size="sm"><Crop />Crop</Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="More" tooltip={false}><MoreHorizontal /></Button>
          </div>
        ),
      },
      {
        name: "Тип клипа и ссылка",
        spec: "сегменты; link",
        where: "Клиппер: Content, Screenshot, Link; настройка папки",
        zone: "bg-background",
        render: () => (
          <div className="flex items-center gap-3">
            <SegmentedControl
              value="content"
              options={[{ value: "content", label: "Content" }, { value: "screenshot", label: "Screenshot" }, { value: "link", label: "Link" }]}
              onChange={noop}
              aria-label="Type"
            />
            <Button type="button" variant="link">Learn more</Button>
          </div>
        ),
      },
    ],
  },
];

interface IconUse {
  Icon: LucideIcon | (() => ReactNode);
  name: string;
  /** Rendered size in px. */
  size: number;
}

interface IconGroup {
  title: string;
  icons: readonly IconUse[];
}

const ICON_GROUPS: readonly IconGroup[] = [
  {
    title: "Хром и полоса вкладок",
    icons: [
      { Icon: Columns2, name: "Columns2", size: 13 },
      { Icon: ChevronLeft, name: "ChevronLeft", size: 13 },
      { Icon: ChevronRight, name: "ChevronRight", size: 13 },
      { Icon: X, name: "X", size: 13 },
      { Icon: Plus, name: "Plus", size: 13 },
      { Icon: Search, name: "Search", size: 13 },
      { Icon: Settings2, name: "Settings2", size: 13 },
      { Icon: MoreHorizontal, name: "MoreHorizontal", size: 13 },
      { Icon: MineLogo, name: "MineLogo", size: 16 },
    ],
  },
  {
    title: "Карточки и их меню",
    icons: [
      { Icon: ExternalLink, name: "ExternalLink", size: 13 },
      { Icon: Plus, name: "Plus, Connect", size: 13 },
      { Icon: Unlink, name: "Unlink", size: 13 },
      { Icon: Trash2, name: "Trash2", size: 13 },
      { Icon: Pencil, name: "Pencil", size: 13 },
      { Icon: GripVertical, name: "GripVertical", size: 13 },
      { Icon: Cloud, name: "Cloud", size: 13 },
      { Icon: Plus, name: "Plus, строка «Create New Collection»", size: 16 },
    ],
  },
  {
    title: "Открытая карточка и просмотр",
    icons: [
      { Icon: Expand, name: "Expand", size: 13 },
      { Icon: Minus, name: "Minus", size: 13 },
      { Icon: Copy, name: "Copy", size: 13 },
      { Icon: Minimize2, name: "Minimize2", size: 13 },
      { Icon: CloudDownload, name: "CloudDownload", size: 13 },
    ],
  },
  {
    title: "Меню, пространства, состояния",
    icons: [
      { Icon: CheckIcon, name: "CheckIcon", size: 13 },
      { Icon: ChevronRightIcon, name: "ChevronRightIcon, подменю", size: 13 },
      { Icon: XIcon, name: "XIcon, закрыть диалог", size: 13 },
      { Icon: ChevronDown, name: "ChevronDown", size: 13 },
      { Icon: FolderOpen, name: "FolderOpen", size: 13 },
      { Icon: FolderPlus, name: "FolderPlus", size: 13 },
      { Icon: Download, name: "Download", size: 13 },
      { Icon: RefreshCw, name: "RefreshCw", size: 13 },
      { Icon: AlertTriangle, name: "AlertTriangle", size: 13 },
      { Icon: Check, name: "Check", size: 13 },
      { Icon: Edit3, name: "Edit3", size: 13 },
    ],
  },
  {
    title: "Клиппер",
    icons: [
      { Icon: Camera, name: "Camera", size: 13 },
      { Icon: Crop, name: "Crop", size: 13 },
      { Icon: AppWindow, name: "AppWindow", size: 13 },
    ],
  },
];

function ThemePanel({ theme, tokens, children }: { theme: Theme; tokens: CSSProperties; children: ReactNode }) {
  return (
    <div data-theme={theme} className="min-w-0 rounded-1 border border-border bg-background p-3 text-foreground" style={tokens}>
      {children}
    </div>
  );
}

function SampleRow({ sample, light, dark }: { sample: Sample; light: CSSProperties; dark: CSSProperties }) {
  const cell = (theme: Theme, tokens: CSSProperties) => (
    <ThemePanel theme={theme} tokens={tokens}>
      <div className={cn("inline-flex min-h-10 items-center rounded-1 px-3 py-2", sample.zone)}>{sample.render()}</div>
    </ThemePanel>
  );
  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_minmax(260px,1.4fr)_minmax(260px,1.4fr)] items-center gap-3">
      <div className="grid gap-0.5">
        <span className="text-sm text-foreground">{sample.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{sample.spec}</span>
        <span className="text-xs text-tertiary-foreground">{sample.where}</span>
      </div>
      {cell("light", light)}
      {cell("dark", dark)}
    </div>
  );
}

function IconRow({ group, light, dark }: { group: IconGroup; light: CSSProperties; dark: CSSProperties }) {
  const cell = (theme: Theme, tokens: CSSProperties) => (
    <ThemePanel theme={theme} tokens={tokens}>
      <div className="flex flex-wrap gap-x-4 gap-y-3">
        {group.icons.map(({ Icon, name, size }) => (
          <div key={`${name}-${size}`} className="grid justify-items-center gap-1">
            <span
              className="inline-flex size-6 items-center justify-center text-foreground [&>svg]:size-[var(--icon-size)] [&>svg]:shrink-0"
              // A custom property has no key in CSSProperties.
              style={{ "--icon-size": `${size}px` } as CSSProperties}
            >
              <Icon />
            </span>
            <span className="font-mono text-[10px] leading-3 text-muted-foreground">{name}</span>
            <span className="font-mono text-[10px] leading-3 text-tertiary-foreground">{size} px</span>
          </div>
        ))}
      </div>
    </ThemePanel>
  );
  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_minmax(260px,1.4fr)_minmax(260px,1.4fr)] items-start gap-3">
      <span className="pt-3 text-sm text-foreground">{group.title}</span>
      {cell("light", light)}
      {cell("dark", dark)}
    </div>
  );
}

export function UiInventoryPage() {
  const [tokens] = useState(() => {
    const names = rootCustomProperties();
    return { light: readThemeTokens("light", names), dark: readThemeTokens("dark", names) };
  });
  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="grid max-w-[1280px] gap-8 p-6">
        <header className="grid gap-1">
          <h1 className="text-lg text-foreground">Кнопки и значки интерфейса</h1>
          <p className="text-sm text-muted-foreground">
            Только то, что интерфейс рисует сейчас, настоящими компонентами, в натуральную величину. Слева что это и где, дальше светлая и тёмная тема.
          </p>
        </header>
        <section className="grid gap-6">
          <h2 className="text-base text-foreground">Кнопки</h2>
          {GROUPS.map((group) => (
            <div key={group.title} className="grid gap-3">
              <h3 className="text-sm text-muted-foreground">{group.title}</h3>
              {group.samples.map((sample) => (
                <SampleRow key={`${group.title}-${sample.name}`} sample={sample} light={tokens.light} dark={tokens.dark} />
              ))}
            </div>
          ))}
        </section>
        <section className="grid gap-4">
          <h2 className="text-base text-foreground">Значки</h2>
          {ICON_GROUPS.map((group) => (
            <IconRow key={group.title} group={group} light={tokens.light} dark={tokens.dark} />
          ))}
        </section>
      </div>
    </div>
  );
}
