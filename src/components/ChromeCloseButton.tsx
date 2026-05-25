import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ChromeCloseButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "size" | "variant"
> & {
  label?: string;
};

export function ChromeCloseButton({
  className,
  label = "Close detail",
  type = "button",
  ...props
}: ChromeCloseButtonProps) {
  return (
    <Button
      type={type}
      variant="ghost"
      size="icon"
      aria-label={label}
      className={cn("shrink-0 text-muted-foreground hover:text-foreground", className)}
      {...props}
    >
      <X className="size-4" />
      <span className="sr-only">{label}</span>
    </Button>
  );
}
