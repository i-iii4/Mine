// The build of the running extension and the build of its files on disk
// (SPEC_CLIPPER.md, К4). The browser keeps the worker's code, the files it
// imported included, until the extension reloads, even across worker
// restarts; `fetch`, `executeScript` and the pages the extension opens read
// the files on disk, which an update replaces meanwhile. Classic script on
// globalThis, the convention every lib/ file follows: the worker imports it
// right after dist/build-identity.js.
(function (root) {
  "use strict";

  // Written by the extension build from the same value as
  // dist/build-identity.js; the helper reads it as the installed build.
  const IDENTITY_ON_DISK = "dist/runtime-identity.json";

  /// The build written into the worker's code by dist/build-identity.js, or
  /// `null` for a worker without one.
  function running() {
    const identity = root.MineBuildIdentity;
    return typeof identity?.buildId === "string" && identity.buildId.length > 0 && typeof identity.commit === "string"
      ? identity
      : null;
  }

  /// The build of the files on disk now, or `null` when they do not name one.
  async function onDisk() {
    try {
      const response = await root.fetch(root.chrome.runtime.getURL(IDENTITY_ON_DISK), { cache: "no-store" });
      if (!response.ok) return null;
      /** @type {unknown} */
      const identity = await response.json();
      if (typeof identity !== "object" || identity === null || !("buildId" in identity)) return null;
      return typeof identity.buildId === "string" && identity.buildId.length > 0 ? identity.buildId : null;
    } catch {
      return null;
    }
  }

  /// Make the reload into `installed` pending, unless this worker runs it, has
  /// no build of its own, or reloaded for it once already: a browser that
  /// loads another folder than the one updated does not reload in a loop.
  /// Returns whether the reload is pending.
  /** @param {unknown} installed the build the helper reports as installed */
  async function noteInstalled(installed) {
    if (typeof installed !== "string" || installed.length === 0) return false;
    const own = running();
    if (own === null || own.buildId === installed) return false;
    const { mineReloadedFor } = await root.chrome.storage.local.get("mineReloadedFor");
    if (mineReloadedFor === installed) return false;
    await root.chrome.storage.session.set({ mineReloadPending: installed });
    return true;
  }

  /// Whether files read from disk now may serve this worker. `same`: they
  /// are of its build, or it has no build to keep apart. `reload`: an update
  /// replaced them, and the reload into their build is now pending.
  /// `refused`: they name no build, or the reload into theirs already
  /// happened once and did not bring it.
  async function filesOfRunningBuild() {
    const own = running();
    if (own === null) return "same";
    const disk = await onDisk();
    if (disk === own.buildId) return "same";
    if (disk === null) return "refused";
    return (await noteInstalled(disk)) ? "reload" : "refused";
  }

  root.MineExtensionBuild = Object.freeze({ running, onDisk, noteInstalled, filesOfRunningBuild });
})(globalThis);
