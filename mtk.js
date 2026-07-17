/**
 * mtk.js — MTK-F31 SIM Dispenser Driver
 *
 * Implements the MUTEK frame structure protocol. Injects `Dispenser` into `KioskBridge`.
 * Requires `kiosk.js` to be loaded first.
 */
(function (global) {
  'use strict';

  var KioskBridge = global.KioskBridge;
  if (!KioskBridge) throw new Error('kiosk.js must be loaded before mtk.js');

  var SerialPortConnection = KioskBridge._SerialPortConnection;

  // ─── 1. MTK-F31 Protocol Specification ────────────────────────────────────

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

  var MTK_ERRORS = {
    '01': 'Card Jam / Mechanical Blockage',
    '02': 'Empty / No Card in hopper',
    '03': 'Card pre-empty warning',
    '04': 'Dispenser sensor error',
    '60': 'IC card activation/reader module error',
    '61': 'No card on IC contacts (Check SIM orientation/stacking)',
    '62': 'IC card contacts short circuit',
    '63': 'Unsupported IC card type',
    '64': 'IC card communication error',
    '65': 'IC card communication timeout'
  };

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
    var err = null;
    if (!ok) {
      if (cmt === '4E' && pkt.length >= 18) {
        var code = String.fromCharCode(parseInt(pkt.substr(14,2),16)) + String.fromCharCode(parseInt(pkt.substr(16,2),16));
        var desc = MTK_ERRORS[code] || 'Hardware Error';
        err = 'Error Code: ' + code + ' - ' + desc;
      } else {
        err = 'Negative response: ' + cmt;
      }
    }
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

  // ─── 2. Driver Factory ──────────────────────────────────────────────────

  function _createProtocol(conn) {
    function cmd(cm, pm, ms, data) {
      var pkt = _buildPacket(0, cm, pm, data);
      KioskBridge._logFn('[TX] ' + pkt.match(/.{1,2}/g).join(' '), 'send');
      conn.clearBuffer();
      conn.publish(pkt);
      return conn.readPacket(ms, _validateFrame).then(function (hex) {
        KioskBridge._logFn('[RX] ' + hex.match(/.{1,2}/g).join(' '), 'recv');
        conn.publish('06');
        var r = _parsePacket(hex);
        if (!r.ok) throw new Error(r.err || 'Command failed');
        return hex;
      });
    }

    return {
      dispense: function () {
        KioskBridge._statusFn('Resetting...', 'Initializing dispenser...');
        return KioskBridge.wait(200)
          .then(function () { return cmd(CM_RESET, PM_RESET, 4000); })
          .then(function () { return KioskBridge.wait(500); })
          .then(function () { KioskBridge._statusFn('Feeding Card...', 'Moving card to reader.'); return cmd(CM_MOVE, PM_MOVE_IC, 6000); })
          .then(function () { return KioskBridge.wait(500); })
          .then(function () { KioskBridge._statusFn('Ejecting...', 'Dispensing card to bezel.'); return cmd(CM_MOVE, PM_MOVE_EJECT, 6000); })
          .then(function () { KioskBridge._statusFn('Done!', 'Collect your SIM card.'); });
      },

      readIccid: function () {
        KioskBridge._statusFn('Reading ICCID...', 'Initializing...');
        return KioskBridge.wait(200)
          .then(function () { KioskBridge._statusFn('Reading...', 'Reset...'); return cmd(CM_RESET, PM_RESET, 4000); })
          .then(function () { return KioskBridge.wait(500); })
          .then(function () { KioskBridge._statusFn('Reading...', 'Moving card...'); return cmd(CM_MOVE, PM_MOVE_IC, 6000); })
          .then(function () { return KioskBridge.wait(500); })
          .then(function () { KioskBridge._statusFn('Reading...', 'ATR...'); return cmd('51','30', 4000, '35'); })
          .then(function () { return KioskBridge.wait(200); })
          .then(function () { KioskBridge._statusFn('Reading...', 'Select MF...'); return cmd('51','33', 4000, 'A0A40000023F00'); })
          .then(function () { return KioskBridge.wait(200); })
          .then(function () { KioskBridge._statusFn('Reading...', 'Select EF...'); return cmd('51','33', 4000, 'A0A40000022FE2'); })
          .then(function () { return KioskBridge.wait(200); })
          .then(function () { KioskBridge._statusFn('Reading...', 'Read binary...'); return cmd('51','33', 4000, 'A0B000000A'); })
          .then(function (hex) {
            if (hex.length < 40) throw new Error('Response too short for ICCID');
            var raw = hex.substring(20, 40), iccid = '';
            for (var i = 0; i < raw.length; i += 2) iccid += raw[i+1] + raw[i];
            KioskBridge._statusFn('ICCID Read!', iccid);
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

  // ─── 3. Connection Cache & Discovery ──────────────────────────────────────

  var _connCache = {}; // portId → { conn, proto }

  function _openConnection(portId) {
    if (_connCache[portId] && _connCache[portId].conn.active) return _connCache[portId].proto;
    var conn = new SerialPortConnection(portId, function (hex) {
      if (hex === '06') { KioskBridge._logFn('ACK stripped.', 'info'); return ''; }
      return hex;
    });
    var proto = _createProtocol(conn);
    _connCache[portId] = { conn: conn, proto: proto };
    return proto;
  }

  function _autoDetect() {
    var ports = KioskBridge.listPorts();
    KioskBridge._logFn('Auto-detect (Dispenser): scanning ' + ports.length + ' port(s)...');
    function probe(i) {
      if (i >= ports.length) return Promise.reject(new Error('No dispenser found.'));
      var id = ports[i].id;
      KioskBridge._logFn('Probing ' + (i+1) + '/' + ports.length + ': ' + id + '...');
      var conn = new SerialPortConnection(id, function (hex) { return hex === '06' ? '' : hex; });
      var proto = _createProtocol(conn);
      return KioskBridge.wait(200).then(function () { return proto.probe(id); })
        .then(function (portId) { conn.close(); KioskBridge._logFn('Dispenser found: ' + portId); return portId; })
        .catch(function (e) { KioskBridge._logFn('Probe fail ' + id + ': ' + e.message, 'warn'); conn.close(); return probe(i+1); });
    }
    return probe(0);
  }

  // Inject into KioskBridge
  KioskBridge.Dispenser = function (portId) {
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
  };

}(window));
