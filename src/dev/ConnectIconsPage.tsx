import { useState, type CSSProperties, type ReactNode } from "react";
import { MoreHorizontal, Plus, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONNECT_ACTION_BUTTON_CLASS, SIDEBAR_ROW_ACTION_BUTTON_PX } from "@/lib/appLayout";
import { cn } from "@/lib/utils";
import {
  CONNECT_PLACES,
  CURRENT_CONNECT,
  METAPHORS,
  PLUS_ELSEWHERE,
  type Metaphor,
  type NamedIcon,
} from "./connectIconData";

// Icon candidates for the Connect buttons, drawn in the places Connect has
// today with the app's own components, both themes side by side
// (`/__connect-icons` on the dev server). The choice is the person's; the page
// only shows.

type Theme = "light" | "dark";

// The theme reading follows `/__ui-inventory` (UiInventoryPage.tsx): root
// custom properties copied into each panel so the themes sit side by side.
const SKIP_TOKEN_PREFIXES = ["--tw-", "--color-", "--font-", "--text-", "--spacing", "--radius", "--container", "--animate", "--ease", "--default-"];

function rootCustomProperties(): string[] {
  const names = new Set<string>();
  const collect = (style: CSSStyleDeclaration) => {
    for (const name of Array.from(style)) {
      if (name.startsWith("--") && !SKIP_TOKEN_PREFIXES.some((prefix) => name.startsWith(prefix))) names.add(name);
    }
  };
  // A root rule that also holds nested rules keeps its later declarations in
  // CSSNestedDeclarations (the colour ladder does): those are root tokens too,
  // and without them a panel inherits the page theme's muted text.
  const visit = (rules: CSSRuleList, inRoot: boolean) => {
    for (const rule of Array.from(rules)) {
      const isRoot = rule instanceof CSSStyleRule && /:root|html/.test(rule.selectorText);
      const rootScope = isRoot || (inRoot && !(rule instanceof CSSStyleRule));
      if (rule instanceof CSSStyleRule && isRoot) collect(rule.style);
      if (rule instanceof CSSNestedDeclarations && rootScope) collect(rule.style);
      if ("cssRules" in rule && rule.cssRules) visit(rule.cssRules as CSSRuleList, rootScope);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules, false);
    } catch {
      // A sheet from another origin cannot be read; the app's own can.
    }
  }
  return [...names];
}

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

interface Tokens {
  light: CSSProperties;
  dark: CSSProperties;
}

// Layout values are inline: a class new to the dev server can miss its
// stylesheet until the stylesheet itself changes.
const ROW_GRID = "grid items-center gap-3";
const ROW_COLUMNS: CSSProperties = { gridTemplateColumns: "minmax(170px, 0.7fr) minmax(0, 1.5fr) minmax(0, 1.5fr)" };

function ThemePanel({ theme, tokens, children, className }: { theme: Theme; tokens: CSSProperties; children: ReactNode; className?: string }) {
  return (
    <div data-theme={theme} className={cn("min-w-0 rounded-1 border border-border bg-background p-2 text-foreground", className)} style={tokens}>
      {children}
    </div>
  );
}

/** A zone of the app: its class sets the background and `--surface`. */
function Zone({ zone, children, className }: { zone: string; children: ReactNode; className?: string }) {
  return <div className={cn("inline-flex items-center gap-1.5 rounded-1 px-2 py-1.5", zone, className)}>{children}</div>;
}

/** The card's hover Connect: raised, 24 px, glyph 13 px (CardHoverMenu.tsx). */
function CardConnect({ icon }: { icon: NamedIcon }) {
  return (
    <Button type="button" variant="raised" size="icon-xs" aria-label="Connect" tooltip={false}>
      <icon.Icon aria-hidden="true" />
    </Button>
  );
}

/** The open card's Connect: default, 32 px, word then glyph (Detail.tsx). */
function DetailConnect({ icon }: { icon: NamedIcon }) {
  return (
    <Button type="button" variant="default" size="default" style={{ width: 150 }} tooltip={false}>
      Connect
      <icon.Icon className="size-[13px]" />
    </Button>
  );
}

