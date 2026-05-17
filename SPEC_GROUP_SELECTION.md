# SPEC_GROUP_SELECTION

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) | [PLAN.md](PLAN.md) | [SPEC_FRONTEND.md](SPEC_FRONTEND.md) | [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | [SPEC_COLLECTIONS_OBSIDIAN_LINKS.md](SPEC_COLLECTIONS_OBSIDIAN_LINKS.md)

Status: implemented.

## Goal

Add Grid-owned group selection and batch card actions to the desktop feed.
Selection must feel spatial and visual, not list-like: the user selects cards in
the masonry surface and acts on the selected set from a bottom floating action
island.

## Scope

In scope:

- `Cmd+click` toggles individual cards in the current Grid.
- `Shift+click` has the same behavior as `Cmd+click`: it toggles only the
  clicked card.
- Empty-area pointer drag draws a marquee rectangle and selects every committed
  card that intersects it.
- Selected cards get a strong monochrome selected frame.
- A bottom floating action island appears when one or more cards are selected.
- Batch actions: close selection, `Connect`, collection-scoped `Disconnect`,
  `Delete`.

Out of scope for the first implementation:

- `Cmd+A` / keyboard-only range extension.
- Cross-channel persistent selection.
- Selecting skeleton/provisional cards.
- Batch actions in Detail or Search results.

## Ownership

Grid owns selection state:

```ts
type GroupSelectionState = {
  selectedSlugs: Set<string>;
  marqueeSelection: MarqueeSelection | null;
};
```

`Card` does not own selection and does not query DOM selection state. Grid
derives `isSelected` from `selectedSlugs.has(block.slug)` and marks GridItem
with `data-feed-grid-item-selected="true"`.

All selection operations use stable block `slug` identity. Marquee selection
uses `layout.positions`; never `getBoundingClientRect()`, DOM order, or array
index math as source of truth.

## Pointer Selection

### Plain Click

Plain click without modifiers keeps the existing card behavior: open Detail.
It must not accidentally enter multi-select. If a selection exists, opening
Detail clears selection before Detail becomes interactive.

### Modified Click

`Cmd+click` and `Shift+click` on a committed card both toggle only that card:

- not selected -> add to `selectedSlugs`;
- selected -> remove from `selectedSlugs`.

Modified click prevents the normal Detail open action.

If toggling removes the last selected card, `selectedSlugs` becomes empty and
the bottom action island disappears.

`Cmd+Shift+click` is not a separate range mode; it follows the same single-card
toggle behavior.

### Marquee Drag

Empty-area primary-button drag starts marquee selection. Empty area means the
pointer target is not a card, button, input, link, menu item, or editable
surface.

While dragging:

- Grid draws an axis-aligned marquee rectangle in masonry layout coordinates;
- the rectangle becomes active only after a small drag threshold;
- every committed card whose layout rectangle intersects the marquee rectangle
  is selected;
- the current selected set is replaced by the current marquee intersection.

Cards are selected by rectangle intersection, not by center point containment.

## State Reset

Selection is cleared when:

- current channel/tag changes;
- vault route changes or a fresh vault is opened;
- selected blocks disappear from the current `blocks` list;
- user presses `Escape` while Grid selection is active;
- user performs a primary click on empty Grid space without crossing the
  marquee drag threshold;
- a batch `Delete` or collection-scoped `Disconnect` completes successfully;
- plain click opens Detail.

Selection is preserved when:

- `Connect` menu opens and closes without applying changes;
- pointer hover moves between cards;
- keyboard focus moves through the Grid;
- `Cmd+K` opens a card overflow menu.

Keyboard focus, pointer hover, pinned `Cmd+K` menu anchor, and group selection
are separate states. A card can be focused, hovered, pinned, selected, or any
compatible combination of those states.

## Selected Card Visual

Selected cards use a strong monochrome frame, not the blue system selection
color.

Visual contract:

- the frame is individual per selected card, not a rectangle around the whole
  selected area;
- frame color is white in dark theme and black in light theme;
- frame thickness is `2px`;
- frame is outside the card, with a `1px` gap between card edge and frame;
- frame has no corner radius;
- no glow, shadow, blur, gradient, or colored outline;
- selected frame is the primary visual signal and must read stronger than
  hover/focus.

Implementation contract:

- GridItem receives `data-feed-grid-item-selected="true"`;
- selected frame is rendered by GridItem as a sibling overlay outside the
  clipped card layer, not by Card;
- overlay is `pointer-events: none` and does not affect masonry layout;
- use an inner frame, for example:

```css
[data-feed-grid-selection-frame] {
  position: absolute;
  inset: -3px;
  box-shadow: inset 0 0 0 2px var(--feed-selection-frame);
  border-radius: 0;
}
```

Theme tokens:

```css
:root {
  --feed-selection-frame: oklch(0.145 0 0);
}

:root[data-theme="dark"] {
  --feed-selection-frame: oklch(0.985 0 0);
}
```

The selected frame layer must render above media wash and hover overlays. It may
render above the `Cmd+K` badge because the frame sits on the outer 2-6px edge
and does not cover the badge at `left-2 top-2`.

## Marquee Visual

The drag marquee is a temporary Grid-owned overlay rendered inside
`data-grid-layout`.

Visual contract:

- no corner radius;
- `pointer-events: none`;
- fill uses the design-system surface +2 token: `--active`;
- border uses the next surface/border token: `--border`;
- implementation may use `color-mix(in oklch, var(--active) 72%, transparent)`
  for fill readability, but the source value must remain `--active`;
- no glow, blur, gradient, shadow, or color outside the monochrome system.

CSS contract:

```css
[data-feed-grid-marquee-selection] {
  position: absolute;
  border: 1px solid var(--border);
  background: color-mix(in oklch, var(--active) 72%, transparent);
  border-radius: 0;
  pointer-events: none;
}
```

## Bottom Action Island

When `selectedSlugs.size >= 1`, Grid renders a bottom floating action island.

Position and layer:

- absolutely positioned inside the main content pane and centered
  horizontally relative to that right-side content area, not the full app
  viewport;
- above Grid content and below menu/popover layers;
- does not participate in Grid layout and does not cause card reflow;
- uses the same compact floating island language as the image preview bottom
  controls.
- bottom offset is `16px` (`bottom-s3`) from the Grid/main pane bottom. The
  Grid/main pane ends above the `h-8` app bottom bar, so this is the visible
  16px gap above that bar.

Visual contract:

- `rounded-1`;
- `border border-border`;
- fixed height `32px` (`h-8`);
- opaque theme surface: `bg-accent text-foreground`;
- compact horizontal layout with `px-1` and `gap-1`;
- horizontal scrolling when content does not fit available viewport width;
- standard menu shadow only; no internal separators, decorative gradients,
  blur, glow, transparency, or large radius.

Layout order:

- the counter starts the island and uses
  Detail-top-bar typography: `font-mono text-sm`, regular weight, no
  `font-semibold`, and `text-muted-foreground` for a secondary gray read:

  - `1 карточка`;
  - `2 карточки`;
  - `5 карточек`;
  - `21 карточка`;
  - `25 карточек`.
- implement with a dedicated pluralization helper, not string concatenation.
- the rightmost control is an icon-only close button (`X`) that clears
  selection.

Direct action buttons on the island use standard design-system `Button`
variants. `Connect` and `Disconnect` use `variant="default"`;
`Delete` uses `variant="destructive"` (`bg-component-fill text-destructive`
with the standard component hover outline).

Actions are shown directly on the island, not hidden behind an overflow menu in
the first implementation:

| Action | Availability | Behavior |
|---|---|---|
| `Connect` | always enabled when at least one card is selected | Opens batch collection picker for selected cards. |
| `Disconnect` | visible only when `currentTag` is present | Text-only action; removes all selected cards from the current collection. |
| `Delete` | always enabled when at least one card is selected | Text-only red action; opens batch destructive confirmation before deleting selected cards. |

`Delete` and collection-scoped `Disconnect` can live directly on the island; an
ellipsis overflow menu is not required unless the island becomes too crowded in
future work.

Implementation note: `Delete` uses the safe batch path for v1 and calls the
existing card delete command with `delete_unused_media=false`, so selected cards
are removed while media files stay in the vault.

## Batch Connect

Batch Connect uses `BatchCollectionPicker` from the same
`src/components/CollectionPicker.tsx` implementation family as existing
single-card `Connect`. It must inherit the same search input, active row,
right action slot, hover outline and keyboard/pointer conflict contract.
Batch mode intentionally has only binary membership behavior:

- all selected cards connected to channel -> row action is `Disconnect`;
- at least one selected card not connected to channel -> row action is
  `Connect`.

The picker must not render selected-card membership counts like `1/3` or
`2/3`; partial membership is not a separate visible state.

Toggling a channel applies to all selected cards:

- from partial/none -> connect all selected cards to the channel;
- from all connected -> disconnect all selected cards from the channel.

The visible channel order must match sidebar taxonomy order exactly. Realtime
membership updates must not reorder rows while the picker is open.

## Batch Delete

Batch Delete must reuse the existing destructive confirmation principles:

- show exact selected count;
- name the action as deleting cards, not media assets;
- do not delete unrelated media unless the existing card-delete flow already
  owns that behavior for each selected block;
- clear selection only after successful completion.

## Collection-Scoped Disconnect

`Disconnect` is only available inside a concrete collection route
(`currentTag` exists).

The operation removes every selected card from that current collection and then
clears selection. If a selected card is not in the current collection because of
a stale UI snapshot, the operation skips it without failing the whole batch.

## Testing Requirements

Frontend tests must cover:

- `Cmd+click` adds and removes individual selected cards without opening Detail;
- `Shift+click` follows the same single-card toggle behavior as `Cmd+click`;
- empty-area marquee drag renders `data-feed-grid-marquee-selection`;
- marquee selection selects every committed card whose `layout.positions`
  rectangle intersects the marquee rectangle;
- changing channel clears selection;
- disappearing selected blocks are removed from selection;
- `Escape` clears selection before other Grid escape behavior;
- selected GridItem renders `data-feed-grid-item-selected` and selection frame;
- bottom island appears/disappears based on count;
- Russian pluralization for `1`, `2`, `5`, `21`, `25`;
- `Disconnect` only appears when `currentTag` exists and is absent in
  Everything;
- `Delete` opens batch confirmation;
- selection visual coexists with keyboard focus and `Cmd+K` pinned menu anchor.

Manual QA must cover:

- marquee selection across uneven masonry card heights;
- marquee selection on empty spaces between columns and rows;
- dark and light theme selected frames;
- selection frame on image, video, article and mixed media cards;
- bottom island does not overlap open popovers/menus;
- real vault batch connect/remove/delete with Obsidian `Mine Collections`
  wikilinks.
