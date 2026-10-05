import { useEffect, useRef, useState } from "react";
import { motionDuration } from "@/lib/motion";

/// How long the reason stays under the name after a refused name returned to
/// the old one.
export const NAME_REFUSAL_NOTICE_MS = 2500;

/// The shake of a refused name (`name-refused` in global.css), set inline as
/// the animation's length. What follows the shake runs by a timer rather than
/// `animationend`, so a shake that never runs cannot leave the field locked.
export const NAME_REFUSED_SHAKE_MS = 320;

export interface NameEditOptions {
  /// The name before the edit, when there is one: typing it back saves
  /// nothing. A name being created has none.
  current?: string;
  /// Why the typed name would be refused, or null; asked as it is typed.
  check?: (typed: string) => Promise<string | null>;
  /// Saves the typed name, trimmed; a refused name rejects.
  save: (typed: string) => Promise<void>;
  /// The words under the name for what a refused save threw.
  reasonOf: (error: unknown) => string;
  /// The edit is over: the name was saved or kept, or it was refused as the
  /// field was left and the old name returns.
  end: () => void;
}

export interface NameEdit {
  /// The reason the name is refused, shown under it; null when there is none.
  notice: string | null;
  /// The field shakes and takes no typing.
  refused: boolean;
  /// The field opened with `initial` in it.
  begin: (initial: string) => void;
  change: (value: string) => void;
  /// Enter or the submit button: a refused name keeps the field, the cursor
  /// and the typed text, so it can be fixed.
  submit: (value: string) => void;
  /// The field lost focus: it saves, and a refused name returns the old one
  /// while the reason stays a moment.
  leave: (value: string) => void;
  /// Escape: the old name stays.
  cancel: () => void;
}

/// A name edited in place, the way the open card's name in the path is
/// (user's decisions of 05.10.2026), for every name the user types in place.
/// While the typed name would be refused, the reason stands under it. A
/// refused save shakes the field once: after Enter the field stays as it was;
/// after leaving the field the old name returns and the reason stays
/// `NAME_REFUSAL_NOTICE_MS`.
export function useNameEdit({ current, check, save, reasonOf, end }: NameEditOptions): NameEdit {
  const [notice, setNotice] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  // One answer per edit: Enter and the blur that follows it must not save
  // twice, nor a blur during the shake.
  const settled = useRef(false);
  // The edit is over; a save still on its way only reports its refusal.
  const ended = useRef(false);
  // The field was left while it was saved or shook: when the shake ends, the
  // old name returns whatever started it.
  const left = useRef(false);
  // Only the answer to the latest keystroke may speak.
  const checkSequence = useRef(0);
  const noticeTimer = useRef<number | null>(null);
  const shakeTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
  }, []);

  const clearNoticeTimer = () => {
    if (noticeTimer.current !== null) {
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
  };
  const clearShakeTimer = () => {
    if (shakeTimer.current !== null) {
      window.clearTimeout(shakeTimer.current);
      shakeTimer.current = null;
    }
  };
  // The reason stays a moment under the name that returned.
  const noticeAWhile = (reason: string) => {
    setNotice(reason);
    clearNoticeTimer();
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NAME_REFUSAL_NOTICE_MS);
  };
  const finish = () => {
    settled.current = true;
    ended.current = true;
    checkSequence.current += 1;
    clearShakeTimer();
    setNotice(null);
    setRefused(false);
    end();
  };

  const change = (value: string) => {
    const sequence = ++checkSequence.current;
    const typed = value.trim();
    if (!check || !typed || typed === current) {
      setNotice(null);
      return;
    }
    void check(typed).then(
      (problem) => {
        if (sequence === checkSequence.current) setNotice(problem);
      },
      (error: unknown) => {
        console.error("Failed to check the name:", error);
      },
    );
  };

  const begin = (initial: string) => {
    clearNoticeTimer();
    clearShakeTimer();
    settled.current = false;
    ended.current = false;
    left.current = false;
    setRefused(false);
    setNotice(null);
    change(initial);
  };

  // The shake ended. After Enter the field stays as it was, so the name can
  // be fixed; a field that was left returns the old name.
  const endShake = (reason: string) => {
    shakeTimer.current = null;
    setRefused(false);
    if (left.current) {
      ended.current = true;
      end();
      noticeAWhile(reason);
      return;
    }
    settled.current = false;
  };

  const attempt = async (value: string, via: "submit" | "leave") => {
    if (settled.current) {
      // Left while the name was being saved or shook.
      if (via === "leave") left.current = true;
      return;
    }
    settled.current = true;
    checkSequence.current += 1;
    const typed = value.trim();
    if (!typed || typed === current) {
      finish();
      return;
    }
    try {
      await save(typed);
    } catch (error) {
      const reason = reasonOf(error);
      if (ended.current) {
        noticeAWhile(reason);
        return;
      }
      if (via === "leave") left.current = true;
      setNotice(reason);
      setRefused(true);
      clearShakeTimer();
      shakeTimer.current = window.setTimeout(
        () => endShake(reason),
        motionDuration(NAME_REFUSED_SHAKE_MS),
      );
      return;
    }
    if (!ended.current) finish();
  };

  return {
    notice,
    refused,
    begin,
    change,
    submit: (value) => void attempt(value, "submit"),
    leave: (value) => void attempt(value, "leave"),
    cancel: finish,
  };
}
