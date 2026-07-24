import { useRef } from "react";
import type { ProjectionRevision } from "@/types";

export type ProjectionSurface = "grid" | "taxonomy" | "sidebar-previews" | "graph";

export interface ProjectionRevisionOwner {
  accept: (surface: ProjectionSurface, revision: ProjectionRevision) => boolean;
  current: (surface: ProjectionSurface) => ProjectionRevision | null;
  reset: () => void;
}

export function createProjectionRevisionOwner(): ProjectionRevisionOwner {
  const accepted = new Map<ProjectionSurface, ProjectionRevision>();
  return {
    accept(surface, revision) {
      if (!Number.isSafeInteger(revision) || revision < 0) return false;
      const current = accepted.get(surface);
      if (current !== undefined && revision < current) return false;
      accepted.set(surface, revision);
      return true;
    },
    current(surface) {
      return accepted.get(surface) ?? null;
    },
    reset() {
      accepted.clear();
    },
  };
}

export function useProjectionRevisionOwner(): ProjectionRevisionOwner {
  const ownerRef = useRef<ProjectionRevisionOwner | null>(null);
  ownerRef.current ??= createProjectionRevisionOwner();
  return ownerRef.current;
}
