// The pointer leaving the page (SPEC_MOTION_LEVELS.md, «Подсказка уходит,
// когда курсор покинул окно»): WebKit tells it by `pointerleave` on the root
// with no related target, and by no move.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { onPointerLeftPage } from "./pointerLeftPage";

describe("the pointer leaving the page", () => {
  it("is heard when the root is left for nothing, as WebKit sends it out of the window", () => {
    const listener = vi.fn();
    const stop = onPointerLeftPage(listener);
    fireEvent.pointerLeave(document.documentElement, { relatedTarget: null });
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("is not a move between elements of the page, nor a leave of an element inside it", () => {
    const listener = vi.fn();
    const stop = onPointerLeftPage(listener);
    const button = document.createElement("button");
    document.body.append(button);
    fireEvent.pointerLeave(button, { relatedTarget: null });
    fireEvent.pointerOut(document.documentElement, { relatedTarget: button });
    fireEvent.pointerLeave(document.documentElement, { relatedTarget: button });
    expect(listener).not.toHaveBeenCalled();
    button.remove();
    stop();
  });

  it("calls every listener until it stops, and leaves nothing behind", () => {
    const first = vi.fn();
    const second = vi.fn();
    const add = vi.spyOn(document.documentElement, "addEventListener");
    const remove = vi.spyOn(document.documentElement, "removeEventListener");
    const stopFirst = onPointerLeftPage(first);
    const stopSecond = onPointerLeftPage(second);
    expect(add).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(document.documentElement, { relatedTarget: null });
    stopFirst();
    stopFirst();
    fireEvent.pointerLeave(document.documentElement, { relatedTarget: null });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
    stopSecond();
    expect(remove).toHaveBeenCalledTimes(1);
    add.mockRestore();
    remove.mockRestore();
  });
});
