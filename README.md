# esp-hob2hood

Drives a cooker hood from an Electrolux/AEG **hob2hood** induction hob.

The hood is a gutted shell — no motor, no relays, no OEM board. The extraction is
a remotely mounted Onnline EC fan on a 0-10 V input. An ESP32 decodes the hob's
infrared commands and a Shelly dimmer turns them into a fan speed, with a manual
slider on the same chassis as an override. Nothing here switches mains.

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
  unambiguous "cooking is finished" signal — arms a 300 s handback.
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

## The node config

The whole ESPHome side in one piece, as a starting point. It needs a `secrets.yaml`
with `wifi_ssid`, `wifi_password`, `api_encryption_key`, `ota_password` and
`ap_password`.

The raw IR arrays are from this hob and this receiver. Yours will differ enough
to matter — capture your own rather than trusting these.

```yaml
substitutions:
  node_name: hob2hood
  friendly_name: Hob2Hood

  pin_ir: GPIO18

  # Fixed-time tolerance, not the 25 % default: on a 2.9 ms mark 25 % is ±735 µs,
  # loose enough to alias distinct hob2hood codes together.
  ir_tolerance: 200us
  ir_idle: 10ms
  # Glitch threshold. Sub-threshold pulses are MERGED into their neighbours, so a
  # value too high silently corrupts frames. Ceiling is the smallest real edge.
  ir_filter: 300us
  # Must exceed api.batch_delay (100 ms) or HA never sees the ON, and stay under
  # the ~950 ms repeat interval or the repeat frames merge into one pulse.
  ir_pulse: 300ms

  # IP, not mDNS: http_request does not resolve .local names. Give the Shelly a
  # DHCP reservation. The IDs must match the virtual components provisioned there.
  shelly_host: "<shelly-ip>"
  shelly_ir_level: "200"
  shelly_ir_seq: "201"
  shelly_ir_light: "200"
  push_retry: 1s
  push_heartbeat: 30s

esphome:
  name: ${node_name}
  friendly_name: ${friendly_name}
  # Boot presents a known state, not a restored one. The node cannot tell a 5 s
  # OTA reboot from a 6 h power cut, and a stale level runs the fan with nobody
  # cooking. Cost: a reboot mid-session reports 0 until the next hob command.
  on_boot:
    priority: -100
    then:
      - lambda: |-
          id(fan_level_sensor).publish_state(0);
          id(light_sensor).publish_state(false);
          id(decode_count_sensor).publish_state(0);

esp32:
  board: esp32dev
  framework:
    type: esp-idf
    advanced:
      minimum_chip_revision: "3.1"
      sram1_as_iram: true

logger:
  level: DEBUG

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
  fast_connect: false
  # 0s, not the 15 min default: the IR side does not need Wi-Fi, and a node that
  # reboots through an outage drops its state repeatedly for no benefit.
  reboot_timeout: 0s
  ap:
    ssid: "${friendly_name} Fallback"
    password: !secret ap_password

captive_portal:

api:
  id: ha_api
  encryption:
    key: !secret api_encryption_key
  # Same reasoning as wifi.reboot_timeout. The default reboots the node every
  # 15 min whenever no API client is connected.
  reboot_timeout: 0s

ota:
  - platform: esphome
    password: !secret ota_password

# Shelly Gen3 speaks JSON-RPC over plain HTTP POST to /rpc. Short timeout: a push
# that has not landed in 3 s has already lost its race with the next IR frame.
http_request:
  id: shelly_rpc
  timeout: 3s
  watchdog_timeout: 10s
  verify_ssl: false

globals:
  - id: fan_level
    type: int
    restore_value: false
    initial_value: '0'

  - id: light_state
    type: bool
    restore_value: false
    initial_value: 'false'

  - id: decode_count
    type: uint32_t
    restore_value: false
    initial_value: '0'

  # Last value CONFIRMED written to the Shelly. -1 = unknown, which forces one
  # push at boot even when the decoded level is already 0.
  - id: pushed_level
    type: int
    restore_value: false
    initial_value: '-1'

  # What the in-flight request carries. The POST is asynchronous, so fan_level
  # can move on before the response lands.
  - id: posting_level
    type: int
    restore_value: false
    initial_value: '-1'

  - id: pushed_light
    type: int
    restore_value: false
    initial_value: '-1'

  - id: ir_seq
    type: int
    restore_value: false
    initial_value: '0'

  - id: push_fail
    type: uint32_t
    restore_value: false
    initial_value: '0'

script:
  - id: note_command
    parameters:
      cmd: string
    then:
      - lambda: |-
          id(decode_count) += 1;
          id(decode_count_sensor).publish_state(id(decode_count));
          id(command_event).trigger(cmd);

  - id: note_fan
    parameters:
      level: int
      cmd: string
    then:
      - lambda: |-
          id(fan_level) = level;
          id(fan_level_sensor).publish_state(level);
      - script.execute: push_level
      - script.execute:
          id: note_command
          cmd: !lambda 'return cmd;'

  - id: note_light
    parameters:
      lit: bool
      cmd: string
    then:
      - lambda: |-
          id(light_state) = lit;
          id(light_sensor).publish_state(lit);
      - script.execute: push_light
      - script.execute:
          id: note_command
          cmd: !lambda 'return cmd;'

  - id: note_push
    parameters:
      ok: bool
    then:
      - lambda: |-
          id(shelly_link_sensor).publish_state(ok);
          if (!ok) {
            id(push_fail) += 1;
            id(push_fail_sensor).publish_state(id(push_fail));
          }

  # mode: single, not restart: an in-flight POST cannot be cancelled and a second
  # request would race the first. Dropping the overlap costs nothing, because the
  # retry interval re-reads fan_level, so the latest value is what gets pushed.
  - id: push_level
    mode: single
    then:
      - lambda: 'id(posting_level) = id(fan_level);'
      - http_request.post:
          url: http://${shelly_host}/rpc
          request_headers:
            Content-Type: application/json
          body: !lambda |-
            char buf[112];
            snprintf(buf, sizeof(buf),
                     "{\"id\":1,\"method\":\"Number.Set\","
                     "\"params\":{\"id\":${shelly_ir_level},\"value\":%d}}",
                     id(posting_level));
            return std::string(buf);
          # The Shelly answers HTTP 200 for JSON-RPC ERRORS too: an unprovisioned
          # number:200 comes back 200 OK with {"error":{"code":-105,...}}. Testing
          # the status code alone reports a healthy link while every push fails.
          capture_response: true
          on_response:
            then:
              - lambda: |-
                  bool ok = response->status_code == 200 &&
                            body.find("\"error\"") == std::string::npos;
                  if (ok) id(pushed_level) = id(posting_level);
                  else ESP_LOGW("shelly", "push_level rejected: %s", body.c_str());
                  id(note_push)->execute(ok);
          on_error:
            then:
              - script.execute: {id: note_push, ok: false}

  - id: push_light
    mode: single
    then:
      - http_request.post:
          url: http://${shelly_host}/rpc
          request_headers:
            Content-Type: application/json
          body: !lambda |-
            char buf[112];
            snprintf(buf, sizeof(buf),
                     "{\"id\":1,\"method\":\"Boolean.Set\","
                     "\"params\":{\"id\":${shelly_ir_light},\"value\":%s}}",
                     id(light_state) ? "true" : "false");
            return std::string(buf);
          capture_response: true
          on_response:
            then:
              - lambda: |-
                  bool ok = response->status_code == 200 &&
                            body.find("\"error\"") == std::string::npos;
                  if (ok) id(pushed_light) = id(light_state) ? 1 : 0;
                  else ESP_LOGW("shelly", "push_light rejected: %s", body.c_str());
                  id(note_push)->execute(ok);
          on_error:
            then:
              - script.execute: {id: note_push, ok: false}

  # Liveness only. ir_level is written on change, so an unchanged value produces
  # no RPC and the far end cannot tell a quiet kitchen from a dead node. ir_seq
  # always changes. It wraps at 100 to stay readable; the arbiter tests for
  # "changed", never for "increased".
  - id: push_seq
    mode: single
    then:
      - lambda: 'id(ir_seq) = (id(ir_seq) + 1) % 100;'
      - http_request.post:
          url: http://${shelly_host}/rpc
          request_headers:
            Content-Type: application/json
          body: !lambda |-
            char buf[112];
            snprintf(buf, sizeof(buf),
                     "{\"id\":1,\"method\":\"Number.Set\","
                     "\"params\":{\"id\":${shelly_ir_seq},\"value\":%d}}",
                     id(ir_seq));
            return std::string(buf);
          capture_response: true
          on_response:
            then:
              - lambda: |-
                  bool ok = response->status_code == 200 &&
                            body.find("\"error\"") == std::string::npos;
                  if (!ok) ESP_LOGW("shelly", "push_seq rejected: %s", body.c_str());
                  id(note_push)->execute(ok);
          on_error:
            then:
              - script.execute: {id: note_push, ok: false}

# Publish-only templates: no lambda, update_interval never. These are edge-driven,
# and polling them would invent a state change the hob never sent.
sensor:
  - platform: template
    name: "Fan Level"
    id: fan_level_sensor
    icon: mdi:fan
    accuracy_decimals: 0
    update_interval: never

  - platform: template
    name: "Decodes"
    id: decode_count_sensor
    entity_category: diagnostic
    icon: mdi:counter
    accuracy_decimals: 0
    state_class: total_increasing
    update_interval: never

  # A working link is a flat line here; a retrying link is a ramp. That is the
  # difference between "the hob sent nothing" and "the fan did not move".
  - platform: template
    name: "Shelly Push Failures"
    id: push_fail_sensor
    entity_category: diagnostic
    icon: mdi:alert-circle-outline
    accuracy_decimals: 0
    state_class: total_increasing
    update_interval: never

# Every decoded frame, repeats included. An event, not a text sensor: identical
# consecutive commands produce no state change and would be silently under-counted.
event:
  - platform: template
    name: "Command"
    id: command_event
    event_types:
      - fan_off
      - fan_1
      - fan_2
      - fan_3
      - fan_4
      - light_on
      - light_off

# The link's only recovery path. Nothing else re-sends a failed push, and the hob
# will not re-assert to cover for it.
interval:
  - interval: ${push_retry}
    then:
      - if:
          condition:
            lambda: 'return id(pushed_level) != id(fan_level);'
          then:
            - script.execute: push_level
      - if:
          condition:
            lambda: 'return id(pushed_light) != (id(light_state) ? 1 : 0);'
          then:
            - script.execute: push_light

  - interval: ${push_heartbeat}
    then:
      - script.execute: push_seq

remote_receiver:
  id: ir_rx
  pin:
    number: ${pin_ir}
    mode:
      input: true
      pullup: true
    # `inverted:` stays OFF. The TSOP output is active-low and the ESPHome docs
    # commonly suggest inverting, but this receiver idles high, so in these dumps
    # negative = IR burst (mark) and positive = gap (space).
  dump: raw
  tolerance:
    type: time
    value: ${ir_tolerance}
  idle: ${ir_idle}
  filter: ${ir_filter}

binary_sensor:
  - platform: template
    name: "Shelly Link"
    id: shelly_link_sensor
    device_class: connectivity
    entity_category: diagnostic

  - platform: template
    name: "Light"
    id: light_sensor
    device_class: light

  # The raw arrays below were captured from this hob with this receiver, as the
  # MIDRANGE of each edge's observed range across four sessions — ESPHome's
  # matcher is a worst-case test, so the midpoint beats the median. Yours will
  # differ; capture your own with `dump: raw` and tools/parse_raw_dump.py.
  #
  # `delayed_off` is REQUIRED, not a debounce. remote_base publishes true,
  # yield(), false, so the ON lasts one scheduler yield and api.batch_delay
  # overwrites it before the batch flushes — HA would see only OFF, forever,
  # looking exactly like a receiver fault.
  - platform: remote_receiver
    name: "Fan Off"
    id: hob2hood_fan_off
    entity_category: diagnostic
    raw:
      code: [-766, 1400, -758, 1406, -2194, 1414, -770, 1381, -1533, 2092, -735, 1430, -758, 686, -758]
    filters:
      - delayed_off: ${ir_pulse}
    on_press:
      - script.execute: {id: note_fan, level: 0, cmd: 'fan_off'}

  # Ambiguous by nature: this same frame means "automatic boil detection", "the
  # operator pressed the button" and "the hob was switched off and is entering
  # run-on at speed 1". It is recorded as level 1 and nothing more.
  - platform: remote_receiver
    name: "Fan 1"
    id: hob2hood_fan_1
    entity_category: diagnostic
    raw:
      code: [-1484, 1402, -762, 1404, -2195, 1414, -762, 1416, -758, 698, -750, 1416, -734, 2155, -722]
    filters:
      - delayed_off: ${ir_pulse}
    on_press:
      - script.execute: {id: note_fan, level: 1, cmd: 'fan_1'}

  - platform: remote_receiver
    name: "Fan 2"
    id: hob2hood_fan_2
    entity_category: diagnostic
    raw:
      code: [-1472, 1416, -748, 2861, -762, 2140, -3623, 2151, -2206]
    filters:
      - delayed_off: ${ir_pulse}
    on_press:
      - script.execute: {id: note_fan, level: 2, cmd: 'fan_2'}

  - platform: remote_receiver
    name: "Fan 3"
    id: hob2hood_fan_3
    entity_category: diagnostic
    raw:
      code: [-762, 2138, -2918, 2857, -2182, 705, -739, 2148, -2194]
    filters:
      - delayed_off: ${ir_pulse}
    on_press:
      - script.execute: {id: note_fan, level: 3, cmd: 'fan_3'}

  # Reachable only by pressing the button; automatic operation never exceeds 3.
  - platform: remote_receiver
    name: "Fan 4 Boost"
    id: hob2hood_fan_4
    entity_category: diagnostic
    raw:
      code: [-1496, 2102, -1508, 632, -1470, 2138, -1473, 1414, -774, 2112, -749, 694, -1472]
    filters:
      - delayed_off: ${ir_pulse}
    on_press:
      - script.execute: {id: note_fan, level: 4, cmd: 'fan_4'}

  # Re-sent on hob activation even when the light is already on — the one
  # exception to "the hob never re-asserts". Assigning true to true is a no-op.
  - platform: remote_receiver
    name: "Light On"
    id: hob2hood_light_on
    entity_category: diagnostic
    raw:
      code: [-751, 1415, -750, 694, -1470, 754, -734, 1365, -748, 695, -1470, 2862, -734, 696, -749, 716, -1446]
    filters:
      - delayed_off: ${ir_pulse}
    on_press:
      - script.execute: {id: note_light, lit: true, cmd: 'light_on'}

  # Touches the LIGHT ONLY. It fires 120 s after hob deactivation and can land
  # minutes BEFORE `fan off`. Anything that reads it as "session over" and clears
  # the fan level will cut extraction short.
  - platform: remote_receiver
    name: "Light Off"
    id: hob2hood_light_off
    entity_category: diagnostic
    raw:
      code: [-774, 1388, -766, 683, -762, 681, -748, 2138, -750, 694, -748, 1418, -746, 1419, -762, 682, -750]
    filters:
      - delayed_off: ${ir_pulse}
    on_press:
      - script.execute: {id: note_light, lit: false, cmd: 'light_off'}
```

## Layout

```
example hob2hood yaml          IR receiver, code matching, state, push to Shelly
shelly/arbiter.js              the control logic — single writer to the output
shelly/README.md               provisioning the virtual components and script
tools/sim_arbiter.js           runs arbiter.js under node against a mock device
tools/parse_raw_dump.py        IR code decoder tool
```

## Working on it

```bash
esphome config   hob2hood.yaml     
esphome compile  hob2hood.yaml
esphome run      hob2hood.yaml --device COM<N>
esphome logs     hob2hood.yaml --device COM<N>
```

Use serial rather than the API logger for anything you intend to measure — the
API logger drops lines when its buffer overflows, and a dropped line is
indistinguishable from a missed decode.

```bash
python tools/parse_raw_dump.py docs/capture-logs/*.log --cluster   # what arrived
node tools/sim_arbiter.js                                          # arbiter tests
```

Changing the level→percent mapping or the handback timer is a paste-and-restart
on the Shelly, not a reflash.
