import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { NAME_REFUSED_SHAKE_MS, useNameEdit } from "@/hooks/useNameEdit";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/// A name in the top row's path renamed right there (user's decisions of
/// 05.10.2026): the open card's file (DetailCardFileName) and, since
/// 31.10.2026, the collection the feed shows (TopCollectionSwitcher). A click
/// turns the name into a field (16.10.2026; a double click before); the rest
/// of a double click does nothing more in the new field. Leaving the field or
/// Enter saves, Escape keeps the old name. While the typed name would be
/// refused the reason stands right under it. A refused save shakes the field
/// once: after Enter the field stays, with the cursor and the typed name;
/// after leaving the field the old name returns and the reason stays a moment
/// (`useNameEdit`, shared with the sidebar's collection names, which keep the
/// double click: a click opens a collection). The name is not dragged. In the
/// path the name keeps the inner padding of the steps before it, but no hover
/// plate (16.10.2026): under the pointer its text brightens and the cursor is
/// a text cursor, as over a field. A click that only makes an inactive window
/// key never reaches the page (`acceptsFirstMouse` is off, SPEC_TABS.md,
/// В85), so it opens nothing.
export function ChromeNameField({
  name,
  title,
  fieldLabel,
  check,
  save,
  reasonOf,
  resetKey,
  marker,
}: {
  name: string;
  /// The hint over the name at rest.
  title: string;
  /// The field's accessible name.
  fieldLabel: string;
  /// Why the typed name would be refused, or null; writes nothing.
  check?: (typed: string) => Promise<string | null>;
  /// Saves the typed name; rejects when it is refused.
  save: (typed: string) => Promise<void>;
  /// The words under the name for what a refused save threw.
  reasonOf: (error: unknown) => string;
  /// Another thing named here ends the edit, as Escape would.
  resetKey: string;
  /// The data attributes' stem: `data-<marker>` on the name at rest,
  /// `-anchor`, `-input` and `-notice` on the rest.
  marker: string;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // The field opened under a click: the rest of a double or triple click
  // lands on the field and would select a word or the whole name there.
  const openingClick = useRef(false);
  const edit = useNameEdit({
    current: name,
    check,
    save,
    reasonOf,
    end: () => setEditing(false),
  });

  useEffect(() => {
    edit.cancel();
  }, [resetKey]);

  useEffect(() => {
    const input = inputRef.current;
    if (!editing || !input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [editing]);

  const startEditing = () => {
    openingClick.current = true;
    edit.begin(name);
    setEditing(true);
  };

  return (
    <Tooltip open={edit.notice !== null}>
      <TooltipTrigger asChild>
        <div className={cn("flex min-w-0", editing && "flex-1")} {...{ [`data-${marker}-anchor`]: "" }}>
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              aria-label={fieldLabel}
              aria-invalid={edit.notice !== null}
              defaultValue={name}
              readOnly={edit.refused}
              spellCheck={false}
              autoComplete="off"
              // The plate stays while the name is a field, so its extent shows.
              // The field is as wide as its text with the name's 8 px on both
              // sides, as at rest (field-sizing, user's decision of
              // 01.11.2026; WebKit has it since Safari 26.2, the app's
              // minimum macOS). What caps the name at rest caps the field: at
              // the cap the text scrolls inside and the 8 px stay. A field
              // stretched over the row would not follow its text.
              className="state-active field-sizing-content h-6 min-w-0 rounded-1 border-0 bg-transparent px-2 font-mono text-sm leading-6 text-foreground outline-none"
              {...{ [`data-${marker}-input`]: "" }}
              data-name-refused={edit.refused ? "" : undefined}
              style={{ animationDuration: `${NAME_REFUSED_SHAKE_MS}ms` }}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => {
                // A first press starts a new click count: from then on the
                // field selects as any field does. Before it, a second or
                // third press is the rest of the click that opened the field
                // and leaves the cursor at the end of the name.
                if (event.detail <= 1) openingClick.current = false;
                else if (openingClick.current) event.preventDefault();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  edit.submit(event.currentTarget.value);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  edit.cancel();
                }
              }}
              onChange={(event) => edit.change(event.currentTarget.value)}
              onBlur={(event) => edit.leave(event.currentTarget.value)}
            />
          ) : (
            <div
              onClick={startEditing}
              className="h-6 min-w-0 cursor-text select-none truncate rounded-1 px-2 font-mono text-sm leading-6 text-muted-foreground hover:text-foreground"
              title={title}
              {...{ [`data-${marker}`]: "" }}
            >
              {name}
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent
        align="start"
        className="max-w-80 text-destructive"
        {...{ [`data-${marker}-notice`]: "" }}
      >
        {edit.notice}
      </TooltipContent>
    </Tooltip>
  );
}
