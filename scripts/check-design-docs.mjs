import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CORE_DOCUMENTS = new Set(["README.md", "baseline.md", "rebuild-guide.md"]);
const REQUIRED_SUBDOCUMENT_SECTIONS = [
  "Status",
  "Problem",
  "Scope",
  "Observable behavior",
  "Contracts and data flow",
  "Configuration",
  "Persistence",
  "Security and privacy",
  "Failure handling",
  "Verification",
  "References"
];

function posixPath(value) {
  return value.split(path.sep).join("/");
}

async function listMarkdownFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(path.join(directory, entry.name), relative));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(posixPath(relative));
    }
  }
  return files.sort();
}

export function markdownLinks(content) {
  return [...content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean)
    .map((target) => {
      if (target.startsWith("<") && target.endsWith(">")) {
        return target.slice(1, -1);
      }
      return target;
    });
}

export function markdownHeadings(content) {
  return new Set(
    [...content.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)]
      .map((match) => match[1]?.trim().toLowerCase())
      .filter(Boolean)
  );
}

function localPathFromLink(sourceFile, target) {
  if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target)) {
    return undefined;
  }
  const withoutFragment = target.split("#", 1)[0]?.split("?", 1)[0];
  if (!withoutFragment) {
    return undefined;
  }
  try {
    return path.resolve(path.dirname(sourceFile), decodeURIComponent(withoutFragment));
  } catch {
    return null;
  }
}

function linkedDesignDocuments(content, sourceFile, designDirectory) {
  const linked = new Set();
  for (const target of markdownLinks(content)) {
    const resolved = localPathFromLink(sourceFile, target);
    if (!resolved || !resolved.endsWith(".md")) continue;
    const relative = posixPath(path.relative(designDirectory, resolved));
    if (!relative.startsWith("../")) linked.add(relative);
  }
  return linked;
}

export async function checkDesignDocs(rootDirectory = process.cwd()) {
  const designDirectory = path.join(rootDirectory, "design");
  const indexFile = path.join(designDirectory, "README.md");
  const errors = [];

  let documents;
  try {
    documents = await listMarkdownFiles(designDirectory);
  } catch {
    return ["design directory is missing or unreadable"];
  }

  const contents = new Map();
  for (const document of documents) {
    contents.set(document, await readFile(path.join(designDirectory, document), "utf8"));
  }

  const indexContent = contents.get("README.md");
  if (indexContent === undefined) errors.push("design/README.md is required");

  const indexed = indexContent === undefined
    ? new Set()
    : linkedDesignDocuments(indexContent, indexFile, designDirectory);

  for (const document of documents) {
    if (document !== "README.md" && !indexed.has(document)) {
      errors.push(`design/${document} is not linked from design/README.md`);
    }

    const content = contents.get(document) ?? "";
    const sourceFile = path.join(designDirectory, document);
    for (const target of markdownLinks(content)) {
      const resolved = localPathFromLink(sourceFile, target);
      if (resolved === undefined) continue;
      if (resolved === null) {
        errors.push(`design/${document} contains an invalid local link: ${target}`);
        continue;
      }
      try {
        await access(resolved);
      } catch {
        errors.push(`design/${document} contains a broken local link: ${target}`);
      }
    }

    if (CORE_DOCUMENTS.has(document)) continue;
    const headings = markdownHeadings(content);
    for (const section of REQUIRED_SUBDOCUMENT_SECTIONS) {
      if (!headings.has(section.toLowerCase())) {
        errors.push(`design/${document} is missing required section: ${section}`);
      }
    }
  }

  return errors;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  const errors = await checkDesignDocs();
  if (errors.length > 0) {
    process.stderr.write(`Design documentation check failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Design documentation check passed.\n");
  }
}
