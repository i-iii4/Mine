import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import projectConfig from "../../../eslint.config.js";

// The boundary of the editor's modules (SPEC_EDITING.md, Л0.5), checked
// against the project's own ESLint configuration: like the reading pipeline,
// they know neither React, nor Tauri, nor the app's components.

// ESLint loads this very array; only the declared types disagree:
// typescript-eslint's config type has no index signature for language
// options, which ESLint's own type requires.
const config = projectConfig as Linter.Config[];

const PROJECT_ROOT = "/project";
const linter = new Linter({ cwd: PROJECT_ROOT });

function restrictedImports(code: string, file: string): string[] {
  return linter
    .verify(code, config, { filename: `${PROJECT_ROOT}/${file}` })
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

const FORBIDDEN = [
  "import { useState } from \"react\";\nvoid useState;\n",
  "import { createPortal } from \"react-dom\";\nvoid createPortal;\n",
  "import { invoke } from \"@tauri-apps/api/core\";\nvoid invoke;\n",
  "import { Detail } from \"@/components/Detail\";\nvoid Detail;\n",
  "import { listen } from \"@tauri-apps/api/event\";\nvoid listen;\n",
];

describe("the boundary of src/lib/editing (SPEC_EDITING.md, Л0.5)", () => {
  it.each(FORBIDDEN)("forbids: %s", (code) => {
    expect(restrictedImports(code, "src/lib/editing/example.ts")).toHaveLength(1);
  });

  it("allows CodeMirror, Lezer and the reading pipeline", () => {
    const code = [
      "import { EditorState } from \"@codemirror/state\";",
      "import { parser } from \"@lezer/markdown\";",
      "import { READING_REMARK_PLUGINS } from \"@/lib/reading/pipeline\";",
      "void EditorState; void parser; void READING_REMARK_PLUGINS;",
      "",
    ].join("\n");
    expect(restrictedImports(code, "src/lib/editing/example.ts")).toEqual([]);
  });

  it("leaves the editor's tests and elements their imports", () => {
    const code = FORBIDDEN[0]!;
    expect(restrictedImports(code, "src/lib/editing/example.test.ts")).toEqual([]);
    expect(restrictedImports(code, "src/components/editing/Example.tsx")).toEqual([]);
  });
});
