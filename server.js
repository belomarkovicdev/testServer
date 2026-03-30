const net = require("net");
const https = require("https");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "9000", 10);
const HOST = "0.0.0.0";
const API_HOST = "jbtracker.onrender.com";
const API_PATH = "/api/location/raw"; 
// ──────────────────────────────────────────────────────────────────────────────

function log(text) {
  console.log(`[${new Date().toISOString()}] ${text}`);
}

// ─── JT/T 808 Protocol ──────────────────────────────────────────────────────

function unescape808(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d && i + 1 < buf.length) {
      if (buf[i + 1] === 0x02) { out.push(0x7e); i++; }
      else if (buf[i + 1] === 0x01) { out.push(0x7d); i++; }
      else out.push(buf[i]);
    } else {
      out.push(buf[i]);
    }
  }
  return Buffer.from(out);
}

function escape808(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7e) { out.push(0x7d, 0x02); }
    else if (buf[i] === 0x7d) { out.push(0x7d, 0x01); }
    else out.push(buf[i]);
  }
  return Buffer.from(out);
}

function calcChecksum(buf) {
  let cs = 0;
  for (let i = 0; i < buf.length; i++) cs ^= buf[i];
  return cs;
}

function buildResponse(msgId, phoneBytes, serialNum, bodyBuf) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(msgId, 0);
  header.writeUInt16BE(bodyBuf.length, 2);
  phoneBytes.copy(header, 4);
  header.writeUInt16BE(serialNum, 10);
  const payload = Buffer.concat([header, bodyBuf]);
  const cs = calcChecksum(payload);
  const escaped = escape808(Buffer.concat([payload, Buffer.from([cs])]));
  return Buffer.concat([Buffer.from([0x7e]), escaped, Buffer.from([0x7e])]);
}

function buildAck(phoneBytes, serialNum, ackSerial, ackMsgId, result) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(ackSerial, 0);
  body.writeUInt16BE(ackMsgId, 2);
  body.writeUInt8(result, 4);
  return buildResponse(0x8001, phoneBytes, serialNum, body);
}

function buildRegisterAck(phoneBytes, serialNum, ackSerial, result, authCode) {
  const authBuf = Buffer.from(authCode, "ascii");
  const body = Buffer.alloc(3 + authBuf.length);
  body.writeUInt16BE(ackSerial, 0);
  body.writeUInt8(result, 2);
  authBuf.copy(body, 3);
  return buildResponse(0x8100, phoneBytes, serialNum, body);
}

function extractFrames(data) {
  const frames = [];
  let start = -1;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x7e) {
      if (start >= 0 && i > start + 1) {
        frames.push(data.subarray(start + 1, i));
      }
      start = i;
    }
  }
  return frames;
}

// ─── Forward raw frame to API ────────────────────────────────────────────────

function forwardRawFrame(deviceId, rawHex, msgId) {
  const payload = JSON.stringify({ deviceId, msgId, rawHex });
  log(`Forwarding raw frame: msgId=0x${msgId.toString(16).padStart(4,"0")} (${rawHex.length / 2} bytes)`);

  const req = https.request({
    hostname: API_HOST,
    path: API_PATH,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  }, (res) => log(`API responded: ${res.statusCode}`));

  req.on("error", (err) => log(`API error: ${err.message}`));
  req.write(payload);
  req.end();
}

// ─── TCP Server ──────────────────────────────────────────────────────────────
let serverSerial = 0;

