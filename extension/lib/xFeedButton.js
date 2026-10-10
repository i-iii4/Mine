// The Mine button in the header of every X post: feeds, lists, profiles,
// search, X Pro columns, and the header of the post X Pro opens over a column
// (SPEC_CLIPPER.md, «Кнопка Mine в ленте X»; «Доработки после живого
// просмотра», Р1 to Р4). Only the button lives here; what it saves is the
// content script's business.
(function (root) {
  "use strict";

  const OWNED = "data-mine-x-post";
  const POST = 'article[data-testid="tweet"]';
  const CARET = '[data-testid="caret"]';
  const USER_NAME = '[data-testid="User-Name"]';
  const STACK_HEADER = '[data-testid="root"]';
  const HEADING = 'h1[role="heading"]';
  // X's links are `a` elements with role="link"; any other element with that
  // role inside a post is the clickable card of a quoted post.
  const QUOTE_SHELL = '[role="link"]:not(a)';
  // The label of the Grok button is a hint only: it changes with the
  // interface language (Р1).
  const GROK_LABEL = /grok/i;
  // The stack header holds the close box, a spacer, the title and the
  // actions box (Р2).
  const STACK_HEADER_MIN_CHILDREN = 3;
  const X_HOSTS = new Set(["x.com", "twitter.com", "pro.x.com"]);
  const SVG_NS = "http://www.w3.org/2000/svg";
  // The Mine mark of src/components/MineLogo.tsx, in its own grid.
  const MARK_VIEWBOX = "0 0 800 500";
  const MARK_PATH =
    "M800 200V100H700V0H600V100H500V0H300V100H200V0H100V400H0V500H100V400H200V200H300V100H400V300H300V500H400V300H500V200H600V100H700V200ZM600 500H700V300H600Z";
  const LABEL = "Save to Mine";
  // Events of the Mine button that X must not see: its post would open.
  const KEPT_FROM_X = ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend"];
  // The two controls a Mine button is copied from, each with a hover of its own.
  const KIND_POST = "post";
  const KIND_STACK = "stack";

  // What the copied control looked like when the Mine button was made from it.
  const templateLooks = new WeakMap();
  // What X changes on each kind of template control when the pointer is over it.
  const learnedHover = new Map();

  function isXHost(hostname) {
    return X_HOSTS.has(String(hostname || "").toLowerCase());
  }

  function isOwned(node) {
    return Boolean(node?.closest?.(`[${OWNED}]`));
  }

  function elementChildren(node) {
    return [...node.children].filter((child) => !child.matches(`[${OWNED}]`));
  }

  /// Whether `element` belongs to `article` itself rather than to a post
  /// nested in it or to the card of a quoted post.
  function ownedBy(article, element) {
    if (element.closest(POST) !== article) return false;
    for (let node = element.parentElement; node && node !== article; node = node.parentElement) {
      if (node.matches(QUOTE_SHELL)) return false;
    }
    return true;
  }

  function own(article, selector) {
    for (const element of article.querySelectorAll(selector)) {
      if (!isOwned(element) && ownedBy(article, element)) return element;
    }
    return null;
  }

  // ── Which post ───────────────────────────────────────────────────────────

  function statusIdentity(href, baseURI) {
    if (!href) return null;
    try {
      const url = new URL(href, baseURI || "https://x.com/");
      const match = url.pathname.match(/^\/([^/?#]+)\/status\/(\d+)(\/[^?#]*)?/i);
      if (!match) return null;
      return { handle: match[1], tweetId: match[2], rest: match[3] || "", href: url.href };
    } catch {
      return null;
    }
  }

  function profileHandle(href, baseURI) {
    try {
      const segments = new URL(href, baseURI || "https://x.com/").pathname.split("/").filter(Boolean);
      return segments.length === 1 ? segments[0].toLowerCase() : null;
    } catch {
      return null;
    }
  }

  /// The post's own time, outside any quote it carries.
  function ownTime(article) {
    return own(article, "time");
  }

  function timeLink(article, time) {
    const link = time?.closest("a[href]");
    return link && article.contains(link) ? link : null;
  }

  /// The post X Pro opened over a column: its own time is not a link (Р2).
  function isStackMainPost(article) {
    const time = ownTime(article);
    return Boolean(time) && !timeLink(article, time);
  }

  /// The post's ID and author handle as its links spell them: its time link,
  /// else its own status links outside quotes and analytics (Р3).
  function postIdentity(article) {
    const baseURI = article.ownerDocument?.baseURI;
    const fromTime = statusIdentity(timeLink(article, ownTime(article))?.getAttribute("href"), baseURI);
    if (fromTime) return { tweetId: fromTime.tweetId, handle: fromTime.handle, href: fromTime.href };
    const name = own(article, USER_NAME);
    let author = null;
    for (const link of name?.querySelectorAll("a[href]") ?? []) {
      author = profileHandle(link.getAttribute("href"), baseURI);
      if (author) break;
    }
    let first = null;
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      if (isOwned(link) || !ownedBy(article, link)) continue;
      const identity = statusIdentity(link.getAttribute("href"), baseURI);
      if (!identity || /^\/analytics(?:\/|$)/i.test(identity.rest)) continue;
      const found = { tweetId: identity.tweetId, handle: identity.handle, href: identity.href };
      if (!author || identity.handle.toLowerCase() === author) return found;
      first ??= found;
    }
    return first;
  }

  // ── Where the button goes ────────────────────────────────────────────────

  function commonAncestor(a, b) {
    for (let node = a.parentElement; node; node = node.parentElement) {
      if (node.contains(b)) return node;
    }
    return null;
  }

  /// A box that holds one control with an icon and no text: Grok, by its
  /// build rather than its label (Р1).
  function isIconControlBox(box) {
    const control = box.matches("button, [role='button']") ? box : box.querySelector("button, [role='button']");
    if (!control || !control.querySelector("svg")) return false;
    return box.textContent.trim() === "" || GROK_LABEL.test(control.getAttribute("aria-label") || "");
  }

  /// The row of the post's header: the nearest box holding both its "…" and
  /// its author block, or `null` when the post has no header of its own.
  function headerRow(article) {
    const caret = own(article, CARET);
    const name = own(article, USER_NAME);
    if (!caret || !name) return null;
    const row = commonAncestor(caret, name);
    return row && article.contains(row) ? { row, caret } : null;
  }

  /// The place of a post's Mine button: the box it goes before and the box of
  /// "…" it is copied from. `null` when the post has no header of its own.
  function headerSlot(article) {
    const header = headerRow(article);
    if (!header) return null;
    const { row, caret } = header;
    let rightBlock = caret;
    while (rightBlock.parentElement !== row) rightBlock = rightBlock.parentElement;
    // The first level, from "…" up to the right block, where "…" has a
    // neighbour: Grok, or a box with text such as Follow.
    for (let node = caret; node !== rightBlock; node = node.parentElement) {
      let neighbour = node.previousElementSibling;
      while (neighbour?.matches(`[${OWNED}]`)) neighbour = neighbour.previousElementSibling;
      if (!neighbour) continue;
      return { source: node, before: isIconControlBox(neighbour) ? neighbour : node, control: caret };
    }
    // Nothing beside "…": the button stands just before the box of "…".
    const source = caret.parentElement !== rightBlock && caret.parentElement !== row ? caret.parentElement : caret;
    return { source, before: source, control: caret };
  }

  function isStackHeader(element) {
    if (!element?.matches?.(STACK_HEADER)) return false;
    const children = elementChildren(element);
    if (children.length < STACK_HEADER_MIN_CHILDREN) return false;
    const actions = children[children.length - 1];
    return children.some((child) => child.querySelector(HEADING)) && !actions.querySelector(HEADING)
      && Boolean(actions.querySelector("button"));
  }

  function stackActions(header) {
    const children = elementChildren(header);
    return children[children.length - 1] ?? null;
  }

  /// The post a stack header stands for: the first opened post in the nearest
  /// ancestor of the header that holds posts at all (Р2).
  function stackMainPost(header) {
    const body = header.ownerDocument?.body;
    for (let node = header.parentElement; node && node !== body; node = node.parentElement) {
      const posts = [...node.querySelectorAll(POST)];
      if (posts.length === 0) continue;
      return posts.find((post) => !post.parentElement?.closest(POST) && isStackMainPost(post)) ?? null;
    }
    return null;
  }

  /// The stack header above an opened post, outside the post itself.
  function stackHeaderOf(article) {
    const body = article.ownerDocument?.body;
    for (let node = article.parentElement; node && node !== body; node = node.parentElement) {
      for (const header of node.querySelectorAll(STACK_HEADER)) {
        if (!article.contains(header) && isStackHeader(header)) return header;
      }
    }
    return null;
  }

  // ── The copy ─────────────────────────────────────────────────────────────

  /// Classes and inline styles of the copied elements: a different value
  /// means X drew its controls anew (theme, font size), and the copy is made
  /// again.
  function look(elements) {
    return elements
      .filter((element) => element.localName !== "path" && element.localName !== "g")
      .map((element) => `${element.localName}.${element.getAttribute("class") ?? ""}{${element.getAttribute("style") ?? ""}}`)
      .join("|");
  }

  /// The boxes from `from` down to `control`, without their other children,
  /// and the whole control: what the Mine button copies.
  function pathTo(from, control) {
    const chain = [];
    for (let node = control.parentElement; node && from !== control; node = node.parentElement) {
      chain.unshift(node);
      if (node === from) break;
    }
    return chain;
  }

  function sourceLook(from, control) {
    return look([...pathTo(from, control), control, ...control.querySelectorAll("*")]);
  }

  function clonePath(from, control) {
    let top = null;
    let parent = null;
    for (const node of pathTo(from, control)) {
      const copy = node.cloneNode(false);
      if (parent) parent.append(copy); else top = copy;
      parent = copy;
    }
    const copy = control.cloneNode(true);
    if (parent) parent.append(copy); else top = copy;
    return top;
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
  function applyHover(control, kind) {
    const parts = hoverParts(control);
    const hover = learnedHover.get(kind);
    if (!hover || !parts || parts.length !== hover.length) return null;
    const saved = parts.map((element) => [element.getAttribute("class"), element.getAttribute("style")]);
    parts.forEach((element, index) => {
      const { add, remove, style } = hover[index];
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

  /// Which template a control of X is: the "…" of a post, the button of a
  /// stack header, or neither.
  function templateKind(control) {
    if (control.matches(CARET) && control.closest(POST)) return KIND_POST;
    const header = control.closest(STACK_HEADER);
    if (header && isStackHeader(header) && stackActions(header)?.querySelector("button") === control) return KIND_STACK;
    return null;
  }

  /// X draws hover with its own script, which a copy does not get. The
  /// pointer over a template control shows what that script changes; the
  /// Mine buttons copied from it repeat it (rule 2).
  function learnHover(event) {
    const control = event.target?.closest?.("button");
    if (!control || isOwned(control)) return;
    const kind = templateKind(control);
    if (!kind) return;
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
      if (change) learnedHover.set(kind, change);
    });
  }

  function wire(control, kind, post, activate) {
    const keep = (event) => event.stopPropagation();
    for (const type of KEPT_FROM_X) control.addEventListener(type, keep, { passive: true });
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const article = post(control);
      if (article) activate(article, control);
    });
    let undo = null;
    control.addEventListener("pointerenter", () => {
      undo?.();
      undo = applyHover(control, kind);
    });
    control.addEventListener("pointerleave", () => {
      undo?.();
      undo = null;
    });
  }

  /// The copy of a template with the Mine mark in its icon. `post` finds the
  /// post the button saves at the moment it is pressed.
  function createButton(box, kind, post, activate) {
    const doc = box.ownerDocument;
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
    box.setAttribute(OWNED, kind);
    wire(control, kind, post, activate);
    return box;
  }

  /// One Mine button in `container`, just before `before`, copied from
  /// `source` down to `control`. Returns it, or `null` when it cannot be made.
  function place(container, before, source, control, kind, post, activate) {
    const existing = [...container.children].filter((child) => child.matches(`[${OWNED}]`));
    for (const extra of existing.slice(1)) extra.remove();
    let box = existing[0] ?? null;
    // A hovered control shows X's hover, not its look at rest.
    const currentLook = isHovered(control) ? null : sourceLook(source, control);
    if (box && currentLook !== null && templateLooks.get(box) !== currentLook) {
      box.remove();
      box = null;
    }
    if (!box) {
      if (currentLook === null) return null;
      box = createButton(clonePath(source, control), kind, post, activate);
      if (!box) return null;
      templateLooks.set(box, currentLook);
    }
    if (box.nextElementSibling !== before) before.before(box);
    return box;
  }

  function removeButtons(scope) {
    for (const box of scope.querySelectorAll(`[${OWNED}]`)) box.remove();
  }

  function postOfControl(control) {
    return control.closest(POST);
  }

  function postOfStackControl(control) {
    const header = control.closest(STACK_HEADER);
    return header ? stackMainPost(header) : null;
  }

  /// The Mine button of a stack header, before its actions box, while the
  /// header stands for an opened post with an ID (Р2).
  function ensureStackButton(header, activate) {
    if (!isStackHeader(header)) return null;
    const actions = stackActions(header);
    const control = actions.querySelector("button");
    const main = stackMainPost(header);
    // The header nearest to the opened post is its own; a column header
    // further up never claims it.
    if (!main || !postIdentity(main) || stackHeaderOf(main) !== header) {
      for (const box of [...header.children]) if (box.matches(`[${OWNED}]`)) box.remove();
      return null;
    }
    return place(header, actions, actions, control, KIND_STACK, postOfStackControl, activate);
  }

  /// One Mine button in the post's header (Р1), or in the header of its stack
  /// for the post X Pro opened (Р2). Returns the button, or `null` when the
  /// post gets none here.
  function ensureButton(article, activate) {
    if (isStackMainPost(article)) {
      for (const box of article.querySelectorAll(`[${OWNED}]`)) if (ownedBy(article, box)) box.remove();
      const header = stackHeaderOf(article);
      return header ? ensureStackButton(header, activate) : null;
    }
    const slot = headerSlot(article);
    if (!slot || !postIdentity(article)) {
      for (const box of article.querySelectorAll(`[${OWNED}]`)) if (ownedBy(article, box)) box.remove();
      return null;
    }
    const container = slot.before.parentElement;
    // A button left elsewhere in the post, such as in the action row by an
    // earlier version, goes.
    for (const box of article.querySelectorAll(`[${OWNED}]`)) {
      if (box.parentElement !== container && ownedBy(article, box)) box.remove();
    }
    return place(container, slot.before, slot.source, slot.control, KIND_POST, postOfControl, activate);
  }

  /// Every post and stack header of the page: the one full pass, when the
  /// buttons start.
  function scan(doc, activate) {
    for (const article of doc.querySelectorAll(POST)) ensureButton(article, activate);
    for (const header of doc.querySelectorAll(STACK_HEADER)) ensureStackButton(header, activate);
  }

  function holds(node, selector) {
    return node.nodeType === 1 && (node.matches(selector) || Boolean(node.querySelector(selector)));
  }

  const HEADER_PARTS = `${CARET}, ${USER_NAME}, [${OWNED}]`;

  /// The posts and stack headers a batch of changes may have left without
  /// their button: those X added, posts whose header X redrew (inside the
  /// header row or the box of "…", "…" or the Mine button added or removed),
  /// and stack headers whose children changed. Changes anywhere else, other
  /// posts and the action rows among them, are not looked at (Р4).
  function changedPosts(records, posts, headers) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(POST)) posts.add(node);
        for (const post of node.querySelectorAll(POST)) posts.add(post);
        if (node.matches(STACK_HEADER)) headers.add(node);
        for (const header of node.querySelectorAll(STACK_HEADER)) headers.add(header);
      }
      const target = record.target;
      if (target.nodeType !== 1) continue;
      const header = target.closest(STACK_HEADER);
      if (header) headers.add(header);
      const post = target.closest(POST);
      if (!post) continue;
      if ([...record.addedNodes].some((node) => holds(node, HEADER_PARTS))
        || [...record.removedNodes].some((node) => holds(node, HEADER_PARTS))
        || headerRow(post)?.row.contains(target)) {
        posts.add(post);
      }
    }
  }

  /// Keeps a Mine button on every post of the page as X adds, redraws and
  /// reuses them: one full pass at the start, then only the posts and stack
  /// headers the changes concern. Returns the function that stops it.
  function watch(doc, activate) {
    const view = doc.defaultView;
    const posts = new Set();
    const headers = new Set();
    let queued = false;
    // Changes of X reach the observer before this runs: the records left
    // after it are of the buttons' own insertions and are dropped.
    const run = () => {
      queued = false;
      const changed = [...posts];
      const changedHeaders = [...headers];
      posts.clear();
      headers.clear();
      for (const post of changed) if (post.isConnected) ensureButton(post, activate);
      for (const header of changedHeaders) if (header.isConnected) ensureStackButton(header, activate);
      observer.takeRecords();
    };
    const queue = (records) => {
      changedPosts(records, posts, headers);
      if (queued || (posts.size === 0 && headers.size === 0)) return;
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
      posts.clear();
      headers.clear();
      doc.removeEventListener("pointerover", learnHover, { capture: true });
    };
  }

  root.MineXFeedButton = {
    OWNED_ATTRIBUTE: OWNED, isXHost, postIdentity, isStackMainPost, ensureButton, ensureStackButton, scan, watch,
    removeAll: (doc) => removeButtons(doc),
  };
})(globalThis);
