// arbiter.js — the single writer to the 0-10 V output.
//
// Runs on a Shelly Dimmer 0/1-10 V PM Gen3. Arbitrates
// between two edge-triggered sources and drives light:0, whose brightness IS
// the 0-10 V setpoint and whose on/off drives relay O and therefore the hood
// lamp.
//
//   IR   — the ESP32 writes `ir_level` (0-4) into number:200 and the hob's
//          light state into boolean:200, over LAN RPC, and bumps number:201
//          every 30 s as a liveness beat.
//   KNOB — the 10 k slider, read as volts on voltmeter:100 (Shelly Plus
//          Add-on, addon_type "sensor").
//
// NOTHING ELSE MAY WRITE light:0. Not HA, not a schedule, not a webhook, not
// a second script. Two writers fight, and the symptom is intermittent and
// miserable to diagnose. If something needs to influence the output, it
// proposes here.
//
// Something will anyway — HA's light entity is one click away — so the output
// is read back, and a write this script did not make is handled as an actor
// of its own instead of silently leaving S.out wrong. See EXTERNAL WRITES.
//
// Provisioning (virtual components, upload, start) is in shelly/README.md.
//
// ---------------------------------------------------------------------------
// mJS, NOT JavaScript. The Shelly runtime is Cesanta mJS:
//   * no const, no template literals, no for...of, no try/catch
//   * no Array.map/filter/forEach, no String.padStart
//   * arrays do NOT reliably grow — LEVEL_PCT is a literal and only indexed
//   * numbers do not auto-coerce in string concatenation; use JSON.stringify
//   * Math.* is present but thin — abs/round are reimplemented below rather
//     than trusted, because a missing builtin fails at RUNTIME, not at upload
//   * every Shelly.call is ASYNCHRONOUS; nothing here may assume ordering
// Keep it small. RAM is ~140 kB free with nothing else running.
// ---------------------------------------------------------------------------

// ===========================================================================
// TUNABLES
// ===========================================================================

