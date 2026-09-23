// sim_arbiter.js — run shelly/arbiter.js under node with the Shelly runtime
// stubbed, and assert its behaviour.
//
//   node tools/sim_arbiter.js        (from the repo root)
//
// WHAT THIS IS: the real arbiter source, loaded and executed, with
// Shelly.getComponentStatus / getComponentConfig / Shelly.call / Timer.set /
// print replaced by stubs over a mock device. It exercises the actual control
// flow, not a paraphrase of it, and it runs a 300 s handback in a few
// milliseconds.
//
// light:0 is modelled as the arbiter reads it back: its status lags each
// command by the whole transition_duration. That is the worst case for
// mistaking our own fade for someone else's write, and every scenario runs
// under it.
//
// WHAT THIS IS NOT: a substitute for the device. mJS is a SUBSET of JS, so
// node will happily run things the Shelly will reject at upload or at
// runtime — Array.map, try/catch, template literals, a missing Math builtin.
// Passing here means the LOGIC is right. It says nothing about mJS
// compatibility, RPC behaviour, timing, or the voltmeter.
//
// Add a scenario whenever a live run surprises you. The load-bearing ones for
// the 2026-08-25 design are 7 (handback falls to the hob's last command),
// 8 (a run-on longer than the timer still gets honoured), and 9 (drift after a
// handback must not resurrect the override — the failure the latch exists for).
const fs = require('fs');
const src = fs.readFileSync('shelly/arbiter.js', 'utf8');

let dev, tickFn, logs, calls;
let extLogs = 0;                     // "externally" lines, across every reset
const FADE_S = 3, FADE_TICKS = FADE_S * 2;

function reset(initial) {
  dev = Object.assign({
    'voltmeter:100': { voltage: 0.0 },
    'number:200': { value: 0 },      // ir_level
    'boolean:200': { value: false }, // ir_light
    'number:201': { value: 0 },      // ir_seq
    'number:202': { value: 0 },
    'text:200':   { value: '' },
    light: { on: false, brightness: 0 },        // last command, from anyone
    shown: { output: false, brightness: 0 },    // light:0 status, lagging it
    fading: 0,
    failLight: false,                           // Light.Set errors out
    setLag: 0,                                  // ticks before a *.Set lands
    pending: [],
  }, initial || {});
  logs = []; calls = [];
}

function commandLight(on, brightness) {
  dev.light.on = !!on;
  if (brightness !== undefined) dev.light.brightness = brightness;
  dev.fading = FADE_TICKS;
}

const Shelly = {
  getComponentStatus: (k) => (k === 'light:0' ? dev.shown : (k in dev ? dev[k] : null)),
  getComponentConfig: (k) => (k === 'light:0' ? { transition_duration: FADE_S } : null),
  call: (m, p, cb, ud) => {
    calls.push({ m, p });
    if (m === 'Light.Set' && dev.failLight) { if (cb) cb(null, -1, 'injected', ud); return; }
    if (m === 'Light.Set') commandLight(p.on, p.brightness);
    if (m === 'Text.Set') dev['text:200'].value = p.value;
    if (m === 'Number.Set' || m === 'Boolean.Set') {
      const key = (m === 'Number.Set' ? 'number:' : 'boolean:') + p.id;
      if (dev.setLag > 0) { dev.pending.push({ key, value: p.value, due: dev.setLag, cb, ud }); return; }
      dev[key].value = p.value;
    }
    if (cb) cb(null, 0, '', ud);
  },
};
const Timer = { set: (ms, rep, fn) => { tickFn = fn; } };
const print = (s) => { logs.push(s); if (/externally/.test(s)) extLogs++; };

