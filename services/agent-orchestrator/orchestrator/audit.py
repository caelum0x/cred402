"""Append-only audit log.

Every proposed action, the policy decision that gated it, and the eventual
outcome are appended as a single JSON object per line (JSONL) to a file. The log
is *append-only*: entries are flushed and fsync'd immediately and never
rewritten, so it forms a tamper-evident trail of exactly what the agent tried,
what the policy engine decided, and what actually happened against the live API.

It is queryable in-process (:meth:`AuditLog.query`) and on disk (each line is a
self-contained JSON record). Standard library only.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional


@dataclass(frozen=True)
class AuditEntry:
    """One immutable audit record."""

    seq: int
    ts: float
    agent_id: str
    goal: str
    step: int
    tool: str
    description: str
    amount_cspr: str
    verdict: str            # ALLOW / BLOCK / PENDING
    deciding_policy: str
    reason: str
    decisions: List[Dict[str, str]]   # every policy's decision
    executed: bool
    success: Optional[bool]
    outcome: Mapping[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), default=str)


class AuditLog:
    """Append-only JSONL audit log.

    Args:
        path: file path; parent dirs are created. Opened in append mode.
        clock: injectable time source (defaults to ``time.time``).
    """

    def __init__(self, path: str | os.PathLike[str], *, clock: Optional[Callable[[], float]] = None) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._clock = clock or time.time
        # Resume the sequence counter from any existing file so the log stays
        # monotonic across runs.
        self._seq = self._last_seq()

    @property
    def path(self) -> Path:
        return self._path

    def _last_seq(self) -> int:
        if not self._path.exists():
            return 0
        last = 0
        with self._path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    last = max(last, int(json.loads(line).get("seq", 0)))
                except (ValueError, json.JSONDecodeError):
                    continue
        return last

    def append(
        self,
        *,
        agent_id: str,
        goal: str,
        step: int,
        tool: str,
        description: str,
        amount_cspr: str,
        verdict: str,
        deciding_policy: str,
        reason: str,
        decisions: Iterable[Mapping[str, str]],
        executed: bool,
        success: Optional[bool],
        outcome: Optional[Mapping[str, Any]] = None,
    ) -> AuditEntry:
        """Append one record and fsync it. Returns the written entry."""
        self._seq += 1
        entry = AuditEntry(
            seq=self._seq,
            ts=self._clock(),
            agent_id=agent_id,
            goal=goal,
            step=step,
            tool=tool,
            description=description,
            amount_cspr=str(amount_cspr),
            verdict=verdict,
            deciding_policy=deciding_policy,
            reason=reason,
            decisions=[dict(d) for d in decisions],
            executed=executed,
            success=success,
            outcome=dict(outcome or {}),
        )
        with self._path.open("a", encoding="utf-8") as fh:
            fh.write(entry.to_json() + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return entry

    # -- querying ----------------------------------------------------------- #

    def read_all(self) -> List[Dict[str, Any]]:
        """Read every record back from disk as dicts."""
        if not self._path.exists():
            return []
        out: List[Dict[str, Any]] = []
        with self._path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def query(
        self,
        *,
        agent_id: Optional[str] = None,
        verdict: Optional[str] = None,
        executed: Optional[bool] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Filter records on disk by agent, verdict and/or executed flag."""
        for rec in self.read_all():
            if agent_id is not None and rec.get("agent_id") != agent_id:
                continue
            if verdict is not None and rec.get("verdict") != verdict:
                continue
            if executed is not None and bool(rec.get("executed")) != executed:
                continue
            yield rec

    def summary(self) -> Dict[str, Any]:
        """Roll-up counts used for the CLI's final audit summary."""
        records = self.read_all()
        by_verdict: Dict[str, int] = {}
        executed = 0
        failed = 0
        for r in records:
            by_verdict[r.get("verdict", "?")] = by_verdict.get(r.get("verdict", "?"), 0) + 1
            if r.get("executed"):
                executed += 1
                if r.get("success") is False:
                    failed += 1
        return {
            "path": str(self._path),
            "total_entries": len(records),
            "by_verdict": by_verdict,
            "executed": executed,
            "execution_failures": failed,
        }
