// A picture whose file may not be there: a medium iCloud has not brought, a
// file deleted outside Mine, a preview still being built. Its failed load is
// not a broken picture: the picture is hidden and the slot keeps the fill the
// caller gives it, never WebKit's broken-image icon (SPEC_THUMBNAILS.md,
// «Нет файла миниатюры»; SPEC_DEEP_AUDIT.md, Е6.8). The rule and its retry
// on `thumb:updated` are `usePreviewFileRetry`'s; this is that hook for any
// one `<img>`.

import type { ComponentProps } from "react";
import { usePreviewFileRetry } from "@/hooks/usePreviewFileRetry";

type MissingAwareImageProps = Omit<ComponentProps<"img">, "src"> & {
  src: string;
  /** The card whose preview this is, to load again once it is ready; none
   *  for a medium of the space, which has no such event. */
  slug?: string | null;
};

export function MissingAwareImage({ src, slug = null, onError, alt = "", ...imgProps }: MissingAwareImageProps) {
  const { src: retrySrc, missing, markMissing } = usePreviewFileRetry(src, slug);
  if (missing) return null;
  return (
    <img
      {...imgProps}
      alt={alt}
      src={retrySrc}
      onError={(event) => {
        markMissing();
        onError?.(event);
      }}
    />
  );
}
