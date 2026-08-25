# Tools

These tools analyse raw hob2hood captures and exercise the Shelly arbiter without
extra Python or Node packages. Run the examples from the repository root.

Requirements:

- Python 3.10 or newer for `parse_raw_dump.py`; it uses only the standard library.
- Node.js for `sim_arbiter.js`; there is no `npm install` step.

## Capturing raw frames

Start with the capture-only ESPHome config in the
[main README](../README.md#ir-capture-starter). Collect logs over USB so
ESPHome's API logger cannot drop lines, and save the output as a plain-text file.
The parser looks for ESPHome's literal `Received Raw:` records and rejoins frames
that the logger wrapped across lines. Keep the timestamps: cluster mode uses them
to show repeats and the order in which commands arrived.

For example:

```bash
esphome logs capture.yaml --device COM5 | tee capture.log
```

Replace `COM5` with the receiver's serial port, such as `/dev/ttyUSB0` on Linux.

## `parse_raw_dump.py`

The parser has two workflows. Both produce candidate timings from your captures,
not portable or authoritative hob2hood codes.

### Unlabelled capture: cluster first

Use cluster mode when one log contains a whole interaction and you could not
trigger or label each command independently:

```bash
python tools/parse_raw_dump.py capture.log --cluster
```

It groups frames by their quantised structure, separates likely noise, compares
each group with community seed signatures, calculates a candidate raw array, and
prints the arrival sequence. A seed name is only a clue; an unknown cluster is
valid evidence from a different hob generation, not automatically an error.

### Known commands: labelled analysis

Once each log contains only one known command, analyse them in labelled mode.
Repeat `--label` in the same order as the input files:

```bash
python tools/parse_raw_dump.py captures/fan-1.log captures/fan-2.log \
  --label 'fan 1' --label 'fan 2' --yaml
```

If labels are omitted, filename stems are used. For each input, the report keeps
the modal frame length, derives each timing from the midpoint of its observed
range, and reports edge spreads. With multiple files it also prints a cross-match
matrix; every candidate should match zero frames belonging to another command.
`--yaml` appends candidate ESPHome `binary_sensor` entries.

Useful options:

- `--tolerance 200` sets the raw match window in microseconds. Its default is
  200 and it must match `ir_tolerance` in `hob2hood.yaml` when testing production
  candidates.
- `--min-captures 10` sets the labelled-mode quality threshold. Ten usable
  frames per command is the default.
- `--json` replaces the labelled text report with machine-readable output.
- `--yaml` appends an ESPHome snippet to the labelled text report.
- `--cluster` selects the unlabelled text report; `--json` and `--yaml` do not
  apply in this mode.

Run `python tools/parse_raw_dump.py --help` for the complete command-line
reference.

Warnings in the report matter. Do not widen the tolerance merely to hide a large
spread: recheck receiver alignment, shielding, power, `idle`, and `filter`, then
capture again. Also inspect the cross-match matrix directly; collisions are
reported in text but do not currently make the process exit nonzero.

Exit status is `0` for a completed report, `1` when labelled captures fail a
quality check or no frames were found, and `2` for a missing input file or
invalid command line. JSON output returns `0` after successfully reading its
inputs, so consumers should evaluate the reported fields themselves.

## `sim_arbiter.js`

Run the Shelly logic tests with:

```bash
node tools/sim_arbiter.js
```

The simulator loads the real [shelly/arbiter.js](../shelly/arbiter.js), replaces
the Shelly status, RPC, timer, and logging APIs with a mock device, and exercises
the control logic. Long timers such as the 300 s handback complete in
milliseconds. It exits `0` when every assertion passes and `1` if any fail.

Run it from the repository root because it opens `shelly/arbiter.js` using a
root-relative path. Add a scenario when a live-device surprise exposes behaviour
that should remain covered.

Passing the simulator proves the JavaScript control flow against the mock. It
does not prove Shelly mJS compatibility, real RPC behaviour, wall-clock timing,
or electrical behaviour on the dimmer and fan; those still require device tests.
