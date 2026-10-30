"""The nightly supply sync: pull every hospital's inventory, then build the morning report.

Reference solution for all four parts: one relay job per hospital (pages are fetched in order inside it, so a
hospital never gets two requests at once), retries for dropped connections, a deadline through gather, and
progress from on_finish callbacks.
"""
from __future__ import annotations

from typing import Callable, Dict, List, Optional, Sequence

import relay

from .client import HospitalAPI, HospitalOffline, Item, TransientError
from .report import Pull, Report, build_report

WORKERS = 4
RETRY = relay.Retry(times=2, on=(TransientError,))   # 3 tries in all


def pull_hospital(api: HospitalAPI, hospital_id: str) -> List[Item]:
    """Every item in one hospital's inventory, page by page. Stops early once the job is cancelled."""
    first = api.fetch_page(hospital_id, 0)
    items = list(first.items)
    for page in range(1, first.pages):
        if relay.cancelled():
            raise relay.Cancelled(f"{hospital_id} ran out of time")
        items.extend(api.fetch_page(hospital_id, page).items)
    return items


def pull_all(api: HospitalAPI, hospital_ids: Sequence[str], deadline: Optional[float] = None,
             on_progress: Optional[Callable[[int, int], None]] = None) -> Pull:
    """Every hospital's inventory, all at once. Hospitals that stay unreachable are missing; with a deadline, the ones
    that aren't done in time are late."""
    total, finished = len(hospital_ids), relay.Tally()
    with relay.Runner(workers=WORKERS) as runner:
        if on_progress:
            @runner.on_finish
            def report_progress(handle: relay.Handle) -> None:
                if handle.state != "cancelled":
                    on_progress(finished.add(1), total)
        hospital_for = {runner.submit(pull_hospital, api, hospital_id, key=hospital_id, retry=RETRY): hospital_id for hospital_id in hospital_ids}
        outcomes = relay.gather(list(hospital_for), timeout=deadline)
    stock: Dict[str, List[Item]] = {}
    missing, late = [], []
    for outcome in outcomes:
        hospital_id = hospital_for[outcome.handle]
        if outcome.ok:
            stock[hospital_id] = outcome.value
        elif isinstance(outcome.error, relay.Cancelled):
            late.append(hospital_id)
        elif isinstance(outcome.error, (TransientError, HospitalOffline)):
            missing.append(hospital_id)
        else:
            raise outcome.error   # anything else is a bug in the data or the code: fail loudly
    return Pull({hospital_id: stock[hospital_id] for hospital_id in hospital_ids if hospital_id in stock}, sorted(missing), sorted(late))


def run_sync(api: HospitalAPI, hospital_ids: Sequence[str], par_levels: Dict[str, int]) -> Report:
    """The whole nightly job."""
    return build_report(pull_all(api, hospital_ids), par_levels)