function load() {
  new Function('Shelly', 'Timer', 'print', src)(Shelly, Timer, print);
}
const out = () => (dev.light.on ? dev.light.brightness : 0);
const actor = () => dev['text:200'].value;
function ticks(n) {
  for (let i = 0; i < n; i++) {
    if (dev.fading > 0 && --dev.fading === 0) {
      dev.shown = { output: dev.light.on, brightness: dev.light.brightness };
    }
    dev.pending = dev.pending.filter((w) => {
      if (--w.due > 0) return true;
      dev[w.key].value = w.value;
      if (w.cb) w.cb(null, 0, '', w.ud);
      return false;
    });
    tickFn();
  }
}
function knob(v) { dev['voltmeter:100'].voltage = v; }
function ir(level, lit) { dev['number:200'].value = level; dev['boolean:200'].value = lit; }
// A write to light:0 that is not the arbiter's: HA's light entity, the app.
function ha(on, brightness) { commandLight(on, brightness); }
const seen = (re) => logs.filter((l) => re.test(l)).length;

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = String(got) === String(want);
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + label.padEnd(48) +
              ' got ' + String(got).padEnd(10) + ' want ' + want);
  ok ? pass++ : fail++;
}

// ---------------------------------------------------------------- scenario 1
console.log('\n1. IR ladder with the knob untouched');
reset(); load();
check('boot forces silence', out(), 0);
check('boot actor', actor(), 'boot');
ir(0, true);  ticks(1); check('light_on -> floor', out(), 25);
ir(1, true);  ticks(1); check('fan_1', out(), 40);
ir(2, true);  ticks(1); check('fan_2', out(), 60);
ir(3, true);  ticks(1); check('fan_3', out(), 80);
ir(4, true);  ticks(1); check('fan_4', out(), 100);
ir(0, true);  ticks(1); check('fan_off, light still on', out(), 25);
ir(0, false); ticks(1); check('light_off', out(), 0);
check('actor stays ir, nothing latched', actor(), 'ir');

// ---------------------------------------------------------------- scenario 2
console.log('\n2. Measured run-on survives its early light_off');
reset(); load();
ir(1, true); ticks(1); check('hob off, run-on at fan_1', out(), 40);
ir(1, false); ticks(1); check('+120s light_off -> floor withdrawn', out(), 40);
ir(0, false); ticks(1); check('+240s fan_off', out(), 0);

// ---------------------------------------------------------------- scenario 3
console.log('\n3. Knob takeover — IR is recorded, not applied');
reset(); load();
ir(3, true); ticks(1); check('hob at fan_3', out(), 80);
knob(2.2); ticks(1);   check('knob to 22%', out(), 22);
check('actor after knob', actor(), 'knob');
ir(4, true); ticks(1); check('hob fan_4 does not move the output', out(), 22);
check('actor stays knob', actor(), 'knob');
check('but it IS recorded', seen(/ir recorded/), 1);

// ---------------------------------------------------------------- scenario 4
console.log('\n4. Wind knob to zero -> release to the recorded IR state');
knob(0.0); ticks(1);
check('released to the recorded fan_4', out(), 100);
check('actor', actor(), 'ir');
ir(2, true); ticks(1); check('IR governs again immediately', out(), 60);

// ---------------------------------------------------------------- scenario 5
console.log('\n5. Slow wind-down still releases');
reset(); load();
ir(3, true); ticks(1);
knob(2.2); ticks(1); check('manual at 22%', out(), 22);
ir(4, true); ticks(1); check('fan_4 recorded only', out(), 22);
// 22% -> 0 in small steps; each crosses the deadband and re-takes, then zero releases
for (let v = 2.2; v > 0; v -= 0.0367) { knob(Math.max(0, v)); ticks(1); }
knob(0); ticks(1);
check('slow wind-down still released', out(), 100);
check('actor', actor(), 'ir');