/** The sidebar row plaque with the glyph before the word (Sidebar.tsx). */
function SidebarPlaque({ icon, label, detach = false }: { icon?: NamedIcon; label: string; detach?: boolean }) {
  return (
    <button
      type="button"
      className={cn(CONNECT_ACTION_BUTTON_CLASS, "gap-1 [&>svg]:size-[13px] [&>svg]:shrink-0", detach && "text-detach")}
      style={{ minWidth: SIDEBAR_ROW_ACTION_BUTTON_PX }}
    >
      {icon && <icon.Icon aria-hidden="true" />}
      {label}
    </button>
  );
}

/** The sidebar's New Collection `+`: chrome icon on a raised plate (App.tsx). */
function NewCollectionPlus() {
  return (
    <Button type="button" variant="chrome" size="chrome-icon" plate="raised" aria-label="New Collection" tooltip={false}>
      <Plus />
    </Button>
  );
}

function CandidateCells({ icon }: { icon: NamedIcon }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Zone zone="bg-card">
        <Button type="button" variant="raised" size="icon-xs" aria-label="More" tooltip={false}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
        <CardConnect icon={icon} />
      </Zone>
      <Zone zone="bg-background" className="border border-border">
        <DetailConnect icon={icon} />
      </Zone>
      <Zone zone="bg-sidebar">
        <SidebarPlaque icon={icon} label="Connect" />
      </Zone>
      <Zone zone="bg-sidebar">
        <NewCollectionPlus />
        <CardConnect icon={icon} />
      </Zone>
    </div>
  );
}

function CandidateRow({ icon, tokens }: { icon: NamedIcon; tokens: Tokens }) {
  return (
    <div className={ROW_GRID} style={ROW_COLUMNS}>
      <span className="font-mono text-xs text-foreground">{icon.name}</span>
      <ThemePanel theme="light" tokens={tokens.light}>
        <CandidateCells icon={icon} />
      </ThemePanel>
      <ThemePanel theme="dark" tokens={tokens.dark}>
        <CandidateCells icon={icon} />
      </ThemePanel>
    </div>
  );
}

function StateCells({ group }: { group: Metaphor }) {
  const connect = group.connect[0];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Zone zone="bg-sidebar" className="flex-wrap">
        <SidebarPlaque icon={connect} label="Connect" />
        {(group.connected ?? []).map((icon) => (
          <SidebarPlaque key={icon.name} icon={icon} label="Connected" />
        ))}
        {(group.disconnect ?? []).map((icon) => (
          <SidebarPlaque key={icon.name} icon={icon} label="Disconnect" detach />
        ))}
      </Zone>
    </div>
  );
}

function IconNames({ label, icons }: { label: string; icons: readonly NamedIcon[] | undefined }) {
  if (!icons?.length) return null;
  return (
    <span className="text-xs text-muted-foreground">
      {label}: <span className="font-mono text-foreground">{icons.map((icon) => icon.name).join(", ")}</span>
    </span>
  );
}

function MetaphorSection({ group, tokens }: { group: Metaphor; tokens: Tokens }) {
  const hasStates = Boolean(group.connected?.length || group.disconnect?.length);
  return (
    <section className="grid gap-2">
      <div className="grid gap-0.5">
        <h3 className="text-sm text-foreground">{group.title}</h3>
        <p className="text-xs text-muted-foreground">{group.meaning}</p>
        {group.caveat && <p className="text-xs text-tertiary-foreground">{group.caveat}</p>}
        <div className="flex flex-wrap gap-x-4">
          <IconNames label="Подключена" icons={group.connected} />
          <IconNames label="Отключить" icons={group.disconnect} />
        </div>
      </div>
      {group.connect.map((icon) => (
        <CandidateRow key={icon.name} icon={icon} tokens={tokens} />
      ))}
      {hasStates && (
        <div className={ROW_GRID} style={ROW_COLUMNS}>
          <span className="text-xs text-muted-foreground">Пара состояний в боковом меню</span>
          <ThemePanel theme="light" tokens={tokens.light}>
            <StateCells group={group} />
          </ThemePanel>
          <ThemePanel theme="dark" tokens={tokens.dark}>
            <StateCells group={group} />
          </ThemePanel>
        </div>
      )}
    </section>
  );
}

