from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict, Union

DEFAULTS: Dict[str, Any] = {
    "stages": ["read_csv", "normalize_headers", "validate", "parse_prices", "dedupe", "write_json"],
    "options": {
        "encoding": "utf-8",
        "delimiter": ",",
        "required": ["sku", "name", "price"],
        "dedupe_key": "sku",
    },
}


class ConfigError(Exception):
    pass


def _merge(defaults: Dict[str, Any], overrides: Dict[str, Any]) -> Dict[str, Any]:
    """Deep-merges dicts, so a config that sets one option keeps every other default."""
    merged = copy.deepcopy(defaults)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


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

    config = _merge(DEFAULTS, user)
    for key in ("input", "output"):
        if not config.get(key):
            raise ConfigError(f"{path} needs an {key!r} path")
        config[key] = str((path.parent / config[key]).resolve())
    if len(config["options"]["delimiter"]) != 1:
        raise ConfigError(f"{path}: options.delimiter must be a single character")
    return config
