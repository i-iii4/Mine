import { Button } from "@/components/ui/button";

interface SaveButtonProps {
  count: number;
  saving: boolean;
  onClick: () => void;
}

export function SaveButton({ count, saving, onClick }: SaveButtonProps) {
  const label =
    count === 0 ? "Save" : count === 1 ? "Save to 1 channel" : `Save to ${count} channels`;

  return (
    <Button onClick={onClick} disabled={saving} className="w-full">
      {saving ? (
        <div className="size-4 animate-spin rounded-round border-[1.5px] border-background/30 border-t-background" />
      ) : (
        <>
          <span>{label}</span>
          <kbd className="text-sm opacity-60">{"\u2318\u23CE"}</kbd>
        </>
      )}
    </Button>
  );
}
