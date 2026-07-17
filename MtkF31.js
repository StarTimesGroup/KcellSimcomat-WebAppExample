/** version 1
 * MtkF31Controller class encapsulating linear serial workflows via async-await.
 * Built using an IIFE (Immediately Invoked Function Expression) closure to prevent global scope pollution
 * and avoid namespace collisions.
 */
const MtkF31Controller = (function () {
  // String.prototype.padStart polyfill for older WebViews (Chromium < 57)
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (targetLength, padString) {
      var str = String(this);
      targetLength = targetLength >> 0;
      padString = String(padString !== undefined ? padString : ' ');
      if (str.length >= targetLength) {
        return str;
      }
      targetLength = targetLength - str.length;
      while (padString.length < targetLength) {
        padString += padString;
      }
      return padString.slice(0, targetLength) + str;
    };
  }

  // Private Constants matching native MtkF31Controller
  const STX = "F2";
  const ETX = "03";
  const CMT_CMD = "43"; // 'C'
  const CMT_RESP_POS = "50"; // 'P'
  const CMT_RESP_NEG = "4E"; // 'N'

  const CM_RESET = "30";
  const PM_RESET = "31";

  const CM_STATUS = "31";
  const PM_STATUS = "30";

  const CM_MOVE = "32"; // '2'
  const PM_MOVE_EJECT = "30";
  const PM_MOVE_IC = "31";

  // Private Helper: Build MTK Checksum (BCC) packet
  function buildPacket(addr, cm, pm, dataHex = "") {
    const textLen = 3 + (dataHex.length / 2);
    const lenh = ((textLen >> 8) & 0xFF).toString(16).padStart(2, '0');
    const lenl = (textLen & 0xFF).toString(16).padStart(2, '0');
    const addrHex = addr.toString(16).padStart(2, '0');

    let packet = STX + addrHex + lenh + lenl + CMT_CMD + cm + pm + dataHex + ETX;

    let bcc = 0;
    for (let i = 0; i < packet.length; i += 2) {
      bcc ^= parseInt(packet.substr(i, 2), 16);
    }
    packet += bcc.toString(16).padStart(2, '0');
    return packet.toUpperCase();
  }

  // Private Helper: Parse and validate incoming packet
  function parsePacket(hex) {
    if (hex.startsWith("06")) {
      hex = hex.substring(2);
    }
    if (!hex.startsWith(STX)) {
      return { success: false, error: "STX missing" };
    }
    if (hex.length < 14) {
      return { success: false, error: "Packet too short" };
    }

    const lenh = parseInt(hex.substr(4, 2), 16);
    const lenl = parseInt(hex.substr(6, 2), 16);
    const textLen = (lenh << 8) | lenl;
    const expectedLen = 1 + 3 + textLen + 2;

    if (hex.length < expectedLen * 2) {
      return { success: false, error: "Incomplete packet content" };
    }

    const packet = hex.substring(0, expectedLen * 2);

    let calcBcc = 0;
    const bccRange = packet.substring(0, packet.length - 2);
    for (let i = 0; i < bccRange.length; i += 2) {
      calcBcc ^= parseInt(bccRange.substr(i, 2), 16);
    }
    const expectedBcc = parseInt(packet.substr(packet.length - 2, 2), 16);

    if (calcBcc !== expectedBcc) {
      return {
        success: false,
        error: `BCC mismatch: calculated 0x${calcBcc.toString(16).toUpperCase()}, expected 0x${expectedBcc.toString(16).toUpperCase()}`
      };
    }

    const cmt = packet.substr(8, 2);
    const isPositive = (cmt === CMT_RESP_POS);

    let errorMsg = "Unknown Error";
    if (!isPositive) {
      if (cmt === CMT_RESP_NEG && packet.length >= 18) {
        const e1 = String.fromCharCode(parseInt(packet.substr(14, 2), 16));
        const e0 = String.fromCharCode(parseInt(packet.substr(16, 2), 16));
        errorMsg = `Error Code: ${e1}${e0}`;
      } else {
        errorMsg = `Negative Response (${cmt})`;
      }
    }

    return {
      success: isPositive,
      cmt: cmt,
      errorMsg: errorMsg,
      raw: packet,
      fullLen: expectedLen * 2
    };
  }

  // Private Helper: Pluggable packet validator for MTK protocol
  function validateMtkPacket(buffer) {
    if (buffer.length < 14) {
      return { complete: false, consumeBytes: 0 };
    }

    const stxIdx = buffer.indexOf("F2");
    if (stxIdx === -1) {
      // No STX found, discard all currently buffered data as junk
      return { complete: false, consumeBytes: buffer.length };
    }

    // If STX is found but not at the start, discard leading junk
    if (stxIdx > 0) {
      return { complete: false, consumeBytes: stxIdx };
    }

    // Parse packet length bytes (offset 4 for lenh, offset 6 for lenl)
    const lenh = parseInt(buffer.substr(4, 2), 16);
    const lenl = parseInt(buffer.substr(6, 2), 16);
    if (isNaN(lenh) || isNaN(lenl)) {
      // Invalid length representation, discard STX to find next potential STX
      return { complete: false, consumeBytes: 2 };
    }

    const textLen = (lenh << 8) | lenl;
    const expectedLenBytes = 1 + 3 + textLen + 2; // STX (1) + Addr(1)+Len(2) (3) + textLen + ETX(1)+BCC(1) (2)
    const expectedLenChars = expectedLenBytes * 2;

    if (buffer.length < expectedLenChars) {
      return { complete: false, consumeBytes: 0 };
    }

    const packet = buffer.substring(0, expectedLenChars);
    return {
      complete: true,
      packet: packet,
      consumeBytes: expectedLenChars
    };
  }

  // Constructor Function
  function MtkF31Controller(connection, options = {}) {
    const onLog = options.onLog || console.log;
    const onStatus = options.onStatus || console.log;

    return {
      dispense: function () {
        onStatus("Initializing...", "Preparing port configuration...");

        const executeCommand = function (cm, pm, timeoutMs) {
          const packet = buildPacket(0, cm, pm);
          onLog(`[TX] Sending command: ${packet.match(/.{1,2}/g).join(' ')}`, "send");
          connection.clearBuffer();
          connection.publish(packet);

          return connection.readPacket(timeoutMs, validateMtkPacket)
            .then(function (responseHex) {
              onLog(`[RX] Received response: ${responseHex.match(/.{1,2}/g).join(' ')}`, "recv");

              // Send back ACK frame
              onLog("[TX] Sending ACK (0x06) to dispenser.", "info");
              connection.publish("06");

              const parseRes = parsePacket(responseHex);
              if (!parseRes.success) {
                throw new Error(parseRes.errorMsg || "Command failed");
              }
              return parseRes;
            });
        };

        return new Promise(function (resolve, reject) {
          // Wait for port config to apply
          setTimeout(function () {
            // 1. Reset
            onStatus("Resetting...", "Initializing dispenser reset...");
            executeCommand(CM_RESET, PM_RESET, 4000)
              .then(function () {
                return new Promise(function (r) { setTimeout(r, 500); });
              })
              .then(function () {
                // 2. Feed card to IC
                onStatus("Feeding Card...", "Moving SIM card from hopper to reader.");
                return executeCommand(CM_MOVE, PM_MOVE_IC, 6000);
              })
              .then(function () {
                return new Promise(function (r) { setTimeout(r, 500); });
              })
              .then(function () {
                // 3. Eject card
                onStatus("Ejecting Card...", "Dispensing card to customer bezel.");
                return executeCommand(CM_MOVE, PM_MOVE_EJECT, 6000);
              })
              .then(function () {
                onStatus("Dispense Successful!", "Collect your SIM card from the bezel.");
                resolve();
              })
              .catch(reject);
          }, 200);
        });
      },
      readIccid: function () {
        onStatus("Reading ICCID...", "Initializing card read...");

        const executeCommand = function (cm, pm, timeoutMs, dataHex = "") {
          const packet = buildPacket(0, cm, pm, dataHex);
          onLog(`[TX] Sending command: ${packet.match(/.{1,2}/g).join(' ')}`, "send");
          connection.clearBuffer();
          connection.publish(packet);

          return connection.readPacket(timeoutMs, validateMtkPacket)
            .then(function (responseHex) {
              onLog(`[RX] Received response: ${responseHex.match(/.{1,2}/g).join(' ')}`, "recv");

              onLog("[TX] Sending ACK (0x06) to dispenser.", "info");
              connection.publish("06");

              const parseRes = parsePacket(responseHex);
              if (!parseRes.success) {
                throw new Error(parseRes.errorMsg || "Command failed");
              }
              return responseHex;
            });
        };

        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            // 1. Reset
            onStatus("Resetting...", "Initializing dispenser reset...");
            executeCommand(CM_RESET, PM_RESET, 4000)
              .then(function () {
                return new Promise(function (r) { setTimeout(r, 500); });
              })
              .then(function () {
                // 2. Feed card to IC
                onStatus("Feeding Card...", "Moving SIM card from hopper to reader.");
                return executeCommand(CM_MOVE, PM_MOVE_IC, 6000);
              })
              .then(function () {
                return new Promise(function (r) { setTimeout(r, 500); });
              })
              .then(function () {
                // 3. Cold Reset (ATR)
                onStatus("Reading ICCID...", "Performing cold reset on card reader...");
                return executeCommand("51", "30", 4000, "35");
              })
              .then(function () {
                return new Promise(function (r) { setTimeout(r, 200); });
              })
              .then(function () {
                // 4. Select MF
                onStatus("Reading ICCID...", "Selecting Master File (MF)...");
                return executeCommand("51", "33", 4000, "A0A40000023F00");
              })
              .then(function () {
                return new Promise(function (r) { setTimeout(r, 200); });
              })
              .then(function () {
                // 5. Select ICCID EF
                onStatus("Reading ICCID...", "Selecting ICCID file (EF)...");
                return executeCommand("51", "33", 4000, "A0A40000022FE2");
              })
              .then(function () {
                return new Promise(function (r) { setTimeout(r, 200); });
              })
              .then(function () {
                // 6. Read ICCID EF
                onStatus("Reading ICCID...", "Reading ICCID binary data...");
                return executeCommand("51", "33", 4000, "A0B000000A");
              })
              .then(function (responseHex) {
                if (responseHex.length < 40) {
                  throw new Error("Invalid response length from reader");
                }
                const iccidHex = responseHex.substring(20, 40);
                let parsedIccid = "";
                for (let i = 0; i < iccidHex.length; i += 2) {
                  const b = iccidHex.substr(i, 2);
                  parsedIccid += b[1] + b[0];
                }
                onStatus("Read Successful!", "ICCID: " + parsedIccid);
                resolve(parsedIccid);
              })
              .catch(reject);
          }, 200);
        });
      }
    };
  }

  // Public Static Methods attached to constructor
  MtkF31Controller.autoDetectPort = function (ports, onLog = console.log) {
    onLog("Starting Auto-Detect scanning sequence...");

    const ConnectionClass = window.SerialPortConnection;
    if (!ConnectionClass) {
      return Promise.reject(new Error("SerialPortConnection class is not defined. Please define it before calling autoDetectPort."));
    }

    function probePort(index) {
      if (index >= ports.length) {
        return Promise.reject(new Error("No responding dispenser found. Please check connections."));
      }

      const portId = ports[index].id;
      onLog(`Probing device ${index + 1}/${ports.length}: ${portId}...`);

      let conn = null;
      try {
        conn = new ConnectionClass(portId, {
          onLog: onLog,
          onIncoming: function (incoming) {
            if (incoming === "06") {
              onLog("ACK (0x06) received and stripped.", "info");
              return "";
            }
            return incoming;
          }
        });
      } catch (e) {
        onLog(`Probe instantiation fail on ${portId}: ${e.message}`, "warn");
        return probePort(index + 1);
      }

      const activeConn = conn;
      return new Promise(function (resolve) {
        setTimeout(resolve, 200);
      })
        .then(function () {
          const packet = buildPacket(0, CM_STATUS, PM_STATUS);
          onLog(`[TX] Inquiry query: ${packet}`, "send");
          activeConn.clearBuffer();
          activeConn.publish(packet);

          return activeConn.readPacket(1200, validateMtkPacket);
        })
        .then(function (responseHex) {
          onLog(`[RX] Inquiry reply: ${responseHex}`, "recv");
          activeConn.publish("06"); // ACK

          const parseRes = parsePacket(responseHex);
          if (parseRes.success) {
            onLog(`Dispenser successfully found on: ${portId}`);
            activeConn.close();
            return portId;
          }
          throw new Error("Device response not positive");
        })
        .catch(function (e) {
          onLog(`Probe timeout/fail on ${portId}: ${e.message}`, "warn");
          activeConn.close();
          return probePort(index + 1);
        });
    }

    return probePort(0);
  };

  return MtkF31Controller;
})();
