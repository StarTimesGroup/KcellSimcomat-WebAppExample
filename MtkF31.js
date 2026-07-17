/**
 * MtkF31.js — MTK-F31 SIM Card Dispenser Protocol Library  v2
 *
 * Pure protocol layer — no UI, no Android, no jQuery.
 * Depends only on a `connection` object that implements:
 *   .clearBuffer()
 *   .publish(hexString)
 *   .readPacket(timeoutMs, validatorFn) → Promise<hexString>
 *
 * autoDetectPort() accepts an injected `openPort` function so this file
 * has zero coupling to window.* globals.
 */
const MtkF31Controller = (function () {

  // padStart polyfill for Chromium < 57 WebViews
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (len, pad) {
      var s = String(this);
      pad = String(pad !== undefined ? pad : ' ');
      while (pad.length < len - s.length) pad += pad;
      return pad.slice(0, Math.max(0, len - s.length)) + s;
    };
  }

  // ── Protocol constants ──────────────────────────────────────────────────────
  var STX          = 'F2';
  var ETX          = '03';
  var CMT_CMD      = '43'; // 'C'
  var CMT_RESP_POS = '50'; // 'P'
  var CMT_RESP_NEG = '4E'; // 'N'

  var CM_RESET  = '30'; var PM_RESET     = '31';
  var CM_STATUS = '31'; var PM_STATUS    = '30';
  var CM_MOVE   = '32'; var PM_MOVE_IC   = '31';
                        var PM_MOVE_EJECT= '30';

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Build a framed, BCC-checked command packet */
  function buildPacket(addr, cm, pm, dataHex) {
    dataHex = dataHex || '';
    var textLen = 3 + (dataHex.length / 2);
    var lenh = ((textLen >> 8) & 0xFF).toString(16).padStart(2, '0');
    var lenl = (textLen & 0xFF).toString(16).padStart(2, '0');
    var addrHex = addr.toString(16).padStart(2, '0');
    var packet = STX + addrHex + lenh + lenl + CMT_CMD + cm + pm + dataHex + ETX;
    var bcc = 0;
    for (var i = 0; i < packet.length; i += 2) bcc ^= parseInt(packet.substr(i, 2), 16);
    return (packet + bcc.toString(16).padStart(2, '0')).toUpperCase();
  }

  /** Parse and validate a raw response hex string */
  function parsePacket(hex) {
    if (hex.startsWith('06')) hex = hex.substring(2);
    if (!hex.startsWith(STX)) return { success: false, errorMsg: 'STX missing' };
    if (hex.length < 14)      return { success: false, errorMsg: 'Packet too short' };

    var lenh = parseInt(hex.substr(4, 2), 16);
    var lenl = parseInt(hex.substr(6, 2), 16);
    var textLen = (lenh << 8) | lenl;
    var expectedLen = (1 + 3 + textLen + 2) * 2;
    if (hex.length < expectedLen) return { success: false, errorMsg: 'Incomplete packet' };

    var packet = hex.substring(0, expectedLen);
    var bccRange = packet.substring(0, packet.length - 2);
    var calcBcc = 0;
    for (var j = 0; j < bccRange.length; j += 2) calcBcc ^= parseInt(bccRange.substr(j, 2), 16);
    var expectedBcc = parseInt(packet.substr(packet.length - 2, 2), 16);
    if (calcBcc !== expectedBcc) {
      return { success: false, errorMsg: 'BCC mismatch: got 0x' + calcBcc.toString(16).toUpperCase() };
    }

    var cmt = packet.substr(8, 2);
    var isPos = (cmt === CMT_RESP_POS);
    var errorMsg = 'Unknown Error';
    if (!isPos && cmt === CMT_RESP_NEG && packet.length >= 18) {
      errorMsg = 'Error Code: '
        + String.fromCharCode(parseInt(packet.substr(14, 2), 16))
        + String.fromCharCode(parseInt(packet.substr(16, 2), 16));
    }
    return { success: isPos, errorMsg: errorMsg, raw: packet };
  }

  /** Frame completeness checker — plugged into connection.readPacket() */
  function validateFrame(buffer) {
    if (buffer.length < 14) return { complete: false, consumeBytes: 0 };
    var idx = buffer.indexOf('F2');
    if (idx === -1) return { complete: false, consumeBytes: buffer.length };
    if (idx > 0)   return { complete: false, consumeBytes: idx };
    var lenh = parseInt(buffer.substr(4, 2), 16);
    var lenl = parseInt(buffer.substr(6, 2), 16);
    if (isNaN(lenh) || isNaN(lenl)) return { complete: false, consumeBytes: 2 };
    var need = (1 + 3 + ((lenh << 8) | lenl) + 2) * 2;
    if (buffer.length < need) return { complete: false, consumeBytes: 0 };
    return { complete: true, packet: buffer.substring(0, need), consumeBytes: need };
  }

  /** Simple promise-based delay */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── Controller factory ───────────────────────────────────────────────────────

  function MtkF31Controller(connection, options) {
    var onLog    = (options && options.onLog)    || console.log;
    var onStatus = (options && options.onStatus) || console.log;

    /** Send one command, await one framed response, send ACK, return responseHex */
    function cmd(cm, pm, timeoutMs, dataHex) {
      var packet = buildPacket(0, cm, pm, dataHex);
      onLog('[TX] ' + packet.match(/.{1,2}/g).join(' '), 'send');
      connection.clearBuffer();
      connection.publish(packet);
      return connection.readPacket(timeoutMs, validateFrame).then(function (hex) {
        onLog('[RX] ' + hex.match(/.{1,2}/g).join(' '), 'recv');
        connection.publish('06'); // ACK
        var parsed = parsePacket(hex);
        if (!parsed.success) throw new Error(parsed.errorMsg || 'Command failed');
        return hex;
      });
    }

    return {
      /**
       * Full dispense sequence: Reset → Move to IC → Eject
       * @returns {Promise<void>}
       */
      dispense: function () {
        onStatus('Initializing...', 'Preparing dispenser...');
        return wait(200)
          .then(function () { onStatus('Resetting...', 'Initializing dispenser reset...'); return cmd(CM_RESET, CM_STATUS, 4000); })
          .then(function () { return wait(500); })
          .then(function () { onStatus('Feeding Card...', 'Moving SIM card from hopper to reader.'); return cmd(CM_MOVE, PM_MOVE_IC, 6000); })
          .then(function () { return wait(500); })
          .then(function () { onStatus('Ejecting Card...', 'Dispensing card to customer bezel.'); return cmd(CM_MOVE, PM_MOVE_EJECT, 6000); })
          .then(function () { onStatus('Dispense Successful!', 'Collect your SIM card from the bezel.'); });
      },

      /**
       * Read ICCID from the SIM chip via ISO-7816 APDUs.
       * Card remains in reader after this call — caller decides to eject or reject.
       * @returns {Promise<string>} 20-digit ICCID string
       */
      readIccid: function () {
        onStatus('Reading ICCID...', 'Initializing card read...');
        return wait(200)
          .then(function () { onStatus('Resetting...', 'Initializing dispenser reset...'); return cmd(CM_RESET, PM_RESET, 4000); })
          .then(function () { return wait(500); })
          .then(function () { onStatus('Feeding Card...', 'Moving SIM to reader.'); return cmd(CM_MOVE, PM_MOVE_IC, 6000); })
          .then(function () { return wait(500); })
          .then(function () { onStatus('Reading ICCID...', 'Cold reset (ATR)...'); return cmd('51', '30', 4000, '35'); })
          .then(function () { return wait(200); })
          .then(function () { onStatus('Reading ICCID...', 'Select MF...'); return cmd('51', '33', 4000, 'A0A40000023F00'); })
          .then(function () { return wait(200); })
          .then(function () { onStatus('Reading ICCID...', 'Select ICCID EF...'); return cmd('51', '33', 4000, 'A0A40000022FE2'); })
          .then(function () { return wait(200); })
          .then(function () { onStatus('Reading ICCID...', 'Reading binary data...'); return cmd('51', '33', 4000, 'A0B000000A'); })
          .then(function (hex) {
            if (hex.length < 40) throw new Error('Response too short for ICCID');
            // Bytes 10–19 of the response frame hold the ICCID in semi-octet (nibble-swapped) BCD
            var raw = hex.substring(20, 40);
            var iccid = '';
            for (var i = 0; i < raw.length; i += 2) iccid += raw[i + 1] + raw[i];
            onStatus('Read Successful!', 'ICCID: ' + iccid);
            return iccid;
          });
      }
    };
  }

  // ── Static: auto-detect which port has a dispenser ──────────────────────────

  /**
   * @param {Array<{id,name}>} ports     from KioskBridge.listPorts()
   * @param {Function}         openPort  (portId) => SerialPortConnection
   * @param {Function}        [onLog]
   * @returns {Promise<string>} resolved portId
   */
  MtkF31Controller.autoDetectPort = function (ports, openPort, onLog) {
    onLog = onLog || console.log;
    onLog('Auto-Detect: scanning ' + ports.length + ' port(s)...');

    function probe(i) {
      if (i >= ports.length) return Promise.reject(new Error('No responding dispenser found.'));
      var portId = ports[i].id;
      onLog('Probing ' + (i + 1) + '/' + ports.length + ': ' + portId + '...');
      var conn;
      try { conn = openPort(portId, { onLog: onLog }); }
      catch (e) { onLog('Instantiation fail on ' + portId + ': ' + e.message, 'warn'); return probe(i + 1); }

      var packet = buildPacket(0, CM_STATUS, PM_STATUS);
      return wait(200).then(function () {
        conn.clearBuffer();
        conn.publish(packet);
        return conn.readPacket(1200, validateFrame);
      }).then(function (hex) {
        conn.publish('06');
        var res = parsePacket(hex);
        conn.close();
        if (res.success) { onLog('Dispenser found on: ' + portId); return portId; }
        throw new Error('Negative response');
      }).catch(function (e) {
        onLog('Probe fail on ' + portId + ': ' + e.message, 'warn');
        try { conn.close(); } catch (_) {}
        return probe(i + 1);
      });
    }

    return probe(0);
  };

  return MtkF31Controller;
}());
