#!/usr/bin/env bash
# Builds, signs and uploads a release from this Mac.
#
# Builds the committed HEAD for all four platforms — macOS for Apple silicon
# and Intel (signed with Developer ID and notarised), Windows (cross-compiled
# with cargo-xwin) and Linux (in Docker) — uploads the bundles to a draft
# GitHub release, then tags and pushes. The pushed tag runs the Release
# workflow, which publishes the draft with scripts/publish-release.sh.
#
# Usage: scripts/release-build.sh [--publish]
#   --publish  publish from here as well, for when Actions is unavailable
#
# One-time setup of the Mac is in docs/UPDATES.md.
set -euo pipefail

publish=false
case "${1:-}" in
  --publish) publish=true ;;
  "") ;;
  *) echo "usage: release-build.sh [--publish]" >&2; exit 1 ;;
esac

die() { echo "release-build: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

repo="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(git -C "$repo" rev-parse HEAD)"

# Everything lives outside the repo: a worktree of the commit being released,
# so uncommitted changes can never end up in a release, and a Cargo target
# directory that survives between releases, so each one is an incremental
# build rather than a cold one.
root="${ALMASTUDIO_RELEASE_DIR:-$HOME/Library/Caches/almastudio-release}"
src="$root/src"
export CARGO_TARGET_DIR="$root/target"

# ---------------------------------------------------------------------------
# Preflight: everything is checked before the first build starts, so a
# missing key fails in seconds rather than half an hour in.
# ---------------------------------------------------------------------------

step "Checking $(git -C "$repo" log -1 --format='%h %s' "$commit")"

git -C "$repo" fetch -q origin
git -C "$repo" merge-base --is-ancestor "$commit" origin/main \
  || die "HEAD is not on origin/main; push it first."

mkdir -p "$root"
git -C "$repo" worktree remove --force "$src" 2> /dev/null || rm -rf "$src"
git -C "$repo" worktree prune
git -C "$repo" worktree add -q --detach "$src" "$commit"
linux_container="almastudio-linux-build-$$"
cleanup() {
  # A failed run must not leave an emulated build burning CPU behind it.
  docker rm -f "$linux_container" > /dev/null 2>&1 || true
  git -C "$repo" worktree remove --force "$src" 2> /dev/null || true
}
trap cleanup EXIT

version="$(node -p "require('$src/package.json').version")"
tag="v$version"
out="$root/$version"

[ "$(node -p "require('$src/src-tauri/tauri.conf.json').version")" = "$version" ] \
  || die "src-tauri/tauri.conf.json is not at $version."
grep -q "^version = \"$version\"$" "$src/src-tauri/Cargo.toml" \
  || die "src-tauri/Cargo.toml is not at $version."
node "$src/scripts/changelog-section.mjs" "$version" > /dev/null \
  || die "CHANGELOG.md has no section for $version."

if git -C "$repo" rev-parse -q --verify "refs/tags/$tag" > /dev/null; then
  [ "$(git -C "$repo" rev-parse "$tag^{commit}")" = "$commit" ] \
    || die "tag $tag already exists, on another commit."
fi
remote_tag="$(git -C "$repo" ls-remote origin "refs/tags/$tag^{}" "refs/tags/$tag" | tail -1 | cut -f1)"
if [ -n "$remote_tag" ] && [ "$remote_tag" != "$commit" ]; then
  die "origin already has $tag, on another commit."
fi
if [ "$(gh release view "$tag" --json isDraft --jq .isDraft 2> /dev/null)" = "false" ]; then
  die "$tag is already published."
fi

[ -f "$HOME/.almastudio/updater.key" ] \
  || die "no updater signing key at ~/.almastudio/updater.key."
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.almastudio/updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# Apple signing and notarisation settings, in the variables Tauri reads.
env_file="$HOME/.almastudio/release.env"
[ -f "$env_file" ] || die "no $env_file with the Apple signing settings."
set -a
# shellcheck source=/dev/null
. "$env_file"
set +a
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || die "APPLE_SIGNING_IDENTITY is not set in $env_file."
security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY" \
  || die "the keychain has no signing identity \"$APPLE_SIGNING_IDENTITY\"."
if [ -z "${APPLE_API_KEY:-}" ] && [ -z "${APPLE_ID:-}" ]; then
  die "no notarisation credentials in $env_file (APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID, or APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH)."
fi

installed_targets="$(rustup target list --installed)"
for t in aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc; do
  grep -qx "$t" <<< "$installed_targets" || die "missing Rust target $t (rustup target add $t)."
done
command -v cargo-xwin > /dev/null || die "cargo-xwin is not installed (cargo install --locked cargo-xwin)."
command -v makensis > /dev/null || die "makensis is not installed (brew install nsis)."
llvm_bin="$(brew --prefix llvm 2> /dev/null)/bin"
[ -x "$llvm_bin/clang-cl" ] || die "LLVM is not installed (brew install llvm)."
docker info > /dev/null 2>&1 || die "Docker is not running."

rm -rf "$out"
mkdir -p "$out/release" "$out/linux"

# ---------------------------------------------------------------------------
# Builds
# ---------------------------------------------------------------------------

# Linux runs emulated and is by far the slowest, so it starts first and runs
# alongside the native builds.
build_linux() {
  docker build -q --platform linux/amd64 -t almastudio-linux-build \
    -f "$src/scripts/linux-build.Dockerfile" "$src/scripts"
  # The container gets the commit itself, not the worktree: the worktree's
  # node_modules hold macOS binaries.
  git -C "$repo" archive --format=tar "$commit" | docker run --rm -i --platform linux/amd64 \
    --name "$linux_container" \
    -e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
    -e CARGO_TARGET_DIR=/target \
    -v almastudio-cargo-registry:/usr/local/cargo/registry \
    -v almastudio-linux-target:/target \
    -v "$out/linux:/out" \
    almastudio-linux-build bash -euo pipefail -c '
      tar -x -C /src
      npm ci --no-audit --no-fund
      rm -rf /target/release/bundle
      npm run tauri build
      b=/target/release/bundle
      cp $b/appimage/*.AppImage $b/appimage/*.AppImage.sig $b/deb/*.deb $b/rpm/*.rpm /out/'
}

step "Building Linux in Docker, in the background (log: $out/linux.log)"
build_linux > "$out/linux.log" 2>&1 &
linux_pid=$!

step "Installing npm dependencies"
(cd "$src" && npm ci --no-audit --no-fund)

build_mac() {
  local target="$1" arch="$2"
  local bundle="$CARGO_TARGET_DIR/$target/release/bundle"
  step "Building macOS $arch (signed and notarised)"
  rm -rf "$bundle"
  (cd "$src" && npm run tauri build -- --target "$target")
  cp "$bundle/dmg/"*.dmg "$out/release/"
  # Both slices are built as AlmaStudio.app.tar.gz; they are published under
  # names that say which is which.
  cp "$bundle/macos/AlmaStudio.app.tar.gz" "$out/release/AlmaStudio_${version}_${arch}.app.tar.gz"
  cp "$bundle/macos/AlmaStudio.app.tar.gz.sig" "$out/release/AlmaStudio_${version}_${arch}.app.tar.gz.sig"
}

build_mac aarch64-apple-darwin aarch64
build_mac x86_64-apple-darwin x64

step "Building Windows (cross-compiled with cargo-xwin)"
win="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle"
rm -rf "$win"
(cd "$src" && PATH="$llvm_bin:$PATH" npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc)
cp "$win/nsis/"*-setup.exe "$win/nsis/"*-setup.exe.sig "$out/release/"

step "Waiting for the Linux build"
wait "$linux_pid" || { tail -30 "$out/linux.log" >&2; die "the Linux build failed; see $out/linux.log."; }
cp "$out/linux/"* "$out/release/"

step "Built $version"
ls -1 "$out/release"

# ---------------------------------------------------------------------------
# Upload, tag, push
# ---------------------------------------------------------------------------

step "Uploading to the draft release $tag"
if gh release view "$tag" > /dev/null 2>&1; then
  gh release upload "$tag" "$out/release/"* --clobber
else
  # --target: should the tag somehow not reach origin, GitHub would create it
  # on this commit rather than on the tip of the default branch.
  gh release create "$tag" "$out/release/"* --draft --target "$commit" \
    --title "AlmaStudio $version" --notes "Waiting to be published by the Release workflow."
fi

step "Tagging and pushing $tag"
git -C "$repo" rev-parse -q --verify "refs/tags/$tag" > /dev/null || git -C "$repo" tag "$tag" "$commit"
if [ -n "$remote_tag" ]; then
  echo "origin already had $tag, so no workflow was started by this push."
  echo "Publish with: scripts/publish-release.sh $version"
else
  git -C "$repo" push -q origin "$tag"
fi

if $publish; then
  step "Publishing from here"
  "$src/scripts/publish-release.sh" "$version"
else
  echo
  echo "The Release workflow now publishes $tag. If Actions is unavailable:"
  echo "  scripts/publish-release.sh $version"
fi
