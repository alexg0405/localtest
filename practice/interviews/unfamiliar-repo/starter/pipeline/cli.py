from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from .config import ConfigError, load_config
from .registry import UnknownStage
from .runner import PipelineError, run


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline", description="Imports a supplier CSV into the catalog JSON.")
    parser.add_argument("config", help="path to a pipeline config (JSON)")
    parser.add_argument("--quiet", action="store_true", help="only print errors")
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
        summary = run(config)
    except (ConfigError, PipelineError, UnknownStage, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    if not args.quiet:
        print(f"read {summary.rows_read} rows, wrote {summary.items_written} items to {config['output']}")
        for problem in summary.errors:
            print(f"  skipped {problem}")
    return 0
