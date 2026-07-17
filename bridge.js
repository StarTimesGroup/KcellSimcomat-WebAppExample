/**
 * bridge.js — Android WebView ↔ JavaScript plumbing
 *
 * Owns:
 *  - window.KIOSK bootstrap (wraps AndroidBridge)
 *  - window.__KIOSK_dispatch (called by native Java)
 *  - SerialPortConnection class (buffering, framing, timeouts)
 *  - KioskBridge public facade (consumed by app code)
 *
 * Nothing in here knows about MTK protocol, UI, or jQuery.
 */
(function (global) {

  // ---------------------------------------------------------------------------
  // 1. Bootstrap window.KIOSK from AndroidBridge (runs synchronously, before app)
  // ---------------------------------------------------------------------------
  var subscribers = {};

  if (global.AndroidBridge && !global.KIOSK) {
    global.KIOSK = {
      inited: function () { AndroidBridge.inited(); },
      serial: function (id) {
        return {
          publish: function (data) {
            AndroidBridge.publish(id, typeof data === 'object' ? (data.payload || '') : data);
          },
          subscribe: function (callback) {
            subscribers[id] = callback;
            AndroidBridge.subscribe(id);
          }
        };
      }
    };
    global.KIOSK.serial.list = function () {
      return JSON.parse(AndroidBridge.list());
    };
    global.__KIOSK_dispatch = function (id, payload) {
      if (subscribers[id]) {
        try { subscribers[id]({ id: id, payload: payload }); }
        catch (e) { console.error('KIOSK dispatch error:', e); }
      }
    };
  }

  // ---------------------------------------------------------------------------
  // 2. SerialPortConnection — raw serial I/O over KIOSK bridge
  // ---------------------------------------------------------------------------
  function SerialPortConnection(portId, options) {
    options = options || {};
    this.portId     = portId;
    this.onIncoming = options.onIncoming || function (x) { return x; };
    this.buffer     = '';
    this.listeners  = [];
    this.active     = false;
    this._open();
  }

  SerialPortConnection.prototype._open = function () {
    if (!global.KIOSK || this.active) return;
    this.active = true;
    var self = this;
    global.KIOSK.serial(this.portId).subscribe(function (event) {
      if (!event || !event.payload) return;
      var raw = event.payload.replace(/\s+/g, '').toUpperCase();
      var filtered = self.onIncoming(raw);
      if (!filtered) return;
      self.buffer += filtered;
      self.listeners.slice().forEach(function (fn) {
        try { fn(filtered); } catch (e) { console.error('Serial listener error:', e); }
      });
    });
  };

  SerialPortConnection.prototype.publish = function (hex) {
    if (global.KIOSK) global.KIOSK.serial(this.portId).publish(hex);
  };

  SerialPortConnection.prototype.clearBuffer = function () { this.buffer = ''; };

  SerialPortConnection.prototype.readPacket = function (timeoutMs, validator) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error('Timeout waiting for response from serial device'));
      }, timeoutMs);

      function listener() {
        try {
          var res = validator(self.buffer);
          if (res.consumeBytes > 0) self.buffer = self.buffer.substring(res.consumeBytes);
          if (res.complete) { cleanup(); resolve(res.packet); }
        } catch (e) { cleanup(); reject(e); }
      }

      function cleanup() {
        clearTimeout(timer);
        self.listeners = self.listeners.filter(function (fn) { return fn !== listener; });
      }

      self.listeners.push(listener);
      listener(); // check immediately in case buffer already has data
    });
  };

  SerialPortConnection.prototype.close = function () {
    this.listeners = [];
    this.active = false;
    if (global.KIOSK) {
      try { global.KIOSK.serial(this.portId).subscribe(function () {}); } catch (e) {}
    }
  };

  // ---------------------------------------------------------------------------
  // 3. KioskBridge — public API consumed by app glue code
  // ---------------------------------------------------------------------------
  var KioskBridge = {
    /** Returns true when running inside the Android kiosk WebView */
    isAvailable: function () { return !!global.KIOSK; },

    /** Signal Android that the web app has fully loaded */
    signalReady: function () {
      if (global.KIOSK) global.KIOSK.inited();
    },

    /** Returns array of { id, name } serial port objects */
    listPorts: function () {
      return global.KIOSK ? (global.KIOSK.serial.list() || []) : [];
    },

    /**
     * Open a serial port connection.
     * ACK frames (0x06) are stripped automatically.
     * @param {string} portId
     * @param {object} [opts]   optional: { onLog }
     * @returns {SerialPortConnection}
     */
    openPort: function (portId, opts) {
      opts = opts || {};
      return new SerialPortConnection(portId, {
        onIncoming: function (hex) {
          if (hex === '06') {
            if (opts.onLog) opts.onLog('ACK (0x06) stripped.', 'info');
            return '';
          }
          return hex;
        }
      });
    }
  };

  // Expose globally
  global.KioskBridge = KioskBridge;
  global.SerialPortConnection = SerialPortConnection; // kept for MtkF31 autoDetectPort compat

}(window));
