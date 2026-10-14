/** A build of the extension: what dist/build-identity.js names. */
export interface BuildIdentity {
  /** The hash of the built extension files. */
  readonly buildId: string;
  /** The commit the build was made from. */
  readonly commit: string;
}

/**
 * Whether files read from disk now may serve the running worker: `same` when
 * they are of its build or it has none, `reload` when an update replaced them
 * and the reload into their build is now pending, `refused` when they name no
 * build or the reload into theirs already happened once (SPEC_CLIPPER.md, К4).
 */
export type FilesOfRunningBuild = "same" | "reload" | "refused";

declare global {
  /**
   * The build of the worker's code, written by the extension build into
   * dist/build-identity.js; absent in a worker built without one.
   */
  var MineBuildIdentity: BuildIdentity | undefined;

  var MineExtensionBuild: Readonly<{
    /** The build of the worker's code, or `null` for a worker without one. */
    running(): BuildIdentity | null;
    /** The build of the files on disk now, or `null` when they name none. */
    onDisk(): Promise<string | null>;
    /**
     * Make the reload into `installed` pending; `installed` comes from the
     * helper's status. Returns whether the reload is pending.
     */
    noteInstalled(installed: unknown): Promise<boolean>;
    filesOfRunningBuild(): Promise<FilesOfRunningBuild>;
  }>;
}