let CFG = {

  // -- LEVEL -> OUTPUT PERCENT ------------------------------------------
  //
  // Index is the IR fan level: [off, 1, 2, 3, intensive].
  LEVEL_PCT: [0, 40, 60, 80, 100],

  // -- LIGHT AS A FAN FLOOR ----------------------------------------------
  //
  // The hob's `light on` now means "extract at least this much". Combined
  // with LEVEL_PCT the achievable ladder is 0 / 25 / 40 / 60 / 80 / 100.
  //
  // *** FLOOR, NOT ASSIGNMENT — and the difference is measured, not stylistic.
  //
  // `light off` fires ~120 s after the hob is deactivated. This can land 
  // BEFORE `fan off`. The hob's own run-on is still commanding `fan 1`
  // at that moment. If `light off` ASSIGNED 0 % it would cut the run-on short, 
  // while the hob still requests extraction.
  //
  // As a floor, `light off` merely withdraws the 25 % minimum. During run-on
  // LEVEL_PCT[1] = 40 % still governs and the hood keeps pulling until `fan off`
  // actually arrives, which is the whole point of the run-on.
  //
  // To get literal assignment instead, set LIGHT_IS_FLOOR false.
  LIGHT_PCT: 25,
  LIGHT_IS_FLOOR: true,

  // -- IR HANDBACK TIMER -------------------------------------------------
  //
  // The ONLY timer in the system, and it is armed by the HOB, not by the knob.
  //
  // Armed on `light off`. That is the one command that unambiguously means
  // "the hob finished". `fan off` can mean at least three different
  // reasons: end of run-on, at deactivation, and as a manual step-down to 0
  // with the hob still cooking. Reactivation
  // cancels the hob's own pending light timer.
  //
  // On expiry the output does NOT go to zero. It falls to whatever the IR
  // codes last commanded — see the handback in tick(). THAT is what makes the
  // run-on length irrelevant: if `fan off` already arrived during the window
  // the hood stops; if the hob is still running on at `fan 1` the hood keeps
  // extracting and stops when `fan off` actually lands, however late that is.
  //
  // So 300 s is a COMFORT setting, not a measured bound. It answers exactly
  // one question — how long should a knob override outlive the end of
  // cooking?
  //
  // Knob movement during the window does NOT extend or restart it. 
  // The knob still changes the output; it just cannot defer the shutdown.
  HANDBACK_S: 300,

  // -- IR STALENESS ------------------------------------------------------
  // If ir_seq stops advancing for this long the ESP32 is gone (dead, off the
  // network, reflashing). Fall back to the knob: it is a state a human can
  // see and change, which a decay-to-zero is not.
  STALE_S: 1800,

  // -- KNOB MOVEMENT DETECTION -------------------------------------------
  //
  // ABSOLUTE VALUE, not rate of change.
  //
  // The knob has moved when its reading differs from the position last acted
  // on by more than this. That is a plain deadband.
  // That failure is now RECOVERABLE and obvious rather
  // than silent and permanent: wind the knob to zero and control returns to
  // IR instantly (KNOB_RELEASE_PCT below), and `last_actor` reads "knob" the
  // whole time.
  //
  // The dangerous case is drift AFTER a handback, not before it: the knob is
  // parked off-zero, the hood has just been shut down correctly, and 3 % of
  // drift would re-arm manual with no `light off` left to arm another
  // handback — so it would run until morning. S.latched exists for exactly
  // that, and it is why this deadband can stay a plain magnitude test.
  //
  // Sits above the voltmeter's 0.1 V report threshold (~1 % of span) so
  // quantisation alone cannot trip it.
  MOVE_PCT: 3,

  // -- KNOB RELEASE -------------------------------------------------------
  // Winding the slider fully down does two jobs, and which one fires depends
  // on the state it finds:
  //
  //   * a LIVE override is released — control returns to the hob at once,
  //     applying whatever the IR codes currently ask for;
  //   * a LATCHED knob is made live again, without changing the output.
  //
  // One gesture, and it is physical and discoverable in a way that waiting out
  // HANDBACK_S is not. It is also the only way out of a latch.
  //
  // Tested as a POSITION, not as a movement: the knob being AT zero releases,
  // regardless of how it got there. A release that required a detected
  // movement would depend on the deadband, and the whole point of this gesture
  // is that it works when the deadband logic has gone wrong.
  //
  // Above the 0.1 V voltmeter quantisation (~1 % of span) so it is reachable,
  // and it survives changes to the divider: that scales the
  // bottom of travel to 0 % too, and KNOB_FAULT_V would catch a broken wiper
  // before this ever sees it.
  KNOB_RELEASE_PCT: 2,

  // -- KNOB SCALING ------------------------------------------------------
  //
  // KNOB_FAULT_V is used if a bottom resistor is fitted: below it means a
  // broken wiper or a short, NOT "knob at zero", and the correct response is
  // to ignore the knob and run IR-only rather than slam the fan off. With no
  // bottom resistor there is no floor to test against, so 0 disables the
  // check and an open wiper reads as a deliberate zero. 
  // If a bottom resistor is fitted, KNOB_MIN_V must change.
  // 
  KNOB_MIN_V: 0.0,
  KNOB_MAX_V: 10.0,
  KNOB_FAULT_V: 0.0,

  // -- POLL ---------------------------------------------------------------
  // Everything is polled; no status handlers. getComponentStatus is a local
  // memory read, and polling does not depend on whether virtual components
  // emit status deltas — which is undocumented, and would be a silent
  // single-point failure for the entire IR path if it ever changed.
  //
  // Costs up to one tick of knob latency. Acceptable: light:0 fades over
  // transition_duration (3 s), so the tick is not the slow part.
  TICK_MS: 500,

  // -- EXTERNAL WRITES ----------------------------------------------------
  // How far light:0 may sit from what was last commanded before it counts as
  // someone else's write. Tested only once our own write has had time to
  // show: the channel's transition_duration (read at start) plus EXT_SETTLE_S.
  EXT_TOL_PCT: 2,
  EXT_SETTLE_S: 2,

  // -- COMPONENT IDS ------------------------------------------------------
  ID_IR_LEVEL: "number:200",
  ID_IR_LIGHT: "boolean:200",
  ID_IR_SEQ: "number:201",
  // The same two as numeric ids, for the one write made to them here: the
  // IR reset when the output is switched off from outside.
  ID_IR_LEVEL_N: 200,
  ID_IR_LIGHT_N: 200,
  ID_MANUAL: 202,          // number:202 — knob position, published for HA
  // text:200 — who last moved the output, and why it is where it is.
  //   boot | ir | knob | ext | stale, with "+latched" on ir and ext
  // "ir+latched" is the one that matters: IR owns the output AND the knob is
  // inert until wound to zero. Without it, a latched knob is a physical
  // control that does nothing, with no way to tell why. 
  // Kept under text:200's 16-char max_len. The ESP32 reads "stale" back after
  // its own reboot (boot_sync in hob2hood.yaml), so that word is an interface.
  ID_ACTOR: 200,
  ID_VOLTMETER: "voltmeter:100",
  LIGHT_ID: 0,

  DEBUG: true
};

