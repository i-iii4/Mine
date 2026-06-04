import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ExternalLink,
  GripVertical,
  Info,
  MoreHorizontal,
  Plus,
  Strikethrough,
  X,
} from "lucide-react";
import { ActionButton } from "@/components/ActionButton";
import { ChromeCloseButton } from "@/components/ChromeCloseButton";
import { CollectionPicker } from "@/components/CollectionPicker";
import { GroupSelectionActionBar } from "@/components/GroupSelectionActionBar";
import { MenuTextTrigger } from "@/components/MenuTextTrigger";
import { QuantizedMenuScrollArea } from "@/components/QuantizedMenuScrollArea";
import { SearchMenuAction } from "@/components/SearchMenuAction";
import { SearchMenuInput } from "@/components/SearchMenuInput";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { LightBlock, TagCount } from "@/types";
import { ChannelList } from "../../extension/popup/components/ChannelList";
import { SaveButton } from "../../extension/popup/components/SaveButton";
import { ScreenshotPreview } from "../../extension/popup/components/ScreenshotPreview";
import { StatusBar } from "../../extension/popup/components/StatusBar";
import { TypeSwitcher } from "../../extension/popup/components/TypeSwitcher";
import { VaultSelect } from "../../extension/popup/components/VaultSelect";
import type { ChannelInfo } from "../../extension/popup/lib/messaging";

type ColorToken = { readonly token: string; readonly use: string };

type TokenGroup = {
  title: string;
  tokens: readonly ColorToken[];
};

type RedactionIconVariant = {
  family: string;
  label: string;
  glyph: "m";
  style: "regular" | "italic";
};

type ClipPreviewType = "content" | "screenshot" | "link" | "image";

const actualMineIconVariant: RedactionIconVariant = {
  family: "Redaction 100",
  label: "Redaction 100 Italic",
  glyph: "m",
  style: "italic",
};

const COLOR_TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    title: "Поверхности",
    tokens: [
      { token: "--background", use: "Фон страницы" },
      { token: "--chrome", use: "Верхняя панель оболочки" },
      { token: "--card", use: "Фон карточки" },
      { token: "--popover", use: "Фон меню и попапов" },
      { token: "--secondary", use: "= accent (совместимость shadcn)" },
      { token: "--muted", use: "= accent (совместимость shadcn)" },
      { token: "--accent", use: "Hover-фон, action bar" },
      { token: "--active", use: "Нажатие, активная строка" },
      { token: "--border", use: "Границы и разделители" },
      { token: "--border-accent", use: "Акцентная граница (фокус)" },
      { token: "--input", use: "Фон и рамка инпута" },
    ],
  },
  {
    title: "Текст",
    tokens: [
      { token: "--foreground", use: "Основной текст" },
      { token: "--muted-foreground", use: "Вторичный — мета, счётчики" },
      { token: "--tertiary-foreground", use: "Третичный — плейсхолдеры" },
      { token: "--hover-foreground", use: "Текст при hover" },
      { token: "--popover-foreground", use: "Текст в меню" },
      { token: "--accent-foreground", use: "Текст на accent" },
    ],
  },
  {
    title: "Заливки компонентов",
    tokens: [
      { token: "--component-fill", use: "Фон Button, обойма ActionButton" },
      { token: "--component-fill-inner", use: "Внутренняя пуля ActionButton" },
      { token: "--component-fill-hover", use: "Hover-обводка, selected" },
      { token: "--destructive", use: "Ошибки, удаление" },
      { token: "--primary", use: "Checkbox checked, прогресс" },
      { token: "--primary-foreground", use: "Текст на primary" },
    ],
  },
  {
    title: "Оболочка и состояния ленты",
    tokens: [
      { token: "--sidebar", use: "Фон сайдбара" },
      { token: "--sidebar-border", use: "Граница сайдбара" },
      { token: "--glass-bg", use: "Backdrop-стекло" },
      { token: "--card-hover-overlay", use: "Оверлей hover карточки" },
      { token: "--graphic-card-focus-overlay", use: "Фокус-затемнение медиа" },
      { token: "--feed-selection-frame", use: "Рамка выделения ленты" },
    ],
  },
];

const RADIUS_TOKENS = [
  { token: "--radius-0", label: "0px / контент, изображения, текст" },
  { token: "--radius-1", label: "3px / кнопки, меню, контролы, диалоги" },
  { token: "--radius-2", label: "5px / стопка превью каналов" },
  { token: "--radius-round", label: "50% / круглые контролы клиппера" },
  { token: "--radius-card", label: "алиас рамки карточки (= 0)" },
  { token: "--radius-media", label: "алиас медиа карточки (= 0)" },
] as const;

const SPACING_TOKENS = [
  { token: "--spacing-s1", label: "4px / внутри мелких элементов" },
  { token: "--spacing-s2", label: "8px / внутри кнопки, инпута" },
  { token: "--spacing-s3", label: "16px / между элементами карточки" },
  { token: "--spacing-s4", label: "24px / padding карточки от края" },
  { token: "--spacing-s5", label: "32px / gap сетки карточек" },
  { token: "--spacing-s6", label: "48px / между секциями" },
  { token: "--spacing-s7", label: "64px / отступ страницы" },
] as const;

const TYPE_TOKENS = [
  { className: "text-sm", label: "text-sm · 12/16 · мета, счётчики, карточки" },
  { className: "text-base", label: "text-base · 14/20 · основной текст UI" },
  { className: "text-lg", label: "text-lg · 18/24 · заголовки" },
] as const;

const SAMPLE_TAGS: TagCount[] = [
  { tag: "beautiful-web", count: 30 },
  { tag: "catalogs", count: 7 },
  { tag: "periphery", count: 8 },
  { tag: "typography", count: 6 },
  { tag: "very-long-channel-name", count: 6 },
  { tag: "local-first", count: 3 },
];

const CLIPPER_CHANNELS: ChannelInfo[] = SAMPLE_TAGS.map((tag) => ({
  tag: tag.tag,
  block_count: tag.count,
}));

const GROUP_SELECTION_BLOCKS: LightBlock[] = [
  sampleBlock("catalog-cover", "Catalog cover", "image"),
  sampleBlock("braun-tax", "Braun Design Tax", "article"),
  sampleBlock("memory-birds", "Memory is a flock of birds", "article"),
];

const SEGMENT_OPTIONS: readonly SegmentedControlOption<"all" | "connected">[] = [
  { value: "all", label: "All" },
  { value: "connected", label: "Connected" },
];

