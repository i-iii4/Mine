// `==text==`, Obsidian's highlight, as a `mark` node (SPEC_READING_MODE.md,
// Ч3). A syntax extension, not a rewrite of the parsed tree: the parser itself
// decides, so `\==` stays text, and code, math and link destinations, which
// the parser reads as their own constructs, never hold a mark.
//
// Built as `micromark-extension-gfm-strikethrough` 2.1.0 is, with `=` for `~`
// and only a pair of signs: one `=` and `===` stay text. The opening pair
// stands before text and the closing one after it, by the same attention
// rules (`classifyCharacter`) as strikethrough and emphasis.

import type { Mark } from "mdast";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import { splice } from "micromark-util-chunked";
import { classifyCharacter } from "micromark-util-classify-character";
import { resolveAll } from "micromark-util-resolve-all";
import type {
  Code,
  Event,
  Extension,
  Resolver,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from "micromark-util-types";
import type { Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    mark: "mark";
    markSequence: "markSequence";
    markSequenceTemporary: "markSequenceTemporary";
    markText: "markText";
  }
}

declare module "mdast" {
  /** Highlighted text, `==text==`. */
  interface Mark extends Parent {
    type: "mark";
    children: PhrasingContent[];
  }

  interface PhrasingContentMap {
    mark: Mark;
  }

  interface RootContentMap {
    mark: Mark;
  }
}

/** `=` */
const EQUALS_SIGN = 61;
/** The signs on each side of a mark: exactly two. */
const MARK_SEQUENCE_SIZE = 2;
/** `classifyCharacter`'s group of punctuation, micromark's `attentionSideAfter`. */
const ATTENTION_SIDE_AFTER = 2;

/** The micromark extension of the `==text==` syntax. */
export function markSyntax(): Extension {
  const tokenizer = {
    name: "mark",
    tokenize: tokenizeMark,
    resolveAll: resolveAllMark,
  };
  return {
    text: { [EQUALS_SIGN]: tokenizer },
    insideSpan: { null: [tokenizer] },
    attentionMarkers: { null: [EQUALS_SIGN] },
  };
}

/** Pairs each closing sequence with the nearest opening one before it. */
const resolveAllMark: Resolver = (events, context) => {
  let index = -1;
  while (++index < events.length) {
    const closer = events[index];
    if (
      closer?.[0] !== "enter"
      || closer[1].type !== "markSequenceTemporary"
      || !closer[1]._close
    ) {
      continue;
    }
    let open = index;
    while (open--) {
      const opener = events[open];
      if (
        opener?.[0] === "exit"
        && opener[1].type === "markSequenceTemporary"
        && opener[1]._open
      ) {
        closer[1].type = "markSequence";
        opener[1].type = "markSequence";
        const mark: Token = {
          type: "mark",
          start: { ...opener[1].start },
          end: { ...closer[1].end },
        };
        const text: Token = {
          type: "markText",
          start: { ...opener[1].end },
          end: { ...closer[1].start },
        };
        const nextEvents: Event[] = [
          ["enter", mark, context],
          ["enter", opener[1], context],
          ["exit", opener[1], context],
          ["enter", text, context],
        ];
        const insideSpan = context.parser.constructs.insideSpan.null;
        if (insideSpan) {
          splice(nextEvents, nextEvents.length, 0, resolveAll(insideSpan, events.slice(open + 1, index), context));
        }
        splice(nextEvents, nextEvents.length, 0, [
          ["exit", text, context],
          ["enter", closer[1], context],
          ["exit", closer[1], context],
          ["exit", mark, context],
        ]);
        splice(events, open - 1, index - open + 3, nextEvents);
        index = open + nextEvents.length - 2;
        break;
      }
    }
  }
  // An unpaired sequence is the text it is.
  for (const event of events) {
    if (event[1].type === "markSequenceTemporary") event[1].type = "data";
  }
  return events;
};

const tokenizeMark: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  const previous = this.previous;
  const events = this.events;
  let size = 0;

  const more: State = (code: Code) => {
    const before = classifyCharacter(previous);
    if (code === EQUALS_SIGN) {
      // A third sign: `===` is no mark.
      if (size === MARK_SEQUENCE_SIZE) return nok(code);
      effects.consume(code);
      size += 1;
      return more;
    }
    // One sign is no mark either.
    if (size < MARK_SEQUENCE_SIZE) return nok(code);
    const token = effects.exit("markSequenceTemporary");
    const after = classifyCharacter(code);
    token._open = !after || (after === ATTENTION_SIDE_AFTER && Boolean(before));
    token._close = !before || (before === ATTENTION_SIDE_AFTER && Boolean(after));
    return ok(code);
  };

  return (code: Code) => {
    // Inside a run of signs, unless the one before is escaped: `\===` is `=`
    // then a pair.
    if (previous === EQUALS_SIGN && events[events.length - 1]?.[1].type !== "characterEscape") {
      return nok(code);
    }
    effects.enter("markSequenceTemporary");
    return more(code);
  };
};

/** The mdast extension: a `mark` node, drawn as `<mark>`. */
export function markFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      mark(token) {
        const node: Mark = { type: "mark", children: [], data: { hName: "mark" } };
        this.enter(node, token);
      },
    },
    exit: {
      mark(token) {
        this.exit(token);
      },
    },
  };
}

/** The remark plugin of `==text==`. */
export function remarkMark(this: Processor): undefined {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(markSyntax());
  (data.fromMarkdownExtensions ??= []).push(markFromMarkdown());
}
