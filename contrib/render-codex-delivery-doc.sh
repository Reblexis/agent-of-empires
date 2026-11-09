#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p browse
pandoc --standalone --metadata title="Draft-safe automated Codex delivery" docs/guides/codex-automated-delivery.md -o browse/codex-automated-delivery.html
