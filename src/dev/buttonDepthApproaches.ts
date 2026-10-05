// Button volume for the dev comparison page (`/__button-depth`): our variant
// next to the Mac ones, from the audit of 04.10.2026. Each era is rebuilt
// with our tokens (`--surface` is the zone background), so the samples sit on
// our surfaces in both themes. Nothing here is used by the app.

export interface DepthLayers {
  background: string;
  backgroundImage: string | null;
  boxShadow: string | null;
  /** The edges under hover, where they rise with the face (macOS); the
   *  rest edges otherwise. */
  boxShadowHover?: string;
  border: string | null;
  /** Only where the era's shape is part of the look (Aqua's capsule);
   *  everything else keeps our 3px. */
  radius?: string;
}

export interface DepthSource {
  label: string;
  url: string;
}

export interface DepthApproach {
  id: string;
  title: string;
  /** How the button is built and what the eye reads, in two or three
   *  sentences. */
  summary: string;
  /** The approach the app's buttons use now (global.css, --button-depth). */
  current: boolean;
  light: DepthLayers;
  dark: DepthLayers;
  /** Pages the audit opened; only the Mac entries have them. */
  sources?: readonly DepthSource[];
}

// The face of a Platinum button: a light grey under a white highlight, here a
// step darker than our surface so the highlight still reads (the era drew
// #dddddd under #ffffff).
const PLATINUM_FACE_LIGHT = "color-mix(in srgb, var(--surface), black 8%)";
const PLATINUM_FACE_DARK = "color-mix(in srgb, var(--surface), white 16%)";

