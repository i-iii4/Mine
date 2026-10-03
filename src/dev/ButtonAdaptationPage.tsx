import { useState, type CSSProperties, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MineLogo } from "@/components/MineLogo";
import { applyTheme, getStoredTheme, type ThemeMode } from "@/lib/themeMode";
import { cn } from "@/lib/utils";
import { SHADCN_BUTTON_STYLES, type ShadcnButtonStyle } from "./shadcnButtonStyles";

// Buttons, as they are and as shadcn's secondary, outline and ghost would
// make them (`/__buttons` on the dev server). Nothing here is used by the
// app yet: the page is for choosing.

type RegistryVariant = "secondary" | "outline" | "ghost";
type RegistrySize = "icon-lg" | "icon" | "icon-sm" | "icon-xs" | "default";

function RegistryButton({
  look,
  variant,
  size,
  className,
  ...props
}: React.ComponentProps<"button"> & { look: ShadcnButtonStyle; variant: RegistryVariant; size: RegistrySize }) {
  return (
    <button
      type="button"
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(SHADCN_BUTTON_STYLES[look]({ variant, size }), className)}
      {...props}
    />
  );
}

// shadcn's theme radius, which Mine's theme does not carry: the originals
// round as the registry means them to.
const SHADCN_RADIUS = {
  "--radius": "0.625rem",
  "--radius-sm": "calc(var(--radius) - 4px)",
  "--radius-md": "calc(var(--radius) - 2px)",
  "--radius-lg": "var(--radius)",
  "--radius-xl": "calc(var(--radius) + 4px)",
} as CSSProperties;

// The adaptation: Nova's button (the registry's default style) with its
// colours and its behaviour as they are, the same tokens for fill, border
// and hover in either theme, the focus ring, the press that sinks it one
// pixel, the open-menu state. Only the measures are Mine's: 24px controls,
// 13px icons at a 1px line (a non-lucide glyph such as the logo at 16px),
// the 3px radius and the interface's 13px text.
const adaptedButtonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1 rounded-1 border border-transparent bg-clip-padding font-mono text-sm whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg.lucide]:size-[13px] [&_svg:not(.lucide)]:size-4",
  {
    variants: {
      // Nova's variants, word for word.
      variant: {
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
      },
      size: {
        icon: "size-6",
        text: "h-6 px-2",
      },
    },
    defaultVariants: { variant: "ghost", size: "icon" },
  },
);

type AdaptedVariant = NonNullable<VariantProps<typeof adaptedButtonVariants>["variant"]>;