// ===========================================================================
// DERIVED
// ===========================================================================

let TPS = 1000 / CFG.TICK_MS;                  // ticks per second
let HANDBACK_TICKS = CFG.HANDBACK_S * TPS;
let STALE_TICKS = CFG.STALE_S * TPS;
let LIGHT_KEY = "light:" + JSON.stringify(CFG.LIGHT_ID);
let SETTLE_TICKS = 0;                          // set in start(), from the fade

// ===========================================================================
// STATE
// ===========================================================================

let S = {
  out: -1,          // last commanded brightness %, -1 = nothing sent yet
  level: -1,        // last applied IR level, -1 = output is manual
  irSeen: -1,       // last ir_level value observed (edge detection)
  litSeen: -1,      // last ir_light value observed, as 0/1/-1-for-unknown
  seqSeen: -1,      // last ir_seq value observed (liveness)
  silent: 0,        // ticks since ir_seq last advanced
  handback: 0,      // ticks until a knob override is handed back to IR
  settle: 0,        // ticks before light:0 is next compared with S.out
  resetting: 0,     // ticks IR edges wait for the IR reset writes to land
  actor: "",        // the published label's base, without "+latched"
  actorPub: "",
  knobPct: 0,
  // Knob position last acted on. -1 = not yet seeded; the first tick adopts
  // whatever the knob reads so a knob already parked at 50 % does not seize
  // control at boot. Boot presents silence and lets the sources raise it.
  knobRef: -1,
  manualPub: -1,
  stale: false,
  manual: false,    // the knob currently owns the output
  // Knob inert until it reads <= KNOB_RELEASE_PCT. Set when the handback timer
  // takes control away from the knob; see the handback block for why.
  latched: false,
  warned: false
};

// ===========================================================================
// HELPERS
// ===========================================================================

function abs(x) { return x < 0 ? -x : x; }

function rnd(x) {
  if (x < 0) x = 0;
  let i = x | 0;
  return (x - i >= 0.5) ? i + 1 : i;
}

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

function num(x) { return JSON.stringify(x); }

function log(m) { if (CFG.DEBUG) print("[arb] " + m); }

// Fire-and-forget RPC. Errors are logged, never retried: every writer here is
// re-driven by the next tick anyway, so a retry queue would only add a second
// source of stale writes.
function rpc(method, params, what) {
  Shelly.call(method, params, function (r, ec, em, ud) {
    if (ec !== 0) log("RPC FAIL " + ud + " ec=" + num(ec) + " " + (em ? em : ""));
  }, what);
}

function statusOf(key) {
  let st = Shelly.getComponentStatus(key);
  return (st === null || st === undefined) ? null : st;
}

// ===========================================================================
// OUTPUT — the only place light:0 is written
// ===========================================================================

function setOutput(pct) {
  pct = rnd(clamp(pct, 0, 100));
  if (pct === S.out) return;          // never re-send an unchanged setpoint
  S.out = pct;
  S.settle = SETTLE_TICKS;            // our own fade is not someone else's write

  if (pct <= 0) {
    // Explicit off, not brightness 0: the relay (and therefore the hood lamp)
    // follows the channel's on/off, not its level.
    Shelly.call("Light.Set", { id: CFG.LIGHT_ID, on: false }, outDone, "off");
  } else {
    Shelly.call("Light.Set", { id: CFG.LIGHT_ID, on: true, brightness: pct }, outDone,
                "set " + num(pct));
  }
  log("output -> " + num(pct) + "%");
}

