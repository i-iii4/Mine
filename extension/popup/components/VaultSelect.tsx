import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface VaultSelectProps {
  value: string | null;
  options: string[];
  onChange: (value: string) => void;
}

/**
 * Shadow-DOM-friendly replacement for the native <select>. Built from
 * scratch on top of <button> + absolute-positioned menu, without Radix
 * Popper/Portal which would render the menu outside the shadow tree.
 *
 * Visual: matches Input dimensions (h-8, rounded-1, border-input), chevron
 * on the right, menu uses the popover shadow from DESIGN_SYSTEM.md.
 *
 * Close behaviour: click outside the trigger+menu, or Esc, or selection.
 */
export function VaultSelect({ value, options, onChange }: VaultSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const path = e.composedPath?.() ?? [];
      if (containerRef.current && path.includes(containerRef.current)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("click", onDocClick, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("click", onDocClick, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [open]);

  const label = value ? (value.split("/").pop() ?? value) : "";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-1 border border-input bg-background px-3 text-base text-foreground outline-none",
          open && "border-foreground",
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-1 border border-border bg-popover p-1 text-popover-foreground shadow-[0_4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]"
        >
          {options.map((opt) => {
            const isSelected = opt === value;
            const optLabel = opt.split("/").pop() ?? opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-1 px-2 py-1.5 text-left text-base",
                  "hover:bg-accent",
                  isSelected && "font-semibold",
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {isSelected && <Check className="size-4" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{optLabel}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
