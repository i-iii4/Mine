import { readFileSync } from "node:fs";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { toggleTaskItem } from "@/lib/commands";
import { clearActionFailures, NOTHING_CHANGED, TASK_TOGGLE_FAILED_TITLE, useActionFailures } from "@/lib/actionFailures";
import type { IndexedBlock, TaskToggleError } from "@/types";
import { indexedBlock } from "@/test/blocks";
import { ArticleMarkdown } from "./ArticleMarkdown";
import { NoteEmbedLookups } from "./NoteEmbed";
import {
  NO_SPACE_FOR_TASK,
  TASK_NOTE_CHANGED,
  TASK_NOTE_GONE,
  TASK_STATE_CHANGED,
  TaskToggles,
  taskInCloudLine,
  taskReadOnlyLine,
  taskToggleErrorLine,
  useTaskToggles,
  type TaskToggleHost,
} from "./TaskCheckbox";

vi.mock("@/lib/commands", () => ({ getBlock: vi.fn(), resolveNoteLink: vi.fn(), toggleTaskItem: vi.fn() }));

const SOURCE = "Cards/Tasks";

function host() {
  return { onWritten: vi.fn<(block: IndexedBlock) => void>(), onStale: vi.fn<() => void>() } satisfies TaskToggleHost;
}

function written(hash: string): IndexedBlock {
  return indexedBlock({ slug: SOURCE, body_hash: hash });
}

/** A write that answers when the test says. */
function pendingWrite() {
  let resolve: (block: IndexedBlock) => void = () => undefined;
  let reject: (error: TaskToggleError) => void = () => undefined;
  vi.mocked(toggleTaskItem).mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
  return { resolve: (block: IndexedBlock) => resolve(block), reject: (error: TaskToggleError) => reject(error) };
}

function toggles(hash: string | null = "hash-0") {
  const callbacks = host();
  const controller = new TaskToggles(SOURCE, { current: callbacks });
  controller.sync(hash);
  return { controller, callbacks };
}

let failures: ReturnType<typeof useActionFailures> = [];
function FailureProbe() {
  failures = useActionFailures();
  return null;
}

beforeEach(() => {
  vi.mocked(toggleTaskItem).mockReset();
  clearActionFailures();
  failures = [];
});

// SPEC_READING_MODE.md, Ч12.2, Ч12.4.
describe("TaskToggles", () => {
  it("changes the box at once and writes the state the reader saw", async () => {
    const write = pendingWrite();
    const { controller, callbacks } = toggles();
    controller.toggle(12, false);
    expect(controller.visible(12, false)).toBe(true);
    expect(toggleTaskItem).toHaveBeenCalledWith({ source_slug: SOURCE, source_body_hash: "hash-0", item_start: 12, checked: false });
    await act(async () => write.resolve(written("hash-1")));
    expect(callbacks.onWritten).toHaveBeenCalledWith(expect.objectContaining({ body_hash: "hash-1" }));
  });

  it("writes one at a time, each with the hash the last answer gave", async () => {
    const first = pendingWrite();
    const second = pendingWrite();
    const { controller } = toggles();
    controller.toggle(0, false);
    controller.toggle(40, true);
    expect(controller.visible(40, true)).toBe(false);
    expect(toggleTaskItem).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(written("hash-1")));
    expect(toggleTaskItem).toHaveBeenCalledTimes(2);
    expect(vi.mocked(toggleTaskItem).mock.calls[1]?.[0]).toEqual({ source_slug: SOURCE, source_body_hash: "hash-1", item_start: 40, checked: true });
    await act(async () => second.resolve(written("hash-2")));
  });

  it("queues the reverse change for a second click on the same box", async () => {
    const first = pendingWrite();
    pendingWrite();
    const { controller } = toggles();
    controller.toggle(5, false);
    controller.toggle(5, controller.visible(5, false));
    expect(controller.visible(5, false)).toBe(false);
    await act(async () => first.resolve(written("hash-1")));
    expect(vi.mocked(toggleTaskItem).mock.calls[1]?.[0]).toMatchObject({ item_start: 5, checked: true, source_body_hash: "hash-1" });
  });

  it("presses nothing until the whole body and its hash have come", () => {
    const { controller } = toggles(null);
    expect(controller.active).toBe(false);
    controller.toggle(0, false);
    expect(toggleTaskItem).not.toHaveBeenCalled();
    controller.sync("hash-0");
    expect(controller.active).toBe(true);
  });

  it.each<[TaskToggleError, string, boolean]>([
    [{ kind: "stale_body", source_slug: SOURCE }, TASK_NOTE_CHANGED, true],
    [{ kind: "changed", source_slug: SOURCE }, TASK_NOTE_CHANGED, true],
    [{ kind: "state_changed", source_slug: SOURCE, item_start: 0, reason: "no task" }, TASK_STATE_CHANGED, true],
    [{ kind: "in_cloud", file_name: "Tasks.md" }, taskInCloudLine("Tasks.md"), false],
    [{ kind: "read_only", file_name: "Tasks.md" }, taskReadOnlyLine("Tasks.md"), false],
    [{ kind: "source_not_found", source_slug: SOURCE }, TASK_NOTE_GONE, false],
    [{ kind: "no_vault" }, NO_SPACE_FOR_TASK, false],
    [{ kind: "internal", message: "disk on fire" }, "disk on fire", false],
  ])("puts every box back and says why after %o", async (error, line, rereads) => {
    render(<FailureProbe />);
    const first = pendingWrite();
    const { controller, callbacks } = toggles();
    controller.toggle(0, false);
    controller.toggle(9, true);
    await act(async () => first.reject(error));
    expect(controller.visible(0, false)).toBe(false);
    expect(controller.visible(9, true)).toBe(true);
    expect(toggleTaskItem).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([{ kind: "task-toggle", title: TASK_TOGGLE_FAILED_TITLE, summary: NOTHING_CHANGED, messages: [line] }]);
    expect(taskToggleErrorLine(error)).toBe(line);
    expect(callbacks.onStale).toHaveBeenCalledTimes(rereads ? 1 : 0);
  });

  it("takes the notice away at the next success", async () => {
    render(<FailureProbe />);
    const failed = pendingWrite();
    const { controller } = toggles();
    controller.toggle(0, false);
    await act(async () => failed.reject({ kind: "read_only", file_name: "Tasks.md" }));
    expect(failures).toHaveLength(1);
    const next = pendingWrite();
    controller.toggle(0, false);
    await act(async () => next.resolve(written("hash-1")));
    expect(failures).toEqual([]);
  });
});