// A failed write leaves S.out describing an output that never happened. -1
// has the read-back re-learn it, rather than take our own failure for
// someone else's write.
function outDone(r, ec, em, ud) {
  if (ec === 0) return;
  log("RPC FAIL " + ud + " ec=" + num(ec) + " " + (em ? em : ""));
  S.out = -1;
}

// The hob's two independent channels combined into one setpoint.
// `lit` is the light channel, `lvl` the fan channel; neither implies the other.
function irPercent(lvl, lit) {
  // rnd before indexing: the value arrives from a virtual number, so it is a
  // double. No mJS array indexing with a non-integer.
  lvl = rnd(clamp(lvl, 0, 4));
  let fanPct = CFG.LEVEL_PCT[lvl];

  if (!CFG.LIGHT_IS_FLOOR) return lit ? (fanPct > 0 ? fanPct : CFG.LIGHT_PCT) : 0;

  let floorPct = lit ? CFG.LIGHT_PCT : 0;
  return fanPct > floorPct ? fanPct : floorPct;
}

// The label carries the latch. A latched knob is a physical control that
// does nothing, and it WILL be reported as "the slider is broken" unless the
// reason is published somewhere a human can read. Not on "stale", which
// ignores the latch by design; a latched knob never owns the output, so it
// lands on "ir" or "ext".
function setActor(a) {
  S.actor = a;
  let label = (S.latched && a !== "stale") ? a + "+latched" : a;
  if (label === S.actorPub) return;
  S.actorPub = label;
  rpc("Text.Set", { id: CFG.ID_ACTOR, value: label }, "actor");
  log("actor -> " + label);
}

// ===========================================================================
// EXTERNAL WRITES
// ===========================================================================
//
// light:0 is written only here by design, but nothing enforces it: HA's
// light entity, the Shelly app and the web UI all reach it directly. Missed,
// such a write leaves S.out describing an output that no longer exists.
// Seen 2026-09-23: offs missed, the hood switched off from HA, and the hob's
// next `light on` then went nowhere — true onto a stale true is no IR edge,
// and a 40 % equal to the stale S.out is swallowed by setOutput(). Only
// stepping the hob to a new level got the hood back.
//
// So tick() reads the output back once our own fade has settled, and a
// difference is an actor of its own, "ext":
//
//   * Switched OFF: off until the hob next speaks. The IR state goes to idle,
//     and so do number:200 / boolean:200, so that the hob's next word is a
//     change here — above all a `light on` after a missed `light off`, which
//     would otherwise land true onto true and be lost again. The light floor
//     is not lost with it: the ESP32 re-sends the light with every fan
//     command, so mid-cook the hob's next one (the run-on's fan 1, a manual
//     fan off) brings 25 % back, after-run and all. A floor that was only
//     stale stays gone once the hob falls silent. An override ends, the
//     handback is cancelled, and a knob parked off zero is latched, for the
//     same reason the handback latches it: drift must not bring the hood back.
//   * Switched ON, or set to a new level: adopted as the output. Ownership
//     does not move; the next IR edge (if IR owns) or knob movement takes it
//     back, as last-actor-wins would.
function externalWrite(seen, knob) {
  S.settle = SETTLE_TICKS;             // let an external fade finish too
  S.out = seen;
  if (seen > 0) {
    setActor("ext");
    log("output set externally to " + num(seen) + "%");
    return;
  }
  S.manual = false;
  S.handback = 0;
  if (knob > CFG.KNOB_RELEASE_PCT) S.latched = true;
  resetIr();
  setActor("ext");
  log("output switched off externally — IR reset to idle" +
      (S.latched ? "; knob LATCHED, wind it to zero to use it again" : ""));
}

