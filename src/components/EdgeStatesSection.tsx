// Every edge state on one page, so nobody has to produce them.
//
// A folder on an unplugged drive, a file iCloud decided to hold, a brand-new
// space and the steps to its extension: waiting for these to happen is not
// review. They are laid out here with fixed inputs, and a state counts as done
// only when it appears in this section. See DESIGN_SYSTEM.md, «Витрина
// состояний и краёв».
//
// Production components only. A copy drifts away from the real screen and
// nobody notices — which is exactly what happened, and why the "redrawn" label
// that used to excuse it is gone: a state either shows the product's own
// component or does not belong on this page. Anything still assembled here is
// a frame around a real component, never a substitute for one.

import type { ReactNode } from "react";
import { CloudDownload, Play, RefreshCw } from "lucide-react";
import { ActivityIndicators } from "@/components/ActivityIndicators";
import { Card, CardPreviewPendingSurface, CardSourcelessSurface } from "@/components/Card";
import { SidebarTagRowDragPreview } from "@/components/Sidebar";
import { computeCardHeight } from "@/lib/cardHeight";
import { FeedShowContext } from "@/lib/feedDisplay";
import type { LightBlock, PreviewCard } from "@/types";
import { CloudRecommendationCard } from "@/components/CloudRecommendation";
import { IndexingProgress } from "@/components/IndexingProgress";
import { FirstCardMarkerCard } from "@/components/FirstCardMarker";
import { EmptySpaceOnboarding } from "@/components/EmptySpaceOnboarding";
import { SpaceUnavailable } from "@/components/SpaceUnavailable";
import {
  CLOUD_BADGE_DELAY_MS,
  CLOUD_DOWNLOADING_LABEL,
  CLOUD_OFFLINE_LABEL,
} from "@/lib/cloudContent";

/// A state that exists in the product, and the condition that produces it.
function StateCase({
  name,
  when,
  pending = false,
  children,
}: {
  name: string;
  when: string;
  /// The state is specified but not in the product yet.
  pending?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-3 rounded-1 border border-border p-4">
      <div>
        <div className="flex items-baseline gap-2">
          <p className="text-base font-semibold text-foreground">{name}</p>
          {pending && (
            <span className="font-mono text-sm text-destructive">нет в продукте</span>
          )}
        </div>
        <p className="mt-1 text-base text-muted-foreground">{when}</p>
      </div>
      <div className="rounded-1 bg-accent p-4">{children}</div>
    </div>
  );
}

/// Card proportions, so the states read at the size they will have.
function CardFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative aspect-[4/3] w-56 overflow-hidden bg-card">{children}</div>
  );
}

/// A window-sized screen, boxed so several fit on one page.
function ScreenFrame({ children }: { children: ReactNode }) {
  return <div className="h-96 overflow-hidden rounded-1 border border-border">{children}</div>;
}

/// Pictures served with the app, so showcase cards paint real images.
const SHOWCASE_PICTURES = [
  "/feed-scroll-audit/audit-0.svg",
  "/feed-scroll-audit/audit-1.svg",
  "/feed-scroll-audit/audit-2.svg",
  "/feed-scroll-audit/audit-3.svg",
  "/feed-scroll-audit/audit-4.svg",
  "/feed-scroll-audit/audit-5.svg",
];

const SHOWCASE_WIDTH = 224;

function showcaseBlock(id: number, overrides: Partial<LightBlock>): LightBlock {
  return {
    id,
    slug: `design-showcase-${id}`,
    card_kind: "article",
    block_type: "article",
    title: null,
    content_heading: null,
    display_title: null,
    fallback_label: `Showcase ${id}`,
    url: "https://example.test/design-showcase",
    media_file: null,
    thumbnail: null,
    saved_at: "2026-10-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    search_match: null,
    collections: [],
    ...overrides,
  };
}

/// A post with one picture under its title and text.
function showcasePost(id: number, picture: string): LightBlock {
  return showcaseBlock(id, {
    title: "Lunar Orbiter 2, frame 2021",
    preview_text: "The first oblique photograph of the Moon, taken from orbit in 1966.",
    body: "The first oblique photograph of the Moon, taken from orbit in 1966.",
    author: "@orbiter",
    collections: ["Экзопланеты", "Интерфейсы"],
    first_image: picture,
    media_urls: JSON.stringify([picture]),
    preview_manifest: JSON.stringify({
      kind: "image",
      primary_preview_path: picture,
      width: 800,
      height: 600,
      preview_width: 800,
      preview_height: 600,
      tiles: [{
        source_path: picture, preview_path: picture, width: 800, height: 600,
        preview_width: 800, preview_height: 600, is_video: false, is_video_poster: false,
      }],
      overflow_count: 0,
    }),
  });
}