const CURRENT: Metaphor = {
  title: "Сейчас",
  meaning: "ListPlus: карточку добавляют в список, которым коллекция стоит в боковом меню; голый плюс в Mine остаётся за созданием нового (New Collection, New Tab).",
  connect: [CURRENT_CONNECT],
  disconnect: [{ name: "Unlink", Icon: Unlink }],
};

// The current icon also stands in its metaphor's row; the grid shows it once.
const ALL_CONNECT_ICONS: readonly NamedIcon[] = [
  CURRENT_CONNECT,
  ...METAPHORS.flatMap((group) => group.connect).filter((icon) => icon.name !== CURRENT_CONNECT.name),
];

function MagnifiedGrid() {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))" }}>
      {ALL_CONNECT_ICONS.map((icon) => (
        <div key={icon.name} className="grid justify-items-center gap-1">
          <Zone zone="bg-card" className="p-2">
            {/* `zoom` scales layout too, so the button keeps its own proportions. */}
            <div style={{ zoom: 4 }}>
              <CardConnect icon={icon} />
            </div>
          </Zone>
          <span className="font-mono text-[10px] leading-3 text-muted-foreground">{icon.name}</span>
        </div>
      ))}
    </div>
  );
}

function PlaceList({ title, places }: { title: string; places: readonly { what: string; where: string }[] }) {
  return (
    <div className="grid content-start gap-1.5">
      <h2 className="text-sm text-foreground">{title}</h2>
      <ul className="grid gap-1">
        {places.map((place) => (
          <li key={place.where} className="grid gap-0.5">
            <span className="text-xs text-foreground">{place.what}</span>
            <span className="font-mono text-[10px] leading-3 text-tertiary-foreground">{place.where}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ConnectIconsPage() {
  const [tokens] = useState<Tokens>(() => {
    const names = rootCustomProperties();
    return { light: readThemeTokens("light", names), dark: readThemeTokens("dark", names) };
  });
  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="grid gap-6 p-6" style={{ maxWidth: 1400 }}>
        <header className="grid gap-1">
          <h1 className="text-lg text-foreground">Значок для Connect</h1>
          <p className="text-sm text-muted-foreground">
            Значки lucide по смыслу «связать карточку с коллекцией», сгруппированные по метафорам. Каждый нарисован настоящими компонентами на местах Connect в натуральную величину: кнопка карточки рядом с ⋯, кнопка открытой карточки, плашка бокового меню со значком перед словом и кнопка карточки рядом с New Collection. Слева светлая тема, справа тёмная. Ниже все кнопки карточки крупно, в 4 раза.
          </p>
          <p className="text-xs text-tertiary-foreground">
            Плашка бокового меню сейчас без значка, шириной {SIDEBAR_ROW_ACTION_BUTTON_PX} px. Со значком Connect помещается в {SIDEBAR_ROW_ACTION_BUTTON_PX} px, а Connected и Disconnect нет (93 и 95 px), здесь плашка растёт по содержимому.
          </p>
        </header>
        <div className="grid grid-cols-2 gap-6">
          <PlaceList title="Где Connect сейчас" places={CONNECT_PLACES} />
          <PlaceList title="Где плюс уже значит другое" places={PLUS_ELSEWHERE} />
        </div>
        <div className={ROW_GRID} style={ROW_COLUMNS}>
          <span />
          <span className="text-xs text-muted-foreground">Светлая</span>
          <span className="text-xs text-muted-foreground">Тёмная</span>
        </div>
        <MetaphorSection group={CURRENT} tokens={tokens} />
        {METAPHORS.map((group) => (
          <MetaphorSection key={group.title} group={group} tokens={tokens} />
        ))}
        <section className="grid gap-2">
          <h2 className="text-sm text-foreground">Кнопка карточки крупно, в 4 раза</h2>
          <div className="grid grid-cols-2 gap-3">
            <ThemePanel theme="light" tokens={tokens.light}>
              <MagnifiedGrid />
            </ThemePanel>
            <ThemePanel theme="dark" tokens={tokens.dark}>
              <MagnifiedGrid />
            </ThemePanel>
          </div>
        </section>
      </div>
    </div>
  );
}
