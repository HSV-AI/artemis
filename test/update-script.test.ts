import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const sourceScript = new URL("../scripts/update-artemis-if-needed.sh", import.meta.url);

interface RunOptions {
  hasUpdate: boolean;
  currentBranch?: string;
  remote?: string;
  branch?: string;
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function runUpdater(options: RunOptions): Promise<{ stdout: string; commands: string }> {
  const root = await mkdtemp(join(tmpdir(), "artemis-updater-"));
  temporaryDirectories.push(root);
  const scripts = join(root, "scripts");
  const fakeBin = join(root, "fake-bin");
  const commandLog = join(root, "commands.log");
  await mkdir(scripts);
  await mkdir(fakeBin);
  await writeFile(join(scripts, "update-artemis-if-needed.sh"), await readFile(sourceScript));

  await writeExecutable(
    join(fakeBin, "git"),
    `#!/bin/bash
set -eu
printf 'git %s\n' "$*" >> "$FAKE_COMMAND_LOG"
if [[ "$1 $2" == "branch --show-current" ]]; then
  printf '%s\n' "$FAKE_CURRENT_BRANCH"
elif [[ "$1 $2" == "rev-parse HEAD" ]]; then
  if [[ -f "$FAKE_REPO/.updated" ]]; then printf 'new\n'; else printf 'old\n'; fi
elif [[ "$1" == "reset" && "$FAKE_HAS_UPDATE" == "1" ]]; then
  touch "$FAKE_REPO/.updated"
fi
`
  );
  await writeExecutable(
    join(fakeBin, "npm"),
    `#!/bin/bash
printf 'npm %s\n' "$*" >> "$FAKE_COMMAND_LOG"
`
  );
  await writeExecutable(
    join(fakeBin, "docker"),
    `#!/bin/bash
printf 'docker %s\n' "$*" >> "$FAKE_COMMAND_LOG"
`
  );

  const result = await execFileAsync("/bin/bash", [join(scripts, "update-artemis-if-needed.sh")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_COMMAND_LOG: commandLog,
      FAKE_REPO: root,
      FAKE_HAS_UPDATE: options.hasUpdate ? "1" : "0",
      FAKE_CURRENT_BRANCH: options.currentBranch ?? "main",
      ARTEMIS_UPDATE_REMOTE: options.remote ?? "origin",
      ARTEMIS_UPDATE_BRANCH: options.branch ?? "main"
    }
  });
  return {
    stdout: result.stdout,
    commands: await readFile(commandLog, "utf8")
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("update-artemis-if-needed.sh", () => {
  it("exits without rebuilding when the remote commit is unchanged", async () => {
    const result = await runUpdater({
      hasUpdate: false,
      remote: "personal",
      branch: "stable"
    });
    expect(result.stdout).toContain("Checking personal/stable for updates");
    expect(result.stdout).toContain("No updates available.");
    expect(result.commands).toContain("git fetch personal stable");
    expect(result.commands).not.toContain("npm install");
    expect(result.commands).not.toContain("docker compose");
  });

  it("switches branches and rebuilds Compose", async () => {
    const result = await runUpdater({
      hasUpdate: true,
      currentBranch: "feature"
    });
    expect(result.stdout).toContain("switching to 'main'");
    expect(result.stdout).toContain("Update complete");
    expect(result.commands).toContain("git checkout -f main");
    expect(result.commands).toContain("git reset --hard origin/main");
    expect(result.commands).toContain("git pull --ff-only origin main");
    expect(result.commands).not.toContain("npm install");
    expect(result.commands).toContain("docker compose up -d --build");
  });

  it("rebuilds without switching when already on the target branch", async () => {
    const result = await runUpdater({ hasUpdate: true });
    expect(result.commands).not.toContain("git checkout -f");
    expect(result.commands).not.toContain("npm install");
    expect(result.commands).toContain("docker compose up -d --build");
  });
});
