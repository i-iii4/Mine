// Every edge state on one page, so nobody has to produce them.
//
// A folder on an unplugged drive, a file iCloud decided to hold, a brand-new
// space, a clipper that was never connected: waiting for these to happen is not
// review. They are laid out here with fixed inputs, and a state counts as done
// only when it appears in this section. See DESIGN_SYSTEM.md, «Витрина
// состояний и краёв».
//
// Production components wherever a state has one — a redrawn copy would drift
// away from the real screen and nobody would notice. Only states that live
// inside private card internals are redrawn, and they say so.

import type { ReactNode } from "react";
import { Cloud, CloudDownload, ImageOff, RefreshCw } from "lucide-react";
import { ActivityIndicators } from "@/components/ActivityIndicators";
import { CloudBadge } from "@/components/CloudBadge";
import { CloudDisclaimer } from "@/components/CloudDisclaimer";
import { CloudRecommendationCard } from "@/components/CloudRecommendation";
import { IndexingProgress } from "@/components/IndexingProgress";
import { EmptySpaceOnboarding } from "@/components/EmptySpaceOnboarding";
import { FolderConfirmation } from "@/components/FolderConfirmation";
import { SpaceUnavailable } from "@/components/SpaceUnavailable";
import { ClipperStatus } from "@/settings/ClipperStatus";
import {
  CLOUD_BADGE_DELAY_MS,
  CLOUD_DOWNLOADING_LABEL,
  CLOUD_OFFLINE_LABEL,
} from "@/lib/cloudContent";
import type { ClipperSetupStatus } from "@/types";

