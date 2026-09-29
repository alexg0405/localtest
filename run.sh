#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Roomside needs Node.js 20 or newer (npm is included). Install it from https://nodejs.org/ and run this script again."
  exit 1
fi
node -e 'const major=Number(process.versions.node.split(".")[0]); if(major<20){console.error("Please install Node.js 20 or newer.");process.exit(1)}'
if [ ! -d node_modules ]; then npm install; fi
npm run dev -- --open
