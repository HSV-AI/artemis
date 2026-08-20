import { describe, expect, it } from "vitest";
import {
  asRecord,
  asRecords,
  formatContents,
  formatIssueComments,
  formatIssueOrPull,
  formatListItems,
  formatRepository,
  formatSearchItems,
  githubFormatInternals,
  stringValue
} from "../src/github-format.js";

describe("GitHub formatting", () => {
  it("normalizes unknown JSON values", () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord({ value: 1 })).toEqual({ value: 1 });
    expect(asRecords([null, { value: 1 }])).toEqual([{}, { value: 1 }]);
    expect(asRecords("nope")).toEqual([]);
    expect(stringValue(1, "fallback")).toBe("fallback");
    expect(githubFormatInternals.truncate("abcd", 4)).toBe("abcd");
    expect(githubFormatInternals.truncate("abcde", 4)).toBe("abc…");
  });

  it.each([
    ["repositories", { full_name: "o/r", html_url: "url", description: "repo" }, "o/r"],
    ["issues", { title: "Bug", html_url: "url", state: "open", user: { login: "m" }, body: "body" }, "Bug"],
    ["pull_requests", { title: "PR", html_url: "url", state: "open", user: { login: "m" }, body: "body" }, "PR"],
    ["code", { name: "a.ts", html_url: "url", repository: { full_name: "o/r" }, text_matches: [{ fragment: "match" }] }, "match"],
    ["commits", { html_url: "url", author: { login: "m" }, commit: { message: "Subject\nBody" } }, "Subject"]
  ] as const)("formats %s search results", (scope, item, expected) => {
    expect(formatSearchItems(scope, [item])).toContain(expected);
    expect(formatSearchItems(scope, [])).toBe("No results found.");
  });

  it("formats repository and issue metadata", () => {
    expect(formatRepository({
      full_name: "o/r", html_url: "url", description: "desc", private: true,
      default_branch: "main", open_issues_count: 2, stargazers_count: 3, forks_count: 4
    })).toContain("Visibility: private");
    expect(formatIssueOrPull({
      number: 4, title: "Title", html_url: "url", state: "open",
      user: { login: "m" }, labels: [{ name: "bug" }], body: "Body"
    }, "pull request")).toContain("Pull Request #4: Title");
  });

  it("formats comments, branches, pull requests, and issues", () => {
    expect(formatIssueComments([])).toBe("No comments found.");
    expect(formatIssueComments([{ user: { login: "m" }, url: "url", body: "Body" }])).toContain("Comment 1 by m");
    expect(formatListItems("branches", [{ name: "main", commit: { sha: "abc" }, protected: true }])).toContain("protected");
    expect(formatListItems("pull_requests", [{
      number: 1, title: "PR", html_url: "url", state: "open", user: { login: "m" },
      draft: true, head: { ref: "feature" }, base: { ref: "main" }
    }])).toContain("Head: feature → Base: main");
    expect(formatListItems("issues", [{ number: 2, title: "Issue", state: "open", body: "Body" }])).toContain("Issue #2");
    expect(formatListItems("issues", [])).toBe("No results found.");
  });

  it("formats directories, decoded files, unlimited files, and unknown contents", () => {
    expect(formatContents([])).toBe("Directory is empty.");
    expect(formatContents([{ type: "file", path: "README.md" }])).toBe("file: README.md");
    const file = { type: "file", path: "a.txt", html_url: "url", encoding: "base64", content: Buffer.from("abcdef").toString("base64") };
    expect(formatContents(file, 5)).toContain("abcd…");
    expect(formatContents(file, 0)).toContain("abcdef");
    expect(formatContents({ type: "symlink", target: "a" })).toContain('"target": "a"');
  });
});
