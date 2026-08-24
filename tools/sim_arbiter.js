// sim_arbiter.js — run shelly/arbiter.js under node with the Shelly runtime
// stubbed, and assert its behaviour.
//
//   node tools/sim_arbiter.js        (from the repo root)
//
// WHAT THIS IS: the real arbiter source, loaded and executed, with
// Shelly.getComponentStatus / Shelly.call / Timer.set / print replaced by
// stubs over a mock device. It exercises the actual control flow, not a
// paraphrase of it, and it runs a 300 s handback in a few milliseconds.
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

function reset(initial) {
  dev = Object.assign({
    'voltmeter:100': { voltage: 0.0 },
    'number:200': { value: 0 },      // ir_level
    'boolean:200': { value: false }, // ir_light
    'number:201': { value: 0 },      // ir_seq
    'number:202': { value: 0 },
    'text:200':   { value: '' },
    light: { on: false, brightness: 0 },
  }, initial || {});
  logs = []; calls = [];
}

const Shelly = {
  getComponentStatus: (k) => (k in dev ? dev[k] : null),
  call: (m, p, cb) => {
    calls.push({ m, p });
    if (m === 'Light.Set') { dev.light.on = !!p.on; if (p.brightness !== undefined) dev.light.brightness = p.brightness; }
    if (m === 'Text.Set') dev['text:200'].value = p.value;
    if (m === 'Number.Set') dev['number:' + p.id].value = p.value;
    if (cb) cb(null, 0, '', '');
  },
};
const Timer = { set: (ms, rep, fn) => { tickFn = fn; } };
const print = (s) => logs.push(s);

function load() {
  new Function('Shelly', 'Timer', 'print', src)(Shelly, Timer, print);
}
const out = () => (dev.light.on ? dev.light.brightness : 0);
const actor = () => dev['text:200'].value;
function ticks(n) { for (let i = 0; i < n; i++) tickFn(); }
function knob(v) { dev['voltmeter:100'].voltage = v; }
function ir(level, lit) { dev['number:200'].value = level; dev['boolean:200'].value = lit; }
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

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
