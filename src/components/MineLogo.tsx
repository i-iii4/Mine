// The Mine mark on the settings button (DESIGN_SYSTEM.md, «Кнопка логотипа»):
// in a tab page's chrome and in the tab bar.

/** The mark, inheriting its colour from the button around it. */
export function MineLogo() {
  return (
    <svg
      data-mine-logo=""
      aria-hidden="true"
      focusable="false"
      viewBox="-100 -250 1000 1000"
      fill="currentColor"
    >
      {/* Original outline centered in a padded icon canvas: 12.8×8px at 16px. */}
      <path d="M800 200V100H700V0H600V100H500V0H300V100H200V0H100V400H0V500H100V400H200V200H300V100H400V300H300V500H400V300H500V200H600V100H700V200ZM600 500H700V300H600Z" />
    </svg>
  );
}
