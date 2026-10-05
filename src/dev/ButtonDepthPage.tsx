import { useState, type CSSProperties } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEPTH_APPROACHES, type DepthApproach, type DepthLayers } from "./buttonDepthApproaches";

// Our button volume next to the Mac ones, side by side in both themes
// (`/__button-depth` on the dev server). Nothing here is used by the app: the
// samples are drawn with inline styles from the audit data, on the app's own
// zone classes so `--surface` resolves as in the app.

type Theme = "light" | "dark";

// The theme tokens the panels need. The stylesheet defines them on the root
// for one theme at a time; each panel carries both themes' values itself so
// light and dark sit next to each other.
const TOKEN_NAMES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--chrome",
  "--accent",
  "--accent-foreground",
  "--muted-foreground",
  "--tertiary-foreground",
  "--border",
  "--sidebar",
  "--popover",
  "--muted-alpha",
  "--tertiary-alpha",
  // The hover share: the light face of a button is built as a hover plate.
  "--active-alpha",
] as const;

/** The stylesheet's token values for `theme`, read by switching the root for
 *  the moment of the read and back. */
function readThemeTokens(theme: Theme): CSSProperties {
  const root = document.documentElement;
  const previous = root.getAttribute("data-theme");
  root.setAttribute("data-theme", theme);
  const computed = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of TOKEN_NAMES) tokens[name] = computed.getPropertyValue(name).trim();
  if (previous === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", previous);
  // Custom properties have no keys in CSSProperties; these are custom
  // properties by construction.
  return { ...tokens, colorScheme: theme } as CSSProperties;
}

interface Surface {
  key: string;
  label: string;
  /** The app's zone class: sets the background and `--surface`. */
  zone: string;
}

const CARD_SURFACE: Surface = { key: "card", label: "Карточка", zone: "bg-card" };

const APP_SURFACES: readonly Surface[] = [
  { key: "page", label: "Страница", zone: "bg-background" },
  CARD_SURFACE,
  { key: "chrome", label: "Хром", zone: "bg-chrome" },
  { key: "accent", label: "Акцент", zone: "bg-accent" },
];

/** The state layer a hover lays over a face (the app's `--active`). */
const HOVER_LAYER = "linear-gradient(var(--active), var(--active))";

function layersStyle(layers: DepthLayers, hovered = false): CSSProperties {
  let face: CSSProperties;
  if (layers.backgroundImage) {
    face = { backgroundColor: layers.background, backgroundImage: hovered ? `${HOVER_LAYER}, ${layers.backgroundImage}` : layers.backgroundImage };
  } else if (layers.background.includes("padding-box")) {
    // A layered face with its ring in the border: the hover lies over the
    // whole button, so the ring rises with the face (Linear).
    face = { background: hovered ? `${HOVER_LAYER} border-box, ${layers.background}` : layers.background };
  } else {
    face = hovered ? { backgroundColor: layers.background, backgroundImage: HOVER_LAYER } : { background: layers.background };
  }
  // Edges that rise with the face (macOS) have their own hover value.
  const boxShadow = hovered && layers.boxShadowHover ? layers.boxShadowHover : layers.boxShadow;
  return {
    ...face,
    ...(boxShadow ? { boxShadow } : {}),
    ...(layers.border ? { border: layers.border } : {}),
    ...(layers.radius ? { borderRadius: layers.radius } : {}),
  };
}

function PlusSample({ layers }: { layers: DepthLayers }) {
  return (
    <button
      type="button"
      aria-label="Пример кнопки с плюсом"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-1 text-foreground"
      style={layersStyle(layers)}
    >
      <Plus className="size-[13px]" aria-hidden="true" />
    </button>
  );
}

function ConnectSample({ layers, hovered = false }: { layers: DepthLayers; hovered?: boolean }) {
  return (
    <button
      type="button"
      title={hovered ? "При наведении" : undefined}
      className="inline-flex h-6 w-[84px] shrink-0 items-center justify-center rounded-1 px-[1ch] font-sans text-sm font-normal text-foreground"
      style={layersStyle(layers, hovered)}
    >
      {hovered ? "Hover" : "Connect"}
    </button>
  );
}

/** A chrome icon button's hover plate as the app paints it (state layer over
 *  the zone), so the face of a button can be measured against it on the same
 *  zone. */
