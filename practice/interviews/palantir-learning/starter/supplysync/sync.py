"""The nightly supply sync: pull every hospital's inventory, then build the morning report.

Tonight it pulls one hospital after another. With six hospitals of about 40 pages each, at about 10 seconds a
request, that's 40 minutes, and the supply team needs the report by 6am. You'll change this file.
"""
from __future__ import annotations

from typing import Dict, List, Sequence

import relay  # noqa: F401  (our team's job library: see the Docs tab)

from .client import HospitalAPI, Item
from .report import Pull, Report, build_report


def pull_hospital(api: HospitalAPI, hospital_id: str) -> List[Item]:
    """Every item in one hospital's inventory, page by page."""
    first = api.fetch_page(hospital_id, 0)
    items = list(first.items)
    for page in range(1, first.pages):
        items.extend(api.fetch_page(hospital_id, page).items)
    return items


def pull_all(api: HospitalAPI, hospital_ids: Sequence[str]) -> Pull:
    """Every hospital's inventory, one hospital at a time."""
    stock: Dict[str, List[Item]] = {}
    for hospital_id in hospital_ids:
        stock[hospital_id] = pull_hospital(api, hospital_id)
    return Pull(stock)


def run_sync(api: HospitalAPI, hospital_ids: Sequence[str], par_levels: Dict[str, int]) -> Report:
    """The whole nightly job."""
    return build_report(pull_all(api, hospital_ids), par_levels)
