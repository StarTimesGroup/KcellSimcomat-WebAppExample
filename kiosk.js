/**
 * kiosk.js — SIMCOMAT Kiosk Core Bridge
 *
 * Handles Android WebView bindings, serial port pub/sub streams, and developer logging hooks.
 */
(function (global) {
  'use strict';

  // ─── padStart polyfill (Chromium < 57) ──────────────────────────────────────
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (len, pad) {
      var s = String(this);
      pad = String(pad !== undefined ? pad : ' ');
      while (pad.length + s.length < len) pad += pad;
      return pad.slice(0, len - s.length) + s;
    };
  }

  // ─── 1. Android → JS bootstrap ──────────────────────────────────────────────

  var _subscribers = {};

  if (global.AndroidBridge && !global.KIOSK) {
    global.KIOSK = {
      inited: function () { AndroidBridge.inited(); },
      serial: function (id) {
        return {
          publish: function (data) {
            AndroidBridge.publish(id, typeof data === 'object' ? (data.payload || '') : data);
          },
          subscribe: function (cb) {
            _subscribers[id] = cb;
            AndroidBridge.subscribe(id);
          }
        };
      }
    };
    global.KIOSK.serial.list = function () { return JSON.parse(AndroidBridge.list()); };
    global.__KIOSK_dispatch = function (id, payload) {
      if (_subscribers[id]) {
        try { _subscribers[id]({ id: id, payload: payload }); } catch (e) {}
      }
    };
  }

  // ─── 2. SerialPortConnection ─────────────────────────────────────────────────

  function SerialPortConnection(portId, onIncoming) {
    this.portId = portId;
    this._filter = onIncoming || function (x) { return x; };
    this.buffer = '';
    this.listeners = [];
    this.active = false;
    var self = this;
    if (global.KIOSK) {
      this.active = true;
      global.KIOSK.serial(portId).subscribe(function (event) {
        if (!event || !event.payload) return;
        var raw = event.payload.replace(/\s+/g, '').toUpperCase();
        var filtered = self._filter(raw);
        if (!filtered) return;
        self.buffer += filtered;
        self.listeners.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
      });
    }
  }
  SerialPortConnection.prototype.publish    = function (hex) { if (global.KIOSK) global.KIOSK.serial(this.portId).publish(hex); };
  SerialPortConnection.prototype.clearBuffer = function ()   { this.buffer = ''; };
  SerialPortConnection.prototype.close      = function ()   {
    this.listeners = []; this.active = false;
    if (global.KIOSK) try { global.KIOSK.serial(this.portId).subscribe(function () {}); } catch (e) {}
  };
  SerialPortConnection.prototype.readPacket = function (timeoutMs, validator) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { cleanup(); reject(new Error('Serial timeout')); }, timeoutMs);
      function check() {
        try {
          var r = validator(self.buffer);
          if (r.consumeBytes > 0) self.buffer = self.buffer.substring(r.consumeBytes);
          if (r.complete) { cleanup(); resolve(r.packet); }
        } catch (e) { cleanup(); reject(e); }
      }
      function cleanup() {
        clearTimeout(timer);
        self.listeners = self.listeners.filter(function (f) { return f !== check; });
      }
      self.listeners.push(check);
      check();
    });
  };

  // ─── 3. KioskBridge Core API ────────────────────────────────────────────────

  var KioskBridge = {
    // Internal API references for driver modules to use
    _SerialPortConnection: SerialPortConnection,
    _logFn: function (msg, type) { console.log('[' + (type || 'info') + ']', msg); },
    _statusFn: function () {},

    /** Call once when the app mounts */
    init: function () {
      if (global.KIOSK) global.KIOSK.inited();
    },

    /** True when running inside the Android kiosk WebView */
    isAvailable: function () { return !!global.KIOSK; },

    /** Returns [{id, name}]. Useful for debug UI. */
    listPorts: function () { return global.KIOSK ? (global.KIOSK.serial.list() || []) : []; },

    /** Override the log handler. Called by debug.js. */
    onLog: function (fn) { KioskBridge._logFn = fn; },

    /** Override the status handler. Called by debug.js. */
    onStatus: function (fn) { KioskBridge._statusFn = fn; },
    
    /** Promisified sleep helper */
    wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },

    /** Thermal Receipt Printer API */
    Printer: function () {
      return {
        printDemo: function (qrUrl) {
          if (global.AndroidBridge && global.AndroidBridge.printDemoReceipt) {
            try {
              var raw = global.AndroidBridge.printDemoReceipt(qrUrl || '');
              var res = typeof raw === 'string' ? JSON.parse(raw) : raw;
              if (res && res.success) {
                if (KioskBridge._logFn) KioskBridge._logFn('Demo check with QR printed successfully', 'Printer');
                return Promise.resolve(res);
              } else {
                var errMsg = (res && res.error) ? res.error : 'Unknown printer error';
                if (KioskBridge._logFn) KioskBridge._logFn('Print failed: ' + errMsg, 'Printer');
                return Promise.reject(new Error(errMsg));
              }
            } catch (e) {
              if (KioskBridge._logFn) KioskBridge._logFn('Print error: ' + e.message, 'Printer');
              return Promise.reject(e);
            }
          } else {
            if (KioskBridge._logFn) KioskBridge._logFn('Preview mode: demo check simulated with QR', 'Printer');
            return Promise.resolve({ success: true, preview: true });
          }
        },
        printHex: function (hexPayload) {
          if (global.AndroidBridge && global.AndroidBridge.printHex) {
            try {
              var raw = global.AndroidBridge.printHex(hexPayload || '');
              var res = typeof raw === 'string' ? JSON.parse(raw) : raw;
              return res && res.success ? Promise.resolve(res) : Promise.reject(new Error(res ? res.error : 'Print error'));
            } catch (e) {
              return Promise.reject(e);
            }
          } else {
            return Promise.resolve({ success: true, preview: true });
          }
        }
      };
    },

    /** Passport and ID Card Scanner API */
    Passport: function () {
      return {
        scan: function () {
          if (global.AndroidBridge && global.AndroidBridge.scanPassport) {
            try {
              var raw = global.AndroidBridge.scanPassport();
              var res = typeof raw === 'string' ? JSON.parse(raw) : raw;
              if (res && res.success) {
                if (KioskBridge._logFn) KioskBridge._logFn('Document scanned: ' + (res.fullName || res.cardType || 'OK'), 'Passport');
                return Promise.resolve(res);
              } else {
                var errMsg = (res && res.error) ? res.error : 'Document scan failed';
                if (KioskBridge._logFn) KioskBridge._logFn('Scan failed: ' + errMsg, 'Passport');
                return Promise.reject(new Error(errMsg));
              }
            } catch (e) {
              if (KioskBridge._logFn) KioskBridge._logFn('Passport scan error: ' + e.message, 'Passport');
              return Promise.reject(e);
            }
          } else {
            // Browser preview mode
            if (KioskBridge._logFn) KioskBridge._logFn('Preview mode: simulated passport scan', 'Passport');
            return Promise.resolve({
              success: true,
              preview: true,
              cardType: 'PASSPORT',
              fullName: 'DEMO CUSTOMER',
              documentNumber: 'N12345678',
              birthDate: '1995-05-15',
              expiryDate: '2035-05-14',
              nationality: 'KAZ',
              gender: 'M',
              mrz: 'P<KAZDEMO<<CUSTOMER<<<<<<<<<<<<<<<<<<<<<<<\nN123456781KAZ9505152M3505146<<<<<<<<<<<<<<04'
            });
          }
        }
      };
    }
  };

  global.KioskBridge = KioskBridge;

}(window));
