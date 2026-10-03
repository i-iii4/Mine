import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Link, List, ListFilter, MoreHorizontal, Plus, Search, Settings2, X } from "lucide-react";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import { DetailLinkModeTabs } from "@/components/DetailLinkModeTabs";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { SidebarToggleButton } from "@/components/SidebarToggleButton";
import { MineLogo } from "@/components/MineLogo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChromeControl } from "@/components/ui/chrome-control";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fitShowsIcons, useSidebarRowFit, type SidebarRowFit } from "@/hooks/useSidebarRowFit";
import { applyTheme, getStoredTheme, type ThemeMode } from "@/lib/themeMode";
import { cn } from "@/lib/utils";
import type { DetailLinkMode } from "@/types";

// A page to compare versions of the sidebar's filter row side by side, at
// one sidebar width the person drags (settings, Top Bar Variants). Every
// version but the first fits the row by the same rule as the app
// (useSidebarRowFit.ts); they differ in the control that filters the
// collections by the open card.

const LONG_NAME = "irwin-contest-widget-prototype";
const SHORT_NAME = "Mine";

type ControlProps = {
  mode: DetailLinkMode;
  setMode: (mode: DetailLinkMode) => void;
  iconsOnly: boolean;
};

type Variant = {
  id: string;
  title: string;
  note: string;
  fits: boolean;
  control: (props: ControlProps) => ReactNode;
};

const VARIANTS: readonly Variant[] = [
  {
    id: "now",
    title: "1. Было: текстовый переключатель",
    note: "Текстовый переключатель, ряд не сжимается: при открытой карточке поле фильтра пропадает, «+» уезжает.",
    fits: false,
    control: ({ mode, setMode }) => (
      <SegmentedControl
        chrome
        value={mode}
        options={[
          { value: "all", label: "All" },
          { value: "linked", label: "Connected" },
        ]}
        onChange={setMode}
        aria-label="Collection filter"
      />
    ),
  },
  {
    id: "tabs",
    title: "2. Вкладки shadcn: подписи, при нехватке места иконки",
    note: "Так сейчас в приложении. Tabs из реестра shadcn в варианте chrome; подложки переключателя, «+» и лупы видны всегда. Сжатие: имя пространства, затем иконки List и Link, затем поле в лупу.",
    fits: true,
    control: ({ mode, setMode, iconsOnly }) => (
      <DetailLinkModeTabs value={mode} onChange={setMode} iconsOnly={iconsOnly} plate="always" />
    ),
  },
  {
    id: "tabs-icons",
    title: "3. Вкладки shadcn: всегда иконки",
    note: "Те же вкладки, но без подписей при любой ширине: ряд короче, смысл только в подсказке.",
    fits: true,
    control: ({ mode, setMode }) => (
      <Tabs value={mode} onValueChange={(next) => setMode(next === "linked" ? "linked" : "all")} className="h-full gap-0">
        <TabsList variant="chrome" aria-label="Collection filter">
          <TabsTrigger value="all" aria-label="All collections" className="w-5 px-0">
            <List aria-hidden="true" />
          </TabsTrigger>
          <TabsTrigger value="linked" aria-label="Connected collections" className="w-5 px-0">
            <Link aria-hidden="true" />
          </TabsTrigger>
        </TabsList>
      </Tabs>
    ),
  },
  {
    id: "toggle",
    title: "4. Одна кнопка-фильтр",
    note: "ListFilter переключает All и Connected; включённый фильтр держит подсветку.",
    fits: true,
    control: ({ mode, setMode }) => (
      <Button
        type="button"
        variant="chrome"
        size="chrome-icon"
        aria-label={mode === "linked" ? "Showing connected collections. Show all" : "Show connected collections"}
        aria-pressed={mode === "linked"}
        onClick={() => setMode(mode === "linked" ? "all" : "linked")}
        className={cn(mode === "linked" && "text-foreground [&_[data-chrome-plate]]:bg-active")}
      >
        <ListFilter />
      </Button>
    ),
  },
  {
    id: "menu",
    title: "5. Текстовое меню All ›",
    note: "Фильтр в грамматике ряда: текущее значение и стрелка, по щелчку меню. Одно слово вместо двух.",
    fits: true,
    control: ({ mode, setMode }) => (
      <TextMenuChoice value={mode} choices={LINK_MODE_CHOICES} onChange={setMode} title="Collection filter" />
    ),
  },
  {
    id: "switch",
    title: "6. Switch с подписью",
    note: "Switch chrome 24 × 14, круглый. При нехватке места подпись меняется на иконку Link.",
    fits: true,
    control: (props) => <SwitchControl {...props} shape="round" />,
  },
  {
    id: "switch-square",
    title: "7. Switch с подписью, квадратный",
    note: "То же на токенах скругления: дорожка 3 px, бегунок 2 px, как на референсе.",
    fits: true,
    control: (props) => <SwitchControl {...props} shape="square" />,
  },
];

