#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
while read -r name revision; do
  dep="$root/.test-deps/$name"
  if [ ! -d "$dep/.git" ]; then
    git clone --quiet "https://github.com/tmux-plugins/$name.git" "$dep"
  fi
  git -C "$dep" checkout --quiet --detach "$revision"
  test "$(git -C "$dep" rev-parse HEAD)" = "$revision"
done <<'DEPENDENCIES'
tmux-resurrect cff343cf9e81983d3da0c8562b01616f12e8d548
tpm 99469c4a9b1ccf77fade25842dc7bafbc8ce9946
DEPENDENCIES
