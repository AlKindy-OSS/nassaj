#!/usr/bin/env bash
# install-official-node.sh — fetch the official Node.js linux-x64 binary from
# nodejs.org, check it against a pinned sha256 and unpack it (ADR-174 §9.2).
#
# Usage:
#   install-official-node.sh --pins <release-generation-pins.json> <dest>
#   install-official-node.sh --version <x.y.z> --sha256 <hex> <dest>
#
# The pin is the authority: the committed release-generation-pins.json for the
# generation being built, or a previous generation's verified manifest
# (targets[].node) for the fleet simulation (§9.2 step 7b). The tarball is also
# required to be listed with the same sha256 in the release's SHASUMS256.txt.
# Prints the absolute path of the node binary. Needs bash, curl, jq (--pins),
# sha256sum and tar with xz.
set -euo pipefail

VERSION=""
SHA256=""
PINS=""
DEST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pins) PINS="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --sha256) SHA256="${2:-}"; shift 2 ;;
    -*) echo "usage: unknown option $1" >&2; exit 2 ;;
    *) if [[ -z "$DEST" ]]; then DEST="$1"; shift; else echo "usage: unexpected $1" >&2; exit 2; fi ;;
  esac
done

if [[ -n "$PINS" ]]; then
  if ! command -v jq >/dev/null 2>&1; then echo "usage: --pins needs jq" >&2; exit 2; fi
  VERSION="$(jq -r '.node.version' "$PINS")"
  SHA256="$(jq -r '.node.targets["linux-x64-glibc"].sha256' "$PINS")"
fi
if [[ ! "$VERSION" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  echo "node_pin_invalid: version '$VERSION'" >&2; exit 2
fi
if [[ ! "$SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "node_pin_invalid: sha256 '$SHA256'" >&2; exit 2
fi
if [[ -z "$DEST" || -e "$DEST" ]]; then
  echo "usage: <dest> is required and must not exist" >&2; exit 2
fi

FILE="node-v${VERSION}-linux-x64.tar.xz"
BASE="https://nodejs.org/dist/v${VERSION}"
WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/var/tmp}}/nassaj-node-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$WORK/$FILE" "$BASE/$FILE"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$WORK/SHASUMS256.txt" "$BASE/SHASUMS256.txt"

actual="$(sha256sum "$WORK/$FILE" | awk '{ print $1 }')"
if [[ "$actual" != "$SHA256" ]]; then
  echo "node_digest_mismatch: $FILE is $actual, pin $SHA256" >&2; exit 1
fi
if ! grep -qxF "$SHA256  $FILE" "$WORK/SHASUMS256.txt"; then
  echo "node_digest_mismatch: $FILE sha256 is not listed in SHASUMS256.txt" >&2; exit 1
fi

mkdir -p "$DEST"
tar -xJf "$WORK/$FILE" -C "$DEST" --strip-components=1 --no-same-owner
"$DEST/bin/node" --version >/dev/null
echo "$DEST/bin/node"
