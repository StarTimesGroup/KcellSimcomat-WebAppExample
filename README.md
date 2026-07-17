# SIMCOMAT Kiosk Web Portal — Frontend Developer Guide

This directory contains the **web frontend** for the SIMCOMAT SIM card vending machine. The HTML/JS runs inside an Android `WebView` which exposes a native **KIOSK bridge API** for communicating with USB serial hardware (the MTK-F31 card dispenser).

## Quick Start

```bash
# Serve locally (Python 3)
cd app_web/
python3 -m http.server 8000

# The Android emulator WebView loads from:
# http://10.0.2.2:8000/index.html
```

> **Note:** The Android emulator maps `10.0.2.2` → host machine `localhost`.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Android WebView (WebViewActivity.java)              │
│  ┌────────────────────────────────────────────────┐  │
│  │  Your Frontend (index.html / Vue / React)      │  │
│  │                                                │  │
│  │  window.KIOSK ← JS Bridge ← AndroidBridge     │  │
│  └────────────────────────────────────────────────┘  │
│                        ↕                             │
│  UsbSerialManager.java  ←→  USB Serial Hardware     │
│                              (MTK-F31 Dispenser)     │
└──────────────────────────────────────────────────────┘
```

---

## KIOSK Bridge API Reference

The native Android app injects `window.KIOSK` into the WebView. All serial communication goes through this bridge.

### `KIOSK.inited()`

**Must be called** once your app has fully loaded. Signals the Android host that the WebView is ready. If not called within the configured timeout (default 10s), the host shows a "Connection Timeout" dialog.

```js
// Call this in your app's mount/ready lifecycle hook
window.KIOSK.inited();
```

### `KIOSK.serial.list() → Array<{id: string, name: string}>`

Returns a list of available serial ports discovered by the Android USB host.

```js
const ports = window.KIOSK.serial.list();
// Example output:
// [
//   { id: "1001_0", name: "Device ID:1001 [PID:6001/VID:0403] Port 0" },
//   { id: "MOCK_PORT_1", name: "Virtual Mock Dispenser (COM1)" }
// ]
```

### `KIOSK.serial(portId).subscribe(callback)`

Subscribe to incoming data from a serial port. The callback receives hex-encoded payloads.

```js
KIOSK.serial("1001_0").subscribe(function(event) {
    console.log("Port:", event.id);
    console.log("Data (hex):", event.payload);
});
```

### `KIOSK.serial(portId).publish(hexString)`

Send hex-encoded data to a serial port.

```js
KIOSK.serial("1001_0").publish("F20000034330310332");
```

---

## File Structure

```
app_web/
├── index.html         # Main kiosk UI (current vanilla JS + jQuery implementation)
├── MtkF31.js          # MTK-F31 dispenser protocol controller (reusable library)
├── logo.svg           # Activ brand logo
├── tailwind.min.css   # Tailwind CSS v2 fallback (for offline/old WebViews)
└── README.md          # This file
```

---

## Core JS Libraries

### `SerialPortConnection` (defined in `index.html`)

A generic wrapper around the KIOSK serial bridge that provides:

| Method | Description |
|---|---|
| `new SerialPortConnection(portId, options)` | Opens a connection and auto-subscribes |
| `.publish(hex)` | Send hex data to the port |
| `.onData(callback)` | Register a listener for incoming data |
| `.readPacket(timeoutMs, validator)` | Await a complete packet with timeout |
| `.clearBuffer()` | Clear the internal receive buffer |
| `.close()` | Unsubscribe and clean up listeners |

**Options:**
- `onLog(msg)` — logging callback
- `onIncoming(hex) → hex` — transform/filter incoming data before buffering

### `MtkF31Controller` (defined in `MtkF31.js`)

High-level controller for the MTK-F31 card dispenser protocol.

```js
// Create controller
const controller = MtkF31Controller(connection, {
    onLog: (msg, type) => console.log(msg),
    onStatus: (title, subtitle) => updateUI(title, subtitle)
});

