import type { XThreadPost } from "./xThread.types";

/** The author chain of a post, and what kept any of it from loading. */
export interface XThreadCollection {
  posts: XThreadPost[];
  issues: string[];
}

declare global {
  /**
   * The observer of X's responses in the page's own world (MAIN). Absent in
   * a page loaded before the extension, and on any page that is not X.
   */
  var MineXThreadPage:
    | {
        /** The author chain of post `target`, its continuation pages loaded. */
        collect(target: string): Promise<XThreadCollection>;
        /** Post `id` as a feed or conversation of this page delivered it, or `null`. */
        post(id: unknown): Promise<XThreadPost | null>;
      }
    | undefined;
}