const SHOWCASE_TEXT_POST = showcaseBlock(9103, {
  title: "Notes on calm interfaces",
  preview_text: "A calm interface answers when asked and stays still otherwise. Motion is a reply, never decoration.",
  body: "A calm interface answers when asked and stays still otherwise. Motion is a reply, never decoration.",
  author: "@mine",
});

const SHOWCASE_PICTURE = showcaseBlock(9104, {
  card_kind: "media",
  block_type: "image",
  media_file: "Media/orbit.jpg",
  preview_manifest: JSON.stringify({
    kind: "image",
    primary_preview_path: SHOWCASE_PICTURES[2],
    width: 600,
    height: 800,
    preview_width: 600,
    preview_height: 800,
    tiles: [],
    overflow_count: 0,
  }),
});

/// A real feed card at the size the feed would lay it out, with its hover
/// buttons, so the lift answers the pointer here exactly as in the feed.
function ShowcaseCard({ block }: { block: LightBlock }) {
  const height = computeCardHeight(block, SHOWCASE_WIDTH, null, "cards");
  return (
    <FeedShowContext.Provider value="cards">
      <div style={{ width: SHOWCASE_WIDTH, height }}>
        <Card
          block={block}
          vaultPath=""
          thumbsRootPath=""
          onClick={() => {}}
          tags={[]}
          onToggleTag={() => {}}
          onCreateAndAssign={() => {}}
          onRequestRename={() => {}}
          onRequestDelete={() => {}}
        />
      </div>
    </FeedShowContext.Provider>
  );
}

function showcaseThumbnails(count: number): PreviewCard[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `design-showcase-thumb-${index}`,
    url: SHOWCASE_PICTURES[index % SHOWCASE_PICTURES.length]!,
    text: false,
    hasThumb: true,
  }));
}

/// One variant of a showcase case, captioned.
function Variant({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      {children}
      <span className="font-mono text-sm text-muted-foreground">{caption}</span>
    </div>
  );
}

