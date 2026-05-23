import type { InputHTMLAttributes } from "react";

type SearchInputSuppressionProps = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "autoCapitalize" | "autoComplete" | "autoCorrect" | "spellCheck"
>;

export const SEARCH_INPUT_SUPPRESSION_PROPS = {
  autoCapitalize: "none",
  autoComplete: "off",
  autoCorrect: "off",
  spellCheck: false,
} satisfies SearchInputSuppressionProps;
