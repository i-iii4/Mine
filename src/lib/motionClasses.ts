// src/lib/motionClasses.ts: the roles' time and curve as Tailwind classes,
// for a transition whose start a component's own state decides
// (SPEC_MOTION_LEVELS.md, РД1, РД3). Each class reads a role's token, so the
// level changes it in global.css's level blocks and nowhere else (РД6).

/** Отклик, an appearance or a move to a new state: `--motion-enter` on the
 *  response curve. */
export const RESPONSE_ENTER_CLASS = "duration-(--motion-enter) ease-(--motion-ease)";

/** Отклик, a leaving or a fade out: `--motion-exit` on the response curve. */
export const RESPONSE_EXIT_CLASS = "duration-(--motion-exit) ease-(--motion-ease)";

/** Перемещение: `--motion-move` on the move curve, both ways. */
export const MOVE_CLASS = "duration-(--motion-move) ease-(--motion-move-ease)";

/** A fade shown or hidden by state, Отклик: in on the enter time, out on the
 *  exit time. */
export function responseFadeClass(shown: boolean): string {
  return shown ? RESPONSE_ENTER_CLASS : RESPONSE_EXIT_CLASS;
}