export const DEPTH_APPROACHES: readonly DepthApproach[] = [
  {
    id: "ours",
    title: "Ретро-плитка",
    summary: "Заливка по правилам. Объём от цвета заливки, мера одна, тихий шаг линии (0.03 в светлой теме, 0.043 в тёмной): блик ярче заливки на 1,5 шага, нижняя линия темнее на шаг, обводка на 2 шага темнее более тёмного из двух, фона или заливки (в светлой теме это заливка, в тёмной фон), и самая тёмная. Обводка по краю внутри кнопки, линии сразу под ней, тени нет.",
    current: false,
    light: {
      background: "var(--surface)",
      backgroundImage: "linear-gradient(var(--active), var(--active))",
      boxShadow: "inset 0 0 0 0.5px oklch(from color-mix(in srgb, var(--surface), var(--foreground) var(--active-alpha)) clamp(0, calc(l - 0.06), 1) 0 0), inset 0 1.5px 0 oklch(from color-mix(in srgb, var(--surface), var(--foreground) var(--active-alpha)) clamp(0, calc(l + 0.045), 1) 0 0), inset 0 -1.5px 0 oklch(from color-mix(in srgb, var(--surface), var(--foreground) var(--active-alpha)) clamp(0, calc(l - 0.03), 1) 0 0)",
      border: null,
    },
    dark: {
      background: "oklch(from var(--surface) calc(l + 0.09) 0 0)",
      backgroundImage: null,
      boxShadow: "inset 0 0 0 0.5px oklch(from var(--surface) clamp(0, calc(l - 0.0858), 1) 0 0), inset 0 1.5px 0 oklch(from oklch(from var(--surface) calc(l + 0.09) 0 0) clamp(0, calc(l + 0.0644), 1) 0 0), inset 0 -1.5px 0 oklch(from oklch(from var(--surface) calc(l + 0.09) 0 0) clamp(0, calc(l - 0.0429), 1) 0 0)",
      border: null,
    },
  },
  {
    id: "macos-modern",
    title: "Современная macOS",
    summary: "Лицо по правилам: в светлой теме как подложка наведения, в тёмной на 3 шага зоны ярче фона. По контуру внутри кнопки обводка 0,5 px на тихий шаг линии ярче лица (в светлой теме темнее на 0.03, в тёмной светлее на 0.043); при наведении она считается от лица со слоем наведения и поднимается вместе с ним. Больше ничего: ни нижнего края, ни блика, ни тени, обводка ровная по всему контуру. Всё внутри кнопки, размер не меняется, как в приложении с 05.10.2026.",
    current: true,
    light: {
      background: "var(--surface)",
      backgroundImage: "linear-gradient(var(--active), var(--active))",
      boxShadow: "inset 0 0 0 0.5px oklch(from color-mix(in srgb, var(--surface), var(--foreground) var(--active-alpha)) clamp(0, calc(l - 0.03), 1) 0 0)",
      boxShadowHover: "inset 0 0 0 0.5px oklch(from color-mix(in srgb, color-mix(in srgb, var(--surface), var(--foreground) var(--active-alpha)), var(--foreground) var(--active-alpha)) clamp(0, calc(l - 0.03), 1) 0 0)",
      border: null,
    },
    dark: {
      background: "oklch(from var(--surface) calc(l + 0.09) 0 0)",
      backgroundImage: null,
      boxShadow: "inset 0 0 0 0.5px oklch(from oklch(from var(--surface) calc(l + 0.09) 0 0) clamp(0, calc(l + 0.0429), 1) 0 0)",
      boxShadowHover: "inset 0 0 0 0.5px oklch(from color-mix(in srgb, oklch(from var(--surface) calc(l + 0.09) 0 0), var(--foreground) var(--active-alpha)) clamp(0, calc(l + 0.0429), 1) 0 0)",
      border: null,
    },
    sources: [
      { label: "Kuba Suder: A guide to NSButton styles", url: "https://mackuba.eu/2014/10/06/a-guide-to-nsbutton-styles/" },
    ],
  },
  {
    id: "linear",
    title: "Linear",
    summary: "Геометрия Linear, скругление наше. Светлая тема: лицо идёт за зоной и всегда светлее её, зона, смешанная с белым 60%. Тёмная: лицо по правилам, на 3 шага зоны ярче фона. Обводка 0,5 px внутри кнопки, линия по закону линий от более яркого из двух, фона или лица (в светлой теме это фон, в тёмной лицо): в светлой сверху на 2 шага линии ярче, снизу на 3; в тёмной сверху на 2, снизу на 1; свет сверху. Под кнопкой минимальная контактная тень, подобранная по образцу Linear: в светлой теме 1 px вниз, размытие 2 px, сжатие 1 px, чёрный 10%; в тёмной 0,5 px вниз, размытие 1,5 px, чёрный 50%.",
    current: false,
    light: {
      background: "linear-gradient(color-mix(in srgb, var(--surface), white 60%), color-mix(in srgb, var(--surface), white 60%)) padding-box, linear-gradient(to bottom, oklch(from var(--surface) clamp(0, calc(l - 0.06), 1) 0 0), oklch(from var(--surface) clamp(0, calc(l - 0.09), 1) 0 0)) border-box",
      backgroundImage: null,
      boxShadow: "0 1px 2px -1px rgb(0 0 0 / 0.1)",
      border: "0.5px solid transparent",
    },
    dark: {
      background: "linear-gradient(oklch(from var(--surface) calc(l + 0.09) 0 0), oklch(from var(--surface) calc(l + 0.09) 0 0)) padding-box, linear-gradient(to bottom, oklch(from var(--surface) clamp(0, calc(l + 0.1758), 1) 0 0), oklch(from var(--surface) clamp(0, calc(l + 0.1329), 1) 0 0)) border-box",
      backgroundImage: null,
      boxShadow: "0 0.5px 1.5px rgb(0 0 0 / 0.5)",
      border: "0.5px solid transparent",
    },
  },
  {
    id: "modern-side-2",
    title: "Современная с торцом: 2 px",
    summary: "Лицо светлее фона, как у кнопки macOS, тонкая обводка, а вместо размытой тени снизу жёсткая тёмная грань в 2 px. Глаз видит толщину предмета снизу, будто смотрит на клавишу чуть сверху, как на кнопке со скриншота.",
    current: false,
    light: {
      background: "var(--surface)",
      backgroundImage: "linear-gradient(var(--active), var(--active))",
      boxShadow: "0 0 0 0.5px rgb(0 0 0 / 0.14), 0 2px 0 rgb(0 0 0 / 0.16)",
      border: null,
    },
    dark: {
      background: "oklch(from var(--surface) calc(l + 0.09) 0 0)",
      backgroundImage: null,
      boxShadow: "inset 0 0.5px 0 rgb(255 255 255 / 0.12), 0 0 0 0.5px rgb(0 0 0 / 0.5), 0 2px 0 rgb(0 0 0 / 0.55)",
      border: null,
    },
  },
  {
    id: "modern-side-1",
    title: "Современная с торцом: 1 px",
    summary: "То же, но грань тоньше, в 1 px. Кнопка стоит ниже над поверхностью, торец читается как кромка, а не как толщина.",
    current: false,
    light: {
      background: "var(--surface)",
      backgroundImage: "linear-gradient(var(--active), var(--active))",
      boxShadow: "0 0 0 0.5px rgb(0 0 0 / 0.14), 0 1px 0 rgb(0 0 0 / 0.16)",
      border: null,
    },
    dark: {
      background: "oklch(from var(--surface) calc(l + 0.09) 0 0)",
      backgroundImage: null,
      boxShadow: "inset 0 0.5px 0 rgb(255 255 255 / 0.12), 0 0 0 0.5px rgb(0 0 0 / 0.5), 0 1px 0 rgb(0 0 0 / 0.55)",
      border: null,
    },
  },
  {
    id: "bevel-side-2",
    title: "Ретро-плитка с торцом: 2 px",
    summary: "Ретро-плитка со сплошной обводкой внутри и светлой линией по верхней кромке, а под ней жёсткая грань в 2 px вместо тени. Плитка встаёт над поверхностью.",
    current: false,
    light: {
      background: "var(--surface)",
      backgroundImage: "linear-gradient(var(--active), var(--active))",
      boxShadow: "inset 0 0 0 0.5px color-mix(in srgb, var(--surface), black 10%), inset 0 1.5px 0 rgb(from color-mix(in srgb, var(--surface), var(--foreground) var(--active-alpha)) calc(r + 15) calc(g + 15) calc(b + 15)), 0 2px 0 rgb(0 0 0 / 0.14)",
      border: null,
    },
    dark: {
      background: "oklch(from var(--surface) calc(l + 0.09) 0 0)",
      backgroundImage: null,
      boxShadow: "inset 0 0 0 0.5px color-mix(in srgb, var(--surface), black 50%), inset 0 1.5px 0 rgb(255 255 255 / 0.12), 0 2px 0 rgb(0 0 0 / 0.55)",
      border: null,
    },
  },
  {
    id: "outset",
    title: "Выпуклая рамка, как кнопки ранних сайтов",
    summary: "Толстая светлая полоса по верху и левому краю, толстая тёмная по низу и правому, без обводки и тени: так браузеры девяностых рисовали кнопки и рамку outset. Свет слева сверху, тёмные стороны читаются как торцы. Лицо на шаг темнее фона, чтобы светлая полоса была видна на нашем почти белом фоне.",
    current: false,
    light: {
      background: "color-mix(in srgb, var(--surface), black 6%)",
      backgroundImage: null,
      boxShadow: "inset 2px 2px 0 rgb(255 255 255 / 0.9), inset -2px -2px 0 rgb(0 0 0 / 0.32)",
      border: null,
    },
    dark: {
      background: "color-mix(in srgb, var(--surface), white 12%)",
      backgroundImage: null,
      boxShadow: "inset 2px 2px 0 rgb(255 255 255 / 0.18), inset -2px -2px 0 rgb(0 0 0 / 0.6)",
      border: null,
    },
  },
  {
    id: "outset-soft",
    title: "Выпуклая рамка, современная",
    summary: "Та же выпуклая рамка, но в 1 px и мягче, с тонкой обводкой и торцом снизу в 1 px. Свет слева сверху остаётся, кнопка выглядит чище и тише образца.",
    current: false,
    light: {
      background: "color-mix(in srgb, var(--surface), black 4%)",
      backgroundImage: null,
      boxShadow: "inset 1px 1px 0 rgb(255 255 255 / 1), inset -1px -1px 0 rgb(0 0 0 / 0.12), 0 0 0 0.5px rgb(0 0 0 / 0.12), 0 1px 0 rgb(0 0 0 / 0.12)",
      border: null,
    },
    dark: {
      background: "color-mix(in srgb, var(--surface), white 10%)",
      backgroundImage: null,
      boxShadow: "inset 1px 1px 0 rgb(255 255 255 / 0.12), inset -1px -1px 0 rgb(0 0 0 / 0.4), 0 0 0 0.5px rgb(0 0 0 / 0.5), 0 1px 0 rgb(0 0 0 / 0.5)",
      border: null,
    },
  },
  {
    id: "macos-platinum",
    title: "Mac OS 8 и 9, Platinum",
    summary: "Светло-серая кнопка в чёрной обводке в 1 пиксель и по две линии у края: внутри сверху и слева белая линия, снизу и справа две серые, тёмная и светлее. Свет падает слева сверху, кнопка читается выпуклой клавишей; всё неактивное в Platinum плоское. Нажатие заливает её тёмно-серым с белым текстом. В тёмной теме та же схема на светлой относительно фона кнопке, блик слабее.",
    current: false,
    light: {
      background: PLATINUM_FACE_LIGHT,
      backgroundImage: null,
      boxShadow: `0 0 0 1px rgb(0 0 0 / 0.85), inset 1px 1px 0 ${PLATINUM_FACE_LIGHT}, inset -1px -1px 0 rgb(0 0 0 / 0.27), inset 2px 2px 0 rgb(255 255 255 / 1), inset -2px -2px 0 rgb(0 0 0 / 0.27)`,
      border: null,
    },
    dark: {
      background: PLATINUM_FACE_DARK,
      backgroundImage: null,
      boxShadow: `0 0 0 1px rgb(0 0 0 / 0.9), inset 1px 1px 0 ${PLATINUM_FACE_DARK}, inset -1px -1px 0 rgb(0 0 0 / 0.35), inset 2px 2px 0 rgb(255 255 255 / 0.22), inset -2px -2px 0 rgb(0 0 0 / 0.3)`,
      border: null,
    },
    sources: [
      { label: "Apple: Mac OS 8 Human Interface Guidelines, Push Buttons", url: "https://dev.os9.ca/techpubs/mac/HIGOS8Guide/thig-10.html" },
      { label: "Apple: Push Button States", url: "https://dev.os9.ca/techpubs/mac/HIGOS8Guide/thig-11.html" },
      { label: "Apple: Default Buttons", url: "https://dev.os9.ca/techpubs/mac/HIGOS8Guide/thig-12.html" },
      { label: "MacTech: Designing Appearance-savvy Applications (1998)", url: "http://preserve.mactech.com/articles/mactech/Vol.14/14.01/Appearance-savvyApps/index.html" },
      { label: "classicy: кнопка Mac OS 8.1 в CSS", url: "https://github.com/robbiebyrd/classicy" },
      { label: "SiteTemplatePlatinum: кнопка Platinum в CSS", url: "https://github.com/Planetable/SiteTemplatePlatinum" },
    ],
  },
  {
    id: "system-7",
    title: "System 7",
    summary: "Белая кнопка в чёрной обводке в 1 пиксель, углы скруглены ступеньками примерно на три пикселя, ни линий у края, ни тени. Объёма нет: кнопку от текста отличают только скруглённая рамка и место в диалоге. Нажатие инвертирует её, главную кнопку обводит ещё одна рамка в три пикселя через белый пиксель. В тёмной теме это инверсия: кнопка в цвет фона со светлой рамкой.",
    current: false,
    light: {
      background: "color-mix(in srgb, var(--surface), white 100%)",
      backgroundImage: null,
      boxShadow: "0 0 0 1px rgb(0 0 0 / 0.9)",
      border: null,
    },
    dark: {
      background: "color-mix(in srgb, var(--surface), white 4%)",
      backgroundImage: null,
      boxShadow: "0 0 0 1px rgb(255 255 255 / 0.85)",
      border: null,
    },
    sources: [
      { label: "Apple: Macintosh Human Interface Guidelines, Buttons", url: "https://dev.os9.ca/techpubs/mac/HIGuidelines/HIGuidelines-146.html" },
      { label: "system.css: кнопки System 6 в CSS", url: "https://github.com/sakofchit/system.css" },
      { label: "Peter Hilton: Mac OS System 7 buttons vs HTML", url: "https://hilton.org.uk/blog/system-7-buttons" },
      { label: "Infinite Mac: System 7 и Mac OS 8, 9 в браузере", url: "https://infinitemac.org/" },
    ],
  },
  {
    id: "macos-aqua",
    title: "Mac OS X с 10.0 по 10.4, Aqua",
    summary: "Кнопка-капсула из «геля»: серебристый градиент, светлый у верхнего и нижнего края и темнее посередине, сверху мягкий блик, тонкая серая рамка и лёгкая тень. Объём читается как стекло, на которое падает свет сверху. Обычная кнопка белая, главная синяя и в те годы мерцала. Форма капсулы здесь часть облика, поэтому скругление полное, а не наши 3 px.",
    current: false,
    light: {
      background: "color-mix(in srgb, var(--surface), white 100%)",
      backgroundImage:
        "radial-gradient(ellipse 46% 24% at 50% 22%, rgb(255 255 255 / 0.65), rgb(255 255 255 / 0) 100%), linear-gradient(180deg, white 0%, color-mix(in srgb, var(--surface), black 6%) 20%, color-mix(in srgb, var(--surface), black 19%) 46%, color-mix(in srgb, var(--surface), black 17%) 54%, color-mix(in srgb, var(--surface), black 5%) 74%, white 100%)",
      boxShadow: "0 0 0 1px color-mix(in srgb, var(--surface), black 43%), inset 0 1px 1px rgb(255 255 255 / 0.95), inset 0 -1px 1px rgb(255 255 255 / 0.7), 0 1px 2px rgb(0 0 0 / 0.2)",
      border: null,
      radius: "9999px",
    },
    dark: {
      background: "color-mix(in srgb, var(--surface), white 20%)",
      backgroundImage:
        "radial-gradient(ellipse 46% 24% at 50% 22%, rgb(255 255 255 / 0.16), rgb(255 255 255 / 0) 100%), linear-gradient(180deg, color-mix(in srgb, var(--surface), white 20%) 0%, color-mix(in srgb, var(--surface), white 15%) 20%, color-mix(in srgb, var(--surface), white 11%) 46%, color-mix(in srgb, var(--surface), white 12.5%) 54%, color-mix(in srgb, var(--surface), white 17%) 74%, color-mix(in srgb, var(--surface), white 20%) 100%)",
      boxShadow: "0 0 0 1px color-mix(in srgb, var(--surface), white 27%), inset 0 1px 1px rgb(255 255 255 / 0.12), 0 1px 2px rgb(0 0 0 / 0.4)",
      border: null,
      radius: "9999px",
    },
    sources: [
      { label: "Wikipedia: Aqua (user interface)", url: "https://en.wikipedia.org/wiki/Aqua_(user_interface)" },
      { label: "aqua: кнопки Aqua в CSS (gel, silver)", url: "https://github.com/michi-onl/aqua" },
      { label: "Infinite Mac: Mac OS X 10.0 по 10.4 в браузере", url: "https://infinitemac.org/" },
    ],
  },
];