// ---------------------------------------------------------------- scenario 6
console.log('\n6. Knob RESTING at zero must not steal control');
reset(); load();
knob(0); ticks(20);
// At boot the arbiter deliberately ADOPTS the persisted ir_level, so actor
// becoming 'ir' is correct. What must not happen is the zero-release firing.
check('release did not fire at rest', seen(/released to IR/), 0);
check('knob never took control', seen(/actor -> knob/), 0);
check('output stays silent', out(), 0);
ir(2, true); ticks(1); check('IR works from rest', out(), 60);
check('actor', actor(), 'ir');
const before = calls.length; ticks(20);
check('idle ticks issue no writes', calls.length - before, 0);

// ---------------------------------------------------------------- scenario 7
console.log('\n7. Handback: light_off arms, fan_off lands inside the window');
reset(); load();
ir(3, true); ticks(1);
knob(5.0); ticks(1);  check('manual at 50%', out(), 50);
ir(3, false); ticks(1);
check('light_off does not move a manual output', out(), 50);
check('handback armed by light_off', seen(/handback armed/), 1);
ir(0, false); ticks(1);
check('fan_off inside the window is recorded only', out(), 50);
ticks(600);
check('handback -> falls to the recorded fan_off', out(), 0);
check('and the latch is published', actor(), 'ir+latched');

// ---------------------------------------------------------------- scenario 8
console.log('\n8. Run-on LONGER than the handback is still honoured');
reset(); load();
ir(2, true); ticks(1);
knob(7.0); ticks(1);  check('manual at 70%', out(), 70);
ir(1, true); ticks(1);                       // hob deactivates -> run-on fan_1
ir(1, false); ticks(1);                      // +120s light_off, arms handback
ticks(600);
check('expiry falls to fan_1, NOT to zero', out(), 40);
check('actor', actor(), 'ir+latched');
ir(0, false); ticks(1);                      // fan_off arrives late
check('late fan_off still stops the hood', out(), 0);
check('still latched', actor(), 'ir+latched');

// ---------------------------------------------------------------- scenario 9
console.log('\n9. Drift after a handback must NOT resurrect the override');
reset(); load();
ir(3, true); ticks(1);
knob(6.0); ticks(1);  check('manual at 60%', out(), 60);
ir(3, false); ticks(1);
ir(0, false); ticks(1);
ticks(600);
check('handed back and shut down', out(), 0);
check('latched', actor(), 'ir+latched');
const knobTakes = seen(/actor -> knob/);
knob(6.5); ticks(2);                         // +5% — well past MOVE_PCT
knob(7.0); ticks(2);                         // +10%
knob(6.2); ticks(2);
check('drift did not take control', out(), 0);
check('no new knob takeover', seen(/actor -> knob/) - knobTakes, 0);
check('actor unchanged', actor(), 'ir+latched');

// --------------------------------------------------------------- scenario 10
console.log('\n10. Only a trip through zero makes the knob live again');
knob(0.0); ticks(1);
check('latch cleared at zero', seen(/latch cleared/), 1);
check('clearing does not move the output', out(), 0);
check('actor drops the latch', actor(), 'ir');
knob(4.0); ticks(1);
check('knob works again', out(), 40);
check('actor', actor(), 'knob');

// --------------------------------------------------------------- scenario 11
console.log('\n11. Knob movement inside the window does not extend the timer');
reset(); load();
ir(2, true); ticks(1);
knob(5.0); ticks(1);  check('manual at 50%', out(), 50);
ir(2, false); ticks(1);                      // arm
ticks(300);                                  // halfway through
knob(8.0); ticks(1);  check('knob still moves the output', out(), 80);
ticks(301);                                  // 601 ticks since arming
// If the knob move had restarted the timer, the output would still be 80.
check('handback fired on the original schedule', out(), 60);
check('actor', actor(), 'ir+latched');