// Dispense a SIM card (full sequence: Reset → Feed → Eject)
await controller.dispense();
```

**Static method:**
```js
// Auto-detect which port has the dispenser connected
const portId = await MtkF31Controller.autoDetectPort(ports, logFn);
```

---

## Integrating with Vue.js / React

You can replace `index.html` with your own framework-based app. The only requirements are:

### 1. Include the KIOSK bridge bootstrap (copy from `index.html`)

This `<script>` block must run **synchronously before your app mounts** to define `window.KIOSK`:

```html
<script>
    if (window.AndroidBridge && !window.KIOSK) {
        var subscribers = {};
        window.KIOSK = {
            inited: function() { AndroidBridge.inited(); },
            serial: function(id) {
                return {
                    publish: function(data) {
                        var payload = "";
                        if (data && typeof data === 'object') {
                            payload = data.payload || "";
                        } else if (typeof data === 'string') {
                            payload = data;
                        }
                        AndroidBridge.publish(id, payload);
                    },
                    subscribe: function(callback) {
                        subscribers[id] = callback;
                        AndroidBridge.subscribe(id);
                    }
                };
            }
        };
        window.KIOSK.serial.list = function() {
            var listJson = AndroidBridge.list();
            return JSON.parse(listJson);
        };
        window.__KIOSK_dispatch = function(id, payload) {
            if (subscribers[id]) {
                try { subscribers[id]({ id: id, payload: payload }); }
                catch (e) { console.error("Error in KIOSK callback: " + e); }
            }
        };
    }
</script>
```

### 2. Call `KIOSK.inited()` after your app mounts

```js
// Vue 3
onMounted(() => {
    if (window.KIOSK) window.KIOSK.inited();
});

// React
useEffect(() => {
    if (window.KIOSK) window.KIOSK.inited();
}, []);
```

### 3. Include `MtkF31.js` and `SerialPortConnection`

You can either:
- Include them as `<script>` tags before your app bundle
- Copy the classes into your project as ES modules

### 4. Use the dispenser

```js
import { ref } from 'vue'; // or React useState

const status = ref('Idle');

async function dispenseSIM() {
    const ports = window.KIOSK.serial.list();
    
    const connection = new SerialPortConnection(ports[0].id, {
        onLog: console.log,
        onIncoming: (hex) => hex === "06" ? "" : hex  // Strip ACK frames
    });

    const controller = MtkF31Controller(connection, {
        onLog: console.log,
        onStatus: (title, sub) => { status.value = title; }
    });

    try {
        await controller.dispense();
        status.value = 'Success!';
    } catch (e) {
        status.value = 'Error: ' + e.message;
    }
}
```

---

## MTK-F31 Protocol Summary

The dispenser uses a binary serial protocol at **9600 baud, 8N1**:

| Frame Field | Bytes | Description |
|---|---|---|
| STX | 1 | Start of frame: `0xF2` |
| ADDR | 1 | Device address (usually `0x00`) |
| LEN_H | 1 | Text length high byte |
| LEN_L | 1 | Text length low byte |
| CMT | 1 | Command type: `0x43` (cmd), `0x50` (positive), `0x4E` (negative) |
| CM | 1 | Command code |
| PM | 1 | Parameter code |
| DATA | 0..n | Optional data bytes |
| ETX | 1 | End of frame: `0x03` |
| BCC | 1 | XOR checksum of all preceding bytes |

**Command Codes:**

| Command | CM | PM | Description |
|---|---|---|---|
| Reset | `0x30` | `0x31` | Initialize/reset the dispenser |
| Status | `0x31` | `0x30` | Query dispenser status |
| Move to IC | `0x32` | `0x31` | Feed card from hopper to reader |
| Eject | `0x32` | `0x30` | Eject card to customer bezel |

**Dispense Sequence:** `Reset` → wait 500ms → `Move to IC` → wait 500ms → `Eject`

---

## Development Tips

- **Mock Port:** The Android app always adds a `MOCK_PORT_1` virtual port that simulates dispenser responses (400ms delay). Use this for UI development without hardware.
- **Tailwind CSS:** Uses Tailwind v4 Browser CDN (`@tailwindcss/browser@4`). Brand colors are defined via `@theme` in a `<style type="text/tailwindcss">` block.
- **WebView Config:** `webviewURL` in `simcomat.properties` controls which URL the WebView loads (default: `http://10.0.2.2:8000/index.html`).
- **Console Logs:** Use `adb logcat -v time SIMCOMAT_WebViewActivity:D *:W` to see native-side logs.
- **Browser Preview:** Open `index.html` in Chrome — the KIOSK API won't be available, but UI development works. The JS gracefully falls back with a "KIOSK API not detected" warning.

---

## Config File (`simcomat.properties`)

Located on the Android device at `/sdcard/simcomat.properties`:

```properties
webviewOnStart=1          # Auto-launch WebView on app start
webviewTimeout=10         # Seconds before showing timeout dialog
webviewURL=http://10.0.2.2:8000/index.html
portDispenser=            # Empty = auto-detect, or a specific port ID
```
