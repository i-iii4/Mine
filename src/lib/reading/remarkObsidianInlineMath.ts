// `$…$`, a formula in a line, by Obsidian's rule (SPEC_READING_MODE.md, Ч9):
// `$` opens only before a character that is not a space and closes only after
// one, `\$` is a dollar, and a formula holds no other unescaped dollar. So
// `It costs $5 and $10` stays text: the second `$` stands after a space and
// closes nothing. `remark-math` 6.0.0 reads that line as the formula
// `5 and `, and articles from the web are full of prices, so it runs with
// `singleDollarTextMath: false` (only `$$`) and this extension reads the
// single dollar.
//
// It emits the tokens of `micromark-extension-math` (`mathText`,
// `mathTextSequence`, `mathTextData`), so `mdast-util-math`, which
// `remark-math` registers, builds the same `inlineMath` node from them: the
// plugin must come after `remark-math`.

import { markdownLineEnding, markdownLineEndingOrSpace } from "micromark-util-character";
import type { Code, Construct, Extension, State, TokenizeContext, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";

// The tokens of `micromark-extension-math`, as its own types declare them.
declare module "micromark-util-types" {
  interface TokenTypeMap {
    mathText: "mathText";
    mathTextData: "mathTextData";
    mathTextSequence: "mathTextSequence";
  }
}

/** `$` */
const DOLLAR_SIGN = 36;
/** `\` */
const BACKSLASH = 92;

/** Whether a `$` here may open: not inside a run of dollars, unless the one
 *  before it is escaped. */
function previous(this: TokenizeContext, code: Code): boolean {
  return code !== DOLLAR_SIGN || this.events[this.events.length - 1]?.[1].type === "characterEscape";
}

const tokenizeInlineMath: Tokenizer = function (effects, ok, nok) {
  // Whether the last character of the formula is a space: a `$` after one
  // does not close.
  let afterSpace = false;

  const data: State = (code: Code) => {
    if (code === null) return nok(code);
    if (markdownLineEnding(code)) {
      effects.exit("mathTextData");
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      afterSpace = true;
      return lineStart;
    }
    if (code === DOLLAR_SIGN) {
      // A dollar after a space closes nothing, and TeX writes a dollar inside
      // a formula `\$`: this was no formula. `$5 and $10 … $x$` is two
      // prices and the formula `x`, not one formula from `5` to `x`.
      if (afterSpace) return nok(code);
      effects.exit("mathTextData");
      effects.enter("mathTextSequence");
      effects.consume(code);
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok;
    }
    effects.consume(code);
    afterSpace = markdownLineEndingOrSpace(code);
    return code === BACKSLASH ? escaped : data;
  };

  // A backslash takes the next character with it: `\$` inside a formula is
  // TeX's dollar, not the end.
  const escaped: State = (code: Code) => {
    if (code === null || markdownLineEnding(code)) return data(code);
    effects.consume(code);
    afterSpace = false;
    return data;
  };

  const lineStart: State = (code: Code) => {
    if (code === null) return nok(code);
    effects.enter("mathTextData");
    return data(code);
  };

  const afterOpening: State = (code: Code) => {
    // `$ x$`, `$$` and a `$` at the end are no formula.
    if (code === null || code === DOLLAR_SIGN || markdownLineEndingOrSpace(code)) return nok(code);
    effects.enter("mathTextData");
    return data(code);
  };

  return (code: Code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    effects.consume(code);
    effects.exit("mathTextSequence");
    return afterOpening;
  };
};

const inlineMathConstruct: Construct = {
  name: "obsidianInlineMath",
  tokenize: tokenizeInlineMath,
  previous,
};

/** The micromark extension of `$…$` by Obsidian's rule. */
export function obsidianInlineMathSyntax(): Extension {
  return { text: { [DOLLAR_SIGN]: inlineMathConstruct } };
}

/** The remark plugin of `$…$`; it goes after `remark-math`, whose mdast
 *  extension builds the node. */
export function remarkObsidianInlineMath(this: Processor): undefined {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(obsidianInlineMathSyntax());
}