// --------------------------------------------------------------- scenario 12
console.log('\n12. Stale IR overrides the latch — last-resort input wins');
reset(); load();
ir(3, true); ticks(1);
knob(6.0); ticks(1);
ir(3, false); ticks(1);
ir(0, false); ticks(1);
ticks(600);
check('latched and off', actor(), 'ir+latched');
ticks(3600);                                 // STALE_S 1800 x 2 ticks/s
check('stale fallback tracks the knob anyway', out(), 60);
check('actor', actor(), 'stale');

// --------------------------------------------------------------- scenario 13
console.log('\n13. Sub-deadband jitter must not latch into manual');
reset(); load();
ir(3, true); ticks(1); check('hob at fan_3', out(), 80);
[0.2, 0.0, 0.2, 0.1, 0.0, 0.2, 0.1, 0.0, 0.2, 0.0].forEach(function (v) { knob(v); ticks(1); });
check('output unchanged by jitter', out(), 80);
check('actor still ir', actor(), 'ir');
check('no takeover', seen(/actor -> knob/), 0);

// --------------------------------------------------------------- scenario 14
console.log('\n14. Knob parked off-zero at boot must not seize the output');
reset({ 'voltmeter:100': { voltage: 5.0 } }); load();
ticks(4);
check('parked knob does not take over', out(), 0);
check('knob never took control', seen(/actor -> knob/), 0);
ir(2, true); ticks(1); check('IR still governs', out(), 60);
knob(5.6); ticks(1); check('a real nudge DOES take over', out(), 56);
check('actor', actor(), 'knob');

// --------------------------------------------------------------- scenario 15
console.log('\n15. Drift-latch into manual is still recoverable');
reset(); load();
ir(3, true); ticks(1);
knob(0.5); ticks(1); knob(1.0); ticks(1);
check('drifted into manual', actor(), 'knob');
ir(4, true); ticks(1); check('IR now recorded only', out(), 10);
knob(0.0); ticks(1);
check('wind to zero recovers immediately', out(), 100);
check('actor', actor(), 'ir');

// --------------------------------------------------------------- scenario 16
// The 2026-09-23 incident as the arbiter now sees it. An ESP32 reboot used to
// land here as fan_off + light_off, dropping the floor that carries the
// run-on. boot_sync now takes the state back instead, so a reboot is a pause
// in ir_seq and nothing else.
console.log('\n16. ESP32 reboot mid-cook — no writes, the floor still carries the run-on');
reset({ 'number:201': { value: 57 } }); load();
ir(2, true); ticks(1); check('hob at fan_2, light on', out(), 60);
ticks(40);                                   // node down ~20 s: no beats, no writes
dev['number:201'].value = 1; ticks(1);       // first beat after boot_sync adopted
check('reboot did not move the output', out(), 60);
ir(0, true);  ticks(1); check('hob off: fan_off, the floor holds', out(), 25);
ir(0, false); ticks(1); check('+120s light_off ends it', out(), 0);

// --------------------------------------------------------------- scenario 17
// The case the old push-off-on-every-boot existed for, and which boot_sync
// keeps: ir_seq reads 0 because the Shelly booted with the node.
console.log('\n17. Power cut — persisted IR is adopted, the ESP32 push-off ends it');
reset({ 'number:200': { value: 2 }, 'boolean:200': { value: true } }); load();
ticks(1); check('Shelly boot adopts persisted fan_2 + light', out(), 60);
check('actor', actor(), 'ir');
ir(0, false); ticks(1); check('ESP32 push-off silences it', out(), 0);
ticks(600);  check('its light_off expiry latches nothing', actor(), 'ir');

// --------------------------------------------------------------- scenario 18
// The second 2026-09-23 incident. Offs were missed, the hood was switched off
// from HA — a write the arbiter did not make — and the hob's next `light on`
// was lost: a 40 % equal to the stale S.out is deduped away (a), and true
// onto a stale true is no edge at all (b).
console.log('\n18. Stuck on after missed offs, switched off from HA');
check('no own fade read back as external (1-17)', extLogs, 0);
reset(); load();
ir(1, false); ticks(20); check('(a) fan_off missed: stuck at fan_1', out(), 40);
dev.setLag = 2;                              // the reset writes land 2 ticks late
const before18 = calls.length;
ha(false); ticks(12);
check('late reset writes: no blip back on',
      calls.slice(before18).filter((c) => c.m === 'Light.Set' && c.p.on).length, 0);
