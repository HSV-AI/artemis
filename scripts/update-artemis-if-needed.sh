#!/bin/bash
set -euo pipefail

# update-artemis-if-needed.sh
# Checks the configured remote branch for updates. If the local repository is
# behind, force-aligns it to that branch, rebuilds the Docker images, and
# restarts Artemis through Docker Compose.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BRANCH="${ARTEMIS_UPDATE_BRANCH:-main}"
REMOTE="${ARTEMIS_UPDATE_REMOTE:-origin}"

timestamp() {
  date -u "+%Y-%m-%dT%H:%M:%SZ"
}

cd "${REPO_ROOT}"

echo "[$(timestamp)] Checking ${REMOTE}/${BRANCH} for updates"

git fetch "${REMOTE}" "${BRANCH}"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "${CURRENT_BRANCH}" != "${BRANCH}" ]]; then
  echo "Current branch is '${CURRENT_BRANCH}', switching to '${BRANCH}'."
  git checkout -f "${BRANCH}"
fi

LOCAL_COMMIT_BEFORE="$(git rev-parse HEAD)"

echo "Resetting to ${REMOTE}/${BRANCH} and pulling latest changes."
git reset --hard "${REMOTE}/${BRANCH}"
git pull --ff-only "${REMOTE}" "${BRANCH}"

LOCAL_COMMIT_AFTER="$(git rev-parse HEAD)"

if [[ "${LOCAL_COMMIT_BEFORE}" == "${LOCAL_COMMIT_AFTER}" ]]; then
  echo "No updates available."
  exit 0
fi

echo "Rebuilding and restarting Artemis through Docker Compose."
docker compose up -d --build

echo "[$(timestamp)] Update complete"
