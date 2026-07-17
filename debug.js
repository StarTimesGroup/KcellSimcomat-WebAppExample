/**
 * debug.js — SIMCOMAT Developer Harness & UI wiring
 *
 * Exclusively handles background logging, port detection dropdowns,
 * and visual status indicators. Exposes window.debug.portList for index.html.
 */
(function (global) {
  'use strict';

  var _portListeners = [];

  $(document).ready(function () {
    // 1. Hook up the log and status receivers to KioskBridge
    KioskBridge.onLog(log);
    KioskBridge.onStatus(setStatus);

    // 2. Setup port selector dropdown
    loadPorts();
    $('#select-port').on('mousedown focus', loadPorts);

    // Save selected port manually or clear cached dispenser
    $('#select-port').change(function () {
      var val = $(this).val();
      var resolvedPort = null;
      if (val === 'auto') {
        localStorage.removeItem('portId');
        var ports = KioskBridge.listPorts();
        if (ports.length > 0) {
          resolvedPort = ports[0].id;
        }
      } else {
        localStorage.setItem('portId', val);
        resolvedPort = val;
      }
      log('Dispenser port selection updated: ' + val);
      notifyPortChange(resolvedPort);
    });

    // Clear logs button
    $('#console-clear').click(function () {
      $('#console-log').empty();
      log('Logs cleared.');
    });

    // ─── UI Helper Actions ──────────────────────────────────────────────────────

    function log(msg, type) {
      var colors = {
        error: 'text-red-600 font-semibold',
        warn: 'text-amber-600 font-semibold',
        send: 'text-fuchsia-600',
        recv: 'text-emerald-700'
      };
      var ms = new Date().getMilliseconds().toString().padStart(3, '0');
      var time = new Date().toLocaleTimeString('en-US', { hour12: false }) + '.' + ms;
      var el = document.createElement('div');
      el.className = 'mb-1.5 break-all';
      el.innerHTML = '<span class="text-slate-400 mr-1.5">[' + time + ']</span>'
                   + '<span class="' + (colors[type] || 'text-indigo-600') + '">' + msg + '</span>';
      var box = document.getElementById('console-log');
      if (box) {
        box.appendChild(el);
        box.scrollTop = box.scrollHeight;
      }
    }

    function setStatus(title, sub) {
      var el = document.getElementById('status-title');
      var subEl = document.getElementById('status-sub');
      if (el) el.textContent = 'Status: ' + title;
      if (subEl) subEl.textContent = sub || '';
      
      if (el) {
        var t = title.toLowerCase();
        el.className = 'text-lg font-bold ' + (t.includes('error') || t.includes('fail') ? 'text-red-600'
                                              : t.includes('success') ? 'text-emerald-600'
                                              : 'text-brand');
      }
    }

    function loadPorts() {
      var ports = KioskBridge.listPorts();
      var stored = localStorage.getItem('portId') || '1013:611';
      $('#select-port').html('<option value="auto">Auto-Detect Dispenser</option>');
      ports.forEach(function (p) {
        $('#select-port').append($('<option>').val(p.id).text(p.name));
      });
      
      var resolvedPort = null;
      if (stored && $('#select-port option[value="' + stored + '"]').length) {
        $('#select-port').val(stored);
        resolvedPort = stored;
      } else if (ports.length > 0) {
        resolvedPort = ports[0].id;
      }
      
      // Update badge status
      var avail = KioskBridge.isAvailable();
      $('#badge-dot').css({
        background: avail ? '#10b981' : '#94a3b8',
        boxShadow: avail ? '0 0 6px rgba(16,185,129,.6)' : 'none'
      });
      $('#badge-label').text(avail ? 'JSAPI' : 'Preview');

      notifyPortChange(resolvedPort);
    }
  });

  function notifyPortChange(portId) {
    _portListeners.forEach(function (cb) {
      try { cb(portId); } catch (e) {}
    });
  }

  // Expose global debug API
  global.debug = {
    portList: function (callback) {
      _portListeners.push(callback);
      var stored = localStorage.getItem('portId') || '1013:611';
      if (stored) {
        callback(stored);
      } else {
        var ports = KioskBridge.listPorts();
        if (ports.length > 0) {
          callback(ports[0].id);
        } else {
          callback(null);
        }
      }
    }
  };

}(window));
