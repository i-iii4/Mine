import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTabVisible, pauseTabMedia, setTabVisible, useTabVisible } from "./tabVisibility";

describe("tab visibility (SPEC_TABS.md, В41)", () => {
  afterEach(() => {
    setTabVisible(true);
    document.body.innerHTML = "";
  });

  it("starts shown and follows what the backend says", () => {
    expect(isTabVisible()).toBe(true);
    const { result } = renderHook(() => useTabVisible());
    expect(result.current).toBe(true);

    act(() => setTabVisible(false));
    expect(result.current).toBe(false);
    expect(isTabVisible()).toBe(false);

    act(() => setTabVisible(true));
    expect(result.current).toBe(true);
  });

  it("pauses every video and sound of the page", () => {
    const video = document.createElement("video");
    const audio = document.createElement("audio");
    document.body.append(video, audio);
    // Own mocks: the test setup gives every media element one shared pause.
    const pauseVideo = vi.fn();
    const pauseAudio = vi.fn();
    const play = vi.fn();
    Object.defineProperty(video, "pause", { configurable: true, value: pauseVideo });
    Object.defineProperty(audio, "pause", { configurable: true, value: pauseAudio });
    Object.defineProperty(video, "play", { configurable: true, value: play });

    pauseTabMedia();

    expect(pauseVideo).toHaveBeenCalledTimes(1);
    expect(pauseAudio).toHaveBeenCalledTimes(1);
    // Nothing starts again by itself.
    expect(play).not.toHaveBeenCalled();
  });

  it("asks the local page around a YouTube player to pause it", () => {
    const surface = document.createElement("div");
    surface.setAttribute("data-youtube-source-player", "abc");
    const wrapper = document.createElement("iframe");
    wrapper.src = "http://localhost:4321/youtube/abc";
    surface.append(wrapper);
    document.body.append(surface);
    const postMessage = vi.fn();
    // The local page relays the pause to the player (youtube_embed.rs).
    Object.defineProperty(wrapper, "contentWindow", {
      configurable: true,
      value: { postMessage },
    });

    pauseTabMedia();

    expect(postMessage).toHaveBeenCalledWith("mine:pause", "http://localhost:4321");
    surface.remove();
  });

  it("leaves a wrapper whose player has not loaded alone", () => {
    const surface = document.createElement("div");
    surface.setAttribute("data-youtube-source-player", "abc");
    const wrapper = document.createElement("iframe");
    surface.append(wrapper);
    document.body.append(surface);
    Object.defineProperty(wrapper, "contentWindow", {
      configurable: true,
      value: { frames: [] },
    });

    expect(() => pauseTabMedia()).not.toThrow();
  });
});
