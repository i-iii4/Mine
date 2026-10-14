import { describe, expect, it } from "vitest";
import { UNKNOWN_ERROR_TEXT, errorMessage } from "./errorMessage";

// SPEC_DEEP_AUDIT.md, Е6.15: a failure speaks the words of its error, never
// `String(error)`, which gave `Error: …` and `[object Object]`.
describe("errorMessage", () => {
  it("says the message of an error without its class name", () => {
    expect(errorMessage(new Error("The file is locked."))).toBe("The file is locked.");
    expect(errorMessage(new TypeError("Bad input."))).toBe("Bad input.");
  });

  it("says a string as it is", () => {
    expect(errorMessage("Permission denied.")).toBe("Permission denied.");
  });

  it("lets a typed refusal speak through its message, else names its kind", () => {
    expect(errorMessage({ kind: "internal", message: "The index is busy." })).toBe("The index is busy.");
    expect(errorMessage({ kind: "no_vault" })).toBe("no vault");
  });

  it("says that the error is unknown when it carries no words", () => {
    for (const silent of [new Error(""), "", {}, { message: "", kind: "" }, null, undefined, 42]) {
      expect(errorMessage(silent)).toBe(UNKNOWN_ERROR_TEXT);
    }
  });
});
