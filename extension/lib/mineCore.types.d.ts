import type {
  CoreCommand,
  SaveAction,
  VaultWriteLayoutDto,
} from "../../src/types/generated";

/** One collection of a space and how many cards name it (mine-core `CollectionCount`). */
export interface CollectionCount {
  tag: string;
  block_count: number;
}

/** What each save core command answers (mine-core/src/save.rs, `execute`). */
export interface CoreResults {
  capture: { slug: string; markdown: string; hash: string };
  name: { name: string; slug: string };
  unique_file_name: { name: string };
  shortest_link: { target: string };
  layout: VaultWriteLayoutDto;
  detect_layout: VaultWriteLayoutDto;
  collection: { markdown: string };
  inspect: { collection: boolean; position: number | null; collections: string[] };
  collections: CollectionCount[];
  collection_pages: null;
  advance: SaveAction;
  fingerprint: string;
  /** `null` when neither the bytes nor the declared type name a kind it saves. */
  media_extension: { extension: string | null };
}

declare global {
  var MineCore: {
    /**
     * Run one save core command in the WASM build. A refusal of the core
     * rejects with an `Error` carrying its `code` (and the `collection` a
     * `collection_not_found` names).
     */
    call<C extends CoreCommand>(command: C): Promise<CoreResults[C["op"]]>;
  };

  /**
   * wasm-bindgen's `no-modules` glue of the save core
   * (generated/save-core/mine_core.js), which the worker imports before
   * lib/mineCore.js. It is a lexical binding of the worker's global scope,
   * not a property of globalThis. Only the part lib/mineCore.js calls:
   * loading the binary, then running a command.
   */
  function wasm_bindgen(options: { module_or_path: string | BufferSource }): Promise<unknown>;
  namespace wasm_bindgen {
    /** One JSON command in, one JSON envelope `{ ok, value | error }` out. */
    function execute_json(input: string): string;
  }
}