export function EdgeStatesSection() {
  return (
    <section className="grid gap-4" data-design-edge-states="">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Состояния и края</h2>
        <p className="mt-1 max-w-3xl text-base text-muted-foreground">
          То, что нельзя увидеть по требованию: пропавшая папка, выгруженный из
          iCloud файл, новое пространство, неподключённое расширение. Состояние
          считается сделанным только когда оно появилось здесь. Пометка
          «перерисовано» означает, что оригинал живёт внутри приватной части
          карточки; «нет в продукте» — что состояние описано, но не реализовано.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <StateCase
          name="Карточка ждёт содержимое"
          when="Превью ещё не построено: идёт фоновый проход превью пространства. Заливка скелета ленты без иконок и слов, в той же геометрии. Это норма, а не ошибка."
        >
          <CardFrame>
            <CardPreviewPendingSurface />
          </CardFrame>
        </StateCase>

        <StateCase
          name="Та же карточка, содержимое в iCloud"
          when={`Метка в левом верхнем углу, потому что правый занят hover-действиями карточки. Появляется после ${CLOUD_BADGE_DELAY_MS / 1000} с ожидания; здесь настоящий компонент, она проявится сама.`}
        >
          <CardFrame>
            <CardPreviewPendingSurface contentInCloud />
          </CardFrame>
        </StateCase>

        <StateCase
          name="Разворот: оригинал едет"
          when="Превью показывается сразу, оригинал подменяет его. Число появляется, только когда система публикует прогресс, — иначе строка без числа."
        >
          <CardFrame>
            <div className="absolute inset-0 bg-component-fill" />
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-card/90 px-3 py-2">
              <CloudDownload className="size-[13px] text-muted-foreground" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">{CLOUD_DOWNLOADING_LABEL} · 42%</span>
            </div>
          </CardFrame>
          <div className="mt-2">
            <CardFrame>
              <div className="absolute inset-0 bg-component-fill" />
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-card/90 px-3 py-2">
                <CloudDownload className="size-[13px] text-muted-foreground" aria-hidden="true" />
                <span className="text-sm text-muted-foreground">{CLOUD_DOWNLOADING_LABEL}</span>
              </div>
            </CardFrame>
          </div>
        </StateCase>

        <StateCase
          name="Разворот: копирование ждёт содержимое"
          when="Копирование читает файл, а чтение файла из iCloud сначала тянет его. Быстрое копирование индикатора не видит — он появляется только когда ожидание пережило общую задержку."
        >
          <CardFrame>
            <div className="absolute inset-0 bg-component-fill" />
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-card/90 px-3 py-2">
              <CloudDownload className="size-[13px] text-muted-foreground" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">{CLOUD_DOWNLOADING_LABEL}</span>
            </div>
          </CardFrame>
        </StateCase>

        <StateCase
          name="Разворот: оригинал недоступен"
          when="Нет сети. Это состояние файла, а не ошибка приложения, и превью остаётся на месте."
        >
          <CardFrame>
            <div className="absolute inset-0 bg-component-fill" />
            <div className="absolute inset-x-0 bottom-0 grid gap-1 bg-card/90 px-3 py-2">
              <span className="text-sm text-muted-foreground">{CLOUD_OFFLINE_LABEL}</span>
              <span className="text-sm text-foreground underline">Try again</span>
            </div>
          </CardFrame>
        </StateCase>

        <StateCase
          name="Видео, содержимого нет на диске"
          when="Автовоспроизведение не запускается никогда: показывается локальный постер."
        >
          <CardFrame>
            <div className="absolute inset-0 bg-component-fill" />
            <span className="absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-card/80">
              <Play className="ml-0.5 size-[13px] fill-foreground text-foreground" aria-hidden="true" />
            </span>
          </CardFrame>
        </StateCase>

        <StateCase
          name="Медиафайл пропал"
          when="Файл удалён вне приложения. Карточка называет своё имя и имя файла, который искать на диске."
        >
          <CardFrame>
            <CardSourcelessSurface label="Sunset over the bay" mediaFile="sunset-over-the-bay.jpg" />
          </CardFrame>
        </StateCase>

        <StateCase
          name="Превью не читается"
          when="Файл кэша повреждён: он существует, проходит проверку по заголовку и не отдаёт пиксели. Исходный файл не тронут. Без собственного имени это состояние неотличимо от «ещё не готово»."
        >
          <CardFrame>
            <CardSourcelessSurface
              label="Sunset over the bay"
              mediaFile="sunset-over-the-bay.jpg"
              previewUnreadable
            />
          </CardFrame>
        </StateCase>

        <StateCase
          name="Индикаторы в верхней панели — на целом экране"
          when="Место индикаторов: правый край верхней панели, рядом со сведениями пространства. Ниже — те же индикаторы крупно."
        >
          {/* Marked as context: this draws where a component lives, not one of
              its variants, so the variant counters in the browser audit skip
              it instead of being bumped every time a context is added. */}
          <div className="overflow-hidden rounded-1 border border-border" data-showcase-context="">
            <div className="flex h-8 items-center gap-3 border-b border-border bg-chrome px-3">
              <span className="w-20 shrink-0" aria-hidden="true" />
              <span className="text-base font-semibold text-foreground">Mine</span>
              <span className="font-mono text-sm text-tertiary-foreground">
                566 elements · 1.2 GB
              </span>
              <span className="ml-auto">
                <ActivityIndicators cloudPending={12} indexing onRevealSpace={() => {}} />
              </span>
            </div>
            <div className="h-24 bg-background" />
          </div>
        </StateCase>

        <StateCase
          name="Индикаторы крупно"
          when="Две разные работы — две разные иконки. Одна крутилка сказала бы только «занято». Нажмите облако: пояснение настоящее."
        >
          <div className="flex items-center gap-4">
            <ActivityIndicators cloudPending={12} indexing onRevealSpace={() => {}} />
            <span className="font-mono text-sm text-muted-foreground">
              загрузка из iCloud + индексация
            </span>
          </div>
          <div className="mt-3 flex items-center gap-4">
            <ActivityIndicators cloudPending={0} indexing />
            <span className="font-mono text-sm text-muted-foreground">только индексация</span>
          </div>
          <div className="mt-3 flex items-center gap-4">
            <ActivityIndicators cloudPending={3} indexing={false} onRevealSpace={() => {}} />
            <span className="font-mono text-sm text-muted-foreground">только загрузка</span>
          </div>
        </StateCase>

        <StateCase
          name="Тост открытия пространства"
          when="Открытие дольше секунды: одна карточка в правом нижнем углу ведёт обе фазы, сначала индексацию заметок, затем подготовку превью. Числа вместо бесконечного индикатора. Пока лента пуста, есть кнопка другой папки: папка открывается без подтверждения."
        >
          <div className="grid gap-4">
            <Variant caption="заметки, лента пуста">
              <IndexingProgress
                spaceName="Mine"
                step={{ phase: "notes", count: { processed: 284, total: 674 } }}
                onClose={() => {}}
                onChooseAnother={() => {}}
              />
            </Variant>
            <Variant caption="между фазами: превью ещё считают работу">
              <IndexingProgress spaceName="Mine" step={{ phase: "previews", count: null }} onClose={() => {}} />
            </Variant>
            <Variant caption="превью, лента уже с карточками">
              <IndexingProgress
                spaceName="Mine"
                step={{ phase: "previews", count: { processed: 312, total: 643 } }}
                onClose={() => {}}
              />
            </Variant>
          </div>
        </StateCase>

        <StateCase
          name="Полоса миниатюр в левом меню"
          when="Число карточек приходит раньше миниатюр. Пока их нет или превью ещё строятся, свободные места заполняют заглушки той же геометрии, до 20 штук: строка не выглядит пустой и не сдвигается, когда миниатюры приходят."
        >
          <div className="grid w-full max-w-md gap-4">
            <Variant caption="готово: только настоящие миниатюры">
              <div className="h-12">
                <SidebarTagRowDragPreview label="Органика" count={11} cards={showcaseThumbnails(6)} />
              </div>
            </Variant>
            <Variant caption="превью строятся: 3 готовы, остальные места заглушки">
              <div className="h-12">
                <SidebarTagRowDragPreview label="Периферия" count={51} cards={showcaseThumbnails(3)} previewsPending />
              </div>
            </Variant>
            <Variant caption="превью строятся, готовых нет">
              <div className="h-12">
                <SidebarTagRowDragPreview label="Игры" count={6} cards={[]} previewsPending />
              </div>
            </Variant>
          </div>
        </StateCase>

        <StateCase
          name="Подъём карточки при наведении"
          when="Наведите курсор: текст и окно медиа поднимаются, ряд коллекций выезжает из-под нижнего края, картинка смещается на 8 px. Внешний размер карточки не меняется. У текстовой карточки текст уходит за верхний край."
        >
          <div className="flex flex-wrap items-start gap-4">
            <Variant caption="пост">
              <ShowcaseCard block={showcasePost(9102, SHOWCASE_PICTURES[1]!)} />
            </Variant>
            <Variant caption="текст">
              <ShowcaseCard block={SHOWCASE_TEXT_POST} />
            </Variant>
            <Variant caption="картинка">
              <ShowcaseCard block={SHOWCASE_PICTURE} />
            </Variant>
          </div>
        </StateCase>

        <StateCase
          name="Пометка первой карточки"
          when="Один раз после первой сохранённой в пространстве карточки: продукт продаёт локальность, и показать её нужно в момент первого результата."
        >
          <FirstCardMarkerCard
            fileName="Sunset over the bay.md"
            onReveal={() => {}}
            onClose={() => {}}
          />
        </StateCase>

        <StateCase
          name="Всплывающая рекомендация"
          when="Появляется, когда ожидания повторились в разных сессиях: раз открыть старый архив — нормально, жить так — повод объяснить. Закрытие действует на пространство, галочка — навсегда и везде."
        >
          <CloudRecommendationCard
            neverAgain={false}
            onNeverAgainChange={() => {}}
            onReveal={() => {}}
            onClose={() => {}}
          />
        </StateCase>

      </div>

      <StateCase
        name="Пространство недоступно"
        when="Папка переименована, перенесена или на отключённом диске. Привязка не сбрасывается: молча начать с нуля неотличимо от потери всего."
      >
        <ScreenFrame>
          <SpaceUnavailable
            path="/Users/you/Library/Mobile Documents/com~apple~CloudDocs/Mine"
            onReopened={() => {}}
            onForgotten={() => {}}
          />
        </ScreenFrame>
      </StateCase>

      <StateCase
        name="Нет доступа к папке"
        when="Папка на месте, но macOS не даёт её читать — «найдите папку» здесь бесполезный совет. Кнопка ведёт в системные настройки приватности."
      >
        <ScreenFrame>
          <SpaceUnavailable
            path="/Users/you/Documents/Mine"
            reason="access_denied"
            onReopened={() => {}}
            onForgotten={() => {}}
          />
        </ScreenFrame>
      </StateCase>

      <StateCase
        name="Пустое пространство"
        when="Первый экран после выбора папки: два пути наполнения вместо пустоты."
      >
        <ScreenFrame>
          <EmptySpaceOnboarding
            viewportHeight={320}
            onInstallClipper={() => {}}
          />
        </ScreenFrame>
      </StateCase>

      <StateCase
        name="Пустое пространство: как поставить расширение"
        when="После кнопки Install the extension: папка открыта в Finder, одна строка говорит, что с ней делать. Раздела Extension в настройках нет."
      >
        <ScreenFrame>
          <EmptySpaceOnboarding
            viewportHeight={320}
            onInstallClipper={() => {}}
            initialStepsOpen
          />
        </ScreenFrame>
      </StateCase>

      <div className="rounded-1 border border-border p-4">
        <p className="flex items-center gap-2 text-base font-semibold text-foreground">
          <RefreshCw className="size-[13px]" aria-hidden="true" />
          Правило приёмки
        </p>
        <p className="mt-1 max-w-3xl text-base text-muted-foreground">
          Новое состояние интерфейса считается сделанным только когда его видно
          здесь без подготовки условий. Состояние с пометкой «нет в продукте» —
          это не готовая работа, а зафиксированный макет: оно снимается, когда
          появляется реализация.
        </p>
      </div>
    </section>
  );
}
