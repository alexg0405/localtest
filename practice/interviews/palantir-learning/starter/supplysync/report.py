"""The morning report: every item below its par level, network-wide, and the hospitals it couldn't include."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

from .client import Item


@dataclass
class Pull:
    """What the sync got from the hospitals."""

    stock: Dict[str, List[Item]]                    # hospital -> its items
    missing: List[str] = field(default_factory=list)  # hospitals it couldn't get, sorted
    late: List[str] = field(default_factory=list)     # hospitals that didn't finish in time, sorted


@dataclass(frozen=True)
class Shortfall:
    hospital: str
    sku: str
    name: str
    on_hand: int
    par: int


@dataclass
class Report:
    low_stock: List[Shortfall]
    missing: List[str]
    late: List[str]


def build_report(pull: Pull, par_levels: Dict[str, int]) -> Report:
    """Items below their par level (the stock each hospital should keep of that SKU), most short first."""
    low = [Shortfall(hospital, item.sku, item.name, item.on_hand, par_levels[item.sku])
           for hospital, items in pull.stock.items() for item in items
           if item.sku in par_levels and item.on_hand < par_levels[item.sku]]
    low.sort(key=lambda s: (s.on_hand - s.par, s.hospital, s.sku))
    return Report(low, sorted(pull.missing), sorted(pull.late))