const SCREENSHOT_DATA_URL = svgDataUrl(`
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560">
    <rect width="960" height="560" fill="#f5f5f5"/>
    <rect x="64" y="54" width="832" height="64" fill="#111"/>
    <rect x="140" y="170" width="240" height="120" fill="#d8d8d8"/>
    <rect x="440" y="170" width="260" height="120" fill="#d8d8d8"/>
    <rect x="140" y="330" width="560" height="24" fill="#111"/>
    <rect x="140" y="374" width="430" height="18" fill="#777"/>
    <rect x="140" y="410" width="500" height="18" fill="#aaa"/>
  </svg>
`);

const ARTICLE_IMAGE_DATA_URL = svgDataUrl(`
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560">
    <rect width="960" height="560" fill="#111"/>
    <rect x="48" y="48" width="864" height="464" fill="#efefef"/>
    <circle cx="280" cy="260" r="128" fill="#222"/>
    <rect x="472" y="176" width="300" height="28" fill="#222"/>
    <rect x="472" y="232" width="360" height="18" fill="#777"/>
    <rect x="472" y="268" width="280" height="18" fill="#999"/>
    <rect x="472" y="336" width="220" height="44" fill="#111"/>
  </svg>
`);

export function ComponentTestBench() {
  return (
    <TooltipProvider>
      <div className="min-h-full bg-background text-foreground" data-design-system-bench="">
        <div className="border-b border-border px-8 py-6">
          <p className="font-mono text-sm text-muted-foreground">Аудит дизайн-системы Mine</p>
          <h1 className="mt-2 text-lg font-semibold">Токены и компоненты продакшена</h1>
          <p className="mt-2 max-w-3xl text-base text-muted-foreground">
            Страница импортирует реальные примитивы приложения и веб-клиппера. Если
            продакшен-состояние отсутствует здесь — страница устарела. Если состояние
            есть здесь, но нет прод-примитива — реализация дрейфует. Значения токенов
            читаются вживую из текущей темы.
          </p>
        </div>

        <div className="grid gap-8 px-8 py-8">
          <IdeologyPanel />
          <PrinciplesSection />
          <TokenAuditSection />
          <CoreComponentSection />
          <FloatingUiSection />
          <DialogPrimitivesSection />
          <ShellAndSelectionSection />
          <CardPatternSection />
          <ClipperParitySection />
          <AppIconTemplateBench />
        </div>
      </div>
    </TooltipProvider>
  );
}

function IdeologyPanel() {
  return (
    <section className="grid gap-4 rounded-1 border border-border-accent bg-accent p-6">
      <div>
        <p className="font-mono text-sm text-muted-foreground">Идеология</p>
        <h2 className="mt-1 text-lg font-semibold text-foreground">Что и зачем мы делаем</h2>
      </div>
      <div className="grid max-w-3xl gap-3 text-base leading-5 text-foreground">
        <p>
          Дизайн-система — это <strong className="font-semibold">контракт</strong>, а не
          библиотека украшений. Эта страница — поверхность аудита: она импортирует
          настоящие production-примитивы и показывает их рядом с фактическими значениями
          токенов из текущей темы. Цель — сделать дрейф видимым до того, как он попадёт
          в интерфейс.
        </p>
        <p>
          Названия и таблицы фиксируют контракт каждого компонента: высоту, скругление,
          цветовой токен, отступы и состояния. Если меняется production-примитив — эта
          страница меняется в том же PR. Lookalike-компоненты как источник истины
          запрещены; допустимы только небольшие статические превью для состояний, ещё не
          выделенных в переиспользуемый примитив.
        </p>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <ContractCard title="Требования по токенам">
          На странице — только CSS-переменные, реально используемые в desktop UI или
          веб-клиппере. Неиспользуемые shadcn-дефолты и историческая шкала сюда не
          попадают. Значения читаются вживую через computed CSS, а не хардкодятся.
        </ContractCard>
        <ContractCard title="Компоненты">
          Импортируются из production-файлов. Каждый показан со своими реальными
          размерами, токенами и состояниями — таблица характеристик рядом с живым
          примером.
        </ContractCard>
        <ContractCard title="Клиппер">
          Представлен полными состояниями popup на реальной ширине 360px и обязан
          переиспользовать примитивы приложения: триггеры, сегментный контрол, пикер
          каналов, кнопки, поле поиска.
        </ContractCard>
      </div>
    </section>
  );
}

function PrinciplesSection() {
  return (
    <BenchSection
      title="Принципы"
      description="Основания, из которых выводятся решения. Сами значения живут в токенах и контрактах компонентов — здесь о том, почему они именно такие и как принимать новые решения."
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <PrincipleCard title="Радиус кодирует роль, а не вкус">
          Скругление — сигнал, а не украшение. Резкий край сообщает «это контент, окно в
          данные»; мягкий — «это интерфейс, объект, который можно тронуть». Поэтому радиус
          выводится из роли элемента, а не подбирается на глаз. Отсюда резкие карточки и
          мягкие контролы — конкретные значения смотри в токенах скруглений.
        </PrincipleCard>
        <PrincipleCard title="Пространство — закрытая шкала, а не диапазон">
          Отступы берутся из конечного набора ступеней, а не из непрерывного континуума.
          Ограниченный словарь создаёт ритм и делает отклонение заметным: значение вне
          шкалы — это всегда либо баг, либо ещё не принятое решение, а не «так получилось».
          Новая ступень вводится, только если ни одна существующая не подходит.
        </PrincipleCard>
        <PrincipleCard title="Минимум различимых ступеней">
          Каждая ступень — размера, веса, уровня серого — обязана нести различимую задачу.
          Иерархия строится наименьшим числом ступеней: лишние варианты дают не
          выразительность, а произвол и дрейф. Прежде чем вводить четвёртую величину, надо
          доказать, что задача не решается тремя имеющимися.
        </PrincipleCard>
        <PrincipleCard title="Цвет — дефицитный сигнал">
          Оттенок (hue) тратится только на смысл: ошибку, акцент, данные графика. База —
          чисто нейтральная (<code>oklch(L 0 0)</code>), чтобы не отбирать внимание у
          контента. Иерархию текста несёт яркость — единственная ось без семантической
          нагрузки. Любой hue на фоне или основном тексте — сигнал, потраченный впустую.
        </PrincipleCard>
        <PrincipleCard title="Поверхности и компоненты — независимые системы">
          Фоновое наслоение и заливки интерактивных элементов решают разные задачи и имеют
          разные требования к контрасту. Поэтому это два независимых набора токенов: правка
          поверхностей не трогает кнопки, а правка кнопок не трогает фоны.
        </PrincipleCard>
        <PrincipleCard title="Названное — управляемо">
          Каждое значение живёт под именем в одном месте (<code>@theme</code>). То, что
          названо токеном, меняется осознанно и единожды; то, что захардкожено числом в
          компоненте, неизбежно расходится. Поэтому страница читает значения вживую —
          расхождение контракта и реализации видно сразу.
        </PrincipleCard>
      </div>
    </BenchSection>
  );
}

function PrincipleCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-1 border border-border p-4">
      <p className="text-base font-semibold text-foreground">{title}</p>
      <p className="mt-2 text-base leading-5 text-muted-foreground [&_code]:rounded-[2px] [&_code]:bg-component-fill [&_code]:px-1 [&_code]:font-mono [&_code]:text-sm [&_code]:text-foreground">
        {children}
      </p>
    </div>
  );
}

function TokenAuditSection() {
  return (
    <BenchSection
      title="Токены"
      description="Значения читаются из текущей темы. Переключите тему приложения, чтобы проверить светлую и тёмную."
    >
      <div className="grid gap-4 xl:grid-cols-2">
        {COLOR_TOKEN_GROUPS.map((group) => (
          <TokenPanel key={group.title} title={group.title}>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.tokens.map((token) => (
                <ColorTokenChip key={token.token} token={token.token} use={token.use} />
              ))}
            </div>
          </TokenPanel>
        ))}

        <TokenPanel title="Скругления">
          <div className="grid gap-2 sm:grid-cols-2">
            {RADIUS_TOKENS.map((item) => (
              <DimensionTokenChip key={item.token} token={item.token} label={item.label} kind="radius" />
            ))}
          </div>
        </TokenPanel>

        <TokenPanel title="Отступы">
          <div className="grid gap-2 sm:grid-cols-2">
            {SPACING_TOKENS.map((item) => (
              <DimensionTokenChip key={item.token} token={item.token} label={item.label} kind="spacing" />
            ))}
          </div>
        </TokenPanel>

        <TokenPanel title="Типографика">
          <div className="grid gap-2">
            {TYPE_TOKENS.map((item) => (
              <div key={item.label} className="rounded-1 border border-border p-3">
                <p className="font-mono text-sm text-muted-foreground">{item.label}</p>
                <p className={cn(item.className, "mt-2 text-foreground")}>
                  The quick brown fox checks Mine UI rhythm.
                </p>
              </div>
            ))}
          </div>
        </TokenPanel>
      </div>
    </BenchSection>
  );
}