function TestImage(props: ComponentProps<"img"> & ExtraProps) {
  return <img src={props.src} alt={props.alt} />;
}

function TaskArticle({ body, hash }: { body: string; hash: string | null }) {
  const tasks = useTaskToggles(SOURCE, hash, { onWritten: vi.fn(), onStale: vi.fn() });
  return (
    <ArticleMarkdown
      body={body}
      sourceSlug={SOURCE}
      vaultPath="/vault"
      noteEmbeds={new NoteEmbedLookups(SOURCE)}
      tasks={tasks}
      image={TestImage}
      onOpenNote={vi.fn()}
    />
  );
}

describe("TaskCheckbox in the article", () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = readFileSync("src/styles/article.css", "utf8");
    document.head.appendChild(style);
  });
  afterEach(() => style.remove());

  it("names the item's byte offset in the body as written, wikilinks before it included", async () => {
    vi.mocked(toggleTaskItem).mockResolvedValue(written("hash-1"));
    const body = "Ссылка [[Заметка|подпись]] 😀\n\n> - [ ] Купить молоко";
    render(<TaskArticle body={body} hash="hash-0" />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Купить молоко" }));
    const expected = new TextEncoder().encode(body.slice(0, body.indexOf("- [ ]"))).length;
    expect(toggleTaskItem).toHaveBeenCalledWith({ source_slug: SOURCE, source_body_hash: "hash-0", item_start: expected, checked: false });
  });

  it("is inert while only the start of the body is shown and wakes with the hash", () => {
    const { rerender } = render(<TaskArticle body={"- [ ] Task"} hash={null} />);
    const box = screen.getByRole("checkbox", { name: "Task" });
    expect(box).toBeDisabled();
    expect(box).toHaveClass("border-inert-frame");
    rerender(<TaskArticle body={"- [ ] Task"} hash="hash-0" />);
    expect(screen.getByRole("checkbox", { name: "Task" })).toBeEnabled();
  });

  it("toggles by Space in focus, not by Enter", async () => {
    vi.mocked(toggleTaskItem).mockResolvedValue(written("hash-1"));
    render(<TaskArticle body={"- [ ] Task"} hash="hash-0" />);
    const box = screen.getByRole("checkbox", { name: "Task" });
    box.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggleTaskItem).not.toHaveBeenCalled();
    await userEvent.keyboard(" ");
    await waitFor(() => expect(toggleTaskItem).toHaveBeenCalledTimes(1));
    expect(box).toHaveAttribute("data-state", "checked");
  });

  it("draws a done task's text in the secondary step, struck through, and a nested task on its own", () => {
    const { container } = render(<TaskArticle body={"- [x] Parent\n  - [ ] Child"} hash="hash-0" />);
    const [parent, child] = container.querySelectorAll("li[data-task-item]");
    expect(parent).toHaveAttribute("data-task-checked", "true");
    expect(child).toHaveAttribute("data-task-checked", "false");
    const text = parent!.querySelector(":scope > [data-task-text]")!;
    expect(getComputedStyle(text).textDecoration).toContain("line-through");
    expect(text.textContent?.trim()).toBe("Parent");
    expect(child!.closest("[data-task-text]")).toBeNull();
  });

  it("leaves [ ] in a table cell and other signs as text", () => {
    const { container } = render(<TaskArticle body={"| A |\n|---|\n| [ ] |\n\n- [/] half\n- [-] dropped"} hash="hash-0" />);
    expect(container.querySelector("[data-task-checkbox]")).toBeNull();
  });
});
