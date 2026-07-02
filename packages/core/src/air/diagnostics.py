from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


Severity = Literal["info", "warning", "error"]


@dataclass(frozen=True)
class Diagnostic:
    id: str
    severity: Severity
    domain: str
    code: str
    message: str
    related_elements: list[str] = field(default_factory=list)
    observed: dict[str, Any] = field(default_factory=dict)
    expected: dict[str, Any] = field(default_factory=dict)
    suggested_actions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "severity": self.severity,
            "domain": self.domain,
            "code": self.code,
            "message": self.message,
            "related_elements": self.related_elements,
            "observed": self.observed,
            "expected": self.expected,
            "suggested_actions": self.suggested_actions,
        }


class DiagnosticBuilder:
    def __init__(self) -> None:
        self._next_id = 1

    def make(
        self,
        severity: Severity,
        domain: str,
        code: str,
        message: str,
        related_elements: list[str] | None = None,
        observed: dict[str, Any] | None = None,
        expected: dict[str, Any] | None = None,
        suggested_actions: list[str] | None = None,
    ) -> Diagnostic:
        diagnostic = Diagnostic(
            id=f"diag_{self._next_id:05d}",
            severity=severity,
            domain=domain,
            code=code,
            message=message,
            related_elements=related_elements or [],
            observed=observed or {},
            expected=expected or {},
            suggested_actions=suggested_actions or [],
        )
        self._next_id += 1
        return diagnostic

