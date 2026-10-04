#!/usr/bin/env bash
# Inspect the actual distributed DMG, including its app's ad-hoc signature.
set -euo pipefail
shopt -s nullglob

repo="$(cd "$(dirname "$0")/../.." && pwd)"
target="${1:?usage: validate-macos-packages.sh TARGET}"
case "$target" in
  aarch64-apple-darwin) arch=arm64 ;;
  x86_64-apple-darwin) arch=x86_64 ;;
  *) echo "Unsupported macOS target: $target" >&2; exit 1 ;;
esac
bundle="$repo/app/src-tauri/target/$target/release/bundle"
packages=("$bundle"/dmg/*.dmg)
test "${#packages[@]}" -eq 1

mount_point="$(mktemp -d)"
mounted=false
cleanup() {
  if "$mounted"; then hdiutil detach "$mount_point"; fi
  rmdir "$mount_point"
}
trap cleanup EXIT
hdiutil verify "${packages[0]}"
# Tauri embeds our BSD license as a DMG license prompt. Accept it explicitly
# when mounting noninteractively; EOF otherwise cancels the mount in CI.
hdiutil attach "${packages[0]}" -readonly -nobrowse -mountpoint "$mount_point" <<< 'Y'
mounted=true

app="$mount_point/Quipu.app"
binary="$app/Contents/MacOS/quipu"
resources="$app/Contents/Resources"
test -x "$binary"
test "$(lipo -archs "$binary")" = "$arch"
plutil -lint "$app/Contents/Info.plist"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" = com.corelight.quipu
test "$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$app/Contents/Info.plist")" = 15.0
codesign --verify --deep --strict --verbose=2 "$app"
signature="$(codesign --display --verbose=4 "$app" 2>&1)"
grep -q '^Signature=adhoc$' <<< "$signature"
# The exploratory app runs YARA-X/Wasmtime JIT without hardened-runtime signing.
if grep -q 'flags=.*runtime' <<< "$signature"; then
  echo 'Unexpected hardened runtime; review Wasmtime JIT entitlements' >&2
  exit 1
fi

cmp "$repo/LICENSE" "$resources/LICENSE"
cmp "$repo/THIRD_PARTY_LICENSES/NPM.txt" "$resources/THIRD_PARTY_LICENSES/NPM.txt"
cmp "$repo/THIRD_PARTY_LICENSES/RUST.txt" "$resources/THIRD_PARTY_LICENSES/RUST.txt"
diff -r "$repo/examples" "$resources/examples"
