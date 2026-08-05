import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { MicroPreviewModel } from "./MicroPreviewThumbnail";
import { MicroPreviewThumbnail } from "./MicroPreviewThumbnail";

export const CARD_REFERENCE_ROW_SHELL_CLASSES =
  "w-full min-w-0 overflow-hidden rounded-1 border border-border bg-component-fill p-[3px] font-sans text-base";

export const CARD_REFERENCE_ROW_CONTENT_CLASSES =
  "flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden";

export const CARD_REFERENCE_ROW_ESTIMATED_HEIGHT_PX = 40;
export const CARD_REFERENCE_ROW_GAP_PX = 4;

interface CardReferenceRowBaseProps {
  label: string;
  preview: MicroPreviewModel | null;
  leadingSlot?: ReactNode;
  trailingSlot?: ReactNode;
  className?: string;
  contentClassName?: string;
  children?: never;
}

export function CardReferenceRow({
  label,
  preview,
  leadingSlot,
  trailingSlot,
  className,
  contentClassName,
  ...divProps
}: CardReferenceRowBaseProps & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn(CARD_REFERENCE_ROW_SHELL_CLASSES, className)} {...divProps}>
      <CardReferenceRowContent
        label={label}
        preview={preview}
        leadingSlot={leadingSlot}
        trailingSlot={trailingSlot}
        className={contentClassName}
      />
    </div>
  );
}

export const CardReferenceButton = forwardRef<HTMLButtonElement, CardReferenceRowBaseProps & ButtonHTMLAttributes<HTMLButtonElement>>(function CardReferenceButton({
  label,
  preview,
  leadingSlot,
  trailingSlot,
  className,
  contentClassName,
  ...buttonProps
}, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        CARD_REFERENCE_ROW_SHELL_CLASSES,
        "text-left outline-0 outline-transparent hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-component-fill-hover",
        className,
      )}
      {...buttonProps}
    >
      <CardReferenceRowContent
        label={label}
        preview={preview}
        leadingSlot={leadingSlot}
        trailingSlot={trailingSlot}
        className={contentClassName}
      />
    </button>
  );
});

function CardReferenceRowContent({
  label,
  preview,
  leadingSlot,
  trailingSlot,
  className,
}: {
  label: string;
  preview: MicroPreviewModel | null;
  leadingSlot?: ReactNode;
  trailingSlot?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(CARD_REFERENCE_ROW_CONTENT_CLASSES, className)}>
      {leadingSlot}
      <div aria-hidden="true" className="size-8 shrink-0 overflow-hidden bg-component-fill">
        {preview && (
          <MicroPreviewThumbnail
            preview={preview}
            loading="lazy"
            draggable={false}
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        )}
      </div>
      <span className="min-w-0 flex-1 truncate text-left leading-5">{label}</span>
      {trailingSlot}
    </div>
  );
}