// Idle the IR model AND the components it is read from. The writes are
// asynchronous, and until they land the old values are still there to be
// read: IR edges hold off for S.resetting ticks, or that old state would come
// straight back as a fresh command. 2 s against writes that take milliseconds.
function resetIr() {
  S.irSeen = 0;
  S.litSeen = 0;
  S.level = 0;
  S.resetting = 2 * TPS;
  rpc("Number.Set", { id: CFG.ID_IR_LEVEL_N, value: 0 }, "reset ir_level");
  rpc("Boolean.Set", { id: CFG.ID_IR_LIGHT_N, value: false }, "reset ir_light");
}

// ===========================================================================
// KNOB
// ===========================================================================

function vToPct(v) {
  let span = CFG.KNOB_MAX_V - CFG.KNOB_MIN_V;
  if (span <= 0) return 0;
  return clamp((v - CFG.KNOB_MIN_V) / span * 100, 0, 100);
}

// ===========================================================================
// TICK
// ===========================================================================

function tick() {

  // ---- read everything up front -----------------------------------------
  let vm = statusOf(CFG.ID_VOLTMETER);
  let v = (vm === null) ? -1 : vm.voltage;

  // A missing voltmeter is an unplugged Add-on. Treated exactly like a wiper
  // fault: ignore the knob. Never infer zero from a missing reading.
  let faulted = (v < 0) || (CFG.KNOB_FAULT_V > 0 && v < CFG.KNOB_FAULT_V);

  let pct = faulted ? S.knobPct : vToPct(v);
  if (!faulted) {
    S.knobPct = pct;
    // Seed on the first good reading so a knob already parked off-zero does
    // not read as a 0 -> N movement and seize the output at boot.
    if (S.knobRef < 0) S.knobRef = pct;
  }

  let irSt = statusOf(CFG.ID_IR_LEVEL);
  let litSt = statusOf(CFG.ID_IR_LIGHT);
  let seqSt = statusOf(CFG.ID_IR_SEQ);
  let ir = (irSt === null) ? -1 : irSt.value;
  let lit = (litSt === null) ? -1 : (litSt.value ? 1 : 0);
  let seq = (seqSt === null) ? -1 : seqSt.value;

  if (!S.warned && (irSt === null || litSt === null || seqSt === null)) {
    S.warned = true;
    log("WARNING: " + CFG.ID_IR_LEVEL + " / " + CFG.ID_IR_LIGHT + " / " +
        CFG.ID_IR_SEQ +
        " missing — virtual components not provisioned? See shelly/README.md");
  }

  // ---- liveness ----------------------------------------------------------
  if (seq >= 0 && seq !== S.seqSeen) {
    S.seqSeen = seq;
    S.silent = 0;
    if (S.stale) { S.stale = false; log("ir link recovered"); }
  } else {
    S.silent = S.silent + 1;
    if (!S.stale && S.silent > STALE_TICKS) {
      S.stale = true;
      log("ir link STALE — falling back to knob");
    }
  }

  // ---- handback countdown ------------------------------------------------
  // Before the source handlers, so a timer armed this tick gets its full
  // duration rather than being decremented on the same pass.
  if (S.handback > 0) {
    S.handback = S.handback - 1;
    if (S.handback === 0 && S.manual) {
      // Fall to what the HOB last asked for. Not a forced zero — that is the
      // whole design. If `fan off` arrived during the window this is 0 and the
      // hood stops; if the hob is still running on at `fan 1` this is
      // LEVEL_PCT[1] and the hood keeps extracting until `fan off` lands. The
      // run-on can be any length and this stays correct.
      let hb = irPercent(S.irSeen < 0 ? 0 : S.irSeen, S.litSeen === 1);
      S.manual = false;
      S.level = S.irSeen;

      // LATCH. The knob is still physically where the hand left it, and
      // MOVE_PCT is 3 % against an Add-on specified at +/-5 % absolute. Without
      // this, ordinary drift re-arms manual minutes later and the hood comes
      // back on by itself — with the `light off` already consumed, so nothing
      // is left to arm another handback and it runs until morning. Inert until
      // wound to zero, which drift cannot fake.
      S.latched = true;

      setOutput(hb);
      setActor("ir");
      log("handback — released to IR at " + num(hb) + "%; knob LATCHED, wind " +
          "it to zero to use it again");
    }
    // Expiring while IR already owns the output is a no-op by construction:
    // there is no override to end, so nothing is latched.
  }

  // ---- external writes ---------------------------------------------------
  // Before the sources, so the hob and the knob still get the last word.
  // Not while stale: that branch writes the knob position whenever it differs
  // from S.out, so adopting a foreign write there would get it overwritten on
  // the spot. Left alone, it stands until the knob moves, as before.
  if (S.settle > 0) {
    S.settle = S.settle - 1;
  } else if (!S.stale) {
    let lt = statusOf(LIGHT_KEY);
    if (lt !== null) {
      let seen = lt.output ? rnd(lt.brightness) : 0;
      if (S.out < 0) {
        S.out = seen;                    // after our own failed write: re-learn
      } else if (abs(seen - S.out) > CFG.EXT_TOL_PCT) {
        // A tick of its own. The reset alone is three RPCs, and the Shelly
        // caps the calls a script may have unfinished (5).
        externalWrite(seen, faulted ? -1 : pct);
        return;
      }
    }
  }

  // ---- IR edge -----------------------------------------------------------
  // Edge, not level: the heartbeat deliberately does not rewrite ir_level, so
  // any change here is a genuine new command from the hob. On the first tick
  // after a Shelly reboot irSeen is -1, so a persisted ir_level is adopted —
  // that is wanted. It is the ESP32's current truth. After a power cut it is
  // not, and the ESP32 corrects it: booting to find ir_seq still 0 here, it
  // pushes fan off / light off, so the cut still ends at level 0.
  // EITHER channel changing is an IR edge. They are independent on the hob and
  // interleave frame-by-frame, so watching only the fan channel would miss
  // `light on` entirely — and `light on` is what starts extraction at 25 %.
  // Both hold off while an IR reset's writes land (EXTERNAL WRITES).
  if (S.resetting > 0) S.resetting = S.resetting - 1;
  let irMoved = S.resetting === 0 &&
                ((ir >= 0 && ir !== S.irSeen) || (lit >= 0 && lit !== S.litSeen));

  // `light off` is a 1 -> 0 transition, tested BEFORE litSeen is overwritten.
  // Deliberately not (litSeen < 0 && lit === 0): at boot litSeen is -1, and a
  // hob that is simply off must not arm anything.
  let lightWentOff = S.resetting === 0 && lit === 0 && S.litSeen === 1;

  if (irMoved) {
    if (ir >= 0) S.irSeen = ir;
    if (lit >= 0) S.litSeen = lit;
    S.level = S.irSeen;

    // The IR state model is maintained on EVERY edge no matter who owns the
    // output. That is what lets the handback fall to the hob's current truth
    // instead of to a hardcoded zero, and what lets a knob-to-zero release
    // apply something sensible the instant it happens.
    // Unknown channels contribute nothing rather than guessing: a missing
    // boolean must not be read as "light off" and drop the floor.
    if (S.manual) {
      log("ir recorded: level " + num(S.irSeen) + " light " + num(S.litSeen) +
          " — knob owns the output");
    } else {
      setOutput(irPercent(S.irSeen < 0 ? 0 : S.irSeen, S.litSeen === 1));
      setActor("ir");
    }
  }

  // Armed AFTER the edge is absorbed, so the state the handback will apply
  // already includes this `light off`. Armed whether or not the knob currently
  // owns the output: if it does not, expiry is a no-op, and arming
  // unconditionally is one branch fewer than deciding.
  if (lightWentOff) {
    S.handback = HANDBACK_TICKS;
    log("light off — handback armed, " + num(CFG.HANDBACK_S) + "s");
  }

  // ---- knob movement -----------------------------------------------------
  // Checked after IR so that within a single tick the hand wins. Last-actor-
  // wins is licensed by the measured repeat behaviour: the hob does not
  // re-assert, so IR cannot stomp a manual action except when the hob
  // genuinely changes its mind.
  if (!faulted) {
    if (pct <= CFG.KNOB_RELEASE_PCT) {
      // Zero is the one position that always means something, and neither of
      // these depends on the deadband — which is the point: the gesture has to
      // work when the deadband has gone wrong. Gated on latched / manual so a
      // knob that simply RESTS at zero does not re-fire every tick or steal
      // the actor label at boot.
      if (S.latched) {
        S.latched = false;
        S.knobRef = pct;             // next wind-up is measured from zero
        setActor(S.actor);           // same owner, minus "+latched"
        log("knob wound to zero — latch cleared, knob live again");

      } else if (S.manual) {
        // Release a live override. The handback timer is deliberately NOT
        // cleared: if the hand comes back to the knob later in the same
        // window, that new override still gets handed back on schedule.
        S.knobRef = pct;
        S.manual = false;
        S.level = S.irSeen;
        let handBack = irPercent(S.irSeen < 0 ? 0 : S.irSeen, S.litSeen === 1);
        setOutput(handBack);
        setActor("ir");
        log("knob wound to zero — released to IR at " + num(handBack) + "%");
      }

    } else if (!S.latched && abs(pct - S.knobRef) > CFG.MOVE_PCT) {
      // Absolute deadband against the position last acted on — not a rate.
      //
      // Deliberately does NOT arm or extend the handback:
      //  the only timer in the system is armed by the hob. The
      // knob can change the output; it can never defer the shutdown.
      S.knobRef = pct;               // do not re-fire on the same position
      S.manual = true;
      S.level = -1;                  // the output is no longer a level
      setOutput(pct);                // jump to absolute position, no pickup
      setActor("knob");
    }
  }

  // ---- stale fallback ----------------------------------------------------
  // Continuous, not edge-triggered: with the ESP32 gone the knob is the only
  // remaining input, so it tracks absolutely.
  //
  // Deliberately ignores the latch. A latched knob plus a dead ESP32 would
  // leave the hood with NO working input at all, stuck wherever it was. This is
  // the last-resort branch, and it is the one case where honouring the latch
  // would do real harm.
  if (S.stale && !faulted) {
    setOutput(pct);
    setActor("stale");
  }

  // ---- publish -----------------------------------------------------------
  let mp = rnd(pct);
  if (mp !== S.manualPub) {
    S.manualPub = mp;
    rpc("Number.Set", { id: CFG.ID_MANUAL, value: mp }, "manual");
  }
}

