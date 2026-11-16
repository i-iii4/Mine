import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPictureDecode } from "@/test/pictureDecode";
import { usePreparedPicture } from "./usePreparedPicture";

/// SPEC_FEED_SCROLL_PERFORMANCE.md, «Подготовка картинки карточки».

function Picture({ src, onUndecodable }: { src: string | null; onUndecodable: () => void }) {
  const ref = usePreparedPicture(src, onUndecodable);
  return src === null ? null : <img ref={ref} src={src} alt="" />;
}

/// What the element reports once its load is over.
function settleLoad(image: HTMLImageElement, naturalWidth: number) {
  Object.defineProperty(image, "complete", { configurable: true, value: true });
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: naturalWidth });
}

describe("usePreparedPicture", () => {
  let decode: ReturnType<typeof installPictureDecode>["decode"];
  let restoreDecode: () => void;
  let rejectDecode: Array<(reason: unknown) => void>;

  beforeEach(() => {
    rejectDecode = [];
    ({ decode, restore: restoreDecode } = installPictureDecode(
      () => new Promise<void>((_, reject) => { rejectDecode.push(reject); }),
    ));
  });

  afterEach(() => {
    restoreDecode();
  });

  async function failDecode(index = rejectDecode.length - 1) {
    await act(async () => {
      rejectDecode[index]!(new DOMException("The source image cannot be decoded.", "EncodingError"));
      await Promise.resolve();
    });
  }

  it("asks the engine to decode the picture once, when its element is mounted", () => {
    const { container, rerender } = render(<Picture src="/thumbs/a.jpg" onUndecodable={vi.fn()} />);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.contexts[0]).toBe(container.querySelector("img"));

    rerender(<Picture src="/thumbs/a.jpg" onUndecodable={vi.fn()} />);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("prepares the new source when the same element is given another one", () => {
    const { container, rerender } = render(<Picture src="/thumbs/a.jpg" onUndecodable={vi.fn()} />);
    const image = container.querySelector("img");

    rerender(<Picture src="/thumbs/a.jpg?v=2" onUndecodable={vi.fn()} />);

    expect(container.querySelector("img")).toBe(image);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(image?.getAttribute("src")).toBe("/thumbs/a.jpg?v=2");
  });

  it("asks nothing where the engine has no decode()", () => {
    restoreDecode();

    expect(() => render(<Picture src="/thumbs/a.jpg" onUndecodable={vi.fn()} />)).not.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it("reports a picture whose bytes arrived and cannot be decoded", async () => {
    const onUndecodable = vi.fn();
    const { container } = render(<Picture src="/thumbs/a.jpg" onUndecodable={onUndecodable} />);
    settleLoad(container.querySelector("img")!, 640);

    await failDecode();

    expect(onUndecodable).toHaveBeenCalledTimes(1);
  });

  it("calls the handler of the latest render", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { container, rerender } = render(<Picture src="/thumbs/a.jpg" onUndecodable={first} />);
    rerender(<Picture src="/thumbs/a.jpg" onUndecodable={latest} />);
    settleLoad(container.querySelector("img")!, 640);

    await failDecode();

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it("leaves a picture that did not load to the element's error event", async () => {
    const onUndecodable = vi.fn();
    const { container } = render(<Picture src="/thumbs/a.jpg" onUndecodable={onUndecodable} />);
    settleLoad(container.querySelector("img")!, 0);

    await failDecode();

    expect(onUndecodable).not.toHaveBeenCalled();
  });

  it("ignores the rejection of a picture whose card went away", async () => {
    const onUndecodable = vi.fn();
    const { container, unmount } = render(<Picture src="/thumbs/a.jpg" onUndecodable={onUndecodable} />);
    settleLoad(container.querySelector("img")!, 640);
    unmount();

    await failDecode();

    expect(onUndecodable).not.toHaveBeenCalled();
  });

  it("ignores the rejection of a source the element no longer shows", async () => {
    const onUndecodable = vi.fn();
    const { container, rerender } = render(<Picture src="/thumbs/a.jpg" onUndecodable={onUndecodable} />);
    settleLoad(container.querySelector("img")!, 640);
    rerender(<Picture src="/thumbs/a.jpg?v=2" onUndecodable={onUndecodable} />);

    await failDecode(0);

    expect(onUndecodable).not.toHaveBeenCalled();
  });
});
