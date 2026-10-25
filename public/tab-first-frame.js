/* global window, document, requestAnimationFrame */
// A new tab's page waits unseen for its first frame (SPEC_TABS.md, В26).
// When its script does not run at all (it failed to load), the frame after
// the document's load tells the backend instead, so the page is not left
// unseen. A running script reports its own frame and this stands aside.
window.addEventListener("load", function () {
  if ("appStarted" in document.documentElement.dataset) return;
  var tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      tauri.invoke("tab_painted").catch(function () {});
    });
  });
});
