#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
dep="$root/.test-deps/tmux-resurrect"
revision=cff343cf9e81983d3da0c8562b01616f12e8d548
if [ ! -d "$dep/.git" ]; then
  git clone --quiet https://github.com/tmux-plugins/tmux-resurrect.git "$dep"
fi
git -C "$dep" checkout --quiet --detach "$revision"
test "$(git -C "$dep" rev-parse HEAD)" = "$revision"