function SwitchControl({ mode, setMode, shape }: ControlProps & { shape: "round" | "square" }) {
  const id = useId();
  return (
    <ChromeControl>
      <label htmlFor={id} className="inline-flex items-center gap-1.5 px-1 font-mono text-sm text-muted-foreground">
        <Switch
          id={id}
          size="chrome"
          shape={shape}
          checked={mode === "linked"}
          onCheckedChange={(checked) => setMode(checked ? "linked" : "all")}
          aria-label="Connected collections"
        />
        <span data-row-fit-label="">Connected</span>
        <Link aria-hidden="true" data-row-fit-icon="" className="size-[13px]" />
      </label>
    </ChromeControl>
  );
}

/** The page on its own, in a browser tab (`/__top-bar-variants` on the dev
 *  server): the page and a theme switch, nothing of the app around it. */
export function TopBarVariantsPage() {
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme());
  const choose = (mode: ThemeMode) => {
    applyTheme(mode);
    setTheme(mode);
  };
  return (
    // The document never scrolls in this app (global.css); the page is its
    // own scrolling pane, as the settings window's section pane is.
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="flex gap-1 px-6 pt-6">
        {(["system", "light", "dark"] as const).map((mode) => (
          <Button
            key={mode}
            type="button"
            variant={theme === mode ? "secondary" : "ghost"}
            size="sm"
            onClick={() => choose(mode)}
          >
            {mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}
          </Button>
        ))}
      </div>
      <TopBarVariants />
    </div>
  );
}

export function TopBarVariants() {
  const [width, setWidth] = useState(312);
  const [cardOpen, setCardOpen] = useState(true);
  const [longName, setLongName] = useState(true);
  const [tall, setTall] = useState(false);
  const widthId = useId();
  const cardId = useId();
  const nameId = useId();
  const tallId = useId();
  return (
    <div
      className="grid gap-8 p-6"
      data-top-bar-variants=""
      // The tall chrome's rows, here only (SPEC_TABS.md, В83).
      style={tall ? ({ "--chrome-row-content-height": "calc(var(--sidebar-row-height) - 1px)" } as CSSProperties) : undefined}
    >
      <header className="grid gap-1">
        <h1 className="text-lg font-semibold text-foreground">Верхний ряд бокового меню</h1>
        <p className="text-sm text-muted-foreground">
          Имя пространства, поле фильтра коллекций, фильтр по открытой карточке и «+». Тяни ширину и сравнивай.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-6 text-sm text-muted-foreground">
        <label htmlFor={widthId} className="flex items-center gap-3">
          Ширина меню
          <input
            id={widthId}
            type="range"
            min={200}
            max={480}
            value={width}
            onChange={(event) => setWidth(Number(event.target.value))}
            className="w-56"
          />
          <span className="w-14 font-mono text-foreground">{width} px</span>
        </label>
        <label htmlFor={cardId} className="flex items-center gap-2">
          <Switch id={cardId} size="chrome" checked={cardOpen} onCheckedChange={setCardOpen} />
          Карточка открыта
        </label>
        <label htmlFor={nameId} className="flex items-center gap-2">
          <Switch id={nameId} size="chrome" checked={longName} onCheckedChange={setLongName} />
          Длинное имя пространства
        </label>
        <label htmlFor={tallId} className="flex items-center gap-2">
          <Switch id={tallId} size="chrome" checked={tall} onCheckedChange={setTall} />
          Хром 40
        </label>
      </div>

      <MenusInsteadOfSwitches />

      {VARIANTS.map((variant) => (
        <VariantRow
          key={variant.id}
          variant={variant}
          width={width}
          cardOpen={cardOpen}
          name={longName ? LONG_NAME : SHORT_NAME}
        />
      ))}

      <UsedControls />
    </div>
  );
}

