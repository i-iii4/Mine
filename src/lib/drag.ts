// Module-level flag to distinguish internal card drag from external file drag.
// Card.tsx sets it true on dragstart; false on dragend (with delay).
// DropZone.tsx checks it to avoid showing the overlay for internal drags.
//
// The delay is necessary because Tauri's native onDragDropEvent can fire
// slightly after HTML5 dragend, and without the delay the flag would already
// be cleared, letting the DropZone overlay flash on screen.

let _active = false;
let _timer: ReturnType<typeof setTimeout> | undefined;

export function setInternalDragActive(v: boolean) {
  clearTimeout(_timer);
  if (v) {
    _active = true;
  } else {
    _timer = setTimeout(() => { _active = false; }, 300);
  }
}

export function isInternalDragActive() { return _active; }