function HoverPlateSample() {
  return (
    <span
      aria-label="Подложка наведения"
      className="state-active inline-flex size-6 shrink-0 items-center justify-center rounded-1 text-foreground"
    >
      <X className="size-[13px]" aria-hidden="true" />
    </span>
  );
}

function SurfaceSamples({ surface, layers }: { surface: Surface; layers: DepthLayers }) {
  return (
    <div className="grid justify-items-center gap-1">
      <div className={cn("flex items-center gap-2 rounded-1 p-2", surface.zone)}>
        <HoverPlateSample />
        <PlusSample layers={layers} />
        <ConnectSample layers={layers} />
        <ConnectSample layers={layers} hovered />
      </div>
      <span className="text-xs text-muted-foreground">{surface.label}</span>
    </div>
  );
}

/** Four times larger through CSS zoom, which lays out again instead of
 *  scaling a bitmap, so edges stay sharp. */
function ZoomedSample({ surface, layers }: { surface: Surface; layers: DepthLayers }) {
  return (
    <div className="grid justify-items-start gap-1">
      <div className={cn("rounded-1", surface.zone)} style={{ zoom: 4, padding: 6 }}>
        <PlusSample layers={layers} />
      </div>
      <span className="text-xs text-muted-foreground">×4, {surface.label.toLowerCase()}</span>
    </div>
  );
}

function ThemePanel({
  theme,
  tokens,
  layers,
  surfaces,
  zoomOn,
}: {
  theme: Theme;
  tokens: CSSProperties;
  layers: DepthLayers;
  surfaces: readonly Surface[];
  zoomOn: Surface;
}) {
  return (
    // data-theme: the app's derived tokens (the state layer --active, the
    // text steps) are computed again from this panel's own tokens.
    <div data-theme={theme} className="grid gap-4 rounded-1 border border-border bg-background p-4 text-foreground" style={tokens}>
      <span className="text-sm text-muted-foreground">{theme === "light" ? "Светлая тема" : "Тёмная тема"}</span>
      <div className="flex flex-wrap gap-3">
        {surfaces.map((surface) => (
          <SurfaceSamples key={surface.key} surface={surface} layers={layers} />
        ))}
      </div>
      <ZoomedSample surface={zoomOn} layers={layers} />
    </div>
  );
}

function ApproachBlock({
  approach,
  number,
  tokens,
}: {
  approach: DepthApproach;
  number: number;
  tokens: Record<Theme, CSSProperties>;
}) {
  return (
    <section className="grid gap-3 border-t border-border pt-6">
      <h2 className="flex flex-wrap items-center gap-3 text-lg font-semibold">
        {number}. {approach.title}
        {approach.current && (
          <span className="rounded-1 bg-accent px-2 py-0.5 text-sm font-normal text-accent-foreground">сейчас в системе</span>
        )}
      </h2>
      <p className="max-w-[860px] text-sm">{approach.summary}</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <ThemePanel theme="light" tokens={tokens.light} layers={approach.light} surfaces={APP_SURFACES} zoomOn={CARD_SURFACE} />
        <ThemePanel theme="dark" tokens={tokens.dark} layers={approach.dark} surfaces={APP_SURFACES} zoomOn={CARD_SURFACE} />
      </div>
      {approach.sources && (
        <div className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Источники</span>
          <ul className="grid gap-0.5">
            {approach.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                  {source.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function ButtonDepthPage() {
  const [tokens] = useState<Record<Theme, CSSProperties>>(() => ({
    light: readThemeTokens("light"),
    dark: readThemeTokens("dark"),
  }));
  return (
    // The document never scrolls in this app (global.css): the page is its
    // own scrolling pane.
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="grid max-w-[1280px] gap-6 p-6">
        <header className="grid gap-2">
          <h1 className="text-lg font-semibold">Объём кнопки: наш вариант и кнопки Mac</h1>
          <p className="max-w-[860px] text-sm text-muted-foreground">
            Наш вариант рядом с кнопками macOS разных лет, пересобранными на наших поверхностях. Светлая и тёмная тема
            рядом, плюс вчетверо крупнее на карточке. У старых систем тёмной темы не было: как она пересобрана, сказано в
            описании.
          </p>
        </header>

        {DEPTH_APPROACHES.map((approach, index) => (
          <ApproachBlock key={approach.id} approach={approach} number={index + 1} tokens={tokens} />
        ))}
      </div>
    </div>
  );
}
