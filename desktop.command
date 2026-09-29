#!/bin/sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Install Node.js 20 or newer from https://nodejs.org/, then run this file again."
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "Install Rust with https://rustup.rs/ and Xcode Command Line Tools, then run this file again."
  exit 1
fi
node -e 'const major=Number(process.versions.node.split(".")[0]); if(major<20){console.error("Please install Node.js 20 or newer.");process.exit(1)}'
if [ ! -d node_modules ]; then npm install; fi
npm run desktop