function CoreComponentSection() {
  return (
    <BenchSection
      title="Базовые компоненты"
      description="Базовые примитивы и все продуктовые размеры и состояния. Рядом с каждым — таблица фактических характеристик."
    >
      <ComponentSpec
        title="Button — размеры"
        summary="Базовый примитив. Четыре высоты по control-шкале плюс квадратные icon-варианты."
        specs={[
          { prop: "Высота", value: "24 · 28 · 32 · 40 (h-6/7/8/10)" },
          { prop: "Icon", value: "size-8 (32) · size-6 (24, icon-xs)" },
          { prop: "Скругление", value: "3px · rounded-1 · --radius-1" },
          { prop: "Фон", value: "--component-fill" },
          { prop: "Текст", value: "--foreground · 14px · 600" },
          { prop: "Отступы", value: "px-3 (12) · gap-2 (8)" },
          { prop: "Disabled", value: "opacity-50" },
        ]}
      >
        <Button size="xs">xs 24</Button>
        <Button size="sm">sm 28</Button>
        <Button>default 32</Button>
        <Button size="clipper">clipper 40</Button>
        <Button disabled>Disabled</Button>
      </ComponentSpec>

      <ComponentSpec
        title="Button — варианты"
        summary="Один фон, разные акценты. Hover не заливает кнопку, а рисует обводку."
        specs={[
          { prop: "default", value: "bg --component-fill" },
          { prop: "destructive", value: "text --destructive" },
          { prop: "ghost", value: "bg transparent" },
          { prop: "link", value: "underline · hover --hover-foreground" },
          { prop: "Hover", value: "outline 1px · --component-fill-hover" },
          { prop: "SVG", value: "size-4 (16) · xs size-3 (12)" },
        ]}
      >
        <Button variant="default"><Plus />Connect</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button size="icon" aria-label="More"><MoreHorizontal /></Button>
        <ChromeCloseButton label="Close design preview" />
      </ComponentSpec>

      <ComponentSpec
        title="ActionButton"
        summary="Двухслойная пуля топ-бара: внешняя обойма, внутренняя метка, опциональный hotkey-слот."
        specs={[
          { prop: "Root", value: "24 (h-6) · p-[2px] · rounded-1" },
          { prop: "Inner", value: "20 (h-5) · px-[1ch] · rounded-[2px]" },
          { prop: "Шрифт", value: "font-mono · 12px" },
          { prop: "Inner фон", value: "--component-fill-inner" },
          { prop: "Default", value: "transparent → hover --component-fill-hover" },
          { prop: "Selected", value: "--component-fill-hover" },
        ]}
      >
        <ActionButton hotkey="⌘⇧N">New Channel</ActionButton>
        <ActionButton hotkey="⌘,">Settings</ActionButton>
        <ActionButton>No hotkey</ActionButton>
        <ActionButton hotkey="⌘K" isSelected>Selected</ActionButton>
      </ComponentSpec>

      <ComponentSpec
        title="SegmentedControl"
        summary="Сегментный переключатель. Три размера, выделенный сегмент — внутренняя заливка."
        specs={[
          { prop: "compact", value: "root 24 (h-6) · item 20 (h-5) · 12px mono" },
          { prop: "default", value: "root 32 (h-8) · item 24 (h-6) · 14px" },
          { prop: "clipper", value: "root 32 (h-8) · item 28 (h-7) · 14px" },
          { prop: "Скругление", value: "root rounded-1 (3) · item rounded-[2px]" },
          { prop: "Отступ", value: "root p-[2px] · item px-[1ch]" },
          { prop: "Выбран", value: "--component-fill-inner · text --foreground" },
          { prop: "Не выбран", value: "text --muted-foreground" },
        ]}
      >
        <SegmentedControl
          value="all"
          options={SEGMENT_OPTIONS}
          onChange={() => {}}
          aria-label="Compact channel filter"
          size="compact"
        />
        <SegmentedControl
          value="connected"
          options={SEGMENT_OPTIONS}
          onChange={() => {}}
          aria-label="Default channel filter"
          size="default"
        />
        <SegmentedControl
          value="all"
          options={SEGMENT_OPTIONS}
          onChange={() => {}}
          aria-label="Clipper channel filter"
          size="clipper"
        />
      </ComponentSpec>

      <ComponentSpec
        title="Input"
        summary="Текстовое поле. Default 32, clipper 40. Ghost — без рамки и фона для встройки в меню."
        specs={[
          { prop: "Высота", value: "32 (h-8) · clipper 40 (h-10)" },
          { prop: "Скругление", value: "3px · rounded-1 · --radius-1" },
          { prop: "Фон / рамка", value: "--background / --input" },
          { prop: "Отступы", value: "px-3 py-2 (12 · 8)" },
          { prop: "Текст", value: "--foreground · 14px" },
          { prop: "Placeholder", value: "--tertiary-foreground" },
          { prop: "Focus", value: "border --foreground" },
          { prop: "Invalid", value: "border --destructive" },
        ]}
      >
        <Input placeholder="Default input" className="w-56" />
        <Input defaultValue="Filled input" className="w-56" />
        <Input variant="ghost" placeholder="Ghost input..." className="w-56" />
        <Input controlSize="clipper" placeholder="Clipper input 40" className="w-56" />
        <Input disabled placeholder="Disabled" className="w-56" />
      </ComponentSpec>

      <ComponentSpec
        title="SearchMenuInput"
        summary="Плоский заголовок меню: поле без пилюли, отделено нижней границей. Под ним идут строки действий."
        specs={[
          { prop: "Обёртка", value: "p-1 (4) · border-b --border" },
          { prop: "Input", value: "ghost · rounded-0 · px-2 py-0" },
          { prop: "Текст", value: "--foreground · 14px" },
          { prop: "Placeholder", value: "--tertiary-foreground" },
          { prop: "clipper", value: "ряды 40 (controlSize)" },
        ]}
      >
        <div className="w-80 overflow-hidden rounded-1 border border-border bg-popover">
          <SearchMenuInput placeholder="Search channels..." />
          <SearchMenuAction active onPress={() => {}}>
            <span className="truncate">Beautiful web</span>
            <span className="ml-auto text-muted-foreground">30</span>
          </SearchMenuAction>
        </div>
        <div className="w-80 overflow-hidden rounded-1 border border-border bg-popover">
          <SearchMenuInput controlSize="clipper" placeholder="Search spaces..." />
          <SearchMenuAction rowSize="clipper" active onPress={() => {}}>
            <span className="truncate">Mine</span>
          </SearchMenuAction>
        </div>
      </ComponentSpec>

      <ComponentSpec
        title="MenuTextTrigger"
        summary="Текстовый триггер меню в трёх поверхностях. Геометрия и цвет зависят от surface."
        specs={[
          { prop: "topChrome", value: "rounded-0 · text --muted-foreground" },
          { prop: "clipperHeader", value: "24 (h-6) · rounded-1 · px-2 · chevron" },
          { prop: "actionBar", value: "24 (h-6) · p-[2px]" },
          { prop: "Hover", value: "bg --active (chrome) / --component-fill-hover (bar)" },
          { prop: "Открыт", value: "bg --active · text --foreground" },
        ]}
      >
        <div className="flex h-8 items-center gap-0 overflow-hidden rounded-1 border border-border bg-chrome">
          <MenuTextTrigger label="Mine" surface="topChrome" className="px-3" />
          <MenuTextTrigger label="Everything" surface="topChrome" className="px-6" />
        </div>
        <div className="flex h-10 w-80 items-center border border-border bg-accent px-2">
          <MenuTextTrigger label="Mine" surface="clipperHeader" showChevron />
        </div>
        <MenuTextTrigger label="Action" surface="actionBar" hotkey="⌘A" />
      </ComponentSpec>

      <ComponentSpec
        title="Checkbox · Progress · Tooltip"
        summary="Мелкие примитивы состояний. Чекбокс — единственный radius-2 в системе (компенсация масштаба 16px)."
        specs={[
          { prop: "Checkbox", value: "size-4 (16) · rounded-[2px]" },
          { prop: "— checked", value: "bg --primary · галочка 14" },
          { prop: "Progress", value: "h-2 (8) · rounded-1 · трек --primary/20" },
          { prop: "— заполнено", value: "bg --primary" },
          { prop: "Tooltip", value: "bg --foreground · text --background" },
          { prop: "— геометрия", value: "px-3 py-1.5 · rounded-1 · 12px" },
        ]}
      >
        <label className="inline-flex items-center gap-2 text-base">
          <Checkbox />
          Unchecked
        </label>
        <label className="inline-flex items-center gap-2 text-base">
          <Checkbox defaultChecked />
          Checked
        </label>
        <Progress value={45} className="w-56" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button><Info />Tooltip</Button>
          </TooltipTrigger>
          <TooltipContent>Design-system tooltip</TooltipContent>
        </Tooltip>
      </ComponentSpec>
    </BenchSection>
  );
}

