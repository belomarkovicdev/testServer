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
          socket.write(buildResponse(0x8201, phone, serverSerial++, Buffer.alloc(0)));
          log(`[${deviceId}] Auth ack + location query sent`);
          break;
        case 0x0200:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          break;
        case 0x0002:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          log(`[${deviceId}] Heartbeat ack`);
          break;
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
