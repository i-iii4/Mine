// The Mine mark on the settings button (DESIGN_SYSTEM.md, «Кнопка логотипа»):
// in a tab page's chrome and in the tab bar.

/** The mark's own grid: 8 by 5 logo pixels, 100 units each. */
const MARK_PATH =
  "M800 200V100H700V0H600V100H500V0H300V100H200V0H100V400H0V500H100V400H200V200H300V100H400V300H300V500H400V300H500V200H600V100H700V200ZM600 500H700V300H600Z";

/**
 * One logo pixel is 1.5px, three device pixels at 2x, so every edge of the
 * mark falls on a whole device pixel and nothing is blurred: the mark is
 * 12 by 7.5px, its footprint the median of the chrome icons beside it
 * (user's report of 07.10.2026, measured in WebKit). The box is 12 by 8px, a
 * whole number, so the chrome plate centres it on a whole pixel; the mark
 * sits at its top, half a pixel above the plate's middle. The size is the
 * mark's own, set inline: the button's rules for icons (13px, 16px) would
 * scale the grid off the device pixels.
 */
const MARK_BOX = { width: "12px", height: "8px" } as const;

/** The mark, inheriting its colour from the button around it. */
export function MineLogo() {
  return (
    <svg
      data-mine-logo=""
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 800 500"
      preserveAspectRatio="xMidYMin meet"
      fill="currentColor"
      style={MARK_BOX}
    >
      <path d={MARK_PATH} />
    </svg>
  );
}
