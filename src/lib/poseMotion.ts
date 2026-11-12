// Minimal's motion of a window over the page (SPEC_MOTION_LEVELS.md, ОУ2–ОУ5,
// ОУ9): the card's window and the image preview rise into place and sink
// away as one transform and one opacity per moving part, their scrim at the
// same opacity. The parts run on the compositor, so the work on the page
// under them does not hold them up; the runner knows where they stand at any
// moment, so the next motion starts there with no jump (УД8).

import { PEEK_POSE_REST, peekPoseAt, peekPoseKeyframes, type PeekPose, type PeekPoseMove } from "./cardPeek";
import { MOTION_EASE } from "./motion";

/** What moves: the window's parts, each about its own centre, and the scrim,
 *  which only fades. */
export interface PoseTargets {
  parts: readonly (HTMLElement | null)[];
  scrim: HTMLElement | null;
}

/** A motion under way: what it is for, its ends and its animations. */
export interface PoseMotion<Purpose extends string> extends PeekPoseMove {
  purpose: Purpose;
  animations: Animation[];
}

/** One window's motions in Minimal. */
export interface PoseRunner<Purpose extends string> {
  /** Where the window stands now. */
  current(): PeekPose;
  /** The motion under way; null at rest and while a finished one holds its
   *  end. */
  motion(): PoseMotion<Purpose> | null;
  /** Where the last motion ends, or the place at rest. */
  target(): PeekPose;
  /** Whether a motion runs or a finished one holds its end on the page. */
  active(): boolean;
  /** One more with every motion and every stop: a callback that waited a
   *  frame tells whether nothing changed meanwhile. */
  generation(): number;
  /** Moves the window from `from`, or from where it stands, to `to` over
   *  `duration` ms on E; `onEnd` hears its end, once. The motion's clock
   *  starts at the frame the page showed last, so the next frame goes on
   *  from that frame's place at the new motion's own speed (ОУ4, rules 2 and
   *  3). With no animations on the page (jsdom), it ends at once. */
  move(purpose: Purpose, from: PeekPose | null, to: PeekPose, duration: number, targets: PoseTargets, onEnd: () => void): void;
  /** The motions taken off the page where they are; with `rest`, the window
   *  counted back at its place. */
  stop(rest: boolean): void;
}

/** The time `animation` has run, ms; a finished or a missing one has run
 *  `duration`. */
function elapsedOf(animation: Animation | undefined, duration: number): number {
  const time = animation?.currentTime;
  return typeof time === "number" ? time : duration;
}

/** The time of the frame the page showed last: the document timeline's. */
function frameTime(): number | null {
  if (!("timeline" in document)) return null;
  const time = document.timeline.currentTime;
  return typeof time === "number" ? time : null;
}

export function createPoseRunner<Purpose extends string>(): PoseRunner<Purpose> {
  let motion: PoseMotion<Purpose> | null = null;
  let pose: PeekPose = PEEK_POSE_REST;
  let held: Animation[] = [];
  let generation = 0;

  const current = (): PeekPose => (motion ? peekPoseAt(motion, elapsedOf(motion.animations[0], motion.duration)) : pose);

  const stop = (rest: boolean) => {
    for (const animation of [...(motion?.animations ?? []), ...held]) {
      animation.onfinish = null;
      animation.cancel();
    }
    motion = null;
    held = [];
    generation += 1;
    if (rest) pose = PEEK_POSE_REST;
  };

  const move: PoseRunner<Purpose>["move"] = (purpose, from, to, duration, targets, onEnd) => {
    const start = from ?? current();
    stop(false);
    pose = to;
    const parts = targets.parts.filter((part): part is HTMLElement => part !== null);
    const lead = parts[0];
    if (!lead || typeof lead.animate !== "function") {
      onEnd();
      return;
    }
    const first = peekPoseKeyframes(start);
    const last = peekPoseKeyframes(to);
    const timing: KeyframeAnimationOptions = { duration, easing: MOTION_EASE, fill: "forwards" };
    const animations = parts.map((part) => part.animate([first.window, last.window], timing));
    if (targets.scrim) animations.push(targets.scrim.animate([first.scrim, last.scrim], timing));
    const startedAt = frameTime();
    if (startedAt !== null) for (const animation of animations) animation.startTime = startedAt;
    const running: PoseMotion<Purpose> = { purpose, from: start, to, duration, animations };
    motion = running;
    const [leadAnimation] = animations;
    if (!leadAnimation) return;
    leadAnimation.onfinish = () => {
      if (motion !== running) return;
      motion = null;
      held = running.animations;
      onEnd();
    };
  };

  return {
    current,
    motion: () => motion,
    target: () => (motion ? motion.to : pose),
    active: () => motion !== null || held.length > 0,
    generation: () => generation,
    move,
    stop,
  };
}
