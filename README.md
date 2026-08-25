# esp-hob2hood

Drives a cooker hood from an Electrolux/AEG **hob2hood** induction hob.

The hood is a gutted shell — no motor, no relays, no OEM board. The extraction is
a remotely mounted Onnline EC fan on a 0-10 V input. An ESP32 decodes the hob's
infrared commands and a Shelly dimmer turns them into a fan speed, with a manual
slider on the same chassis as an override. Nothing here switches mains except for
turning the hood light on/off.

```
  Hob (IR, 38 kHz)
        │
        ▼
  TSOP38338 ──► ESP32 (ESPHome, raw match)
                    │  LAN RPC: ir_level 0-4, ir_light, heartbeat
                    ▼
  10k slider ──► Shelly Add-on ──► Shelly Dimmer 0/1-10V PM Gen3
                                     ├─ 0-10 V ──► Onnline EC fan
                                     └─ relay O ─► hood lamp
                                     arbiter.js owns the output
```

## How it works

**ESP32 — decode.** A TSOP38338 on GPIO18 feeds ESPHome's `remote_receiver`. The
seven hob2hood commands (fan off/1/2/3/boost, light on/off) are matched as raw
timing arrays captured from this hob and this receiver. The node holds the resulting state — fan
level 0-4 and light on/off — and pushes it to the Shelly on every change, plus a
counter every 30 s so the Shelly can tell a quiet kitchen from a dead node. It
reports the same state to Home Assistant and has no path to the output.

**Shelly — decide and drive.** [shelly/arbiter.js](shelly/arbiter.js) is the
single writer to the dimmer's light channel, whose brightness *is* the 0-10 V
setpoint and whose on/off closes relay O for the hood lamp. It arbitrates two
edge-triggered inputs: the IR level from the ESP32, and the 10 k slider read as
volts on the Add-on. `light on` sets a 25 % fan floor rather than assigning a
speed, giving a ladder of 0 / 25 / 40 / 60 / 80 / 100 %.

**Home Assistant — watch only.** It observes, notifies and retunes. It is never in
the control path, so the hood keeps working with HA down, and the knob keeps
working with the network down.

## Arbitration

The knob owns the fan until the hob says cooking is over.

- Moving the slider more than 3 % takes the output and jumps straight to its
  absolute position. IR commands after that are recorded but not applied.
- `light off` — which the hob sends ~2 min after deactivation, and is the only
  unambiguous “cooking is finished” signal — arms a 300 s handback.
- On expiry the output falls to whatever the IR last commanded, not to zero. If
  the hob is still running on at fan 1, extraction continues until `fan off`
  actually arrives, however late.
- Winding the knob to ≤2 % hands control back to IR immediately. After a
  handback the knob is latched until it makes that trip through zero, so drift on
  a parked slider can't resurrect an override hours later.
- If the ESP32's heartbeat stops for ~30 min the Shelly falls back to the slider
  position — a state a human can see and change.

`last_actor`, `ir_level` and `manual_level` are published as virtual components,
so why the fan sits at 40 % is visible rather than inferred.

## IR capture starter

The production node is in [hob2hood.yaml](hob2hood.yaml). Before using its raw
codes, save the starter below as `capture.yaml`, adjust the board and receiver
pin, and capture the frames produced by your own hob and receiver. This config is
deliberately USB/serial-only: it has no Wi-Fi, Home Assistant, or Shelly
integration and needs no `secrets.yaml`.

```yaml
substitutions:
  node_name: hob2hood-capture
  friendly_name: Hob2Hood Capture

  pin_ir: GPIO18        # Change if needed
  ir_idle: 10ms
  # Pulses shorter than this are merged into their neighbours. Keep it below the
  # shortest real edge or the capture will be silently corrupted.
  ir_filter: 300us

esphome:
  name: ${node_name}
  friendly_name: ${friendly_name}

esp32:
  board: esp32dev       # Change if needed
  framework:
    type: esp-idf

logger:
  level: DEBUG

remote_receiver:
  pin:
    number: ${pin_ir}
    mode:
      input: true
      pullup: true
    # Leave `inverted` unset for this TSOP38338 wiring: the receiver idles high,
    # so raw dumps use negative values for IR bursts and positive values for gaps.
  dump: raw
  idle: ${ir_idle}
  filter: ${ir_filter}
```

`idle: 10ms` is longer than any gap observed inside these hob2hood frames and
much shorter than the roughly 950 ms between repeated frames. If your signal has
shorter real edges than this project's roughly 600 µs minimum, lower
`ir_filter`; filtering is destructive and cannot be undone by the parser.

## Layout

```
README.md                      system overview and capture-only ESPHome starter
hob2hood.yaml                  production decoder, state, and Shelly push
shelly/arbiter.js              the control logic — single writer to the output
shelly/README.md               provisioning the virtual components and script
tools/README.md                capture analysis and simulator usage
tools/parse_raw_dump.py        turns raw logs into candidate IR codes
tools/sim_arbiter.js           runs arbiter.js under Node against a mock device
```

## Working on it

Save the starter above as `capture.yaml`, replace `COM5` with your serial port,
then flash it and collect raw frames over USB:

```bash
esphome config capture.yaml
esphome run capture.yaml --device COM5
esphome logs capture.yaml --device COM5
```

Use serial rather than the API logger for anything you intend to measure — the
API logger drops lines when its buffer overflows, and a dropped line is
indistinguishable from a missed decode. Save the output as a plain-text log, then
analyse it as described in [tools/README.md](tools/README.md).

The full production config can be checked and flashed separately:

```bash
esphome config hob2hood.yaml
esphome compile hob2hood.yaml
esphome run hob2hood.yaml --device COM5
esphome logs hob2hood.yaml --device COM5
```

```bash
python tools/parse_raw_dump.py capture.log --cluster   # identify captured frames
node tools/sim_arbiter.js                              # run arbiter tests
```

Changing the level→percent mapping or the handback timer is a paste-and-restart
on the Shelly, not a reflash.