const server = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`Client connected: ${clientId}`);

  socket.on("data", (chunk) => {
    if (chunk.toString("ascii", 0, 4) === "GET ") {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
      socket.end();
      return;
    }

    log(`Received ${chunk.length} bytes from ${clientId}`);

    const frames = extractFrames(chunk);
    for (const raw of frames) {
      const frame = unescape808(raw);
      if (frame.length < 12) continue;

      const msgId = frame.readUInt16BE(0);
      const phone = frame.subarray(4, 10);
      const serial = frame.readUInt16BE(10);
      const deviceId = phone.toString("hex").replace(/^0+/, "");
      const rawHex = chunk.toString("hex");

      log(`[${deviceId}] Message 0x${msgId.toString(16).padStart(4, "0")}, serial=${serial}`);

      // Forward every frame to the backend
      forwardRawFrame(deviceId, rawHex, msgId);

      // Still handle protocol responses so the tracker stays connected
      switch (msgId) {
        case 0x0100:
          socket.write(buildRegisterAck(phone, serverSerial++, serial, 0, "AUTH" + deviceId));
          log(`[${deviceId}] Registration ack sent`);
          break;
        case 0x0102:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          log(`[${deviceId}] Auth ack sent`);

          // Set GPS-related terminal parameters (0x8103)
          {
            const params = [];

            // 0x0020: Location reporting strategy (DWORD)
            // 0 = timed reporting, 1 = by distance, 2 = timed + distance
            const p1 = Buffer.alloc(9);
            p1.writeUInt32BE(0x0020, 0); p1.writeUInt8(4, 4); p1.writeUInt32BE(0, 5);
            params.push(p1);

            // 0x0021: Location reporting scheme (DWORD)
            // 0 = based on ACC, 1 = based on login status
            const p2 = Buffer.alloc(9);
            p2.writeUInt32BE(0x0021, 0); p2.writeUInt8(4, 4); p2.writeUInt32BE(0, 5);
            params.push(p2);

            // 0x0027: Sleep reporting interval (DWORD, seconds)
            const p3 = Buffer.alloc(9);
            p3.writeUInt32BE(0x0027, 0); p3.writeUInt8(4, 4); p3.writeUInt32BE(10, 5);
            params.push(p3);

            // 0x0028: Emergency alarm reporting interval (DWORD, seconds)
            const p4 = Buffer.alloc(9);
            p4.writeUInt32BE(0x0028, 0); p4.writeUInt8(4, 4); p4.writeUInt32BE(5, 5);
            params.push(p4);

            // 0x0029: Default reporting interval (DWORD, seconds)
            const p5 = Buffer.alloc(9);
            p5.writeUInt32BE(0x0029, 0); p5.writeUInt8(4, 4); p5.writeUInt32BE(10, 5);
            params.push(p5);

            // 0x0001: Heartbeat interval (DWORD, seconds)
            const p6 = Buffer.alloc(9);
            p6.writeUInt32BE(0x0001, 0); p6.writeUInt8(4, 4); p6.writeUInt32BE(30, 5);
            params.push(p6);

            const paramCount = Buffer.alloc(1);
            paramCount.writeUInt8(params.length, 0);
            const setBody = Buffer.concat([paramCount, ...params]);
            socket.write(buildResponse(0x8103, phone, serverSerial++, setBody));
            log(`[${deviceId}] Set GPS params: strategy=timed, sleep=10s, default=10s`);
          }

          // Request immediate location
          socket.write(buildResponse(0x8201, phone, serverSerial++, Buffer.alloc(0)));
          log(`[${deviceId}] Location query sent`);

          // Temporary location tracking (0x8202) - every 5s indefinitely
          {
            const trackBody = Buffer.alloc(4);
            trackBody.writeUInt16BE(5, 0);     // interval: 5 seconds
            trackBody.writeUInt16BE(0xFFFF, 2); // duration: indefinite
            socket.write(buildResponse(0x8202, phone, serverSerial++, trackBody));
            log(`[${deviceId}] Temporary tracking: every 5s indefinitely`);
          }
          break;
        case 0x0200:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          break;
        case 0x0002:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          log(`[${deviceId}] Heartbeat ack`);
          break;
        case 0x0107: {
          // Terminal attribute report - device tells us its capabilities
          // Respond with query terminal params to trigger full config exchange
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          log(`[${deviceId}] Terminal attribute report received, ack sent`);
          
          // Query all terminal parameters (0x8104) - empty body
          socket.write(buildResponse(0x8104, phone, serverSerial++, Buffer.alloc(0)));
          log(`[${deviceId}] Queried all terminal parameters`);
          break;
        }
        case 0x0001: {
          // Terminal general response - device acking our commands
          const bodyLen2 = frame.readUInt16BE(2) & 0x03ff;
          const respBody2 = frame.subarray(12, 12 + bodyLen2);
          if (respBody2.length >= 5) {
            const ackId = respBody2.readUInt16BE(2);
            const result = respBody2.readUInt8(4);
            log(`[${deviceId}] Device ack: cmd=0x${ackId.toString(16).padStart(4,"0")} result=${result === 0 ? "OK" : "FAIL(" + result + ")"}`);
          }
          break;
        }
        case 0x0104: {
          // Terminal parameter response
          const bodyLen3 = frame.readUInt16BE(2) & 0x03ff;
          const respBody3 = frame.subarray(12, 12 + bodyLen3);
          log(`[${deviceId}] Terminal params (${respBody3.length} bytes): ${respBody3.subarray(0, Math.min(64, respBody3.length)).toString("hex")}...`);
          break;
        }
        default:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          log(`[${deviceId}] Unknown 0x${msgId.toString(16).padStart(4, "0")}, ack sent`);
      }
    }
  });

  socket.on("end", () => log(`Client disconnected: ${clientId}`));
  socket.on("error", (err) => log(`Socket error from ${clientId}: ${err.message}`));
});

server.on("error", (err) => log(`Server error: ${err.message}`));

server.listen(PORT, HOST, () => {
  log(`TCP server listening on ${HOST}:${PORT}`);
});
