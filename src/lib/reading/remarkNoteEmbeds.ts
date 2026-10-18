// Note embeds (SPEC_READING_MODE.md, Ч11.1): `![[Note]]`, which the wikilink
// pre-processing has made `![](Note)`, and `![](Note.md)` name a note, not a
// picture, when their target is local, has no scheme and no extension of
// media. Such an image becomes a note embed (`span[data-mine-note-embed]`),
// which `NoteEmbed` draws as the note's card; in a table cell it becomes a
// wikilink to the note, because a 240 px card would set the column's width
// (Ч11.3).

import type { Image, Link, Nodes, PhrasingContent, Root } from "mdast";
import { decodeLocalMarkdownUrl, wikilinkHref } from "@/lib/markdownWikilinks";

declare module "mdast" {
  /** A note drawn as its card inside the article. */
  interface NoteEmbed extends Node {
    type: "noteEmbed";
  }

  interface PhrasingContentMap {
    noteEmbed: NoteEmbed;
  }

  interface RootContentMap {
    noteEmbed: NoteEmbed;
  }
}

/** Extensions that end a file name inside a link target, as the core lists
 *  them (`mine_core::domain::block::IMAGE_MEDIA_EXTS`, `VIDEO_MEDIA_EXTS`,
 *  `mine_core::links::FILE_EXTENSIONS` without `md`); `remarkNoteEmbeds.test.ts`
 *  keeps the lists equal. */
export const MEDIA_LINK_EXTENSIONS: readonly string[] = [
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "avif",
  "mp4", "webm", "m4v", "mov",
  "pdf", "mp3", "m4a", "wav", "ogg",
];

/** The note's extension. */
const NOTE_EXTENSION = "md";
/** A name's extension: up to eight Latin letters or digits after its last
 *  dot, at least one a letter (`canvas`, `base`, `svg`). A name like
 *  `Meeting 18.10.2026` or `Note v1.2` has none, so it names a note, as in
 *  Obsidian. */
const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The `data-mine-*` properties a note embed is drawn with. */
export const NOTE_EMBED_PROPERTY = "dataMineNoteEmbed";
export const NOTE_EMBED_FRAGMENT_PROPERTY = "dataMineNoteEmbedFragment";
export const NOTE_EMBED_LABEL_PROPERTY = "dataMineNoteEmbedLabel";

/** What a note embed names: the note, and the heading or block after `#`. */
export interface NoteEmbedTarget {
  /** The note as written, without its fragment. */
  note: string;
  /** `Heading` of `Note#Heading`, `^block` of `Note#^block`. */
  fragment: string | null;
}

function fileExtension(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const extension = EXTENSION.exec(base)?.[1];
  return extension && /[A-Za-z]/.test(extension) ? extension.toLowerCase() : null;
}

/** Whether `name` ends in an extension that names a file rather than a
 *  heading: `Graph #td (video 1).mp4` is one name with `#` in it. */
function namesMediaFile(name: string): boolean {
  const extension = fileExtension(name);
  return extension !== null && MEDIA_LINK_EXTENSIONS.includes(extension);
}

/** The note an embed's decoded target names, or `null` when it names
 *  something else: a remote address, media, or a file of another kind
 *  (`.canvas`, `.base`), which are drawn as before. The fragment splits
 *  off as the core does (`mine_core::links::split_link_fragment`). */
export function noteEmbedTarget(target: string): NoteEmbedTarget | null {
  const trimmed = target.trim();
  if (!trimmed || SCHEME.test(trimmed) || trimmed.startsWith("#")) return null;
  if (namesMediaFile(trimmed)) return null;
  const hash = trimmed.indexOf("#");
  const note = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const fragment = hash === -1 ? null : trimmed.slice(hash + 1) || null;
  if (!note) return null;
  const extension = fileExtension(note);
  if (extension !== null && extension !== NOTE_EXTENSION) return null;
  return { note, fragment };
}

/** What the person wrote of the target, `Note#Heading` with its fragment. */
function writtenTarget(target: NoteEmbedTarget): string {
  return target.fragment === null ? target.note : `${target.note}#${target.fragment}`;
}

function embedNode(image: Image, target: NoteEmbedTarget): PhrasingContent {
  const label = image.alt?.trim() ?? "";
  return {
    type: "noteEmbed",
    position: image.position,
    data: {
      hName: "span",
      hProperties: {
        [NOTE_EMBED_PROPERTY]: target.note,
        ...(target.fragment === null ? {} : { [NOTE_EMBED_FRAGMENT_PROPERTY]: target.fragment }),
        ...(label ? { [NOTE_EMBED_LABEL_PROPERTY]: label } : {}),
      },
    },
  };
}

function cellLink(image: Image, target: NoteEmbedTarget): Link {
  const written = writtenTarget(target);
  return {
    type: "link",
    url: wikilinkHref(written),
    children: [{ type: "text", value: image.alt?.trim() || written }],
    position: image.position,
  };
}

function transform(node: Nodes, inCell: boolean) {
  if (!("children" in node)) return;
  // Any child may be replaced by any node: the array is read and written as
  // the union of nodes, which every parent's children belong to.
  const children = node.children as Nodes[];
  const childrenInCell = inCell || node.type === "tableCell";
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child?.type === "image") {
      const target = noteEmbedTarget(decodeLocalMarkdownUrl(child.url));
      if (target) children[index] = childrenInCell ? cellLink(child, target) : embedNode(child, target);
      continue;
    }
    if (child) transform(child, childrenInCell);
  }
}

/** The remark plugin of note embeds. */
export function remarkNoteEmbeds() {
  return (tree: Root) => {
    transform(tree, false);
  };
}
