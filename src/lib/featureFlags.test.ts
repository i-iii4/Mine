import { describe, expect, it } from "vitest";
import * as featureFlags from "./featureFlags";

// Article audio is switched off, and its switch is the one flag left: the
// flags that were always off went with their dead branches
// (SPEC_ARTICLE_AUDIO.md, «Status»; SPEC_DEEP_AUDIT.md, Е8.1).
describe("feature flags", () => {
  it("keeps article audio off", () => {
    expect(featureFlags.ARTICLE_AUDIO_ENABLED).toBe(false);
  });

  it("holds no other switch", () => {
    expect(Object.keys(featureFlags)).toEqual(["ARTICLE_AUDIO_ENABLED"]);
  });
});
