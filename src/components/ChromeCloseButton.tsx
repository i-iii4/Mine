import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";

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
      variant="chrome"
      size="chrome-icon"
      aria-label={label}
      className={className}
      {...props}
    >
      <X />
      <span className="sr-only">{label}</span>
    </Button>
  );
}
