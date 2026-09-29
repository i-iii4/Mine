import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge knows Tailwind's default scales only. Without the project's
// own tokens (src/styles/global.css, @theme) it cannot tell that
// `rounded-pill` and `rounded-1` set the same property, keeps both, and the
// stylesheet order silently decides which one wins. Keep this list in step
// with the `--radius-*` and `--spacing-*` tokens.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["0", "1", "2", "card", "media", "pill", "round"],
      spacing: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
