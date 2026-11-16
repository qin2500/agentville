#!/bin/bash
# usage: m6night.sh outdir
cd "$(dirname "$0")/../.."; OUT=$1; mkdir -p $OUT; PORT=5395
node_modules/.bin/vite -c tools/artpass/vite.config.mjs --port $PORT --strictPort > $OUT/vite.log 2>&1 &
VP=$!; trap 'kill $VP 2>/dev/null' EXIT
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:$PORT/ && break; sleep 1; done
ARTPASS_PORT=$PORT node tools/artpass/side-by-side.mjs --fixture busy --zoom 1 --night --t 120 --out-dir $OUT > $OUT/busy.json 2> $OUT/busy.err
node tools/artpass/luminance.mjs $OUT busy | tee $OUT/lum.json