function VariantRow({
  variant,
  width,
  cardOpen,
  name,
}: {
  variant: Variant;
  width: number;
  cardOpen: boolean;
  name: string;
}) {
  const [mode, setMode] = useState<DetailLinkMode>("all");
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  // The first version shows the row as it is, unfitted: it gives the hook
  // no row to measure.
  const unfitted = useRef<HTMLElement | null>(null);
  const measured = useSidebarRowFit(variant.fits ? rowRef : unfitted, fieldRef, `${cardOpen}|${name}|${query !== ""}`);
  const fit: SidebarRowFit | null = variant.fits ? measured : null;
  const searchOpen = focused || query !== "";
  return (
    <section className="grid gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-base font-semibold text-foreground">{variant.title}</h2>
        {fit && <span className="font-mono text-xs text-tertiary-foreground">стадия: {fit}</span>}
      </div>
      <p className="max-w-[640px] text-sm text-muted-foreground">{variant.note}</p>
      <div className="overflow-hidden rounded-1 border border-border" style={{ width: width + 2 }}>
        <div className="chrome-row flex border-b border-border bg-chrome" data-chrome-separator="bottom">
          <div
            ref={rowRef}
            data-row-fit={fit ?? "full"}
            data-row-search-open={variant.fits && searchOpen ? "" : undefined}
            className="flex h-[var(--chrome-row-content-height)] min-w-0 flex-1"
          >
            <MenuTextTrigger
              label={name}
              surface="topChrome"
              showChevron
              data-row-fit-name={variant.fits ? "" : undefined}
              className="max-w-[50%] justify-start pr-[var(--top-collection-pad-x)] pl-[var(--top-collection-pad-x)]"
            />
            <div aria-hidden="true" className="h-full w-px shrink-0 bg-border" />
            <div className="flex h-full min-w-0 flex-1 items-center bg-sidebar">
              <Button
                type="button"
                variant="chrome"
                size="chrome-icon"
                aria-label="Filter collections"
                data-row-fit-search-button=""
                className="ml-2"
                plate={variant.id === "tabs" ? "always" : "hover"}
                onClick={() => fieldRef.current?.focus()}
              >
                <Search />
              </Button>
              <Input
                ref={fieldRef}
                aria-label="Filter collections"
                placeholder="Filter collections..."
                variant="ghost"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                data-row-fit-field=""
                className="h-full min-w-0 flex-1 rounded-0 bg-transparent px-3 py-0 font-mono text-sm text-muted-foreground placeholder:text-muted-foreground"
              />
              <div className="mr-2 flex shrink-0 items-center gap-1" data-row-fit-actions="">
                {cardOpen && variant.control({ mode, setMode, iconsOnly: fit !== null && fitShowsIcons(fit) })}
                <Button
                  type="button"
                  variant="chrome"
                  size="chrome-icon"
                  aria-label="New Collection"
                  plate={variant.id === "tabs" ? "always" : "hover"}
                >
                  <Plus />
                </Button>
              </div>
            </div>
          </div>
        </div>
        <div className="flex h-10 items-center bg-sidebar px-4 text-sm text-muted-foreground">
          {mode === "linked" ? "Connected collections" : "Everything"}
        </div>
      </div>
    </section>
  );
}

type PageRowKind = "before" | "tabs" | "menus";

const LINK_MODE_CHOICES: readonly MenuChoice<DetailLinkMode>[] = [
  { value: "all", label: "All", name: "All collections" },
  { value: "linked", label: "Connected", name: "Connected collections" },
];

const VIEW_CHOICES: readonly MenuChoice<"grid" | "graph">[] = [
  { value: "grid", label: "Grid", name: "Grid" },
  { value: "graph", label: "Graph", name: "Graph" },
];

