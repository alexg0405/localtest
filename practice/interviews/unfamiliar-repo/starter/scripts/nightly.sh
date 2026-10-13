#!/bin/sh
# Run by the scheduler at 02:00. Exits non-zero (and pages on-call) when the import fails.
set -eu
cd "$(dirname "$0")/.."
"${PYTHON:-python3}" -m pipeline examples/nightly.json
