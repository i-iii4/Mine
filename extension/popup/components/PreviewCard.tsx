import { Input } from "@/components/ui/input";

interface PreviewCardProps {
  title: string;
  onTitleChange: (value: string) => void;
  domain: string;
  thumbnailUrl: string | null;
  imagePreviewUrl: string | null;
}

export function PreviewCard({
  title,
  onTitleChange,
  domain,
  thumbnailUrl,
  imagePreviewUrl,
}: PreviewCardProps) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border pb-2">
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt=""
            className="size-12 shrink-0 rounded-1 bg-muted object-cover"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Input
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Title"
            className="h-auto border-0 border-b border-transparent p-0 text-base font-semibold focus-visible:border-border focus-visible:ring-0"
          />
          {domain && (
            <span className="truncate text-sm text-muted-foreground">{domain}</span>
          )}
        </div>
      </div>

      {imagePreviewUrl && (
        <div className="max-h-[120px] overflow-hidden rounded-1">
          <img
            src={imagePreviewUrl}
            alt=""
            className="block max-h-[120px] w-full object-cover"
          />
        </div>
      )}
    </>
  );
}
