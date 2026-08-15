// What a brand-new space says instead of nothing.
//
// An empty Everything route used to render an empty area: no hint that a
// clipper exists, no mention of dragging files in, no way to reach the Are.na
// import. The three ways to fill a space are the three things worth saying, and
// they are said once — the state disappears with the first card and does not
// come back. See SPEC_ONBOARDING.md О14–О16.

import { Download, FolderInput, MousePointerSquareDashed } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptySpaceOnboardingProps {
  viewportHeight: number;
  onInstallClipper: () => void;
  onImportFromArena: () => void;
}

interface PathProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}

function FillPath({ icon, title, description, action }: PathProps) {
  return (
    <div className="flex max-w-xs flex-col items-center gap-2 text-center">
      <span className="text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <p className="text-base font-semibold text-foreground">{title}</p>
      <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}

export function EmptySpaceOnboarding({
  viewportHeight,
  onInstallClipper,
  onImportFromArena,
}: EmptySpaceOnboardingProps) {
  return (
    <div
      className="grid place-items-center"
      style={{ minHeight: Math.max(320, viewportHeight) }}
      data-empty-space-onboarding=""
    >
      <div className="flex flex-col items-center gap-8 px-8">
        <div className="max-w-md text-center">
          <p className="text-lg font-semibold text-foreground">
            This space is empty
          </p>
          <p className="mt-1 text-base text-muted-foreground">
            Everything you save lands here as ordinary files in your folder.
          </p>
        </div>

        <div className="flex flex-wrap items-start justify-center gap-10">
          <FillPath
            icon={<Download className="size-5" />}
            title="Save from the web"
            description="The browser clipper saves pages, images and videos straight into this space."
            action={
              <Button variant="secondary" onClick={onInstallClipper}>
                Install the clipper
              </Button>
            }
          />
          <FillPath
            icon={<MousePointerSquareDashed className="size-5" />}
            title="Drag files in"
            description="Drop images, videos or documents anywhere in this window."
          />
          <FillPath
            icon={<FolderInput className="size-5" />}
            title="Bring a collection"
            description="Import your Are.na channels — each one becomes a collection here."
            action={
              <Button variant="secondary" onClick={onImportFromArena}>
                Import from Are.na
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}
