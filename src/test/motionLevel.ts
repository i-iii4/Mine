// The motion level a test runs at (SPEC_MOTION_LEVELS.md, «Тесты»): set
// through the module's own choice, never by faking `matchMedia`, which only
// motion.test.ts does, where the system's flag itself is under test.

import { chooseMotionLevel, MOTION_LEVEL_STORAGE_KEY, type MotionLevel } from "@/lib/motion";

/** The level in force for this test: the module's level and the root's
 *  `data-motion`. */
export function setMotionLevel(level: MotionLevel): void {
  chooseMotionLevel(level);
}

/** Back to Full with no stored choice: the shared `afterEach` of setup.ts. */
export function resetMotionLevel(): void {
  chooseMotionLevel("full");
  window.localStorage.removeItem(MOTION_LEVEL_STORAGE_KEY);
}