/// A state that exists in the product, and the condition that produces it.
function StateCase({
  name,
  when,
  drawn = false,
  pending = false,
  children,
}: {
  name: string;
  when: string;
  /// The state lives inside a private card internal and is redrawn here.
  drawn?: boolean;
  /// The state is specified but not in the product yet.
  pending?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid content-start gap-3 rounded-1 border border-border p-4">
      <div>
        <div className="flex items-baseline gap-2">
          <p className="text-base font-semibold text-foreground">{name}</p>
          {drawn && (
            <span className="font-mono text-sm text-muted-foreground">перерисовано</span>
          )}
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

const CLIPPER_BROWSERS: ClipperSetupStatus["browsers"] = [
  { label: "Chrome", detected: true, connected: false },
  { label: "Dia", detected: true, connected: false },
];

function clipperStatus(overrides: Partial<ClipperSetupStatus>): ClipperSetupStatus {
  return {
    host_installed: false,
    host_current: false,
    app_version: "0.1.0",
    browsers: CLIPPER_BROWSERS,
    ...overrides,
  };
}

export function EdgeStatesSection() {
  return (
    <section className="grid gap-4" data-design-edge-states="">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Состояния и края</h2>
        <p className="mt-1 max-w-3xl text-base text-muted-foreground">
          То, что нельзя увидеть по требованию: пропавшая папка, выгруженный из
          iCloud файл, новое пространство, неподключённый клиппер. Состояние
          считается сделанным только когда оно появилось здесь. Пометка
          «перерисовано» означает, что оригинал живёт внутри приватной части
          карточки; «нет в продукте» — что состояние описано, но не реализовано.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <StateCase
          name="Карточка ждёт содержимое"
          when="Превью ещё не построено. Обычная заглушка без объяснений — это норма, а не ошибка."
          drawn
        >
          <CardFrame>
            <div className="absolute inset-0 grid place-items-center">
              <div className="text-center">
                <ImageOff className="mx-auto size-6 text-muted-foreground/50" aria-hidden="true" />
                <p className="mt-1 text-sm text-foreground">Sunset over the bay</p>
              </div>
            </div>
          </CardFrame>
        </StateCase>

        <StateCase
          name="Та же карточка, содержимое в iCloud"
          when={`Метка появляется только после ${CLOUD_BADGE_DELAY_MS / 1000} с ожидания — быстрый файл не должен ею мигать. Здесь настоящий компонент, поэтому она проявится сама.`}
        >
          <CardFrame>
            <div className="absolute inset-0 grid place-items-center">
              <div className="text-center">
                <ImageOff className="mx-auto size-6 text-muted-foreground/50" aria-hidden="true" />
                <p className="mt-1 text-sm text-foreground">Sunset over the bay</p>
              </div>
            </div>
            <CloudBadge active />
          </CardFrame>
        </StateCase>

        <StateCase
          name="Разворот: оригинал едет"
          when="Превью показывается сразу, оригинал подменяет его. Число появляется, только когда система публикует прогресс, — иначе строка без числа."
          drawn
        >
          <CardFrame>
            <div className="absolute inset-0 bg-component-fill" />
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-card/90 px-3 py-2">
              <CloudDownload className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">{CLOUD_DOWNLOADING_LABEL} · 42%</span>
            </div>
          </CardFrame>
          <div className="mt-2">
            <CardFrame>
              <div className="absolute inset-0 bg-component-fill" />
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-card/90 px-3 py-2">
                <CloudDownload className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm text-muted-foreground">{CLOUD_DOWNLOADING_LABEL}</span>
              </div>
            </CardFrame>
          </div>
        </StateCase>

        <StateCase
          name="Разворот: оригинал недоступен"
          when="Нет сети. Это состояние файла, а не ошибка приложения, и превью остаётся на месте."
          drawn
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
          drawn
        >
          <CardFrame>
            <div className="absolute inset-0 bg-component-fill" />
            <span className="absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-card/80">
              <span className="ml-0.5 border-y-[6px] border-l-[10px] border-y-transparent border-l-foreground" />
            </span>
            <span className="absolute right-2 top-2 flex items-center rounded-1 bg-card/80 px-1.5 py-0.5 backdrop-blur-sm">
              <Cloud className="size-3 text-muted-foreground" aria-hidden="true" />
            </span>
          </CardFrame>
        </StateCase>

        <StateCase
          name="Медиафайл пропал"
          when="Файл удалён вне приложения. Причина названа прямо, без разговоров про форматы."
          drawn
        >
          <CardFrame>
            <div className="absolute inset-0 grid place-items-center">
              <div className="px-4 text-center">
                <ImageOff className="mx-auto size-6 text-muted-foreground/50" aria-hidden="true" />
                <p className="mt-1 text-sm text-foreground">Media file is missing</p>
              </div>
            </div>
          </CardFrame>
        </StateCase>

        <StateCase
          name="Индикаторы в верхней панели"
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
          name="Прогресс первичной индексации"
          when="Первое подключение большого пространства: числа вместо бесконечного индикатора, показывается вместо онбординга пустой ленты — «пространство пусто» было бы неправдой."
        >
          <div className="h-64">
            <IndexingProgress spaceName="Mine" processed={1284} total={3000} />
          </div>
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

        <StateCase
          name="Постоянное объяснение в настройках"
          when="Раздел Spaces. Живёт всегда, потому что пространство в iCloud продолжает вести себя так же."
        >
          <CloudDisclaimer offloadedCount={12} onRevealSpace={() => {}} />
          <div className="mt-3">
            <CloudDisclaimer offloadedCount={0} />
          </div>
        </StateCase>

        <StateCase
          name="Клиппер: не подключён"
          when="Первый запуск. Расширение ещё не связано с приложением."
        >
          <ClipperStatus status={clipperStatus({})} />
        </StateCase>

        <StateCase
          name="Клиппер: подключён"
          when="Звено установлено, версия совпадает с приложением."
        >
          <ClipperStatus
            status={clipperStatus({
              host_installed: true,
              host_current: true,
              browsers: CLIPPER_BROWSERS.map((browser) => ({ ...browser, connected: true })),
            })}
          />
        </StateCase>

        <StateCase
          name="Клиппер: версия разошлась"
          when="Приложение обновилось, звено осталось прежним. Без этой строки сохранение просто перестало бы работать."
        >
          <ClipperStatus
            status={clipperStatus({
              host_installed: true,
              host_current: false,
              browsers: [
                { label: "Chrome", detected: true, connected: true },
                { label: "Dia", detected: true, connected: false },
              ],
            })}
          />
        </StateCase>

        <StateCase
          name="Клиппер: ни одного браузера"
          when="Ставить некуда — приложение не делает вид, что нашло Chrome."
        >
          <ClipperStatus status={clipperStatus({ browsers: [] })} />
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
        name="Подтверждение непустой папки"
        when="Выбор папки рекурсивен и необратим, а ~/Documents — один промах. Счёт показывается до начала работы."
      >
        <ScreenFrame>
          <FolderConfirmation
            path="/Users/you/Documents"
            preview={{ markdown_files: 120, media_files: 40, other_files: 8 }}
            onConfirm={() => {}}
            onChooseAnother={() => {}}
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

      <div className="rounded-1 border border-border p-4">
        <p className="flex items-center gap-2 text-base font-semibold text-foreground">
          <RefreshCw className="size-4" aria-hidden="true" />
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
