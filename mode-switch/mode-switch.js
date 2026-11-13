// Shelly 1 Gen4: button-triggered relay mode sequence
// Relay output: Switch:0
// Physical input: Input:0

let CFG = {
  switchId: 0,
  inputId: 0,
  timeoutSeconds: 10,
  longPressSeconds: 1.0,
  pulseMilliseconds: 100,
  storageKey: "lamp_state",
  virtualButtonId: 200,
  debounceMilliseconds: 250
};

let modeState = 0;
let lastStarted = 0;
let offSince = 0;

let ready = false;
let busy = false;
let buttonHeld = false;
let longPressEligible = false;
let longPressTimer = null;

function nowSeconds() {
  return Date.now() / 1000;
}

function finish() {
  busy = false;
}

let lastAcceptedTriggerAt = 0;

function acceptTrigger() {
  let now = Date.now();

  if (now - lastAcceptedTriggerAt < CFG.debounceMilliseconds) {
    console.log("Ignored rapid duplicate trigger");
    return false;
  }

  lastAcceptedTriggerAt = now;
  return true;
}


function saveState(callback) {
  Shelly.call(
    "KVS.Set",
    {
      key: CFG.storageKey,
      value: {
        modeState: modeState,
        lastStarted: lastStarted,
        offSince: offSince
      }
    },
    function (result, errorCode, errorMessage) {
      if (errorCode !== 0) {
        console.log("Could not save state:", errorMessage);
      }
      if (callback) callback();
    }
  );
}

function setRelay(on, callback) {
  Shelly.call(
    "Switch.Set",
    { id: CFG.switchId, on: on },
    function (result, errorCode, errorMessage) {
      callback(errorCode === 0, errorMessage);
    }
  );
}

// Pulse the relay off/on, then advance the mode.
function pulseAndAdvance() {
  setRelay(false, function (ok, errorMessage) {
    if (!ok) {
      console.log("Could not pulse relay off:", errorMessage);
      finish();
      return;
    }

    offSince = nowSeconds();

    Timer.set(CFG.pulseMilliseconds, false, function () {
      setRelay(true, function (onOk, onErrorMessage) {
        if (!onOk) {
          console.log("Could not turn relay back on:", onErrorMessage);
          offSince = nowSeconds();
          saveState(finish);
          return;
        }

        modeState = modeState + 1;
        lastStarted = nowSeconds();
        offSince = 0;
        saveState(finish);
      });
    });
  });
}

function handleTrigger() {
  if (!ready || busy) return false;

  let relay = Shelly.getComponentStatus("switch", CFG.switchId);
  if (!relay) {
    console.log("Could not read relay status");
    return false;
  }

  busy = true;

  // Relay is off: turn it on and start mode 1.
  if (relay.output !== true) {
    setRelay(true, function (ok, errorMessage) {
      if (!ok) {
        console.log("Could not turn relay on:", errorMessage);
        finish();
        return;
      }

      modeState = 1;
      lastStarted = nowSeconds();
      offSince = 0;
      saveState(finish);
    });
    return true;
  }

  let timedOut =
    lastStarted > 0 &&
    (nowSeconds() - lastStarted) > CFG.timeoutSeconds;

  // Turn off after the timeout, or when mode 3 is active.
  if (timedOut || modeState === 3) {
    setRelay(false, function (ok, errorMessage) {
      if (!ok) {
        console.log("Could not turn relay off:", errorMessage);
        finish();
        return;
      }

      if (!timedOut) {
        modeState = 0;
      }
      
      offSince = nowSeconds();
      // As in your original logic, lastStarted is not reset here.
      saveState(finish);
    });
    return true;
  }

  // Otherwise pulse off/on and advance the mode.
  pulseAndAdvance();
  return true;
}

function handleLongPress() {
  longPressTimer = null;

  if (!buttonHeld || !longPressEligible) return;

  // If the first relay action is still finishing, retry shortly.
  if (busy) {
    longPressTimer = Timer.set(100, false, handleLongPress);
    return;
  }

  let relay = Shelly.getComponentStatus("switch", CFG.switchId);
  if (!relay || relay.output !== true) return;

  longPressEligible = false;
  busy = true;
  pulseAndAdvance();
}

function startListening() {
  // Keep track of how long the relay has been off, including when switched
  // through another control method.
  Shelly.addStatusHandler(function (status) {
    if (
      status.component === "switch:" + CFG.switchId &&
      status.delta &&
      status.delta.output !== undefined
    ) {
      if (status.delta.output === false) {
        offSince = nowSeconds();
        saveState();
      } else {
        offSince = 0;
        saveState();
      }
    }
  });

  Shelly.addEventHandler(function (event) {
    if (event.component !== "input:" + CFG.inputId || !event.info) return;

    if (event.info.event === "btn_down") {
      if (!acceptTrigger()) return;
      buttonHeld = true;
      longPressEligible = false;

      if (longPressTimer !== null) {
        Timer.clear(longPressTimer);
        longPressTimer = null;
      }

      let relay = Shelly.getComponentStatus("switch", CFG.switchId);
      let wasOffLongEnough =
        relay &&
        relay.output !== true &&
        offSince > 0 &&
        (nowSeconds() - offSince) > CFG.timeoutSeconds;

      if (wasOffLongEnough) {
        mode = 0
      }
      if (mode == 0 && handleTrigger()) {
        longPressEligible = true;
        longPressTimer = Timer.set(
          CFG.longPressSeconds * 1000,
          false,
          handleLongPress
        );
      }
    }

    if (event.info.event === "btn_up") {
      buttonHeld = false;
      longPressEligible = false;

      if (longPressTimer !== null) {
        Timer.clear(longPressTimer);
        longPressTimer = null;
      }
    }
  });
  
  let modeSwitch = Virtual.getHandle("button:" + CFG.virtualButtonId);

  if (modeSwitch) {
    modeSwitch.on("single_push", function () {
      console.log("Mode Switch virtual button pressed");
      handleTrigger();
    });
  } else {
    console.log("Could not find the Mode Switch virtual button");
  }


  console.log("Mode-control script ready");
}

// Restore saved mode/timestamps before accepting button events.
Shelly.call("KVS.Get", { key: CFG.storageKey }, function (result, errorCode) {
  if (errorCode === 0 && result && result.value) {
    modeState = Number(result.value.modeState) || 0;
    lastStarted = Number(result.value.lastStarted) || 0;
    offSince = Number(result.value.offSince) || 0;
  } else {
    console.log("No saved state; starting with mode 0");
  }

  let relay = Shelly.getComponentStatus("switch", CFG.switchId);
  if (relay && relay.output === true) {
    offSince = 0;
  } else if (offSince === 0) {
    // If this is the first run with the new script, start measuring from now.
    offSince = nowSeconds();
  }

  ready = true;
  startListening();
  saveState();
});