#!/bin/bash
# Headless screenshot of the running viewer (Chrome or Edge, software GL).
# Usage: tools/shot.sh "<hash params>" out.png [width height] [virtual ms]
# Example: tools/shot.sh "zone=gfaydark&view=top" gfay.png 1600 900
# The viewer must already be running; set PORT if it is not on 3080.
H="$1"; OUT="$2"; W="${3:-1600}"; HT="${4:-900}"; T="${5:-30000}"; P="${PORT:-3080}"
B="/c/Program Files/Google/Chrome/Application/chrome.exe"; [ -f "$B" ] || B="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PROF=$(mktemp -d)
timeout 180 "$B" --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=$W,$HT --hide-scrollbars --virtual-time-budget=$T --user-data-dir="$PROF" --no-first-run --disable-sync --screenshot="$OUT" "http://localhost:$P/#$H" >/dev/null 2>&1
ls -la "$OUT" | awk '{print $5, $9}'
