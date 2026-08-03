#!/usr/bin/env python3
"""Run the test-all phases and print one aggregate summary."""

from __future__ import annotations

import argparse
import re
import subprocess
import time
from dataclasses import dataclass

ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


@dataclass
class TestCounts:
    passed: int = 0
    failed: int = 0
    skipped: int = 0

    def add(self, passed: int = 0, failed: int = 0, skipped: int = 0) -> None:
        self.passed += passed
        self.failed += failed
        self.skipped += skipped


@dataclass
class AggregateStats:
    vitest: TestCounts
    rust: TestCounts
    tap: TestCounts
    live: TestCounts

    @classmethod
    def empty(cls) -> AggregateStats:
        return cls(
            vitest=TestCounts(),
            rust=TestCounts(),
            tap=TestCounts(),
            live=TestCounts(),
        )

    def observe(self, raw_line: str) -> None:
        line = ANSI_ESCAPE.sub("", raw_line).strip()

        if line.startswith("Tests "):
            self._observe_named_counts(line, self.vitest)
            return

        rust_match = re.search(
            r"test result: \w+\.\s+(\d+) passed;\s+(\d+) failed;\s+"
            r"(\d+) ignored;",
            line,
        )
        if rust_match:
            self.rust.add(
                passed=int(rust_match.group(1)),
                failed=int(rust_match.group(2)),
                skipped=int(rust_match.group(3)),
            )
            return

        compact_rust_match = re.search(
            r"cargo test:\s+(\d+) passed(?:,\s+(\d+) failed)?", line
        )
        if compact_rust_match:
            self.rust.add(
                passed=int(compact_rust_match.group(1)),
                failed=int(compact_rust_match.group(2) or 0),
            )
            return

        tap_match = re.fullmatch(r"# (pass|fail|skipped) (\d+)", line)
        if tap_match:
            field = {
                "pass": "passed",
                "fail": "failed",
                "skipped": "skipped",
            }[tap_match.group(1)]
            setattr(self.tap, field, getattr(self.tap, field) + int(tap_match.group(2)))
            return

        live_match = re.match(r"(PASS|FAIL|SKIP)\b", line)
        if live_match:
            field = {
                "PASS": "passed",
                "FAIL": "failed",
                "SKIP": "skipped",
            }[live_match.group(1)]
            setattr(self.live, field, getattr(self.live, field) + 1)

    @staticmethod
    def _observe_named_counts(line: str, counts: TestCounts) -> None:
        for value, label in re.findall(r"(\d+) (passed|failed|skipped)", line):
            setattr(counts, label, getattr(counts, label) + int(value))

    def total(self) -> TestCounts:
        return TestCounts(
            passed=sum(
                counts.passed
                for counts in (self.vitest, self.rust, self.tap, self.live)
            ),
            failed=sum(
                counts.failed
                for counts in (self.vitest, self.rust, self.tap, self.live)
            ),
            skipped=sum(
                counts.skipped
                for counts in (self.vitest, self.rust, self.tap, self.live)
            ),
        )


@dataclass(frozen=True)
class PhaseResult:
    name: str
    returncode: int
    elapsed_seconds: float


def run_phase(name: str, command: list[str], stats: AggregateStats) -> PhaseResult:
    print(f"\n===== {name} =====", flush=True)
    started_at = time.monotonic()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    try:
        for line in process.stdout:
            print(line, end="", flush=True)
            stats.observe(line)
        returncode = process.wait()
    except KeyboardInterrupt:
        process.terminate()
        returncode = process.wait()
        raise
    return PhaseResult(name, returncode, time.monotonic() - started_at)


def format_duration(seconds: float) -> str:
    minutes, remaining = divmod(round(seconds), 60)
    return f"{minutes}m {remaining:02d}s" if minutes else f"{remaining}s"


def print_summary(
    phases: list[PhaseResult], stats: AggregateStats, elapsed_seconds: float
) -> None:
    total = stats.total()
    overall_ok = all(phase.returncode == 0 for phase in phases)
    status = "PASSED" if overall_ok else "FAILED"

    print("\n" + "=" * 68)
    print("TEST-ALL SUMMARY")
    print("=" * 68)
    for phase in phases:
        phase_status = "PASS" if phase.returncode == 0 else "FAIL"
        print(
            f"{phase_status:4}  {format_duration(phase.elapsed_seconds):>8}  "
            f"{phase.name}"
        )

    print("-" * 68)
    for label, counts in (
        ("Vitest", stats.vitest),
        ("Rust", stats.rust),
        ("Node TAP", stats.tap),
        ("Live checks", stats.live),
    ):
        print(
            f"{label:<12} passed {counts.passed:>5}  "
            f"failed {counts.failed:>3}  skipped {counts.skipped:>4}"
        )
    print("-" * 68)
    print(
        f"Known total  passed {total.passed:>5}  "
        f"failed {total.failed:>3}  skipped {total.skipped:>4}"
    )
    print(f"Overall: {status} in {format_duration(elapsed_seconds)}")
    print("=" * 68)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--make", default="make", help="make executable")
    parser.add_argument(
        "--require-live",
        action="store_true",
        help="fail when live sidecars or cloud providers are not configured",
    )
    args = parser.parse_args()

    require = "1" if args.require_live else "0"
    phases = [
        ("Deterministic verification", [args.make, "verify"]),
        (
            "Live sidecars and registries",
            [args.make, "test-live", f"REQUIRE={require}"],
        ),
        ("Live cloud providers", [args.make, "test-live-cloud", f"REQUIRE={require}"]),
    ]

    started_at = time.monotonic()
    stats = AggregateStats.empty()
    results: list[PhaseResult] = []
    try:
        for name, command in phases:
            result = run_phase(name, command, stats)
            results.append(result)
            if result.returncode != 0:
                break
    finally:
        print_summary(results, stats, time.monotonic() - started_at)

    return 0 if all(result.returncode == 0 for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
