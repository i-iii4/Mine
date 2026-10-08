import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Input } from "@/components/ui/input";
import { SEARCH_INPUT_SUPPRESSION_PROPS } from "@/lib/searchInputSuppression";
import { cn } from "@/lib/utils";

type SearchMenuInputProps = Omit<
  ComponentPropsWithoutRef<typeof Input>,
  "className" | "variant"
> & {
  inputClassName?: string;
  wrapperClassName?: string;
};

export const SearchMenuInput = forwardRef<HTMLInputElement, SearchMenuInputProps>(
  function SearchMenuInput({
    controlSize = "default",
    inputClassName,
    wrapperClassName,
    ...props
  }, ref) {
    return (
      <div className={cn("shrink-0 border-b border-border p-surface", wrapperClassName)}>
        <Input
          ref={ref}
          {...SEARCH_INPUT_SUPPRESSION_PROPS}
          {...props}
          variant="ghost"
          controlSize={controlSize}
          className={cn(
            "rounded-0 px-plate py-0 hover:placeholder:text-muted-foreground focus:placeholder:text-muted-foreground",
            inputClassName,
          )}
        />
      </div>
    );
  },
);