function FloatingUiSection() {
  return (
    <BenchSection
      title="Плавающие элементы"
      description="Меню: роли ширины (command / selector / picker) и контракт квантованной высоты строк."
    >
      <ComponentSpec
        title="DropdownMenu — command"
        summary="Командное меню карточки. Ширина по контенту в пределах роли command; вложенный picker открывает CollectionPicker."
        specs={[
          { prop: "Ширина", value: "max-content · min 192 · max 300" },
          { prop: "Контейнер", value: "rounded-1 · bg --popover · border · p-1 · shadow-md" },
          { prop: "Пункт", value: "py-1.5 px-2 · gap-2 · rounded-1 · 14px" },
          { prop: "Hover", value: "bg --active · text --accent-foreground" },
          { prop: "destructive", value: "text --destructive" },
          { prop: "Разделитель", value: "h-px · bg --border · my-1" },
          { prop: "SVG", value: "size-4 (16) · --muted-foreground" },
        ]}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>Open command menu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent widthRole="command">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Plus className="size-3" />
                Connect
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent widthRole="picker" className="p-0">
                <CollectionPicker
                  blockSlug="bench-card"
                  selectedTags={["beautiful-web"]}
                  tags={SAMPLE_TAGS}
                  onToggleTag={() => {}}
                  onCreateAndAssign={() => {}}
                  stopKeyPropagation
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem>
              <ExternalLink className="size-3" />
              Source
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Reveal in Finder</DropdownMenuItem>
            <DropdownMenuItem>Copy Path</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ComponentSpec>

      <ComponentSpec
        title="ContextMenu"
        summary="Правый клик. Та же структура, что DropdownMenu, но hover-пункт берёт фон --accent."
        specs={[
          { prop: "Контейнер", value: "rounded-1 · bg --popover · border · p-1" },
          { prop: "Пункт", value: "py-1.5 px-2 · gap-2 · rounded-1" },
          { prop: "Hover", value: "bg --accent · text --accent-foreground" },
          { prop: "destructive", value: "text --destructive" },
        ]}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex h-16 w-64 items-center justify-center rounded-1 border border-dashed border-border text-sm text-muted-foreground">
              Right-click target
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Create Card</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </ComponentSpec>

      <ComponentSpec
        title="QuantizedMenuScrollArea"
        summary="Скролл-область меню с квантованной высотой: показывает целое число строк, обрезка по высоте viewport."
        specs={[
          { prop: "Высота строки", value: "default 32 · clipper 40" },
          { prop: "Padding списка", value: "compact 4 · default 8" },
          { prop: "maxRows", value: "по умолчанию 8" },
          { prop: "Высота", value: "rows × rowHeight + padding" },
          { prop: "Overflow", value: "overflow-y-auto · min-h-0" },
        ]}
      >
        <div className="w-72 rounded-1 border border-border bg-popover">
          <QuantizedMenuScrollArea rowCount={6} maxRows={4} innerClassName="p-1">
            {SAMPLE_TAGS.map((tag) => (
              <SearchMenuAction key={tag.tag} onPress={() => {}}>
                <span className="truncate">{tag.tag}</span>
                <span className="ml-auto text-muted-foreground">{tag.count}</span>
              </SearchMenuAction>
            ))}
          </QuantizedMenuScrollArea>
        </div>
        <div className="w-72 rounded-1 border border-border bg-popover">
          <QuantizedMenuScrollArea rowCount={6} rowSize="clipper" maxRows={4} innerClassName="p-1">
            {SAMPLE_TAGS.map((tag) => (
              <SearchMenuAction key={tag.tag} rowSize="clipper" onPress={() => {}}>
                <span className="truncate">{tag.tag}</span>
                <span className="ml-auto text-muted-foreground">{tag.count}</span>
              </SearchMenuAction>
            ))}
          </QuantizedMenuScrollArea>
        </div>
      </ComponentSpec>
    </BenchSection>
  );
}

