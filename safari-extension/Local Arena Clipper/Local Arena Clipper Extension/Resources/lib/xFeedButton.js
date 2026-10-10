// The Mine button in the action row of every X post: feeds, lists, profiles,
// search and X Pro columns (SPEC_CLIPPER.md, «Кнопка Mine в ленте X»). Only
// the button lives here; what it saves is the content script's business.
(function (root) {
  "use strict";

  const OWNED = "data-mine-x-post";
  const POST = 'article[data-testid="tweet"]';
  // A row of the post's own actions, not some other group inside the post.
  const POST_ACTIONS = '[data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="like"], [data-testid="unlike"]';
  // Like and repost light up in colours of their own; every other control of
  // the row lights up in X's accent, the hover the Mine button shares (rule 2).
  const OWN_HOVER_COLOUR = new Set(["like", "unlike", "retweet", "unretweet"]);
  const X_HOSTS = new Set(["x.com", "twitter.com", "pro.x.com"]);
  const SVG_NS = "http://www.w3.org/2000/svg";
  // The Mine mark of src/components/MineLogo.tsx, in its own grid.
  const MARK_VIEWBOX = "0 0 800 500";
  const MARK_PATH =
    "M800 200V100H700V0H600V100H500V0H300V100H200V0H100V400H0V500H100V400H200V200H300V100H400V300H300V500H400V300H500V200H600V100H700V200ZM600 500H700V300H600Z";
  const LABEL = "Save to Mine";
  // Events of the Mine button that X must not see: its post would open.
  const KEPT_FROM_X = ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"];

  // What the copied control looked like when the Mine button was made from it.
  const templateLooks = new WeakMap();
  // What X changes on one of its accent controls when the pointer is over it.
  let accentHover = null;

  function isXHost(hostname) {
    return X_HOSTS.has(String(hostname || "").toLowerCase());
  }

  function isOwned(node) {
    return Boolean(node?.closest?.(`[${OWNED}]`));
  }

  /// The post's own action row: the last group of X's post actions that
  /// belongs to this post rather than to a post nested in it.
  function actionRow(article) {
    let row = null;
    for (const group of article.querySelectorAll('[role="group"]')) {
      if (group.closest(POST) === article && group.querySelector(POST_ACTIONS)) row = group;
    }
    return row;
  }

  /// The last control X put in the row and the box it sits in: the box is
  /// the outermost element that holds only this control.
  function template(row) {
    const controls = [...row.querySelectorAll("button")].filter((control) => !isOwned(control));
    const control = controls[controls.length - 1];
    if (!control) return null;
    let box = control;
    while (box.parentElement && box.parentElement !== row && box.parentElement.children.length === 1) {
      box = box.parentElement;
    }
    return { control, box };
  }

  /// Classes and inline styles of the box: a different value means X drew
  /// its controls anew (theme, font size), and the copy is made again.
  function look(box) {
    return [box, ...box.querySelectorAll("*")]
      .filter((element) => element.localName !== "path" && element.localName !== "g")
      .map((element) => `${element.localName}.${element.getAttribute("class") ?? ""}{${element.getAttribute("style") ?? ""}}`)
      .join("|");
  }

  function isHovered(element) {
    try {
      return element.matches(":hover");
    } catch {
      return false;
    }
  }

  /// The elements X restyles when the pointer is over a control: from the
  /// control down to its icon, and the halo drawn just before the icon.
  function hoverParts(control) {
    const icon = control.querySelector("svg");
    if (!icon) return null;
    const parts = [];
    for (let node = icon.parentElement; node && node !== control.parentElement; node = node.parentElement) {
      parts.unshift(node);
      if (node === control) break;
    }
    if (parts[0] !== control) return null;
    if (icon.previousElementSibling) parts.push(icon.previousElementSibling);
    return parts;
  }

  function partLook(element) {
    const style = {};
    for (let index = 0; index < element.style.length; index += 1) {
      const name = element.style[index];
      style[name] = element.style.getPropertyValue(name);
    }
    return { classes: new Set(element.classList), style };
  }

  /// What X changed on each part between rest and hover, or `null` when it
  /// changed nothing.
  function hoverChange(rest, hovered) {
    let changed = false;
    const change = rest.map((before, index) => {
      const after = hovered[index];
      const add = [...after.classes].filter((name) => !before.classes.has(name));
      const remove = [...before.classes].filter((name) => !after.classes.has(name));
      const style = {};
      for (const name of new Set([...Object.keys(before.style), ...Object.keys(after.style)])) {
        if (before.style[name] !== after.style[name]) style[name] = after.style[name] ?? "";
      }
      if (add.length || remove.length || Object.keys(style).length) changed = true;
      return { add, remove, style };
    });
    return changed ? change : null;
  }

  /// Puts X's hover change on the Mine button; the returned function takes
  /// it back off.
  function applyHover(control) {
    const parts = hoverParts(control);
    if (!accentHover || !parts || parts.length !== accentHover.length) return null;
    const saved = parts.map((element) => [element.getAttribute("class"), element.getAttribute("style")]);
    parts.forEach((element, index) => {
      const { add, remove, style } = accentHover[index];
      element.classList.remove(...remove);
      element.classList.add(...add);
      for (const [name, value] of Object.entries(style)) element.style.setProperty(name, value);
    });
    return () => parts.forEach((element, index) => {
      const [className, style] = saved[index];
      if (className === null) element.removeAttribute("class"); else element.setAttribute("class", className);
      if (style === null) element.removeAttribute("style"); else element.setAttribute("style", style);
    });
  }

  function afterPaint(view, callback) {
    const frame = typeof view?.requestAnimationFrame === "function"
      ? (next) => view.requestAnimationFrame(next)
      : (next) => setTimeout(next, 16);
    frame(() => frame(callback));
  }

  /// X draws hover with its own script, which a copy does not get. The
  /// pointer over an accent control of X shows what that script changes; the
  /// Mine button repeats it (rule 2).
  function learnHover(event) {
    const target = event.target;
    const control = target?.closest?.(`${POST} [role="group"] button, ${POST} [role="group"] a[href]`);
    if (!control || isOwned(control) || OWN_HOVER_COLOUR.has(control.getAttribute("data-testid"))) return;
    if (event.relatedTarget && control.contains(event.relatedTarget)) return;
    const parts = hoverParts(control);
    if (!parts) return;
    const rest = parts.map(partLook);
    let left = false;
    const leave = () => { left = true; };
    control.addEventListener("pointerleave", leave, { once: true });
    afterPaint(control.ownerDocument.defaultView, () => {
      control.removeEventListener("pointerleave", leave);
      if (left || !control.isConnected) return;
      const change = hoverChange(rest, parts.map(partLook));
      if (change) accentHover = change;
    });
  }

  function wire(control, activate) {
    const keep = (event) => event.stopPropagation();
    for (const type of KEPT_FROM_X) control.addEventListener(type, keep, { passive: true });
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const article = control.closest(POST);
      if (article) activate(article, control);
    });
    let undo = null;
    control.addEventListener("pointerenter", () => {
      undo?.();
      undo = applyHover(control);
    });
    control.addEventListener("pointerleave", () => {
      undo?.();
      undo = null;
    });
  }

  /// A copy of X's control box with the Mine mark in its icon.
  function createButton(source, activate) {
    const doc = source.ownerDocument;
    const box = source.cloneNode(true);
    for (const element of [box, ...box.querySelectorAll("*")]) {
      for (const name of element.getAttributeNames()) {
        if (name === "id" || name === "href" || name.startsWith("data-") || name.startsWith("aria-")) {
          element.removeAttribute(name);
        }
      }
      // Counts and labels are X's, not Mine's.
      for (const child of [...element.childNodes]) if (child.nodeType === 3) child.remove();
    }
    const control = box.localName === "button" ? box : box.querySelector("button");
    const icon = control?.querySelector("svg");
    if (!icon) return null;
    for (const extra of box.querySelectorAll("svg")) if (extra !== icon) extra.remove();
    icon.setAttribute("viewBox", MARK_VIEWBOX);
    const group = doc.createElementNS(SVG_NS, "g");
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", MARK_PATH);
    group.append(path);
    icon.replaceChildren(group);
    control.setAttribute("type", "button");
    control.setAttribute("aria-label", LABEL);
    box.setAttribute(OWNED, "");
    wire(control, activate);
    return box;
  }

  /// One Mine button, last in the post's action row. Returns it, or `null`
  /// when the post has no row of its own.
  function ensureButton(article, activate) {
    const row = actionRow(article);
    if (!row) return null;
    const existing = [...row.querySelectorAll(`[${OWNED}]`)];
    for (const extra of existing.slice(1)) extra.remove();
    let box = existing[0] ?? null;
    const source = template(row);
    if (!source) {
      box?.remove();
      return null;
    }
    // A hovered control shows X's hover, not its look at rest.
    const sourceLook = isHovered(source.control) ? null : look(source.box);
    if (box && sourceLook !== null && templateLooks.get(box) !== sourceLook) {
      box.remove();
      box = null;
    }
    if (!box) {
      if (sourceLook === null) return null;
      box = createButton(source.box, activate);
      if (!box) return null;
      templateLooks.set(box, sourceLook);
    }
    if (source.box.nextElementSibling !== box) source.box.after(box);
    return box;
  }

  /// Every post of the page: the one full pass, when the buttons start.
  function scan(doc, activate) {
    for (const article of doc.querySelectorAll(POST)) ensureButton(article, activate);
  }

  function holdsRowOrButton(node) {
    return node.nodeType === 1
      && (node.matches(`[role="group"], [${OWNED}]`) || Boolean(node.querySelector(`[role="group"], [${OWNED}]`)));
  }

  /// The posts a batch of changes may have left without their button: posts
  /// X added (the post itself or posts inside an added node), and posts
  /// whose action row X redrew, the button's parent or neighbours included.
  /// Changes anywhere else, other posts among them, are not looked at.
  function changedPosts(records, into) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(POST)) into.add(node);
        for (const post of node.querySelectorAll(POST)) into.add(post);
      }
      const target = record.target;
      const post = target.nodeType === 1 ? target.closest(POST) : null;
      if (!post) continue;
      if (target.closest('[role="group"]')
        || [...record.addedNodes].some(holdsRowOrButton) || [...record.removedNodes].some(holdsRowOrButton)) {
        into.add(post);
      }
    }
    return into;
  }

  /// Keeps a Mine button on every post of the page as X adds, redraws and
  /// reuses them: one full pass at the start, then only the posts the
  /// changes concern. Returns the function that stops it.
  function watch(doc, activate) {
    const view = doc.defaultView;
    const pending = new Set();
    let queued = false;
    // Changes of X reach the observer before this runs: the records left
    // after it are of the buttons' own insertions and are dropped.
    const run = () => {
      queued = false;
      const posts = [...pending];
      pending.clear();
      for (const post of posts) if (post.isConnected) ensureButton(post, activate);
      observer.takeRecords();
    };
    const queue = (records) => {
      changedPosts(records, pending);
      if (queued || pending.size === 0) return;
      queued = true;
      if (typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(run);
      else setTimeout(run, 16);
    };
    const observer = new view.MutationObserver(queue);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    doc.addEventListener("pointerover", learnHover, { capture: true, passive: true });
    scan(doc, activate);
    observer.takeRecords();
    return () => {
      observer.disconnect();
      pending.clear();
      doc.removeEventListener("pointerover", learnHover, { capture: true });
    };
  }

  root.MineXFeedButton = { OWNED_ATTRIBUTE: OWNED, isXHost, actionRow, ensureButton, scan, watch };
})(globalThis);
