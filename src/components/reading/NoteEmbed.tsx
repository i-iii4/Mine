import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ReadOnlyCardPreview } from "@/components/Card";
import { getBlock, resolveNoteLink } from "@/lib/commands";
import { logFailure } from "@/lib/appLog";
import type { IndexedBlock } from "@/types";

/** A note embed's card: as wide as the previews of related notes, the graph
 *  and the sidebar (SPEC_CARD_STATES.md, С10.4), narrower only in a narrower
 *  column. */
export const NOTE_EMBED_WIDTH_PX = 240;
/** The log line of an embed whose note could not be looked up. */
export const NOTE_EMBED_LOOKUP_FAILED_TITLE = "Could not find the embedded note";

/** What a note embed knows of its target. */
export type NoteEmbedLookup =
  | { state: "loading" }
  | { state: "found"; block: IndexedBlock }
  | { state: "missing" };

const LOADING: NoteEmbedLookup = { state: "loading" };
const MISSING: NoteEmbedLookup = { state: "missing" };

/**
 * The note embeds of one article, looked up together (SPEC_READING_MODE.md,
 * Ч11.4): every embed asks for its target when the body is shown; the
 * targets asked in one commit are resolved in one pass (`resolveNoteLink`,
 * then `getBlock`), and a target written twice is looked up once. `settled`
 * resolves when no lookup is under way, so the jump to a block can wait for
 * the embeds' first answers. `refresh`, on `vault-refreshed`, looks every
 * known target up again and keeps what is shown until the new answer comes:
 * a renamed, deleted or new note changes its embed.
 */
export class NoteEmbedLookups {
  private readonly results = new Map<string, NoteEmbedLookup>();
  private readonly listeners = new Set<() => void>();
  private readonly queued = new Set<string>();
  private pendingCount = 0;
  private settledWaiters: Array<() => void> = [];
  private flushScheduled = false;
  private generation = 0;

  constructor(private readonly sourceSlug: string | undefined) {}

  /** What is known of `target` now. */
  lookup(target: string): NoteEmbedLookup {
    return this.results.get(target) ?? LOADING;
  }

  /** Look `target` up, unless it is known or under way. */
  request(target: string): void {
    if (this.results.has(target) || this.queued.has(target)) return;
    this.results.set(target, LOADING);
    this.enqueue(target);
  }

  /** Look every known target up again (`vault-refreshed`). */
  refresh(): void {
    this.generation += 1;
    for (const target of this.results.keys()) this.enqueue(target);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Resolves when no lookup is queued or under way. */
  settled(): Promise<void> {
    if (this.pendingCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.settledWaiters.push(resolve));
  }

  private enqueue(target: string) {
    if (this.queued.has(target)) return;
    this.queued.add(target);
    this.pendingCount += 1;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush() {
    this.flushScheduled = false;
    const targets = [...this.queued];
    this.queued.clear();
    const generation = this.generation;
    const blocks = new Map<string, Promise<IndexedBlock | null>>();
    const blockOf = (slug: string) => {
      let block = blocks.get(slug);
      if (!block) {
        block = getBlock(slug);
        blocks.set(slug, block);
      }
      return block;
    };
    for (const target of targets) {
      const answer = this.sourceSlug
        ? resolveNoteLink(this.sourceSlug, target).then((slug) => (slug ? blockOf(slug) : null))
        : Promise.resolve(null);
      void answer
        .then(
          (block): NoteEmbedLookup => (block ? { state: "found", block } : MISSING),
          (error: unknown): NoteEmbedLookup => {
            logFailure(NOTE_EMBED_LOOKUP_FAILED_TITLE, error);
            return MISSING;
          },
        )
        .then((result) => {
          // A refresh asked again meanwhile: its own answer is the one shown.
          if (generation === this.generation || this.results.get(target) === LOADING) {
            this.results.set(target, result);
            for (const listener of this.listeners) listener();
          }
          this.pendingCount -= 1;
          if (this.pendingCount === 0) {
            const waiters = this.settledWaiters;
            this.settledWaiters = [];
            for (const resolve of waiters) resolve();
          }
        });
    }
  }
}

/** The lookups of the embeds of the article of `sourceSlug`, refreshed on
 *  `vault-refreshed`. */
export function useNoteEmbedLookups(sourceSlug: string | undefined): NoteEmbedLookups {
  const lookups = useMemo(() => new NoteEmbedLookups(sourceSlug), [sourceSlug]);
  useEffect(() => {
    const refresh = () => lookups.refresh();
    window.addEventListener("vault-refreshed", refresh);
    return () => window.removeEventListener("vault-refreshed", refresh);
  }, [lookups]);
  return lookups;
}

/** The card's width: 240, or the column's when it is narrower. `shown`
 *  changes when the embed's element comes or goes. */
function useEmbedWidth(shown: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(NOTE_EMBED_WIDTH_PX);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => {
      const available = node.clientWidth;
      setWidth(available > 0 ? Math.min(NOTE_EMBED_WIDTH_PX, available) : NOTE_EMBED_WIDTH_PX);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);
  return { ref, width };
}

/**
 * A note embedded in the article, `![[Note]]` (SPEC_READING_MODE.md, Ч11):
 * the note's card as the feed draws it, unfolded, without a shadow, centred on
 * a line of its own. Until its lookup answers it takes no room; a note that is
 * not there is one quiet line with the name as written (or the caption), not
 * pressable, like a missing note among related notes. The card shows the
 * note's preview, not its body, so an embed never unfolds into the note's own
 * embeds: a note that embeds itself, or a ring of two, shows one card each.
 */
export function NoteEmbed({
  lookups,
  target,
  fragment,
  label,
  vaultPath,
  thumbsRootPath,
}: {
  lookups: NoteEmbedLookups;
  target: string;
  fragment: string | null;
  label: string | null;
  vaultPath: string;
  thumbsRootPath?: string;
}) {
  const lookup = useSyncExternalStore(lookups.subscribe, () => lookups.lookup(target), () => LOADING);
  const { ref, width } = useEmbedWidth(lookup.state);

  useEffect(() => {
    lookups.request(target);
  }, [lookups, target]);

  if (lookup.state === "loading") return null;
  if (lookup.state === "missing") {
    const written = fragment === null ? target : `${target}#${fragment}`;
    return (
      <span
        ref={ref}
        className="text-muted-foreground"
        title={`No note named “${target}”`}
        data-note-embed="missing"
      >
        {label || written}
      </span>
    );
  }
  return (
    <span ref={ref} data-note-embed="found" data-note-embed-slug={lookup.block.slug}>
      <ReadOnlyCardPreview
        block={lookup.block}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath}
        width={width}
        shadow="none"
      />
    </span>
  );
}
