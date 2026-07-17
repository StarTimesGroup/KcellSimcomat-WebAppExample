# SIMCOMAT Kiosk Web Portal

> **Live Demo → [startimesgroup.github.io/KcellSimcomat-WebAppExample](https://startimesgroup.github.io/KcellSimcomat-WebAppExample/)**

Frontend portal for the SIMCOMAT SIM card vending machine.  
Runs inside an Android `WebView` that exposes a native USB-serial bridge.  
In a regular browser the UI loads in preview mode — no hardware required.

---

## File Structure

```
app_web/
├── bridge.js        # Layer 1 — Android ↔ JS plumbing (KioskBridge API)
├── MtkF31.js        # Layer 2 — MTK-F31 serial protocol (pure JS, no globals)
├── index.html       # Layer 3 — UI + app glue (~80 lines of script)
├── logo.svg
└── tailwind.min.css # Offline fallback for older WebViews
```

### Layer responsibilities

| File | Owns | Knows nothing about |
|---|---|---|
| `bridge.js` | `AndroidBridge` bootstrap, `SerialPortConnection`, `KioskBridge` API | MTK protocol, UI, jQuery |
| `MtkF31.js` | Packet framing, BCC checksum, `dispense()`, `readIccid()`, `autoDetectPort()` | Android, DOM, `window.*` |
| `index.html` | UI layout, log helper, port dropdown, button wiring | Serial framing, hex encoding |

---

## Quick Start

```bash
# Serve locally (no build step)
cd app_web/
python3 -m http.server 8000
# Open http://localhost:8000
```

The bridge falls back gracefully when `AndroidBridge` is absent — the UI runs in **Preview mode** with a grey status badge.

---

## KioskBridge API (`bridge.js`)

Consumed by `index.html`. Hides all Android plumbing.

```js
KioskBridge.isAvailable()           // → bool
KioskBridge.signalReady()           // calls AndroidBridge.inited()
KioskBridge.listPorts()             // → Array<{ id, name }>
KioskBridge.openPort(id, { onLog }) // → SerialPortConnection
```

---

## MtkF31Controller API (`MtkF31.js`)

Accepts any object with `.clearBuffer()`, `.publish(hex)`, `.readPacket(ms, fn)`.

```js
const conn = KioskBridge.openPort(portId, { onLog });
const ctrl = MtkF31Controller(conn, { onLog, onStatus });

await ctrl.dispense();           // Reset → Move to IC → Eject
const iccid = await ctrl.readIccid(); // Returns 20-digit ICCID string
```

**Auto-detect port:**
```js
const portId = await MtkF31Controller.autoDetectPort(
  KioskBridge.listPorts(),
  KioskBridge.openPort,  // injected — no window.* coupling
  onLog
);
```

---

## Dispense Sequence

```
Reset → wait 500ms → Move to IC → wait 500ms → Eject
```

## ICCID Read Sequence

```
Reset → Move to IC → Cold Reset (ATR) → Select MF → Select EF 2FE2 → Read Binary → nibble-swap decode
```

Card stays in the reader after `readIccid()`. Caller ejects or rejects based on the returned value.

---

## MTK-F31 Frame Format (9600 8N1)

| Field | Size | Value |
|---|---|---|
| STX | 1 B | `0xF2` |
| ADDR | 1 B | `0x00` (primary dispenser) |
| LEN_H / LEN_L | 2 B | payload length |
| CMT | 1 B | `0x43` cmd · `0x50` OK · `0x4E` err |
| CM / PM | 2 B | command + parameter |
| DATA | 0–n B | optional APDU |
| ETX | 1 B | `0x03` |
| BCC | 1 B | XOR checksum of all preceding bytes |

---

## Android Config (`/sdcard/simcomat.properties`)

```properties
webviewOnStart=1
webviewTimeout=10
webviewURL=https://startimesgroup.github.io/KcellSimcomat-WebAppExample/
portDispenser=        # empty = auto-detect
```

Set via ADB:
```bash
adb connect 192.168.68.68:5555
adb shell "printf 'webviewOnStart=1\nwebviewTimeout=10\nwebviewURL=https://startimesgroup.github.io/KcellSimcomat-WebAppExample/\nportDispenser=\n' > /sdcard/simcomat.properties"
```

---

## Debug

```bash
# Native WebView logs
adb logcat -v time SIMCOMAT_WebViewActivity:D *:W

# Mock port — always available in the Android app
# Select "Virtual Mock Dispenser (COM1)" to test without hardware
```
