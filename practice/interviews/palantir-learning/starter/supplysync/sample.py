"""A sample night: six hospitals' inventories and the network's par levels, for tests and for trying things out."""
from __future__ import annotations

from typing import Dict, List

from .client import Item

NAMES = {
    "GLV-M": "Nitrile gloves, medium (box)",
    "GLV-L": "Nitrile gloves, large (box)",
    "SYR-10": "Syringe, 10 mL",
    "IV-1L": "Saline IV bag, 1 L",
    "N95": "N95 respirator",
    "GAUZE": "Gauze pads, 4 in (pack)",
    "CATH-16": "IV catheter, 16 gauge",
    "TAPE": "Medical tape (roll)",
    "MASK": "Surgical mask (box)",
    "SWAB": "Alcohol swabs (box)",
    "GOWN": "Isolation gown",
    "TUBE": "IV extension tubing",
}

PAR_LEVELS: Dict[str, int] = {
    "GLV-M": 40, "GLV-L": 30, "SYR-10": 200, "IV-1L": 120, "N95": 80, "GAUZE": 60,
    "CATH-16": 50, "TAPE": 25, "MASK": 45, "SWAB": 35, "GOWN": 70, "TUBE": 40,
}

_ON_HAND = {
    "brook":    [52, 18, 240, 95, 80, 61, 12, 30, 44, 40, 75, 41],
    "cedar":    [41, 33, 150, 130, 22, 70, 55, 9, 60, 36, 71, 39],
    "harbor":   [12, 31, 205, 119, 90, 58, 50, 26, 45, 2, 68, 44],
    "lakeside": [40, 29, 300, 121, 81, 60, 49, 25, 46, 35, 70, 40],
    "maple":    [0, 30, 199, 140, 79, 75, 51, 28, 50, 38, 90, 55],
    "summit":   [45, 35, 210, 60, 85, 62, 53, 27, 47, 36, 72, 10],
}


def inventories() -> Dict[str, List[Item]]:
    """Each hospital's twelve items (three pages of four)."""
    skus = list(NAMES)
    return {hospital: [Item(sku, NAMES[sku], count) for sku, count in zip(skus, counts)] for hospital, counts in _ON_HAND.items()}


HOSPITALS = list(_ON_HAND)
