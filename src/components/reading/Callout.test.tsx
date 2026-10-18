import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CALLOUT_TYPES, type CalloutType } from "@/lib/reading/callouts";
import { CALLOUT_COLOR_CLASSES, Callout, CalloutBody, CalloutTitle } from "./Callout";

function renderCallout(type: CalloutType, fold: "folded" | "unfolded" | null = null) {
  return render(
    <Callout type={type} fold={fold}>
      <CalloutTitle>Title</CalloutTitle>
      <CalloutBody empty={false}><p>Body</p></CalloutBody>
    </Callout>,
  );
}

const LUCIDE_CLASS: Record<string, string> = {
  Pencil: "lucide-pencil",
  ClipboardList: "lucide-clipboard-list",
  Info: "lucide-info",
  CircleCheck: "lucide-circle-check",
  Flame: "lucide-flame",
  Check: "lucide-check",
  CircleHelp: "lucide-circle-question-mark",
  TriangleAlert: "lucide-triangle-alert",
  X: "lucide-x",
  Zap: "lucide-zap",
  Bug: "lucide-bug",
  List: "lucide-list",
  Quote: "lucide-quote",
};

// The colour of each type as Obsidian 1.13.7 draws it (`--callout-*` of its
// app.css): red, orange, blue, cyan, green, purple and the grey of a quote.
const OBSIDIAN_COLORS: Record<CalloutType, string> = {
  note: "blue",
  abstract: "cyan",
  info: "blue",
  todo: "blue",
  tip: "cyan",
  success: "green",
  question: "orange",
  warning: "orange",
  failure: "red",
  danger: "red",
  bug: "red",
  example: "purple",
  quote: "grey",
};

// SPEC_READING_MODE.md, Ч8; the colours by the user's decision of 18.10.2026
// (В3 (а)): icon and title in the type's colour, the body in the article's.
describe("Callout", () => {
  it.each(Object.entries(CALLOUT_TYPES) as [CalloutType, { icon: string }][])("draws %s with its icon", (type, { icon }) => {
    const { container } = renderCallout(type);
    const svg = container.querySelector(`[data-callout-icon='${type}']`);
    expect(svg?.getAttribute("class")).toMatch(new RegExp(`${LUCIDE_CLASS[icon]}\\b|lucide-circle-help`));
    expect(container.querySelector("[data-callout-title]")).toHaveTextContent("Title");
  });

  it.each(Object.keys(CALLOUT_TYPES) as CalloutType[])("colours the icon and the title of %s as Obsidian does", (type) => {
    expect(CALLOUT_TYPES[type].color).toBe(OBSIDIAN_COLORS[type]);
    const { container } = renderCallout(type);
    const title = container.querySelector("[data-callout-title]");
    expect(title).toHaveClass(CALLOUT_COLOR_CLASSES[CALLOUT_TYPES[type].color]);
    // The icon takes the title's colour; the body keeps the article's.
    expect(container.querySelector("[data-callout-icon]")?.getAttribute("class")).not.toMatch(/\btext-/);
    expect(container.querySelector("[data-callout-body]")?.className).not.toMatch(/\btext-/);
  });

  it("draws red and orange types with the semantic colours Mine has, the others with the callout's own", () => {
    expect(CALLOUT_COLOR_CLASSES).toEqual({
      red: "text-destructive",
      orange: "text-detach",
      blue: "text-callout-blue",
      cyan: "text-callout-cyan",
      green: "text-callout-green",
      purple: "text-callout-purple",
      grey: "text-muted-foreground",
    });
  });

  it("colours a folding callout's title too, the chevron staying quiet", () => {
    const { container } = renderCallout("danger", "folded");
    expect(container.querySelector("summary")).toHaveClass("text-destructive");
    expect(container.querySelector("[data-disclosure-chevron]")).toHaveClass("text-muted-foreground");
  });

  it("stands in a box on the card zone with a line and the card corner", () => {
    const { container } = renderCallout("note");
    expect(container.querySelector("[data-callout]")).toHaveClass("bg-card", "border", "border-border", "rounded-card", "p-surface", "my-5");
    expect(container.querySelector("[data-callout-title]")).toHaveClass("min-h-row", "px-plate", "font-semibold");
    expect(container.querySelector("[data-callout-body]")).toHaveClass("px-plate", "pb-plate");
  });

  it("does not fold without a sign", () => {
    const { container } = renderCallout("info");
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
  });

  it("starts folded with - and unfolds by a click", () => {
    const { container } = renderCallout("tip", "folded");
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(container.querySelector("summary")!, { detail: 1 });
    expect(details.open).toBe(true);
    expect(container.querySelector("[data-disclosure-chevron]")).toHaveClass("rotate-90");
  });

  it("starts unfolded with + and folds by Enter and Space", () => {
    const { container } = renderCallout("tip", "unfolded");
    const details = container.querySelector("details")!;
    const summary = container.querySelector("summary")!;
    expect(details.open).toBe(true);
    fireEvent.keyDown(summary, { key: "Enter" });
    expect(details.open).toBe(false);
    fireEvent.keyDown(summary, { key: " " });
    expect(details.open).toBe(true);
    expect(summary).toHaveClass("focus-visible:outline-ring");
  });

  it("is its title alone when the body is empty", () => {
    const { container } = render(
      <Callout type="note" fold={null}>
        <CalloutTitle>Only</CalloutTitle>
        <CalloutBody empty><p>never</p></CalloutBody>
      </Callout>,
    );
    expect(container.querySelector("[data-callout-body]")).toBeNull();
  });
});
