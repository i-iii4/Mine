import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type GraphCollectionLabelProps = React.ComponentPropsWithoutRef<"button">;

export const GraphCollectionLabel = React.forwardRef<
  HTMLButtonElement,
  GraphCollectionLabelProps
>(({ className, type = "button", ...props }, ref) => (
  <Badge asChild interactive variant="graphLabel">
    <button
      ref={ref}
      type={type}
      className={cn(className)}
      {...props}
    />
  </Badge>
));

GraphCollectionLabel.displayName = "GraphCollectionLabel";
