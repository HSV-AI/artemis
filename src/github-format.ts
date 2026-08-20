export type JsonRecord = Record<string, unknown>;
export type GitHubSearchScope =
  | "repositories"
  | "issues"
  | "pull_requests"
  | "code"
  | "commits";
export type GitHubListResource = "pull_requests" | "issues" | "branches";

export function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

export function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nested(record: JsonRecord, key: string): JsonRecord {
  return asRecord(record[key]);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function formatSearchItems(scope: GitHubSearchScope, value: unknown): string {
  const items = asRecords(value);
  if (items.length === 0) return "No results found.";

  return items.map((item, index) => {
    if (scope === "repositories") {
      return [
        `${index + 1}. ${stringValue(item.full_name, "unknown")}`,
        `   ${stringValue(item.html_url)}`,
        `   ${truncate(stringValue(item.description, "No description"), 160)}`
      ].join("\n");
    }
    if (scope === "code") {
      const fragments = asRecords(item.text_matches)
        .map((match) => stringValue(match.fragment))
        .filter(Boolean)
        .join(" / ");
      return [
        `${index + 1}. ${stringValue(item.name, "unknown")}`,
        `   ${stringValue(item.html_url)}`,
        `   ${stringValue(nested(item, "repository").full_name, "unknown")}`,
        `   ${truncate(fragments, 160)}`
      ].join("\n");
    }
    if (scope === "commits") {
      const commit = nested(item, "commit");
      const message = stringValue(commit.message);
      return [
        `${index + 1}. ${message.split("\n")[0] ?? ""}`,
        `   ${stringValue(item.html_url)}`,
        `   ${stringValue(nested(item, "author").login, stringValue(nested(commit, "author").name, "unknown"))}`,
        `   ${truncate(message, 160)}`
      ].join("\n");
    }
    return [
      `${index + 1}. ${stringValue(item.title, "Untitled")}`,
      `   ${stringValue(item.html_url)}`,
      `   ${stringValue(item.state, "unknown")} by ${stringValue(nested(item, "user").login, "unknown")}`,
      `   ${truncate(stringValue(item.body, "No body"), 160)}`
    ].join("\n");
  }).join("\n\n");
}

export function formatRepository(value: unknown): string {
  const data = asRecord(value);
  return [
    stringValue(data.full_name, "Unknown repository"),
    stringValue(data.html_url),
    "",
    truncate(stringValue(data.description, "No description"), 400),
    "",
    `Visibility: ${booleanValue(data.private) ? "private" : "public"}`,
    `Default branch: ${stringValue(data.default_branch, "unknown")}`,
    `Open issues: ${numberValue(data.open_issues_count)}`,
    `Stars: ${numberValue(data.stargazers_count)}`,
    `Forks: ${numberValue(data.forks_count)}`
  ].join("\n");
}

export function formatIssueOrPull(value: unknown, kind: "issue" | "pull request"): string {
  const data = asRecord(value);
  const labels = asRecords(data.labels).map((label) => stringValue(label.name)).filter(Boolean);
  return [
    `${kind === "issue" ? "Issue" : "Pull Request"} #${numberValue(data.number)}: ${stringValue(data.title, "Untitled")}`,
    stringValue(data.html_url),
    "",
    `State: ${stringValue(data.state, "unknown")}`,
    `Author: ${stringValue(nested(data, "user").login, "unknown")}`,
    `Labels: ${labels.join(", ") || "none"}`,
    "",
    truncate(stringValue(data.body, "No body"), 1200)
  ].join("\n");
}

export function formatIssueComments(value: unknown): string {
  const comments = asRecords(value);
  if (comments.length === 0) return "No comments found.";
  return comments.map((comment, index) => [
    `Comment ${index + 1} by ${stringValue(nested(comment, "user").login, "unknown")}`,
    stringValue(comment.html_url, stringValue(comment.url)),
    "",
    truncate(stringValue(comment.body, "No body"), 1200)
  ].join("\n")).join("\n\n");
}

export function formatListItems(resource: GitHubListResource, value: unknown): string {
  const items = asRecords(value);
  if (items.length === 0) return "No results found.";
  return items.map((item, index) => {
    if (resource === "branches") {
      return [
        `${index + 1}. ${stringValue(item.name, "unknown")}`,
        `   ${stringValue(nested(item, "commit").sha)}`,
        `   ${booleanValue(item.protected) ? "protected" : "unprotected"}`
      ].join("\n");
    }
    if (resource === "pull_requests") {
      return [
        `${index + 1}. PR #${numberValue(item.number)}: ${stringValue(item.title, "Untitled")}`,
        `   ${stringValue(item.html_url)}`,
        `   ${stringValue(item.state, "unknown")} by ${stringValue(nested(item, "user").login, "unknown")}`,
        `   Draft: ${booleanValue(item.draft) ? "yes" : "no"}`,
        `   Head: ${stringValue(nested(item, "head").ref, "unknown")} → Base: ${stringValue(nested(item, "base").ref, "unknown")}`
      ].join("\n");
    }
    return [
      `${index + 1}. Issue #${numberValue(item.number)}: ${stringValue(item.title, "Untitled")}`,
      `   ${stringValue(item.html_url)}`,
      `   ${stringValue(item.state, "unknown")} by ${stringValue(nested(item, "user").login, "unknown")}`,
      `   ${truncate(stringValue(item.body, "No body"), 160)}`
    ].join("\n");
  }).join("\n\n");
}

export function formatContents(value: unknown, limit = 4000): string {
  if (Array.isArray(value)) {
    const entries = asRecords(value);
    if (entries.length === 0) return "Directory is empty.";
    return entries.map((entry) => `${stringValue(entry.type, "unknown")}: ${stringValue(entry.path)}`).join("\n");
  }
  const data = asRecord(value);
  if (data.type === "file" && typeof data.content === "string" && data.encoding === "base64") {
    const decoded = Buffer.from(data.content, "base64").toString("utf8");
    const content = limit > 0 ? truncate(decoded, limit) : decoded;
    return [`File: ${stringValue(data.path)}`, stringValue(data.html_url), "", content].join("\n");
  }
  return JSON.stringify(value, null, 2);
}

export const githubFormatInternals = { truncate };
