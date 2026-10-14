// The service worker's script loader, which lib.dom does not declare (the
// extension program is checked against the DOM library, background.js
// included). background.js loads the classic scripts of lib/ with it.
declare function importScripts(...urls: string[]): void;
