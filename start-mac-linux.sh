#!/bin/sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --omit=dev
exec node server.js