// ===========================================================================
// START
// ===========================================================================

function start() {
  // Force silence before the first tick and let the sources raise it.
  //
  // light:0 is set to initial_state "off", so a power cut will not
  // resume the fan on its own. This is still NOT redundant: a script restart --
  // Script.Stop/Start, an edit, a crash-and-restart -- does not reboot the
  // device, so initial_state never runs and the output is whatever it was.
  // Without this the arbiter would inherit a setpoint it has no record of and
  // would not correct it until the next edge.
  //
  // The settle window first, since setOutput() starts one: our own fade must
  // not read back as someone else's write, so it is the channel's configured
  // transition, not an assumed one.
  let fade = 3;
  let lc = Shelly.getComponentConfig(LIGHT_KEY);
  if (lc !== null && lc !== undefined && lc.transition_duration !== undefined) {
    fade = lc.transition_duration;
  }
  SETTLE_TICKS = rnd((fade + CFG.EXT_SETTLE_S) * TPS);

  setActor("boot");
  setOutput(0);

  Timer.set(CFG.TICK_MS, true, tick, null);

  log("started: tick=" + num(CFG.TICK_MS) + "ms handback=" + num(CFG.HANDBACK_S) +
      "s stale=" + num(CFG.STALE_S) + "s settle=" + num(SETTLE_TICKS / TPS) +
      "s levels=" + JSON.stringify(CFG.LEVEL_PCT) +
      " move=+/-" + num(CFG.MOVE_PCT) + "%" +
      " release<=" + num(CFG.KNOB_RELEASE_PCT) + "%" +
      " light=" + num(CFG.LIGHT_PCT) + "%" +
      (CFG.LIGHT_IS_FLOOR ? " (floor)" : " (ASSIGN — cuts the run-on short)"));
}

start();
