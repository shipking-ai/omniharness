#!/usr/bin/env bash
# Build, verify and publish the omniharness-cli npm wrapper.
#
# Usage:
#   scripts/release-npm.sh               # auto-bump patch (0.1.1 -> 0.1.2), verify, publish
#   scripts/release-npm.sh --minor       # auto-bump minor (0.1.1 -> 0.2.0)
#   scripts/release-npm.sh --major       # auto-bump major (0.1.1 -> 1.0.0)
#   scripts/release-npm.sh 0.2.0         # explicit version
#   scripts/release-npm.sh --dry-run     # bump + verify only, skip publish
#
# To jump to a new version line (a major release, say), set it in
# npm/package.json. A version there that is newer than the one on npm is
# released exactly as written; every release after it bumps from it as usual.
#
# Prerequisites:
#   - npm authenticated. In CI this is npm trusted publishing (OIDC): the
#     workflow's id-token permission is the credential, so no token is stored.
#     Running it by hand needs `npm login`, or a granular token with "Bypass
#     2FA for publish" set as NODE_AUTH_TOKEN or in .npmrc.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
PRINT_ONLY=0
BUMP="patch"
VERSION_ARG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run)            DRY_RUN=1 ;;
    --print-next-version) PRINT_ONLY=1 ;;
    --minor)              BUMP="minor" ;;
    --major)              BUMP="major" ;;
    -*)        echo "unknown option: $arg" >&2; exit 2 ;;
    *)         VERSION_ARG="$arg" ;;
  esac
done

# latest_published queries npm for the current published version of the package.
# Returns empty string when the package has never been published.
# RELEASE_LATEST_PUBLISHED stands in for the registry, so the version rules
# below can be checked without network access or a real package.
latest_published() {
  if [[ -n "${RELEASE_LATEST_PUBLISHED+set}" ]]; then
    echo "$RELEASE_LATEST_PUBLISHED"
    return
  fi
  npm view omniharness-cli version 2>/dev/null || true
}

# next_version prints the version that would be published, writing nothing.
#
# The baseline is the *latest published* version on npm, not the local
# package.json, so a CI run never tries to re-publish an existing version —
# except that a local version newer than anything published is a deliberate
# jump (2.0.0 over 0.1.122) and is released as written, without a bump.
next_version() {
  VERSION_ARG="$VERSION_ARG" BUMP="$BUMP" LATEST_PUBLISHED="$(latest_published)" node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync("npm/package.json", "utf8"));
    const parse = (v) => v.split(".").map(Number);
    const newer = (a, b) => {
      const [x, y] = [parse(a), parse(b)];
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
      return false;
    };
    const published = process.env.LATEST_PUBLISHED;
    const [maj, min, pat] = parse(published || j.version);
    if (process.env.VERSION_ARG) console.log(process.env.VERSION_ARG);
    else if (published && newer(j.version, published)) console.log(j.version);
    else if (process.env.BUMP === "major") console.log(`${maj + 1}.0.0`);
    else if (process.env.BUMP === "minor") console.log(`${maj}.${min + 1}.0`);
    else console.log(`${maj}.${min}.${pat + 1}`);
  '
}

# bump_version writes the next version into npm/package.json and prints it.
# One rule for both: it is whatever next_version says.
bump_version() {
  local v
  v="$(next_version)"
  V="$v" node -e '
    const fs = require("fs");
    const p = "npm/package.json";
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.version = process.env.V;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  '
  echo "$v"
}

# --print-next-version resolves the next version and stops, without publishing.
# The release uses it to build and verify the Go binaries *before* npm goes
# out, then passes the same version back in explicitly — so the two channels
# cannot disagree about what shipped, and a broken build stops the release
# rather than stranding a published npm version with no binaries.
if [[ "$PRINT_ONLY" == "1" ]]; then
  next_version
  exit 0
fi

VERSION="$(bump_version)"

# Hand the resolved version to the workflow so the git tag matches what was
# published, rather than re-deriving it.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "version=$VERSION" >> "$GITHUB_OUTPUT"
fi

# The package ships the new Ink/Mastra TUI. Build it before packaging so the
# published launcher executes the TypeScript interface rather than the legacy
# Go Bubble Tea cockpit.
cd npm
npm install --ignore-scripts

# Verify the TypeScript side before building it. This is the same suite CI
# runs on pull requests; running it here too means a release can never ship a
# tarball whose tests were never executed.
echo "Verifying: npm test"
npm test
npm run build
cd "$REPO_ROOT"

echo "Built omniharness-cli v$VERSION TypeScript CLI"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: publish skipped. Next version would be $VERSION"
  exit 0
fi

cd npm
npm publish
echo "Published omniharness-cli v$VERSION"
