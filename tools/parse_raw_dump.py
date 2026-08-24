#!/usr/bin/env python3
"""Turn `esphome logs` raw dumps into candidate raw arrays plus variance stats.

Two modes, because this hob offers no way to trigger one command on demand and
no feedback about which command it just sent (decisions.md, 2026-08-05).

CLUSTER MODE (`--cluster`) — the one you want first. Takes an UNLABELLED log,
groups frames by structural signature, and cross-references each group against
the community seed codes:

    esphome logs esphome/hob2hood.yaml | tee docs/capture-logs/2026-08-05-cycle.log
    python tools/parse_raw_dump.py docs/capture-logs/2026-08-05-cycle.log --cluster

You press whatever you can press; the tool tells you how many distinct commands
came out, which are known codes, and in what order they arrived.

LABELLED MODE (the original) — for once you have earned labels. One log file =
one command, and it complains if that assumption looks wrong:

    python tools/parse_raw_dump.py docs/capture-logs/*.log --label "fan 1" --yaml

Several labelled files at once additionally runs the Phase 2 cross-match matrix:
does any candidate code match another command's frames at the tolerance?

Outputs are *candidates*. Nothing here is authoritative until it is committed to
docs/ir-codes.md with its capture conditions (AGENTS.md §3, §10.1).
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

# `[16:23:45][I][remote.raw:041]: ` — timestamp optional, tag/line varies.
LOG_PREFIX = re.compile(r"^(?:\[[^\]]*\])*:?\s?")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
RAW_MARKER = "Received Raw:"
# A continuation line is nothing but signed integers, commas and whitespace.
CONTINUATION = re.compile(r"^[\s,]*-?\d+(?:\s*,\s*-?\d+)*\s*,?\s*$")
# Leading `[16:23:45]` or `[16:23:45.123]`, kept rather than stripped: with no
# per-command trigger, arrival time is the main labelling signal we have.
STAMP = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\]")

# ESPHome's raw dumper chunks one frame across several "Received Raw:" lines at
# ~64 chars, so a frame is the marker line plus every numeric line that follows.

# --- Community seed codes — REFERENCE ONLY (AGENTS.md §3) --------------------
#
# These are NOT ground truth and must never be committed to docs/ir-codes.md or
# to YAML. AGENTS.md §3 permits exactly one use, which is this one: "useful only
# for cross-referencing community sources". The tool therefore only ever reports
# whether a captured cluster *resembles* a seed. It never emits a seed value as
# a candidate — every number it proposes comes from your own captures.
SEED_CODES: dict[str, list[int]] = {
    "fan off": [-720, 1468, -722, 1470, -2114, 1472, -722, 1470, -1416, 2218, -724, 1470, -724, 720, -698],
    "fan 1": [-1416, 1494, -722, 1570, -1974, 1510, -722, 1468, -726, 718, -724, 1468, -724, 2216, -696],
    "fan 2": [-1440, 1472, -724, 2936, -752, 2190, -3530, 2224, -2114],
    "fan 3": [-696, 2240, -2784, 2968, -2116, 750, -724, 2216, -2114],
    "fan 4 / boost": [-1416, 2244, -1418, 722, -1418, 2216, -1418, 1470, -724, 2216, -722, 722, -1392],
    "light on": [-718, 1472, -720, 726, -1388, 752, -718, 1472, -694, 750, -1390, 2994, -720, 724, -720, 726, -1386],
    "light off": [-684, 1488, -658, 778, -684, 758, -686, 2278, -660, 788, -628, 1532, -688, 1504, -686, 786, -658],
}

# hob2hood quantises to a base unit near 720 us. Marks and spaces get their own
# fitted unit because the receiver distorts them oppositely and by different
# amounts — measured on this build: spaces ~752 us, marks ~695 us, where the
# seed source is the mirror image (749 / 699). Fitting one unit for both would
# bury that asymmetry in the residual and cost us the clean quantisation.
UNIT_MIN, UNIT_MAX = 560.0, 900.0
UNIT_STEP = 0.5
# Frames arriving closer together than this are one press, not two. Measured
# 2026-08-05 on the first real capture: the hob sends each command ~3 times at
# ~0.9-1.0 s spacing, so anything under 1.5 s is the same press repeating.
BURST_GAP_S = 1.5

# Noise rejection. Real hob2hood frames are 9-17 edges and quantise tightly —
# every identified cluster in the first real capture fit within 32 us. Junk from
# the induction hob and ambient IR fits nothing (residuals 380-475 us) and comes
# in odd lengths. Without this split, 26 noise shapes drown 7 real codes.
MIN_REAL_EDGES = 9
MAX_REAL_RESIDUAL = 120.0


@dataclass
class Frame:
    """One raw capture, with the arrival time we need for sequencing."""

    values: list[int]
    stamp: float | None
    lineno: int
    # Signature of the cluster this frame ended up in; None means noise. Set by
    # cluster_report, because a rescued frame belongs to a cluster whose signature
    # is not its own.
    cluster: tuple[int, ...] | None = None

    def __len__(self) -> int:
        return len(self.values)


@dataclass
class Analysis:
    label: str
    source: Path
    frames: list[Frame]
    kept: list[Frame]
    edge_counts: Counter
    candidate: list[int]
    spreads: list[int]

    @property
    def modal_edges(self) -> int:
        return self.edge_counts.most_common(1)[0][0] if self.edge_counts else 0

    @property
    def worst_spread(self) -> int:
        return max(self.spreads) if self.spreads else 0


def strip_prefix(line: str) -> str:
    return LOG_PREFIX.sub("", ANSI.sub("", line.rstrip("\n")), count=1)


def parse_stamp(line: str) -> float | None:
    """Seconds-since-midnight from an esphome log prefix, or None if absent."""
    m = STAMP.match(ANSI.sub("", line.lstrip()))
    if not m:
        return None
    h, mi, s, frac = m.groups()
    out = int(h) * 3600 + int(mi) * 60 + int(s)
    return out + float(f"0.{frac}") if frac else float(out)


def parse_frames(text: str) -> list[Frame]:
    """Extract every raw frame from an esphome log, reassembling wrapped lines."""
    frames: list[Frame] = []
    current: Frame | None = None

    for lineno, line in enumerate(text.splitlines(), start=1):
        body = strip_prefix(line)

        if RAW_MARKER in body:
            if current:
                frames.append(current)
            current = Frame(_numbers(body.split(RAW_MARKER, 1)[1]), parse_stamp(line), lineno)
            continue

        if current is not None and CONTINUATION.match(body) and body.strip():
            current.values.extend(_numbers(body))
            continue

        # Any other log line ends the frame.
        if current is not None:
            frames.append(current)
            current = None

    if current:
        frames.append(current)
    return [f for f in frames if f.values]


def _numbers(chunk: str) -> list[int]:
    return [int(m) for m in re.findall(r"-?\d+", chunk)]


def analyse(frames: list[Frame], label: str, source: Path) -> Analysis:
    counts = Counter(len(f) for f in frames)
    modal = counts.most_common(1)[0][0] if counts else 0
    kept = [f for f in frames if len(f) == modal]

    candidate: list[int] = []
    spreads: list[int] = []
    for i in range(modal):
        column = [f.values[i] for f in kept]
        # MIDRANGE, not median or mean. ESPHome's matcher is a worst-case test —
        # every edge must fall inside +/-tolerance or the whole frame is rejected —
        # so the right value is the one minimising the LARGEST deviation, which is
        # the midpoint of the observed range. The median minimises total deviation
        # instead, and on a bimodal edge it sits inside the larger cluster and
        # throws the smaller one away. Measured on fan 2's edge 6 (bimodal, modes
        # ~250 us apart): median gave 96/100 frames decoding, midrange gives
        # 100/100, with cross-match still clean.
        #
        # The cost is outlier sensitivity — one corrupt capture drags the midpoint.
        # That is caught rather than hidden: with midrange, `spread > 2*tolerance`
        # is now an exact statement that NO stored value can decode every frame,
        # so the warning below means what it says instead of being a heuristic.
        candidate.append(int(round((min(column) + max(column)) / 2)))
        spreads.append(max(column) - min(column))

    return Analysis(label, source, frames, kept, counts, candidate, spreads)


def format_report(a: Analysis, tolerance: int, min_captures: int) -> list[str]:
    out = [
        "",
        f"=== {a.label}  ({a.source.name}) ===",
        f"frames parsed : {len(a.frames)}",
    ]

    if not a.frames:
        out.append("  !! no raw frames found - is `dump: raw` set and the log from `esphome logs`?")
        return out

    out.append(f"edge counts   : {dict(sorted(a.edge_counts.items()))}")
    out.append(f"usable frames : {len(a.kept)} of {len(a.frames)} at the modal {a.modal_edges} edges")

    if len(a.edge_counts) > 1:
        out.append(
            "  !! MIXED EDGE COUNTS. Either two different commands landed in this log, or "
            "frames are being fragmented/truncated. Check `idle:` (AGENTS.md s7) before "
            "trusting anything below."
        )
    if len(a.kept) < min_captures:
        out.append(
            f"  !! only {len(a.kept)} usable captures; Phase 1 requires >= {min_captures} per action."
        )

    out.append("")
    out.append("  idx      median       min       max    spread")
    for i, (val, spread) in enumerate(zip(a.candidate, a.spreads)):
        column = [f.values[i] for f in a.kept]
        flag = "  <-- exceeds tolerance" if spread > 2 * tolerance else ""
        out.append(f"  {i:3d} {val:11d} {min(column):9d} {max(column):9d} {spread:9d}{flag}")

    out.append("")
    out.append(f"worst spread  : {a.worst_spread} us  (tolerance window is +/-{tolerance} us)")
    if a.worst_spread > 2 * tolerance:
        out.append(
            "  !! At least one edge varies by more than the matcher's window, so some captures "
            "will NOT match this candidate. Fix it at the receiver - alignment, shading, supply "
            "decoupling (AGENTS.md s2) - never by widening tolerance (s10.2)."
        )

    out.append("")
    out.append("  candidate raw array:")
    out.append(f"    {yaml_array(a.candidate)}")
    return out


def yaml_array(code: list[int]) -> str:
    return "[" + ", ".join(str(v) for v in code) + "]"


def yaml_snippet(analyses: list[Analysis]) -> list[str]:
    out = [
        "",
        "--- ESPHome snippet (candidates - verify against docs/ir-codes.md before use) ---",
        "",
        "binary_sensor:",
    ]
    for a in analyses:
        if not a.candidate:
            continue
        slug = re.sub(r"[^a-z0-9]+", "_", a.label.lower()).strip("_")
        out += [
            "  - platform: remote_receiver",
            f'    name: "hob2hood {a.label}"',
            f"    id: hob2hood_{slug}",
            f"    # captured {a.source.name}; {len(a.kept)} samples, worst spread {a.worst_spread} us",
            "    raw:",
            f"      code: {yaml_array(a.candidate)}",
        ]
    return out


def cross_match(analyses: list[Analysis], tolerance: int) -> list[str]:
    """Phase 2: would any candidate code fire on another command's frames?

    Mirrors ESPHome's raw matcher: each expected value must agree in sign and be
    within the tolerance window. It is a PREFIX match — trailing received values
    are ignored — so a short code that prefixes a longer one always cross-matches.
    """
    out = ["", "--- cross-match matrix (Phase 2: must be zero) ---", ""]
    collisions = 0

    for pattern in analyses:
        if not pattern.candidate:
            continue
        for target in analyses:
            if target is pattern or not target.kept:
                continue
            hits = sum(1 for f in target.kept if matches(pattern.candidate, f.values, tolerance))
            if hits:
                collisions += 1
                pfx = " (prefix)" if len(pattern.candidate) < target.modal_edges else ""
                out.append(
                    f"  !! '{pattern.label}' matches {hits}/{len(target.kept)} "
                    f"'{target.label}' frames{pfx}"
                )

    if not collisions:
        out.append(f"  clean - no candidate matches another command's frames at +/-{tolerance} us")
    else:
        out.append("")
        out.append(
            "  Do NOT resolve this by changing tolerance. Re-capture, extend the code to "
            "include more edges, or discriminate on a later part of the frame."
        )
    return out


def matches(pattern: list[int], frame: list[int], tolerance: int) -> bool:
    if len(pattern) > len(frame):
        return False
    for expected, got in zip(pattern, frame):
        if (expected < 0) != (got < 0):
            return False
        if abs(abs(expected) - abs(got)) > tolerance:
            return False
    return True


# --- Cluster mode ------------------------------------------------------------
#
# The hob gives no way to trigger one command on demand and no feedback about
# which it sent, so labels cannot come from the operator. They have to be
# inferred: group frames that are structurally the same, then work out what each
# group means from arrival order and from resemblance to the seeds.
#
# Grouping is on QUANTISED STRUCTURE, not on timings. hob2hood edges are near
# multiples of a ~720 us unit, so a frame reduces to a sequence of signed unit
# counts — (-1, +2, -1, +2, -3, ...). That signature survives receiver
# distortion, which raw timings do not: this build's fan-off capture deviates
# from the seed by up to 148 us of a 200 us budget, and would blow it outright
# on a 4-unit edge. Two captures of one command share a signature even when
# their microsecond values do not.


def plural(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def cluster_name(i: int) -> str:
    """A, B, ... Z, AA, AB, ... — a real capture blew straight past 26 clusters."""
    name = ""
    while True:
        name = chr(ord("A") + i % 26) + name
        i = i // 26 - 1
        if i < 0:
            return name


def is_noise(sig: tuple[int, ...], residual: float) -> bool:
    return len(sig) < MIN_REAL_EDGES or residual > MAX_REAL_RESIDUAL


def fit_unit(mags: list[int]) -> tuple[float, float]:
    """Fit the base unit to a set of magnitudes; return (unit, worst residual).

    Brute force over the plausible range. Cheap, and immune to the chicken-and-egg
    problem of deriving the unit from values you have not yet quantised.
    """
    if not mags:
        return (0.0, 0.0)

    best_unit, best_worst = 0.0, float("inf")
    steps = int((UNIT_MAX - UNIT_MIN) / UNIT_STEP) + 1
    for i in range(steps):
        unit = UNIT_MIN + i * UNIT_STEP
        worst = 0.0
        for m in mags:
            k = max(1, round(m / unit))
            worst = max(worst, abs(m - k * unit))
            if worst >= best_worst:
                break
        if worst < best_worst:
            best_unit, best_worst = unit, worst
    return (best_unit, best_worst)


def signature(values: list[int]) -> tuple[tuple[int, ...], float, float, float]:
    """Quantise a frame. Returns (signature, unit_mark, unit_space, worst residual)."""
    unit_mark, res_mark = fit_unit([v for v in values if v > 0])
    unit_space, res_space = fit_unit([-v for v in values if v < 0])

    sig: list[int] = []
    for v in values:
        unit = unit_mark if v > 0 else unit_space
        k = max(1, round(abs(v) / unit)) if unit else 1
        sig.append(k if v > 0 else -k)
    return tuple(sig), unit_mark, unit_space, max(res_mark, res_space)


def seed_signatures() -> dict[tuple[int, ...], str]:
    return {signature(code)[0]: name for name, code in SEED_CODES.items()}


def press_events(frames: list[Frame]) -> int:
    """Frames closer together than BURST_GAP_S are one press repeated."""
    stamped = [f for f in frames if f.stamp is not None]
    if not stamped:
        return len(frames)
    ordered = sorted(stamped, key=lambda f: f.stamp)
    events = 1
    for prev, cur in zip(ordered, ordered[1:]):
        if cur.stamp - prev.stamp > BURST_GAP_S:
            events += 1
    return events + (len(frames) - len(stamped))


def cluster_report(frames: list[Frame], source: Path, tolerance: int) -> tuple[list[str], bool]:
    """Group an unlabelled log by signature and cross-reference against the seeds."""
    out = ["", f"=== cluster report  ({source.name}) ===", f"frames parsed : {len(frames)}"]
    if not frames:
        out.append("  !! no raw frames found - is `dump: raw` set and the log from `esphome logs`?")
        return out, True

    groups: dict[tuple[int, ...], list[Frame]] = {}
    fits: dict[tuple[int, ...], list[tuple[float, float, float]]] = {}
    for f in frames:
        sig, um, us, res = signature(f.values)
        groups.setdefault(sig, []).append(f)
        fits.setdefault(sig, []).append((um, us, res))

    # Judge a cluster on the MEDIAN of its frames' residuals, never on one frame.
    # An earlier version kept only the last frame's fit, so whichever capture
    # happened to arrive last decided whether the whole cluster was noise — a real
    # code with one distorted trailing frame could be discarded outright.
    meta: dict[tuple[int, ...], tuple[float, float, float]] = {
        sig: (
            statistics.median(u for u, _, _ in v),
            statistics.median(s for _, s, _ in v),
            statistics.median(r for _, _, r in v),
        )
        for sig, v in fits.items()
    }

    seeds = seed_signatures()
    real = {s: list(m) for s, m in groups.items() if not is_noise(s, meta[s][2])}
    noise_pool = [f for s, m in groups.items() if is_noise(s, meta[s][2]) for f in m]
    for sig, members in real.items():
        for f in members:
            f.cluster = sig

    # Rescue pass. The quantisation heuristic is a proxy for "is this a real code";
    # the authority is ESPHome's own matcher. Once candidates exist, re-test every
    # reject against them — a distorted but perfectly matchable frame should not be
    # thrown away. Measured on the first two captures: 1 of 102 rejects was a real
    # `fan 4 / boost` that the matcher accepts at every edge.
    rescued = 0
    if real:
        provisional = {s: analyse(m, "", source).candidate for s, m in real.items()}
        keep: list[Frame] = []
        for f in noise_pool:
            for sig, cand in provisional.items():
                if matches(cand, f.values, tolerance):
                    real[sig].append(f)
                    f.cluster = sig
                    rescued += 1
                    break
            else:
                keep.append(f)
        noise_pool = keep

    # Biggest cluster first: the commands you triggered most are the ones you
    # can say most about.
    ordered = sorted(real.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    names = {sig: cluster_name(i) for i, (sig, _) in enumerate(ordered)}

    noise_frames = len(noise_pool)
    out.append(f"distinct codes: {len(ordered)}   (+{noise_frames} noise frames, see below)")
    unknown = [s for s, _ in ordered if s not in seeds]
    if unknown:
        out.append(
            f"  ** {len(unknown)} cluster(s) match NO seed code. That is expected - the seeds "
            "are one hob generation, not a specification. Capture conditions and a decisions.md "
            "note, please (AGENTS.md s6)."
        )

    for sig, members in ordered:
        unit_mark, unit_space, residual = meta[sig]
        a = analyse(members, names[sig], source)
        seed = seeds.get(sig)

        out += [
            "",
            f"--- cluster {names[sig]} : {plural(len(members), 'frame')}, "
            f"{plural(press_events(members), 'press event')}, {len(sig)} edges",
            f"    identified    : {seed if seed else 'UNKNOWN - matches no seed'}",
            f"    signature     : {' '.join(f'{v:+d}' for v in sig)}",
            f"    unit fit      : mark {unit_mark:.0f} us, space {unit_space:.0f} us, "
            f"worst residual {residual:.0f} us",
        ]
        if residual > 120:
            out.append(
                "    !! high residual - this frame does not quantise cleanly, so its signature "
                "may be wrong. Suspect a corrupt or merged capture before trusting the grouping."
            )
        out.append(f"    candidate     : {yaml_array(a.candidate)}")
        out.append(f"    worst spread  : {a.worst_spread} us  (tolerance window +/-{tolerance} us)")
        if a.worst_spread > 2 * tolerance:
            out.append(
                "    !! spread exceeds the matcher window; some captures will not match this "
                "candidate. Fix at the receiver, never by widening tolerance (AGENTS.md s10.2)."
            )
        if seed:
            devs = [abs(abs(c) - abs(s)) for c, s in zip(a.candidate, SEED_CODES[seed])]
            out.append(
                f"    vs seed       : worst edge deviation {max(devs)} us "
                f"({'within' if max(devs) <= tolerance else 'OUTSIDE'} +/-{tolerance} us)"
            )

    if rescued:
        out += [
            "",
            f"    ({rescued} distorted frame(s) quantised to no known shape but still match a",
            f"     candidate at +/-{tolerance}us, so they were kept - ESPHome would decode them.)",
        ]

    if noise_pool:
        lengths = Counter(len(f.values) for f in noise_pool)
        out += [
            "",
            f"--- rejected as noise : {noise_frames} frames in {len(lengths)} lengths",
            f"    edge counts   : {dict(sorted(lengths.items()))}",
            "    Not hob2hood: too few edges, or no base unit fits them. Expect junk from the",
            "    induction hob's own EMI and from ambient IR. It is only cosmetic while you are",
            "    reading a log, but it is a real problem for Phase 2 - a binary_sensor cannot",
            "    reject what it never sees cleanly. Shorten/shield the receiver lead and check",
            "    the supply filter before trusting a discrimination test (docs/hardware.md).",
        ]

    out += sequence_report(frames, names)
    # Unknown clusters are information, not failure. Only a parse failure is.
    return out, False


def clock(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def sequence_report(frames: list[Frame], names: dict[tuple[int, ...], str]) -> list[str]:
    """Arrival order — the raw material for working out what each cluster means.

    NOISE IS EXCLUDED, and gaps are measured between consecutive *real* frames.
    An earlier version listed noise inline as "."; anyone filtering those lines out
    to read the sequence then read gaps measured from frames they could not see,
    which turned a 5-minute pause into an apparent 36 seconds. Absolute timestamps
    are printed alongside so the gaps can always be checked against the log.
    """
    out = ["", "--- arrival sequence (real frames only) ---", ""]
    stamped = [f for f in frames if f.stamp is not None]
    if not stamped:
        out.append("  no timestamps in this log; sequence is file order only.")
        out.append("  " + " ".join(names[signature(f.values)[0]] for f in frames))
        return out

    real = [f for f in stamped if f.cluster is not None]
    if not real:
        out.append("  no identifiable frames - everything in this log was rejected as noise.")
        return out

    out.append("  clock           gap(s)  code")
    prev: float | None = None
    for f in sorted(real, key=lambda f: f.stamp):
        gap = None if prev is None else f.stamp - prev
        if gap is not None and gap > BURST_GAP_S:
            out.append("")
        out.append(
            f"  {clock(f.stamp)}  {'    -  ' if gap is None else f'{gap:7.2f}'}  "
            f"{names[f.cluster]}"
        )
        prev = f.stamp
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Parse esphome raw IR dumps into candidate codes and variance stats.",
        epilog="Candidates are not ground truth. Commit to docs/ir-codes.md with capture conditions.",
    )
    ap.add_argument("logs", nargs="+", type=Path, help="esphome log files, one command each")
    ap.add_argument(
        "--label",
        action="append",
        default=None,
        help="command name for each log, in order; defaults to the filename stem",
    )
    ap.add_argument(
        "--tolerance",
        type=int,
        default=200,
        help="matcher window in us, must equal ir_tolerance in hob2hood.yaml (default: 200)",
    )
    ap.add_argument(
        "--min-captures",
        type=int,
        default=10,
        help="Phase 1 minimum captures per action (default: 10)",
    )
    ap.add_argument(
        "--cluster",
        action="store_true",
        help="treat logs as UNLABELLED: group frames by structure and identify them against "
        "the community seeds. Use this when you cannot trigger one command at a time.",
    )
    ap.add_argument("--yaml", action="store_true", help="emit an ESPHome binary_sensor snippet")
    ap.add_argument("--json", action="store_true", help="machine-readable output instead of a report")
    args = ap.parse_args(argv)

    for path in args.logs:
        if not path.is_file():
            print(f"error: no such file: {path}", file=sys.stderr)
            return 2

    if args.cluster:
        lines: list[str] = []
        failed = False
        for path in args.logs:
            report, bad = cluster_report(
                parse_frames(path.read_text(errors="replace")), path, args.tolerance
            )
            lines += report
            failed |= bad
        print("\n".join(lines))
        return 1 if failed else 0

    labels = args.label or []
    analyses: list[Analysis] = []

    for i, path in enumerate(args.logs):
        label = labels[i] if i < len(labels) else path.stem
        analyses.append(analyse(parse_frames(path.read_text(errors="replace")), label, path))

    if args.json:
        print(
            json.dumps(
                [
                    {
                        "label": a.label,
                        "source": str(a.source),
                        "frames": len(a.frames),
                        "usable": len(a.kept),
                        "edge_counts": {str(k): v for k, v in sorted(a.edge_counts.items())},
                        "candidate": a.candidate,
                        "spreads": a.spreads,
                        "worst_spread": a.worst_spread,
                    }
                    for a in analyses
                ],
                indent=2,
            )
        )
        return 0

    lines: list[str] = []
    for a in analyses:
        lines += format_report(a, args.tolerance, args.min_captures)
    if len(analyses) > 1:
        lines += cross_match(analyses, args.tolerance)
    if args.yaml:
        lines += yaml_snippet(analyses)

    print("\n".join(lines))

    problems = any(
        not a.frames or len(a.kept) < args.min_captures or a.worst_spread > 2 * args.tolerance
        for a in analyses
    )
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