function DialogPrimitivesSection() {
  return (
    <BenchSection
      title="Диалоги и прокрутка"
      description="Модальные примитивы порталятся в body и центрируются — на странице открываются живым триггером. Внизу — единственный кастомный scrollbar."
    >
      <ComponentSpec
        title="Dialog"
        summary="Модальное окно для форм (rename, merge, import). Оверлей затемняет фон, окно центрировано."
        specs={[
          { prop: "Ширина", value: "max-w-lg (512) · моб calc(100%−2rem)" },
          { prop: "Скругление", value: "3px · rounded-1" },
          { prop: "Фон / рамка", value: "--background / border" },
          { prop: "Отступы", value: "p-6 (24) · gap-4 (16)" },
          { prop: "Оверлей", value: "bg-black/50 · fixed inset-0" },
          { prop: "Close", value: "top/right 16 · X size-4 (16)" },
          { prop: "Title / Desc", value: "18px 600 / 14px --muted-foreground" },
        ]}
      >
        <DialogDemo />
      </ComponentSpec>

      <ComponentSpec
        title="AlertDialog"
        summary="Подтверждение деструктивного действия (удаление). Опциональный media-слот, action + cancel."
        specs={[
          { prop: "Размеры", value: "default max-w-lg (512) · sm max-w-xs (320)" },
          { prop: "Media-слот", value: "size-16 (64) · bg --accent · rounded-1" },
          { prop: "Отступы", value: "p-6 (24) · gap-4 (16)" },
          { prop: "Action", value: "Button default" },
          { prop: "Cancel", value: "Button ghost" },
          { prop: "Footer", value: "моб column-reverse · sm row/grid" },
          { prop: "Title / Desc", value: "18px 600 / 14px --muted-foreground" },
        ]}
      >
        <AlertDialogDemo />
      </ComponentSpec>

      <ComponentSpec
        title="ScrollArea"
        summary="Кастомный скроллбар (ImportDialog). Нативные скроллбары в приложении скрыты; здесь — единственный видимый."
        specs={[
          { prop: "Скроллбар", value: "верт w-2.5 (10) · гор h-2.5 (10)" },
          { prop: "Бегунок", value: "bg --border · rounded-1 (3)" },
          { prop: "Рамка-зазор", value: "1px transparent · p-px" },
          { prop: "Viewport", value: "size-full · rounded-[inherit]" },
        ]}
      >
        <ScrollAreaDemo />
      </ComponentSpec>
    </BenchSection>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Открыть диалог</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Переименовать карточку</DialogTitle>
          <DialogDescription>
            Имя файла станет основой нового slug.
          </DialogDescription>
        </DialogHeader>
        <Input defaultValue="catalog-cover" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button onClick={() => setOpen(false)}>Сохранить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AlertDialogDemo() {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Открыть подтверждение</Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="default">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>Удалить карточку?</AlertDialogTitle>
          <AlertDialogDescription>
            Файл и связанные медиа будут удалены без возможности отмены.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction>Удалить</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ScrollAreaDemo() {
  const rows = [...SAMPLE_TAGS, ...SAMPLE_TAGS];
  return (
    <ScrollArea className="h-40 w-64 rounded-1 border border-border">
      <div className="p-2">
        {rows.map((tag, index) => (
          <div
            key={`${tag.tag}-${index}`}
            className="flex h-8 items-center justify-between px-2 text-base"
          >
            <span className="truncate text-foreground">{tag.tag}</span>
            <span className="text-muted-foreground">{tag.count}</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function ShellAndSelectionSection() {
  return (
    <BenchSection
      title="Оболочка и пакетное выделение"
      description="Верхняя и вторичная панели оболочки, плавающие острова действий, пакетное выделение."
    >
      <ComponentSpec
        title="Top chrome"
        summary="Верхняя панель оболочки: строка навигации и вторичная строка статистики. Моноширинный шрифт."
        specs={[
          { prop: "Высота строки", value: "32 (h-8)" },
          { prop: "Фон", value: "--chrome (нав) · --background (статы)" },
          { prop: "Шрифт", value: "font-mono · 12px/16" },
          { prop: "Текст", value: "--muted-foreground · статы --tertiary-foreground" },
          { prop: "Разделители", value: "border --border" },
          { prop: "Отступ", value: "px-3 (12)" },
        ]}
      >
        <div className="grid w-full overflow-hidden rounded-1 border border-border">
          <div className="grid h-8 grid-cols-[160px_1fr] bg-chrome font-mono text-sm text-muted-foreground">
            <div className="flex items-center border-r border-border px-3">Mine</div>
            <div className="flex items-center justify-between px-3">
              <span>Everything</span>
              <span>⌘, Settings</span>
            </div>
          </div>
          <div className="grid h-8 grid-cols-[160px_1fr] border-t border-border bg-background font-mono text-sm text-tertiary-foreground">
            <div className="flex items-center border-r border-border px-3">128 files · 42 .md · 86 media</div>
            <div className="flex items-center px-3">128 cards</div>
          </div>
        </div>
      </ComponentSpec>

      <ComponentSpec
        title="GroupSelectionActionBar"
        summary="Плавающий остров пакетных действий. Кнопки xs, центрирован, отступ снизу по --spacing-s3."
        specs={[
          { prop: "Высота", value: "32 (h-8)" },
          { prop: "Фон / рамка", value: "--accent / --border" },
          { prop: "Скругление", value: "3px · rounded-1" },
          { prop: "Тень", value: "shadow-md" },
          { prop: "Позиция", value: "bottom 16 (--spacing-s3) · центр" },
          { prop: "Отступ", value: "px-1 · gap-1 (4)" },
          { prop: "Кнопки", value: "Button xs · close ghost icon" },
        ]}
      >
        <div className="relative h-32 w-full overflow-hidden rounded-1 border border-border bg-background">
          <GroupSelectionActionBar
            selectedBlocks={GROUP_SELECTION_BLOCKS}
            tags={SAMPLE_TAGS}
            currentTag="beautiful-web"
            onLoadBlockTags={async () => new Map([
              ["catalog-cover", ["beautiful-web"]],
              ["braun-tax", ["catalogs"]],
              ["memory-birds", []],
            ])}
            onBatchSetTag={() => {}}
            onCreateAndAssignBatch={() => {}}
            onDeleteSelectedBlocks={async () => {}}
            onMergeSelectedBlocks={() => {}}
            onClearSelection={() => {}}
          />
        </div>
      </ComponentSpec>
    </BenchSection>
  );
}

function CardPatternSection() {
  return (
    <BenchSection
      title="Карточки и инлайн-действия"
      description="Состояния карточек — это композиции, а не изолированные shadcn-примитивы."
    >
      <ComponentSpec
        title="Карточка ленты — фокус и выделение"
        summary="Карточки контента: radius 0, медиа в фокусе. Клавиатурный фокус — затемнение поверх медиа, batch-выделение — рамка снаружи."
        specs={[
          { prop: "Карточка", value: "border --border · bg --card · rounded-0" },
          { prop: "Медиа", value: "rounded-0 (--radius-media) · object-cover" },
          { prop: "Keyboard-фокус", value: "оверлей --graphic-card-focus-overlay" },
          { prop: "Выделение", value: "рамка 2px снаружи · inset -3px" },
          { prop: "Цвет рамки", value: "--feed-selection-frame" },
          { prop: "Отступ", value: "p-3 (12)" },
        ]}
      >
        <div className="grid max-w-5xl gap-4 md:grid-cols-3">
          <FeedCardPreview state="default" />
          <FeedCardPreview state="keyboard" />
          <FeedCardPreview state="selected" />
        </div>
      </ComponentSpec>

      <ComponentSpec
        title="Бейдж шортката на карточке"
        summary="Скоупный шорткат поверх графической карточки — не перекрывает медиа, в отличие от фокус-оверлея."
        specs={[
          { prop: "Позиция", value: "absolute · left/top 8" },
          { prop: "Фон", value: "--component-fill" },
          { prop: "Текст", value: "--foreground · font-mono · 12px · 600" },
          { prop: "Скругление", value: "3px · rounded-1" },
          { prop: "Отступ", value: "px-[1ch]" },
        ]}
      >
        <div className="relative w-80 border border-border bg-card p-3">
          <img src={ARTICLE_IMAGE_DATA_URL} alt="" className="block w-full rounded-0" />
          <div className="pointer-events-none absolute left-5 top-5 rounded-1 bg-component-fill px-[1ch] font-mono text-sm font-semibold text-foreground">
            ⌘K
          </div>
          <p className="mt-3 text-base text-muted-foreground">
            Graphic card keeps media as the visual focus while badge explains the scoped shortcut.
          </p>
        </div>
      </ComponentSpec>

      <ComponentSpec
        title="Остров действий выделения текста"
        summary="Компактная горизонтальная панель над выделением в статье. Переиспользует контракт Button (xs)."
        specs={[
          { prop: "Высота", value: "32 (h-8)" },
          { prop: "Фон / рамка", value: "--accent / --border" },
          { prop: "Скругление", value: "3px · rounded-1" },
          { prop: "Тень", value: "shadow-md" },
          { prop: "Отступ", value: "px-1 · gap-1 (4)" },
          { prop: "Кнопки", value: "Button xs · close icon-xs ghost" },
        ]}
      >
        <div className="inline-flex h-8 items-center gap-1 rounded-1 border border-border bg-accent px-1 shadow-md">
          <Button size="xs"><Plus className="size-3" />Create Card</Button>
          <Button size="xs" variant="destructive"><Strikethrough className="size-3" />Delete Text</Button>
          <Button size="icon-xs" variant="ghost" aria-label="Close text selection menu">
            <X className="size-3" />
          </Button>
        </div>
      </ComponentSpec>

      <ComponentSpec
        title="Стопка перетаскивания"
        summary="Превью группового drag в стиле macOS: смещённые карточки без мутации раскладки ленты."
        specs={[
          { prop: "Карточка", value: "border --border · bg --card · rounded-1 · shadow-md" },
          { prop: "Смещение", value: "left ~9 · top ~7 на слой" },
          { prop: "Поворот", value: "−1°…+1.6° на слой" },
          { prop: "Иконка", value: "GripVertical size-4 (16) · --muted-foreground" },
        ]}
      >
        <div className="relative h-28 w-72">
          {[2, 1, 0].map((index) => (
            <div
              key={index}
              className="absolute h-20 w-56 rounded-1 border border-border bg-card shadow-md"
              style={{
                left: index * 9,
                top: index * 7,
                transform: `rotate(${index === 0 ? -1 : index === 1 ? 0.7 : 1.6}deg)`,
              }}
            >
              <div className="flex h-full items-center gap-3 p-3">
                <GripVertical className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-base font-semibold">3 selected cards</p>
                  <p className="text-sm text-muted-foreground">Drag stack preview</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </ComponentSpec>
    </BenchSection>
  );
}

function ClipperParitySection() {
  return (
    <BenchSection
      title="Веб-клиппер"
      description="Полные состояния popup на реальной ширине 360px. Компоненты импортированы из extension/popup."
    >
      <div className="grid gap-6 xl:grid-cols-2">
        <ClipperFrame type="content" />
        <ClipperFrame type="screenshot" />
        <ClipperFrame type="link" />
        <ClipperFrame type="image" />
      </div>
    </BenchSection>
  );
}

function ClipperFrame({ type }: { type: ClipPreviewType }) {
  const hasTypeRow = type !== "image";
  const title = type === "image" ? "Клиппер · изображение — без строки Type" : `Клиппер · ${type} — ширина 360`;

  return (
    <div>
      <p className="mb-2 font-mono text-sm text-muted-foreground">{title}</p>
      <div className="w-[360px] overflow-hidden rounded-1 border border-border bg-background shadow-md">
        <VaultSelect
          value="/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine"
          options={[
            "/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Mine",
            "/Users/i_iii/Library/Mobile Documents/com~apple~CloudDocs/Journal",
          ]}
          onChange={() => {}}
          onClose={() => {}}
        />

        {hasTypeRow && (
          <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-chrome px-4">
            <span className="text-base text-muted-foreground">Type:</span>
            <TypeSwitcher current={type} onChange={() => {}} />
          </div>
        )}

        <div className="mine-clipper-body" data-after-type={hasTypeRow ? "true" : "false"}>
          <div className="mine-clipper-section-stack">
            {type === "content" && <ClipperContentPreview />}
            {type === "screenshot" && (
              <ScreenshotPreview
                dataUrl={SCREENSHOT_DATA_URL}
                cropSupported
                onCrop={() => {}}
                onRetake={() => {}}
              />
            )}
            {type === "link" && <ClipperLinkPreview />}
            {type === "image" && <ClipperImagePreview />}
          </div>

          <ChannelList
            channels={CLIPPER_CHANNELS}
            selectedTags={["beautiful-web"]}
            recentTags={["beautiful-web", "catalogs"]}
            onToggle={() => {}}
            onCreate={() => {}}
          />

          <div className="mine-clipper-section-stack">
            <SaveButton count={1} saving={false} onClick={() => {}} />
            {type === "content" && (
              <StatusBar message="Saved state / error state uses same slot" type="success" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ClipperContentPreview() {
  return (
    <div className="max-h-[280px] overflow-y-auto rounded-1 border border-border p-2">
      <div className="mine-clipper-article-preview prose prose-sm mt-1.5 max-w-none">
        <h1>Design systems are contracts</h1>
        <p>
          A component page is useful only when it reuses production primitives
          and makes drift visible before it reaches the interface.
        </p>
        <img src={ARTICLE_IMAGE_DATA_URL} alt="" loading="lazy" />
      </div>
    </div>
  );
}

function ClipperLinkPreview() {
  return (
    <div className="space-y-1.5 rounded-1 border border-border p-2">
      <div className="rounded-1 bg-accent">
        <img
          src={ARTICLE_IMAGE_DATA_URL}
          alt=""
          className="mx-auto block max-h-[120px] w-auto max-w-full rounded-1 object-contain"
        />
      </div>
      <p className="truncate text-sm font-semibold">A quiet interface contract</p>
      <p className="line-clamp-2 text-sm text-muted-foreground">
        Link previews keep the same type scale and surface hierarchy as cards.
      </p>
      <p className="truncate text-sm text-tertiary-foreground">example.com</p>
    </div>
  );
}

function ClipperImagePreview() {
  return (
    <div className="rounded-1 border border-border bg-accent">
      <img
        src={ARTICLE_IMAGE_DATA_URL}
        alt=""
        className="mx-auto block max-h-[220px] w-auto max-w-full rounded-1 object-contain"
      />
    </div>
  );
}

function FeedCardPreview({ state }: { state: "default" | "keyboard" | "selected" }) {
  const label = state === "default"
    ? "default"
    : state === "keyboard"
      ? "keyboard focus"
      : "batch selected";

  return (
    <div className="relative">
      {state === "selected" && (
        <div className="absolute -inset-[3px] border-2 border-[var(--feed-selection-frame)]" />
      )}
      <div className="relative border border-border bg-card">
        <div className="relative overflow-hidden bg-accent">
          <img src={ARTICLE_IMAGE_DATA_URL} alt="" className="block aspect-[4/3] w-full object-cover" />
          {state === "keyboard" && (
            <div className="absolute inset-0 bg-[var(--graphic-card-focus-overlay)]" />
          )}
        </div>
        <div className="p-3">
          <p className="text-base font-semibold text-foreground">{label}</p>
          <p className="mt-1 text-base text-muted-foreground">
            Graphic card surface, card radius 0, hover controls are separate.
          </p>
        </div>
      </div>
    </div>
  );
}

function TokenPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-1 border border-border p-4">
      <p className="mb-3 font-mono text-sm text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function ColorTokenChip({ token, use }: { token: string; use: string }) {
  return (
    <div className="grid grid-cols-[48px_1fr] gap-3 rounded-1 border border-border p-2">
      <div
        className="size-12 rounded-1 border border-border"
        style={{ background: `var(${token})` }}
      />
      <div className="min-w-0">
        <p className="truncate font-mono text-sm text-foreground">{token}</p>
        <CssVariableValue token={token} />
        <p className="mt-0.5 text-sm text-muted-foreground">{use}</p>
      </div>
    </div>
  );
}

function DimensionTokenChip({
  token,
  label,
  kind,
}: {
  token: string;
  label: string;
  kind: "spacing" | "radius";
}) {
  return (
    <div className="grid grid-cols-[64px_1fr] gap-3 rounded-1 border border-border p-2">
      <div className="flex h-12 items-center justify-center">
        {kind === "spacing" ? (
          <div className="h-4 bg-foreground" style={{ width: `var(${token})` }} />
        ) : (
          <div className="size-10 border border-foreground" style={{ borderRadius: `var(${token})` }} />
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate font-mono text-sm text-foreground">{token}</p>
        <p className="text-sm text-muted-foreground">{label}</p>
        <CssVariableValue token={token} />
      </div>
    </div>
  );
}

function CssVariableValue({ token }: { token: string }) {
  const value = useCssVariableValue(token);
  return (
    <p className="truncate font-mono text-sm text-tertiary-foreground">
      {value || `var(${token})`}
    </p>
  );
}

function useCssVariableValue(token: string): string {
  const [value, setValue] = useState("");

  useEffect(() => {
    const readValue = () => {
      setValue(window.getComputedStyle(document.documentElement).getPropertyValue(token).trim());
    };
    readValue();

    const observer = new MutationObserver(readValue);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [token]);

  return value;
}

type SpecRow = { readonly prop: string; readonly value: string };

function ComponentSpec({
  title,
  summary,
  specs,
  children,
}: {
  title: string;
  summary?: string;
  specs: readonly SpecRow[];
  children: ReactNode;
}) {
  return (
    <div className="rounded-1 border border-border p-4">
      <p className="font-mono text-base font-semibold text-foreground">{title}</p>
      {summary && (
        <p className="mt-1 max-w-2xl text-base text-muted-foreground">{summary}</p>
      )}
      <div className="mt-3 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-wrap items-center gap-2 self-start rounded-1 border border-dashed border-border bg-accent/40 p-3">
          {children}
        </div>
        <SpecTable specs={specs} />
      </div>
    </div>
  );
}

function SpecTable({ specs }: { specs: readonly SpecRow[] }) {
  return (
    <dl className="grid h-fit grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-1 border border-border p-3 font-mono text-sm">
      {specs.map((row) => (
        <div key={`${row.prop}:${row.value}`} className="contents">
          <dt className="text-muted-foreground">{row.prop}</dt>
          <dd className="break-words text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BenchSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 max-w-3xl text-base text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="grid gap-4">
        {children}
      </div>
    </section>
  );
}

function ContractCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-1 border border-border bg-card p-4">
      <p className="font-mono text-sm text-foreground">{title}</p>
      <p className="mt-2 text-base text-muted-foreground">{children}</p>
    </div>
  );
}

function AppIconTemplateBench() {
  return (
    <BenchSection
      title="Иконка приложения"
      description="Исходник иконки и превью под маской: иконка приложения — ассет дизайн-системы."
    >
      <div className="grid max-w-xl gap-4 [grid-template-columns:repeat(auto-fill,minmax(304px,1fr))]">
        <RedactionIconCard variant={actualMineIconVariant} />
      </div>
    </BenchSection>
  );
}

function RedactionIconCard({ variant }: { variant: RedactionIconVariant }) {
  return (
    <div className="rounded-1 border border-border bg-background p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm text-foreground">{variant.label}</p>
          <p className="font-mono text-sm text-muted-foreground">строчная m</p>
        </div>
        <div
          className="text-lg leading-6 text-foreground"
          style={redactionGlyphStyle(variant, 24)}
        >
          {variant.glyph}
        </div>
      </div>

      <div className="flex items-end gap-3">
        <AppIconSourceTemplate variant={variant} />
        <div className="flex items-end gap-2">
          <AppIconMaskedPreview variant={variant} size={96} label="крупно" />
          <AppIconMaskedPreview variant={variant} size={56} label="средне" />
          <AppIconMaskedPreview variant={variant} size={32} label="мелко" />
        </div>
      </div>
    </div>
  );
}

function AppIconSourceTemplate({ variant }: { variant: RedactionIconVariant }) {
  const size = 112;
  const grid = Math.max(1, Math.round(size / 8));

  return (
    <div className="flex flex-col gap-2">
      <div
        className="relative border border-border bg-white"
        style={{
          width: size,
          height: size,
        }}
      >
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #000 1px, transparent 1px), linear-gradient(to bottom, #000 1px, transparent 1px)",
            backgroundSize: `${grid}px ${grid}px`,
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <RedactionGlyph variant={variant} size={size * 0.72} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-sm text-muted-foreground">
        <span>исходник</span>
        <span>1024</span>
      </div>
    </div>
  );
}

function AppIconMaskedPreview({
  variant,
  size,
  label,
}: {
  variant: RedactionIconVariant;
  size: number;
  label: string;
}) {
  const grid = Math.max(1, Math.round(size / 8));

  return (
    <div className="flex flex-col gap-2">
      <div
        className="relative overflow-hidden border border-border bg-white shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
        style={{
          width: size,
          height: size,
          borderRadius: `${size * 0.2237}px`,
        }}
      >
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #000 1px, transparent 1px), linear-gradient(to bottom, #000 1px, transparent 1px)",
            backgroundSize: `${grid}px ${grid}px`,
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <RedactionGlyph variant={variant} size={size * 0.72} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-sm text-muted-foreground">
        <span>{label}</span>
      </div>
    </div>
  );
}

function RedactionGlyph({ variant, size }: { variant: RedactionIconVariant; size: number }) {
  return (
    <div
      className="select-none text-black"
      style={redactionGlyphStyle(variant, size)}
    >
      {variant.glyph}
    </div>
  );
}

function redactionGlyphStyle(variant: RedactionIconVariant, size: number): CSSProperties {
  return {
    fontFamily: `"${variant.family}", "Redaction", serif`,
    fontSize: size,
    fontStyle: variant.style === "italic" ? "italic" : "normal",
    fontWeight: 400,
    lineHeight: 1,
    letterSpacing: 0,
  };
}

function sampleBlock(slug: string, title: string, blockType: LightBlock["block_type"]): LightBlock {
  return {
    id: slug.length,
    slug,
    card_kind: blockType === "image" ? "media" : "article",
    block_type: blockType,
    title,
    content_heading: title,
    display_title: title,
    fallback_label: title,
    url: "https://example.com",
    media_file: blockType === "image" ? "image.jpg" : null,
    thumbnail: null,
    saved_at: "2026-05-31T00:00:00Z",
    width: 960,
    height: 560,
    author: "Mine",
    body: "Sample block for design-system bench.",
    preview_text: "Sample block for design-system bench.",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    search_match: null,
  };
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
