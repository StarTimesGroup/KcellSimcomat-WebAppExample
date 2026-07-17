/**
 * bridge.js — SIMCOMAT Kiosk Bridge  v3
 *
 * Self-contained. No external dependencies.
 * Bundles: Android bootstrap, SerialPortConnection, MTK-F31 protocol.
 *
 * Public API (the only thing a frontend dev needs to know):
 *
 *   KioskBridge.init()                   // call once on app mount
 *   KioskBridge.isAvailable()            // true inside Android WebView
 *   KioskBridge.Dispenser(portId)        // portId = null → auto-detect
 *     .dispense()   → Promise<void>
 *     .readIccid()  → Promise<string>    // 20-digit ICCID
 *
 * Hooks for debug.js (optional):
 *   KioskBridge.onLog(fn)                // fn(msg, type)
 *   KioskBridge.onStatus(fn)             // fn(title, subtitle)
 *   KioskBridge.listPorts()              // → [{id, name}]
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

  // ─── 3. MTK-F31 Protocol (internal) ─────────────────────────────────────────

  var STX = 'F2', ETX = '03';
  var CM_RESET = '30', PM_RESET = '31';
  var CM_STATUS = '31', PM_STATUS = '30';
  var CM_MOVE = '32', PM_MOVE_IC = '31', PM_MOVE_EJECT = '30';

  function _buildPacket(addr, cm, pm, data) {
    data = data || '';
    var tlen = 3 + data.length / 2;
    var p = STX + addr.toString(16).padStart(2,'0')
          + ((tlen >> 8) & 0xFF).toString(16).padStart(2,'0')
          + (tlen & 0xFF).toString(16).padStart(2,'0')
          + '43' + cm + pm + data + ETX;
    var bcc = 0;
    for (var i = 0; i < p.length; i += 2) bcc ^= parseInt(p.substr(i, 2), 16);
    return (p + bcc.toString(16).padStart(2,'0')).toUpperCase();
  }

  function _parsePacket(hex) {
    if (hex.startsWith('06')) hex = hex.substring(2);
    if (!hex.startsWith(STX) || hex.length < 14) return { ok: false, err: 'Bad frame' };
    var tlen = (parseInt(hex.substr(4,2),16) << 8) | parseInt(hex.substr(6,2),16);
    var need = (1 + 3 + tlen + 2) * 2;
    if (hex.length < need) return { ok: false, err: 'Incomplete' };
    var pkt = hex.substring(0, need);
    var bcc = 0;
    for (var i = 0; i < pkt.length - 2; i += 2) bcc ^= parseInt(pkt.substr(i,2),16);
    if (bcc !== parseInt(pkt.slice(-2), 16)) return { ok: false, err: 'BCC mismatch' };
    var cmt = pkt.substr(8, 2);
    var ok = cmt === '50';
    var err = ok ? null : ('Error: ' + (cmt === '4E' && pkt.length >= 18
      ? String.fromCharCode(parseInt(pkt.substr(14,2),16)) + String.fromCharCode(parseInt(pkt.substr(16,2),16))
      : cmt));
    return { ok: ok, err: err, raw: pkt };
  }

  function _validateFrame(buf) {
    if (buf.length < 14) return { complete: false, consumeBytes: 0 };
    var idx = buf.indexOf('F2');
    if (idx === -1) return { complete: false, consumeBytes: buf.length };
    if (idx > 0)   return { complete: false, consumeBytes: idx };
    var tlen = (parseInt(buf.substr(4,2),16) << 8) | parseInt(buf.substr(6,2),16);
    if (isNaN(tlen)) return { complete: false, consumeBytes: 2 };
    var need = (1 + 3 + tlen + 2) * 2;
    if (buf.length < need) return { complete: false, consumeBytes: 0 };
    return { complete: true, packet: buf.substring(0, need), consumeBytes: need };
  }

  function _wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function _createProtocol(conn, logFn, statusFn) {
    function cmd(cm, pm, ms, data) {
      var pkt = _buildPacket(0, cm, pm, data);
      logFn('[TX] ' + pkt.match(/.{1,2}/g).join(' '), 'send');
      conn.clearBuffer();
      conn.publish(pkt);
      return conn.readPacket(ms, _validateFrame).then(function (hex) {
        logFn('[RX] ' + hex.match(/.{1,2}/g).join(' '), 'recv');
        conn.publish('06');
        var r = _parsePacket(hex);
        if (!r.ok) throw new Error(r.err || 'Command failed');
        return hex;
      });
    }

    return {
      dispense: function () {
        statusFn('Resetting...', 'Initializing dispenser...');
        return _wait(200)
          .then(function () { return cmd(CM_RESET, PM_RESET, 4000); })
          .then(function () { return _wait(500); })
          .then(function () { statusFn('Feeding Card...', 'Moving card to reader.'); return cmd(CM_MOVE, PM_MOVE_IC, 6000); })
          .then(function () { return _wait(500); })
          .then(function () { statusFn('Ejecting...', 'Dispensing card to bezel.'); return cmd(CM_MOVE, PM_MOVE_EJECT, 6000); })
          .then(function () { statusFn('Done!', 'Collect your SIM card.'); });
      },

      readIccid: function () {
        statusFn('Reading ICCID...', 'Initializing...');
        return _wait(200)
          .then(function () { statusFn('Reading...', 'Reset...'); return cmd(CM_RESET, PM_RESET, 4000); })
          .then(function () { return _wait(500); })
          .then(function () { statusFn('Reading...', 'Moving card...'); return cmd(CM_MOVE, PM_MOVE_IC, 6000); })
          .then(function () { return _wait(500); })
          .then(function () { statusFn('Reading...', 'ATR...'); return cmd('51','30', 4000, '35'); })
          .then(function () { return _wait(200); })
          .then(function () { statusFn('Reading...', 'Select MF...'); return cmd('51','33', 4000, 'A0A40000023F00'); })
          .then(function () { return _wait(200); })
          .then(function () { statusFn('Reading...', 'Select EF...'); return cmd('51','33', 4000, 'A0A40000022FE2'); })
          .then(function () { return _wait(200); })
          .then(function () { statusFn('Reading...', 'Read binary...'); return cmd('51','33', 4000, 'A0B000000A'); })
          .then(function (hex) {
            if (hex.length < 40) throw new Error('Response too short for ICCID');
            var raw = hex.substring(20, 40), iccid = '';
            for (var i = 0; i < raw.length; i += 2) iccid += raw[i+1] + raw[i];
            statusFn('ICCID Read!', iccid);
            return iccid;
          });
      },

      /** Probe this connection with a STATUS command; resolve portId if responding */
      probe: function (portId) {
        var pkt = _buildPacket(0, CM_STATUS, PM_STATUS);
        conn.clearBuffer(); conn.publish(pkt);
        return conn.readPacket(1200, _validateFrame).then(function (hex) {
          conn.publish('06');
          var r = _parsePacket(hex);
          if (r.ok) return portId;
          throw new Error('Negative probe response');
        });
      }
    };
  }

  // ─── 4. KioskBridge public API ───────────────────────────────────────────────

  var _logFn    = function (msg, type) { console.log('[' + (type || 'info') + ']', msg); };
  var _statusFn = function () {};
  var _connCache = {}; // portId → { conn, proto }

  function _openConnection(portId) {
    if (_connCache[portId] && _connCache[portId].conn.active) return _connCache[portId].proto;
    var conn = new SerialPortConnection(portId, function (hex) {
      if (hex === '06') { _logFn('ACK stripped.', 'info'); return ''; }
      return hex;
    });
    var proto = _createProtocol(conn, _logFn, _statusFn);
    _connCache[portId] = { conn: conn, proto: proto };
    return proto;
  }

  function _autoDetect() {
    var ports = global.KIOSK ? (global.KIOSK.serial.list() || []) : [];
    _logFn('Auto-detect: scanning ' + ports.length + ' port(s)...');
    function probe(i) {
      if (i >= ports.length) return Promise.reject(new Error('No dispenser found.'));
      var id = ports[i].id;
      _logFn('Probing ' + (i+1) + '/' + ports.length + ': ' + id + '...');
      var conn = new SerialPortConnection(id, function (hex) { return hex === '06' ? '' : hex; });
      var proto = _createProtocol(conn, _logFn, function () {});
      return _wait(200).then(function () { return proto.probe(id); })
        .then(function (portId) { conn.close(); _logFn('Dispenser found: ' + portId); return portId; })
        .catch(function (e) { _logFn('Probe fail ' + id + ': ' + e.message, 'warn'); conn.close(); return probe(i+1); });
    }
    return probe(0);
  }

  var KioskBridge = {
    /** Call once when the app mounts */
    init: function () {
      if (global.KIOSK) global.KIOSK.inited();
    },

    /** True when running inside the Android kiosk WebView */
    isAvailable: function () { return !!global.KIOSK; },

    /** Returns [{id, name}]. Useful for debug UI. */
    listPorts: function () { return global.KIOSK ? (global.KIOSK.serial.list() || []) : []; },

    /** Override the log handler. Called by debug.js. */
    onLog: function (fn) { _logFn = fn; },

    /** Override the status handler. Called by debug.js. */
    onStatus: function (fn) { _statusFn = fn; },

    /**
     * Get a Dispenser handle.
     * @param {string|null} portId  Specific port ID, or null to auto-detect.
     *                              Null → first checks localStorage("portId"), then probes all ports.
     */
    Dispenser: function (portId) {
      function resolve() {
        var id = portId || localStorage.getItem('portId');
        if (id) return Promise.resolve(_openConnection(id));
        return _autoDetect().then(function (detectedId) {
          localStorage.setItem('portId', detectedId);
          return _openConnection(detectedId);
        });
      }
      return {
        dispense:  function () { return resolve().then(function (p) { return p.dispense(); }); },
        readIccid: function () { return resolve().then(function (p) { return p.readIccid(); }); }
      };
    }
  };

  global.KioskBridge = KioskBridge;

}(window));
