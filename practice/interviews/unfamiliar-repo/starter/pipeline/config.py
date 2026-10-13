from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Union

DEFAULTS: Dict[str, Any] = {
    "stages": ["read_csv", "normalize_headers", "validate", "parse_prices", "dedupe", "write_json"],
    "options": {
        "encoding": "utf-8",
        "required": ["sku", "name", "price"],
        "dedupe_key": "sku",
    },
}


class ConfigError(Exception):
    pass


def load_config(path: Union[str, Path]) -> Dict[str, Any]:
    """Reads a pipeline config and fills in defaults. Paths are relative to the config's folder."""
    path = Path(path)
    try:
        user = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"config not found: {path}") from None
    except json.JSONDecodeError as error:
        raise ConfigError(f"{path} is not valid JSON: {error}") from None
    if not isinstance(user, dict):
        raise ConfigError(f"{path} must contain a JSON object")

    config = {**DEFAULTS, **user}
    for key in ("input", "output"):
        if not config.get(key):
            raise ConfigError(f"{path} needs an {key!r} path")
        config[key] = str((path.parent / config[key]).resolve())
    return config