check('HA off read back as a session end', actor(), 'ext');
check('IR components reset to idle', dev['number:200'].value + '/' + dev['boolean:200'].value, '0/false');
dev['boolean:200'].value = true; ticks(1);   // next session: ESP32 pushes light_on
check('hob light_on takes (was swallowed)', out(), 25);
check('actor', actor(), 'ir');
reset(); load();
ir(1, true); ticks(20); check('(b) light_off missed too: stuck 1/on', out(), 40);
ha(false); ticks(12);
dev['boolean:200'].value = true; ticks(1);   // ESP32's own light_state is still on
check('light_on is an edge again', out(), 25);

// --------------------------------------------------------------- scenario 19
console.log('\n19. A level set from HA is adopted, and IR is not deduped against it');
reset(); load();
ir(1, false); ticks(20);
ha(true, 70); ticks(8);
check('adopted, labelled', actor(), 'ext');
check('a level change resets nothing', dev['number:200'].value, 1);
ir(1, true); ticks(1);                       // edge that computes 40 % again
check('40 % re-sent over HA\'s 70 %', out(), 40);
check('actor', actor(), 'ir');

// --------------------------------------------------------------- scenario 20
console.log('\n20. HA off while the knob owns it — the parked knob is latched');
reset(); load();
ir(2, true); ticks(1);
knob(6.0); ticks(20); check('knob owns it', out(), 60);
ha(false); ticks(12);
check('override ended, knob latched', actor(), 'ext+latched');
knob(6.4); ticks(12); check('drift does not bring it back', out(), 0);
knob(0.0); ticks(1);  check('zero clears the latch', actor(), 'ext');
knob(3.0); ticks(1);  check('knob live again', out(), 30);
check('actor', actor(), 'knob');

// --------------------------------------------------------------- scenario 21
console.log('\n21. Stale: a foreign write is left standing, not fought or read');
reset(); load();
knob(5.0); ticks(3602); check('stale tracks the knob', out(), 50);
ha(false); ticks(20);
check('HA off stands', out(), 0);
check('not read as a session end', seen(/externally/), 0);

// --------------------------------------------------------------- scenario 22
console.log('\n22. Our own failed write is re-learned, not blamed on someone else');
reset(); load();
dev.failLight = true;
ir(1, false); ticks(20); check('write failed, output unchanged', out(), 0);
check('not read as external', seen(/externally/), 0);
dev.failLight = false;
ir(2, false); ticks(1); check('next command goes through', out(), 60);

// --------------------------------------------------------------- scenario 23
// HA off in the middle of cooking at the light floor, the most used setting.
// The IR reset idles boolean:200 too, and the floor comes back only because
// the ESP32 re-sends the light with every fan command — so each hob fan
// command below is written as ir(level, true), which is what the ESP32 sends.
console.log('\n23. HA off mid-cook: the next fan command brings the floor back');
reset(); load();
ir(0, true); ticks(20); check('cooking at the light floor', out(), 25);
ha(false); ticks(12); check('HA off', out(), 0);
ir(0, true); ticks(1);  check('manual mode: fan_off + light, floor back', out(), 25);
ir(0, false); ticks(1); check('+120s light_off ends the after-run', out(), 0);
reset(); load();
ir(0, true); ticks(20); ha(false); ticks(12);
ir(1, true); ticks(1);  check('auto mode: run-on fan_1 + light', out(), 40);
ir(0, true); ticks(1);  check('fan_off: the floor carries it', out(), 25);
ir(0, false); ticks(1); check('light_off ends it', out(), 0);

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
