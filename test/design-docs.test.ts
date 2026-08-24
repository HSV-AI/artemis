import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDesignDocs, markdownHeadings, markdownLinks } from "../scripts/check-design-docs.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("design documentation guardrail", () => {
  it("accepts the repository design-document structure", async () => {
    await expect(checkDesignDocs(process.cwd())).resolves.toEqual([]);
  });

  it("extracts Markdown links and normalized headings", () => {
    expect(markdownLinks("[Local](doc.md) [Web](https://example.com)"))
      .toEqual(["doc.md", "https://example.com"]);
    expect(markdownHeadings("# Title\n\n## Failure handling\n"))
      .toEqual(new Set(["title", "failure handling"]));
  });

  it("reports orphaned, incomplete, and broken documents", async () => {
    const root = mkdtempSync(join(tmpdir(), "artemis-design-check-"));
    temporaryDirectories.push(root);
    const design = join(root, "design");
    mkdirSync(design);
    writeFileSync(join(design, "README.md"), "# Index\n\n[Baseline](baseline.md)\n[Missing](missing.md)\n");
    writeFileSync(join(design, "baseline.md"), "# Baseline\n");
    writeFileSync(join(design, "orphan.md"), "# Orphan\n\n## Problem\n");

    const errors = await checkDesignDocs(root);

    expect(errors).toContain("design/orphan.md is not linked from design/README.md");
    expect(errors).toContain("design/README.md contains a broken local link: missing.md");
    expect(errors).toContain("design/orphan.md is missing required section: Status");
    expect(errors).toContain("design/orphan.md is missing required section: Verification");
  });
});
