# Shelly provisioning — Kubu-shelly (Dimmer 0/1-10 V PM Gen3)

Device: `192.168.1.114`, model `S3DM-0010WW`, fw `2.0.0`,
`auth_en: false`, `addon_type: sensor`.


---

## 0. Before anything — confirm two settings by eye

One is settled; one still needs an eyeball.

**`light:0.op_mode` is `0`.** The design requires **0-10 V**, not 1-10 V: in
1-10 V the channel stays nominally on at the bottom of travel, so the fan never
stops and the hood lamp never goes out. `0` is *probably* 0-10 V, but confirm it
in the web UI rather than trusting the number.

**`light:0.initial_state` — `off`.** `restore_last`
would mean a power cut could resume the fan at its last speed
with nobody in the kitchen. Changed at the source via
`Light.SetConfig {id:0, config:{initial_state:"off"}}`, which also closes the
window between the channel restoring and `arbiter.js` reaching its first
statement. The arbiter still forces the output off at startup, because a *script*
restart does not reboot the device and `initial_state` does not run.

Also worth knowing, neither of them a problem yet:

- `transition_duration: 3.0` — every setpoint fades over 3 s. Intended, but it
  means a change is never instant at the grille.
- `min_brightness_on_toggle: 3` — only applies to toggle, not to the explicit
  `Light.Set {brightness: N}` the arbiter uses.
- `sys.restart_required: true` is set on the device. It was already set before
  the `initial_state` change, so something earlier is also pending. Nothing here
  depends on it — `initial_state` is read at boot, so the next boot uses the new
  value whether or not you restart deliberately.

---

## 1. Create the virtual components

Five of the ten available. **Order matters** — Shelly assigns IDs sequentially
from 200 per type, and `arbiter.js` and `esphome/hob2hood.yaml` both hard-code
them. Note `boolean:200` and `text:200` are separate ID spaces from `number:*`,
so both start at 200.
Chamge the Shelly IP at S=192.168.1.114 to the correct one

```bash
S=192.168.1.114

# number:200 — ir_level, written by the ESP32 on change only.
# persisted: the arbiter adopts this on the first tick after a Shelly reboot,
# which is what restores the hood mid-session instead of leaving it dead until
# the next hob press.
curl -s "http://$S/rpc/Virtual.Add" -H 'Content-Type: application/json' -d '{
  "type":"number",
  "config":{"name":"IR Level","min":0,"max":4,"default_value":0,
            "persisted":true,"meta":{"ui":{"view":"label","unit":""}}}}'

# boolean:200 — the hob's LIGHT channel, written by the ESP32 on change.
# Sets a 25 % fan floor; it is an actuator input now, not a diagnostic.
curl -s "http://$S/rpc/Virtual.Add" -H 'Content-Type: application/json' -d '{
  "type":"boolean",
  "config":{"name":"IR Light","default_value":false,"persisted":true,
            "meta":{"ui":{"view":"label"}}}}'

# number:201 — ir_seq, liveness beat, bumped every 30 s by the ESP32.
curl -s "http://$S/rpc/Virtual.Add" -H 'Content-Type: application/json' -d '{
  "type":"number",
  "config":{"name":"IR Seq","min":0,"max":99,"default_value":0,
            "persisted":false,"meta":{"ui":{"view":"label","unit":""}}}}'

# number:202 — manual_level, knob position in %, published BY the arbiter.
curl -s "http://$S/rpc/Virtual.Add" -H 'Content-Type: application/json' -d '{
  "type":"number",
  "config":{"name":"Knob Position","min":0,"max":100,"default_value":0,
            "persisted":false,"meta":{"ui":{"view":"label","unit":"%"}}}}'

# text:200 — last_actor: boot | ir | ir+latched | knob | stale.
# "ir+latched" is 10 chars; max_len 16 covers the whole vocabulary.
# "When someone asks why the fan is at 40 %, the answer should be visible
#  rather than inferred."
curl -s "http://$S/rpc/Virtual.Add" -H 'Content-Type: application/json' -d '{
  "type":"text",
  "config":{"name":"Last Actor","max_len":16,"persisted":false,
            "meta":{"ui":{"view":"label"}}}}'
```

Verify the IDs came out as expected before going further:

```bash
curl -s "http://$S/rpc/Shelly.GetComponents?dynamic_only=true"
```

Expect exactly `number:200`, `number:201`, `number:202`, `boolean:200` and
`text:200`. If any ID differs, fix the constants in `shelly/arbiter.js`
(`CFG.ID_*`) and the `shelly_ir_level` / `shelly_ir_seq` / `shelly_ir_light`
substitutions in `esphome/hob2hood.yaml` — do not renumber by deleting and
re-adding, the counter does not reset.

---

## 2. Upload the script

Easiest path is the web UI: **Scripts → Add script**, name it `arbiter`, paste
`shelly/arbiter.js`, Save, Start, and tick **Run on startup**.


---

## 3. Watch it run

The script logs to the device console (web UI → the script's log pane), or:

```bash
curl -s "http://$S/rpc/Script.GetStatus?id=1"
curl -s "http://$S/rpc/Shelly.GetStatus" | python -m json.tool
```


Expected on a healthy system:

- `text:200` cycles `boot` → `ir` as soon as the ESP32 pushes.
- `number:201` advances every 30 s. If it stops, the ESP32 link is down — check
  `binary_sensor.hob2hood_shelly_link` and `sensor.hob2hood_shelly_push_failures`
  in HA before suspecting the Shelly. 
- `number:202` tracks the slider.
- `light:0.brightness` only changes when `text:200` changes or the hob sends
  something. A brightness that moves on its own means a second writer got in.

---

## 4. Commissioning order

`LEVEL_PCT` is still a placeholder in `arbiter.js`, which is the reason to do
this in stages.

1. **Link first.** Provision, upload, and confirm `ir_level` tracks the hob with
   the fan disconnected or the breaker off. Walk the ladder 1-2-3-4-off at the
   hob and watch `number:200` follow, and the hob light toggle `boolean:200`.
   Expected setpoints: 0 / 25 / 40 / 60 / 80 / 100 %.

   The one worth watching for real is the **run-on**: switch the hob off and
   confirm the output stays at 40 % when `light off` arrives ~2 min later, and
   only drops to 0 when `fan off` arrives ~2 min after that. If it drops early,
   `LIGHT_IS_FLOOR` got turned off.
2. **Then V_start.** With ducting connected, sweep the output up from 0 and find
   the rising start voltage, judged at the grille and not at the fan. Check cold
   and warm. Put the result in `docs/hardware.md` and set `CFG.LEVEL_PCT`.
3. **Then the handback.** `CFG.HANDBACK_S` is 300 s. Since the handback falls to
   the last IR command rather than forcing zero, this no longer has to cover the
   run-on and is purely a comfort setting: how long should a knob override
   outlive the end of cooking? Move it freely.

   What to watch for on the first real cook-and-shutdown: `last_actor` going to
   `ir+latched` when the timer expires, and the slider being **dead** until it is
   wound to zero. 

Changing `LEVEL_PCT` or `HANDBACK_S` is a paste-and-restart, not a reflash.