function AdaptedButton({
  variant,
  size,
  className,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof adaptedButtonVariants>) {
  return <button type="button" className={cn(adaptedButtonVariants({ variant, size }), className)} {...props} />;
}

export function ButtonAdaptationPage() {
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme());
  const [look, setLook] = useState<ShadcnButtonStyle>("nova");
  const choose = (mode: ThemeMode) => {
    applyTheme(mode);
    setTheme(mode);
  };
  return (
    // The document never scrolls in this app (global.css): the page is its
    // own scrolling pane.
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="grid max-w-[1100px] gap-10 p-6">
        <header className="grid gap-3">
          <div className="flex gap-1">
            {(["system", "light", "dark"] as const).map((mode) => (
              <RegistryButton key={mode} look="nova" variant={theme === mode ? "secondary" : "ghost"} size="default" onClick={() => choose(mode)} style={SHADCN_RADIUS}>
                {mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}
              </RegistryButton>
            ))}
          </div>
          <h1 className="text-lg font-semibold">Кнопки: было и стало</h1>
          <p className="max-w-[720px] text-sm text-muted-foreground">
            Сверху оригинал из реестра shadcn, дословно, в пяти его стилях (по умолчанию Nova). Ниже адаптация трёх
            вариантов secondary, outline, ghost: цвета и поведение Nova без изменений (заливки, рамки, наведение,
            фокус, нажатие, открытое меню), наши только размеры. Дальше каждая группа кнопок интерфейса как сейчас и
            как стала бы.
          </p>
        </header>

        <Section title="Оригинал shadcn (реестр, дословно)">
          <div className="flex flex-wrap items-center gap-1">
            {(Object.keys(SHADCN_BUTTON_STYLES) as ShadcnButtonStyle[]).map((style) => (
              <RegistryButton key={style} look="nova" variant={look === style ? "secondary" : "ghost"} size="default" onClick={() => setLook(style)} style={SHADCN_RADIUS}>
                {style[0]?.toUpperCase() + style.slice(1)}
              </RegistryButton>
            ))}
          </div>
          <div className="grid gap-2" style={SHADCN_RADIUS}>
            <div className="flex flex-wrap gap-10">
              {(["secondary", "outline", "ghost"] as const).map((variant) => (
                <div key={variant} className="grid justify-items-start gap-2">
                  <div className="flex items-center gap-3">
                    {(["icon-lg", "icon", "icon-sm", "icon-xs"] as const).map((size) => (
                      <RegistryButton key={size} look={look} variant={variant} size={size} aria-label={`${variant} ${size}`}>
                        <ArrowRight />
                      </RegistryButton>
                    ))}
                    <RegistryButton look={look} variant={variant} size="default">Button</RegistryButton>
                  </div>
                  <span className="font-mono text-xs text-tertiary-foreground">{variant}</span>
                </div>
              ))}
            </div>
            <span className="font-mono text-xs text-tertiary-foreground">
              стиль {look}: icon-lg, icon, icon-sm, icon-xs и с текстом; нажатие опускает кнопку на 1 px
            </span>
          </div>
        </Section>

        <Section title="Адаптация: цвета и поведение Nova, наши размеры">
          <VariantGrid
            render={(variant) => (
              <>
                <AdaptedButton variant={variant} aria-label={`${variant} icon`}><ArrowRight /></AdaptedButton>
                <AdaptedButton variant={variant} size="text">Button</AdaptedButton>
              </>
            )}
            note="значок 24 × 24 и 13 px, текст 24 px высотой; радиус 3 px; нажатие опускает на 1 px"
          />
          <div className="grid gap-2">
            <span className="font-mono text-xs text-tertiary-foreground">на поверхностях интерфейса</span>
            <div className="flex flex-wrap gap-3">
              {[
                { label: "полоса вкладок", surface: "bg-accent" },
                { label: "хром", surface: "bg-chrome" },
                { label: "таблица", surface: "bg-sidebar" },
              ].map(({ label, surface }) => (
                <div key={label} className={cn("grid gap-2 rounded-1 border border-border p-3", surface)}>
                  <div className="flex items-center gap-2">
                    {(["secondary", "outline", "ghost"] as const).map((variant) => (
                      <AdaptedButton key={variant} variant={variant} aria-label={`${variant} on ${label}`}><Plus /></AdaptedButton>
                    ))}
                  </div>
                  <span className="font-mono text-xs text-tertiary-foreground">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Полоса вкладок: chrome → ghost">
          <BeforeAfter
            surface="bg-accent"
            before={
              <>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Sidebar"><PanelLeft /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Back"><ChevronLeft /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Forward"><ChevronRight /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Close Tab"><X /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="New Tab"><Plus /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Mine settings"><MineLogo /></Button>
              </>
            }
            after={
              <>
                {[PanelLeft, ChevronLeft, ChevronRight, X, Plus].map((Icon, index) => (
                  <AdaptedButton key={index} variant="ghost" aria-label={`ghost ${index}`}><Icon /></AdaptedButton>
                ))}
                <AdaptedButton variant="ghost" aria-label="Mine settings"><MineLogo /></AdaptedButton>
              </>
            }
          />
        </Section>

        <Section title="Ряд фильтра над таблицей: + → secondary, лупа и × → ghost">
          <BeforeAfter
            surface="bg-sidebar"
            before={
              <>
                <Button type="button" variant="chrome" size="chrome-icon" plate="always" aria-label="Filter collections"><Search /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Clear"><X /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" plate="always" aria-label="New Collection"><Plus /></Button>
              </>
            }
            after={
              <>
                <AdaptedButton variant="ghost" aria-label="Filter collections"><Search /></AdaptedButton>
                <AdaptedButton variant="ghost" aria-label="Clear"><X /></AdaptedButton>
                <AdaptedButton variant="secondary" aria-label="New Collection"><Plus /></AdaptedButton>
              </>
            }
          />
        </Section>

        <Section title="Ряд страницы: chrome → ghost">
          <BeforeAfter
            surface="bg-chrome"
            before={
              <>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Display options"><Settings2 /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Card actions"><MoreHorizontal /></Button>
                <Button type="button" variant="chrome" size="chrome-icon" aria-label="Close detail"><X /></Button>
              </>
            }
            after={
              <>
                <AdaptedButton variant="ghost" aria-label="Display options"><Settings2 /></AdaptedButton>
                <AdaptedButton variant="ghost" aria-label="Card actions"><MoreHorizontal /></AdaptedButton>
                <AdaptedButton variant="ghost" aria-label="Close detail"><X /></AdaptedButton>
              </>
            }
          />
        </Section>

        <Section title="Карточка: default → outline">
          <div className="flex flex-wrap gap-6">
            <CardMock label="Было: default icon-xs">
              <Button type="button" variant="default" size="icon-xs" aria-label="Source"><ExternalLink /></Button>
              <Button type="button" variant="default" size="icon-xs" aria-label="Card actions"><MoreHorizontal /></Button>
              <Button type="button" variant="default" size="icon-xs" aria-label="Connect"><Plus /></Button>
            </CardMock>
            <CardMock label="Стало: outline">
              <AdaptedButton variant="outline" aria-label="Source"><ExternalLink /></AdaptedButton>
              <AdaptedButton variant="outline" aria-label="Card actions"><MoreHorizontal /></AdaptedButton>
              <AdaptedButton variant="outline" aria-label="Connect"><Plus /></AdaptedButton>
            </CardMock>
            <CardMock label="Или: secondary">
              <AdaptedButton variant="secondary" aria-label="Source"><ExternalLink /></AdaptedButton>
              <AdaptedButton variant="secondary" aria-label="Card actions"><MoreHorizontal /></AdaptedButton>
              <AdaptedButton variant="secondary" aria-label="Connect"><Plus /></AdaptedButton>
            </CardMock>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function VariantGrid({ render, note }: { render: (variant: AdaptedVariant) => ReactNode; note: string }) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-10">
        {(["secondary", "outline", "ghost"] as const).map((variant) => (
          <div key={variant} className="grid justify-items-start gap-2">
            <div className="flex items-center gap-3">{render(variant)}</div>
            <span className="font-mono text-xs text-tertiary-foreground">{variant}</span>
          </div>
        ))}
      </div>
      <span className="font-mono text-xs text-tertiary-foreground">{note}</span>
    </div>
  );
}

function BeforeAfter({ surface, before, after }: { surface: string; before: ReactNode; after: ReactNode }) {
  return (
    <div className="grid gap-3">
      {[
        { label: "Было", content: before },
        { label: "Стало", content: after },
      ].map(({ label, content }) => (
        <div key={label} className="flex items-center gap-4">
          <span className="w-12 font-mono text-xs text-tertiary-foreground">{label}</span>
          <div className={cn("flex h-[31px] items-center gap-1 rounded-1 border border-border px-2", surface)}>{content}</div>
        </div>
      ))}
    </div>
  );
}

function CardMock({ label, children }: { label: string; children: ReactNode }) {
  const [source, more, connect] = Array.isArray(children) ? children : [children];
  return (
    <div className="grid gap-2">
      <div
        className="relative h-[170px] w-[230px] overflow-hidden rounded-1 border border-border"
        // A stand-in for a card's image: light and dark both under the buttons.
        style={{ background: "linear-gradient(135deg, #e9e4dc 0%, #b9b1a6 45%, #3f3a35 100%)" }}
      >
        <div className="absolute top-2 right-2 flex items-center gap-1">
          {source}
          {more}
        </div>
        <div className="absolute right-2 bottom-2">{connect}</div>
      </div>
      <span className="font-mono text-xs text-tertiary-foreground">{label}</span>
    </div>
  );
}