type MenuChoice<T extends string> = { value: T; label: string; name: string };

/** A choice in the row's own grammar: the current value and a chevron, a
 *  menu of the values on click, as `Mine ›` and `Everything ›` are. */
function TextMenuChoice<T extends string>({
  value,
  choices,
  onChange,
  title,
}: {
  value: T;
  choices: readonly MenuChoice<T>[];
  onChange: (value: T) => void;
  title: string;
}) {
  const current = choices.find((choice) => choice.value === value) ?? choices[0];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <MenuTextTrigger
          label={current?.label ?? ""}
          surface="topChrome"
          showChevron
          aria-label={`${title}: ${current?.name ?? ""}`}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={4}>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const chosen = choices.find((choice) => choice.value === next);
            if (chosen) onChange(chosen.value);
          }}
        >
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>
              {choice.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The second chrome row of the main window with a card open: the
 *  sidebar's half and the content's half. `kind` picks how its two choices
 *  are drawn. */
function PageRow({ kind }: { kind: PageRowKind }) {
  const [view, setView] = useState<"grid" | "graph">("grid");
  const [mode, setMode] = useState<DetailLinkMode>("all");
  const plate = kind === "tabs" ? "always" : "hover";
  return (
    <div className="chrome-row flex h-[calc(var(--chrome-row-content-height)+1px)] items-center border-b border-border bg-chrome" data-chrome-separator="bottom">
      <div className="flex h-full w-[340px] shrink-0 items-center border-r border-sidebar-border">
        <MenuTextTrigger label="Mine" surface="topChrome" showChevron className="pr-[var(--top-collection-pad-x)] pl-[var(--top-collection-pad-x)]" />
        <div aria-hidden="true" className="h-full w-px shrink-0 bg-border" />
        <div className="flex h-full min-w-0 flex-1 items-center bg-sidebar">
          <span className="min-w-0 flex-1 truncate px-3 font-mono text-sm text-muted-foreground">Filter collections...</span>
          <div className="mr-2 flex shrink-0 items-center gap-1">
            {kind === "before" && (
              <SegmentedControl
                chrome
                value={mode}
                options={LINK_MODE_CHOICES.map(({ value, label }) => ({ value, label }))}
                onChange={setMode}
                aria-label="Collection filter"
              />
            )}
            {kind === "tabs" && <DetailLinkModeTabs value={mode} onChange={setMode} plate="always" />}
            {kind === "menus" && (
              <TextMenuChoice value={mode} choices={LINK_MODE_CHOICES} onChange={setMode} title="Collection filter" />
            )}
            <Button type="button" variant="chrome" size="chrome-icon" aria-label="New Collection" plate={plate}><Plus /></Button>
          </div>
        </div>
      </div>
      <div className="flex h-full min-w-0 flex-1 items-center gap-3">
        <MenuTextTrigger label="Everything" surface="topChrome" showChevron className="pl-[var(--top-collection-pad-x)]" />
        <span className="shrink-0 font-mono text-sm text-tertiary-foreground">657 elements</span>
        {kind === "menus" ? (
          <TextMenuChoice value={view} choices={VIEW_CHOICES} onChange={setView} title="View" />
        ) : (
          <>
            <span className="shrink-0 font-mono text-sm text-tertiary-foreground">View:</span>
            <SegmentedControl
              chrome
              value={view}
              options={VIEW_CHOICES.map(({ value, label }) => ({ value, label }))}
              onChange={setView}
              aria-label="View mode"
            />
          </>
        )}
        <div className="ml-auto flex items-center gap-1 pr-2">
          <Button type="button" variant="chrome" size="chrome-icon" aria-label="Display options"><Settings2 /></Button>
          <Button type="button" variant="chrome" size="chrome-icon" aria-label="Card actions"><MoreHorizontal /></Button>
          <ChromeCloseButton />
        </div>
      </div>
    </div>
  );
}

/** The three ways of the row side by side: as it was, as it is today, and
 *  with menus in place of the switches. */
function MenusInsteadOfSwitches() {
  return (
    <section className="grid gap-4" data-menus-instead-of-switches="">
      <h2 className="text-lg font-semibold text-foreground">Меню вместо переключателей</h2>
      <p className="max-w-[720px] text-sm text-muted-foreground">
        Ряд говорит одной грамматикой: текущее значение и стрелка, по щелчку меню (Mine ›, Everything ›), рядом иконки действий.
        Переключатель показывает все значения сразу и в эту грамматику не входит. В третьем ряду фильтр и вид стали такими же меню: All › и Grid ›.
      </p>
      <div className="grid gap-1">
        <span className="font-mono text-xs text-tertiary-foreground">Было: текстовый переключатель с плашкой</span>
        <PageRow kind="before" />
      </div>
      <div className="grid gap-1">
        <span className="font-mono text-xs text-tertiary-foreground">Сейчас: вкладки, подложки всегда</span>
        <PageRow kind="tabs" />
      </div>
      <div className="grid gap-1">
        <span className="font-mono text-xs text-tertiary-foreground">Предложение: меню All › и Grid ›</span>
        <PageRow kind="menus" />
      </div>
    </section>
  );
}

/** The buttons and switches the app draws in its main window's top rows and
 *  on its cards, as they stand there. */
function UsedControls() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="grid gap-6" data-used-controls="">
      <h2 className="text-lg font-semibold text-foreground">Кнопки и переключатели в интерфейсе</h2>

      <div className="grid gap-2">
        <h3 className="text-base font-semibold text-foreground">Полоса вкладок</h3>
        <div className="flex h-[calc(var(--chrome-row-content-height)+1px)] items-center border-y border-border bg-accent">
          <div className="flex h-full items-center gap-1 pr-2 pl-2">
            <SidebarToggleButton collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
            <Button type="button" variant="chrome" size="chrome-icon" aria-label="Back"><ChevronLeft /></Button>
            <Button type="button" variant="chrome" size="chrome-icon" aria-label="Forward"><ChevronRight /></Button>
          </div>
          <div className="relative flex h-full w-[200px] items-center border-x border-border bg-chrome pr-1 pl-3 font-mono text-sm text-foreground">
            <span className="min-w-0 flex-1 truncate">Mine</span>
            <Button type="button" variant="chrome" size="chrome-icon" aria-label="Close Tab"><X /></Button>
          </div>
          <div className="flex h-full items-center pr-1 pl-2">
            <Button type="button" variant="chrome" size="chrome-icon" aria-label="New Tab"><Plus /></Button>
          </div>
          <div className="ml-auto flex h-full items-center pr-2">
            <Button type="button" variant="chrome" size="chrome-icon" aria-label="Mine settings"><MineLogo /></Button>
          </div>
        </div>
        <p className="font-mono text-xs text-tertiary-foreground">боковое меню, назад, вперёд, закрыть вкладку, новая вкладка, логотип с меню</p>
      </div>

      <div className="grid gap-2">
        <h3 className="text-base font-semibold text-foreground">Ряд страницы</h3>
        <PageRow kind="tabs" />
        <p className="font-mono text-xs text-tertiary-foreground">пространство, поле фильтра, All / Connected при открытой карточке, новая коллекция; коллекция, число, View, Display, меню и закрытие открытой карточки</p>
      </div>

      <div className="grid gap-2">
        <h3 className="text-base font-semibold text-foreground">Карточка</h3>
        <div className="relative h-[180px] w-[240px] overflow-hidden rounded-1 border border-border bg-component-fill">
          <div className="absolute top-2 right-2 flex items-center gap-1">
            <Button type="button" variant="default" size="icon-xs" aria-label="Source"><ExternalLink aria-hidden="true" /></Button>
            <Button type="button" variant="default" size="icon-xs" aria-label="Card actions"><MoreHorizontal /></Button>
          </div>
          <div className="absolute right-2 bottom-2 flex items-center">
            <Button type="button" variant="default" size="icon-xs" aria-label="Connect"><Plus aria-hidden="true" /></Button>
          </div>
        </div>
        <p className="font-mono text-xs text-tertiary-foreground">при наведении: источник и меню карточки сверху, добавить в коллекцию снизу</p>
      </div>
    </section>
  );
}
