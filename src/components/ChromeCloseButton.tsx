import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { commandById } from "@/lib/commandRegistry";

type ChromeCloseButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "size" | "variant"
> & {
  label?: string;
};

export function ChromeCloseButton({
  className,
  label = "Close",
  type = "button",
  ...props
}: ChromeCloseButtonProps) {
  return (
    <Button
      type={type}
      variant="chrome"
      size="chrome-icon"
      aria-label={label}
      shortcut={commandById("close-element").combo}
      className={className}
      {...props}
    >
      <X />
      <span className="sr-only">{label}</span>
    </Button>
  );
}
