# SIMCOMAT Kiosk Web Portal

> **Live Demo → [startimesgroup.github.io/KcellSimcomat-WebAppExample](https://startimesgroup.github.io/KcellSimcomat-WebAppExample/)**

Frontend portal for the SIMCOMAT SIM card vending machine.  
Runs inside an Android `WebView` that exposes a native USB-serial bridge.  
In a regular browser, the UI loads in preview mode — no hardware required.

---

## File Structure

```
app_web/
├── kiosk.js         # Core Bridge (Android ↔ JS boot + pub/sub streams)
├── mtk.js           # MTK-F31 Protocol Driver (Injects Dispenser to Bridge)
├── debug.js         # Debug Harness (developer logs, status indicators, dropdown UI)
├── index.html       # Client Portal (HTML template + minimal glue script)
├── logo.svg
└── tailwind.min.css # Offline fallback for older WebViews
```

### Script Separation of Concerns

* **`kiosk.js`**: Completely self-contained core bridge. Owns WebView bootstrapping and serial port listener subscriptions. Has zero awareness of DOM selectors or jQuery.
* **`mtk.js`**: Contains the MTK-F31 protocol implementation and hooks into `KioskBridge.Dispenser`.
* **`debug.js`**: Connects developer harness event listeners to log serial communications, update status headers, construct port lists, and manage the connectivity badge.
* **`index.html`**: Contains the client-facing UI design and the basic scripts to glue the buttons to the bridge commands.

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

## Client Integration Example (`index.html`)

This is the standard integration pattern. All buttons are safely wrapped in a jQuery ready check and remain disabled if no active port is selected:

```html
<script src="kiosk.js"></script>
<script src="mtk.js"></script>
<script>
    $(document).ready(function () {
        // 1. Initialize bridge on load
        KioskBridge.init();

        // Default SIM dispenser ID if none saved in localStorage
        var portId = localStorage.getItem('portId') || '0403:6011:1013:0';

        function updateButtonsState() {
            var disabled = !portId;
            $('#btn-dispense, #btn-read-iccid').prop('disabled', disabled);
        }

        // 2. Listen to port selection and update state dynamically
        if (window.debug && window.debug.portList) {
            window.debug.portList(function (selectedPortId) {
                portId = selectedPortId;
                if (portId) {
                    localStorage.setItem('portId', portId);
                } else {
                    localStorage.removeItem('portId');
                }
                updateButtonsState();
            });
        }

        updateButtonsState();

        // 3. Wire Dispense Action
        $('#btn-dispense').click(function () {
            KioskBridge.Dispenser(portId).dispense()
                .then(function () { console.log('Dispense successful!'); })
                .catch(function (error) { console.error('Dispense failed:', error); });
        });

        // 4. Wire Read ICCID Action (capturing resolved string)
        $('#btn-read-iccid').click(function () {
            KioskBridge.Dispenser(portId).readIccid()
                .then(function (iccid) {
                    console.log('Captured ICCID:', iccid);
                    // Proceed with checkout/billing verification flow
                })
                .catch(function (error) { console.error('ICCID Read failed:', error); });
        });
    });
</script>
```

---

## KioskBridge API (`kiosk.js` & `mtk.js`)

```js
// Boot and availability
KioskBridge.init();
KioskBridge.isAvailable(); // → true when running inside Kiosk WebView

// Dispenser instance factory
// (If portId is null, it checks localStorage or auto-detects ports)
const dispenser = KioskBridge.Dispenser(portId);

await dispenser.dispense();           // Reset → Move to IC → Eject SIM
const iccid = await dispenser.readIccid(); // Reads EF 2FE2 and decodes nibble-swapped BCD
```

---

## Developer Harness API (`debug.js`)

Used to interface developer screens and logging components.

```js
// Hook into background console logs
KioskBridge.onLog(function (message, type) {
    // type is 'send', 'recv', 'warn', 'error', or 'info'
});

// Hook into mechanical phase transitions
KioskBridge.onStatus(function (title, subtitle) {
    // title: e.g. "Feeding Card...", subtitle: "Moving card to reader."
});

// Port discovery notifications (resolves first connected port if empty)
debug.portList(function (portId) {
    // Fired on initial load and dropdown override selection changes
});
```

---

## Android Config (`/sdcard/simcomat.properties`)

Set the WebView to direct to GitHub Pages:
```properties
webviewOnStart=1
webviewTimeout=10
webviewURL=https://startimesgroup.github.io/KcellSimcomat-WebAppExample/
portDispenser=0403:6011:1013:0    # Hardcoded SIM Dispenser ID
```

Set via ADB command:
```bash
adb connect 192.168.68.68:5555
adb shell "printf 'webviewOnStart=1\nwebviewTimeout=10\nwebviewURL=https://startimesgroup.github.io/KcellSimcomat-WebAppExample/\nportDispenser=0403:6011:1013:0\n' > /sdcard/simcomat.properties"
```
