const net = require("net");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.RAILWAY_TCP_APPLICATION_PORT || process.env.PORT || "9000", 10);
const HOST = "0.0.0.0";
const API_HOST = process.env.API_HOST ||
  "https://pet-tracker-gfe7aygtbbhhb3b3.westeurope-01.azurewebsites.net";
const API_PATH = "/api/location/raw";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
// ──────────────────────────────────────────────────────────────────────────────

function log(text) {
  console.log(`[${new Date().toISOString()}] ${text}`);
}

// ─── Device socket registry: IMEI → { socket, phone } ────────────────────────
const deviceRegistry = new Map();

// ─── JT/T 808 Protocol helpers ───────────────────────────────────────────────
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
  for (const b of buf) {
    if (b === 0x7e) out.push(0x7d, 0x02);
    else if (b === 0x7d) out.push(0x7d, 0x01);
    else out.push(b);
  }
  return Buffer.from(out);
}

function calcChecksum(buf) {
  let cs = 0;
  for (const b of buf) cs ^= b;
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
      if (start >= 0 && i > start + 1) frames.push(data.subarray(start + 1, i));
      start = i;
    }
  }
  return frames;
}

// ─── ICAR ASCII command framing ───────────────────────────────────────────────
function buildAsciiCommand(cmd) {
  return Buffer.concat([Buffer.from([0x7e]), Buffer.from(cmd, "ascii"), Buffer.from([0x7e])]);
}

// ─── Pending ack registry: "deviceId:ackMsgId" → { resolve, timer } ──────────
const pendingAcks = new Map();

function resolveDeviceAck(deviceId, ackMsgId, result) {
  const key = `${deviceId}:${ackMsgId}`;
  const pending = pendingAcks.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingAcks.delete(key);
    pending.resolve(result === 0 ? "OK" : `FAIL(${result})`);
  }
}

function waitForDeviceAck(deviceId, ackMsgId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const key = `${deviceId}:${ackMsgId}`;
    const timer = setTimeout(() => {
      pendingAcks.delete(key);
      resolve("timeout");
    }, timeoutMs);
    pendingAcks.set(key, { resolve, timer });
  });
}

// ─── Command dispatch ─────────────────────────────────────────────────────────
async function sendCommand(deviceId, commandType, params, level) {
  const entry = deviceRegistry.get(deviceId);
  if (!entry) return { ok: false, reason: "device_not_connected" };
  if (!entry.socket || entry.socket.destroyed) {
    deviceRegistry.delete(deviceId);
    return { ok: false, reason: "device_not_connected" };
  }

  const builders = {
    RESTART:       () => buildAsciiCommand("SL RT"),
    FACTORY_RESET: () => buildAsciiCommand("SL FT"),
    CHECK_CONFIG:  () => buildAsciiCommand("SL CX"),
    BUZZER:        () => buildAsciiCommand("SL XG"),
    SET_INTERVAL:  () => params ? buildAsciiCommand(`SL SC${params}`) : null,
    SET_APN:       () => params ? buildAsciiCommand(`SL APN${params}`) : null,
    SET_SERVER:    () => params ? buildAsciiCommand(`SL DP${params}`) : null,
    SET_ADMIN:     () => params ? buildAsciiCommand(`SL CP${params}#`) : null,
    SOUND:         () => buildAsciiCommand(`SL SND${Math.min(9, Math.max(1, level || 5))}`),
    VIBRATION:     () => buildAsciiCommand(`SL VIB${Math.min(9, Math.max(1, level || 5))}`),
    SHOCK:         () => buildAsciiCommand(`SL SHK${Math.min(9, Math.max(1, level || 5))}`),
    LED_STROBE:    () => buildAsciiCommand("SL LED"),
    VOICE_MONITOR: () => buildAsciiCommand("SL VM"),
  };

  const builder = builders[commandType];
  if (!builder) return { ok: false, reason: "unknown_command" };

  const frame = builder();
  if (!frame) return { ok: false, reason: "missing_params" };

  entry.socket.write(frame);
  log(`[${deviceId}] Command sent: ${commandType}${params ? " params=" + params : ""}${level ? " level=" + level : ""}`);

  // Respond immediately — don't block waiting for device ack
  // Ack will be logged when device replies with 0x0001 (handled in processDeviceData)
  waitForDeviceAck(deviceId, 0x0001).then((deviceAck) => {
    log(`[${deviceId}] Device ack for ${commandType}: ${deviceAck}`);
  });

  return { ok: true, deviceAck: "pending" };
}

// ─── Forward raw frame to Spring backend ─────────────────────────────────────
function forwardRawFrame(deviceId, rawHex, msgId) {
  const https = require("https");
  const payload = JSON.stringify({ deviceId, msgId, rawHex });
  const url = new URL(API_PATH, API_HOST);
  const req = https.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  }, (res) => log(`API responded: ${res.statusCode}`));
  req.on("error", (err) => log(`API error: ${err.message}`));
  req.write(payload);
  req.end();
}

// ─── HTTP request handler ─────────────────────────────────────────────────────
async function handleHttp(socket, firstChunk) {
  // Buffer the full request in case body arrives in multiple chunks
  let rawBuffer = firstChunk;

  await new Promise((resolve) => {
    // Give up to 500ms for remaining chunks to arrive
    const timeout = setTimeout(resolve, 500);
    socket.on("data", (chunk) => {
      rawBuffer = Buffer.concat([rawBuffer, chunk]);
      // If we have headers + body, resolve early
      const raw = rawBuffer.toString("utf8");
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const contentLengthMatch = raw.match(/content-length:\s*(\d+)/i);
        if (contentLengthMatch) {
          const contentLength = parseInt(contentLengthMatch[1], 10);
          const bodyStart = headerEnd + 4;
          if (rawBuffer.length >= bodyStart + contentLength) {
            clearTimeout(timeout);
            resolve();
          }
        } else {
          clearTimeout(timeout);
          resolve();
        }
      }
    });
  });

  const raw = rawBuffer.toString("utf8");
  const firstLine = raw.split("\r\n")[0];
  const [method, path] = firstLine.split(" ");

  // Health check
  if (method === "GET" && path === "/health") {
    log(`[HTTP] GET /health`);
    const body = JSON.stringify({ status: "ok", connectedDevices: deviceRegistry.size });
    socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.end();
    return;
  }

  // Connected devices list
  if (method === "GET" && path === "/devices") {
    if (BRIDGE_SECRET) {
      const secretHeader = raw.match(/x-bridge-secret:\s*(.+)/i)?.[1]?.trim();
      if (secretHeader !== BRIDGE_SECRET) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized");
        socket.end();
        return;
      }
    }
    const body = JSON.stringify({ devices: [...deviceRegistry.keys()] });
    socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.end();
    return;
  }

  // Command endpoint
  if (method === "POST" && path === "/command") {
    log(`[HTTP] POST /command received`);
    if (BRIDGE_SECRET) {
      const secretHeader = raw.match(/x-bridge-secret:\s*(.+)/i)?.[1]?.trim();
      if (secretHeader !== BRIDGE_SECRET) {
        log(`[HTTP] Unauthorized - secret mismatch`);
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized");
        socket.end();
        return;
      }
    }

    const bodyStart = raw.indexOf("\r\n\r\n");
    const bodyStr = bodyStart >= 0 ? raw.slice(bodyStart + 4) : "";
    log(`[HTTP] Raw body: ${bodyStr}`);
    let parsed;
    try { parsed = JSON.parse(bodyStr); }
    catch (e) {
      log(`[HTTP] JSON parse error: ${e.message}`);
      socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 12\r\n\r\nInvalid JSON");
      socket.end();
      return;
    }

    const { deviceId, commandType, params, level } = parsed;
    log(`[HTTP] Command request: deviceId=${deviceId} commandType=${commandType} params=${params} level=${level}`);
    log(`[HTTP] Connected devices: ${[...deviceRegistry.keys()].join(", ") || "none"}`);

    if (!deviceId || !commandType) {
      const body = JSON.stringify({ ok: false, reason: "missing_deviceId_or_commandType" });
      socket.write(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.end();
      return;
    }

    const result = await sendCommand(deviceId, commandType, params, level);
    log(`[HTTP] sendCommand result: ${JSON.stringify(result)}`);
    const status = result.ok ? "200 OK" : result.reason === "device_not_connected" ? "404 Not Found" : "400 Bad Request";
    const body = JSON.stringify(result);
    socket.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.end();
    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot found");
  socket.end();
}

// ─── TCP Server ───────────────────────────────────────────────────────────────
let serverSerial = 0;

const server = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`Client connected: ${clientId}`);
  let currentDeviceId = null;

  socket.once("data", (firstChunk) => {
    const peek = firstChunk.toString("ascii", 0, 8);
    if (peek.startsWith("GET ") || peek.startsWith("POST ") || peek.startsWith("HEAD ")) {
      handleHttp(socket, firstChunk);
      return;
    }

    processDeviceData(socket, firstChunk, clientId, (id) => { currentDeviceId = id; });
    socket.on("data", (chunk) => {
      processDeviceData(socket, chunk, clientId, (id) => { currentDeviceId = id; });
    });
  });

  socket.on("end", () => {
    log(`Client disconnected: ${clientId}`);
    if (currentDeviceId) {
      deviceRegistry.delete(currentDeviceId);
      log(`[${currentDeviceId}] Removed from registry`);
    }
  });

  socket.on("error", (err) => {
    log(`Socket error from ${clientId}: ${err.message}`);
    if (currentDeviceId) deviceRegistry.delete(currentDeviceId);
  });
});

function processDeviceData(socket, chunk, clientId, onDeviceId) {
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

    if (!deviceRegistry.has(deviceId) || deviceRegistry.get(deviceId).socket !== socket) {
      deviceRegistry.set(deviceId, { socket, phone });
      onDeviceId(deviceId);
      log(`[${deviceId}] Registered in device registry`);
    }

    forwardRawFrame(deviceId, rawHex, msgId);

    switch (msgId) {
      case 0x0100:
        socket.write(buildRegisterAck(phone, serverSerial++, serial, 0, "AUTH" + deviceId));
        log(`[${deviceId}] Registration ack sent`);
        break;

      case 0x0102:
        socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
        log(`[${deviceId}] Auth ack sent`);
        {
          const makeParam = (id, val) => {
            const p = Buffer.alloc(9);
            p.writeUInt32BE(id, 0); p.writeUInt8(4, 4); p.writeUInt32BE(val, 5);
            return p;
          };
          const params = [
            makeParam(0x0020, 0),
            makeParam(0x0021, 0),
            makeParam(0x0027, 10),
            makeParam(0x0028, 5),
            makeParam(0x0029, 10),
            makeParam(0x0001, 30),
          ];
          const count = Buffer.alloc(1);
          count.writeUInt8(params.length, 0);
          socket.write(buildResponse(0x8103, phone, serverSerial++, Buffer.concat([count, ...params])));
          socket.write(buildResponse(0x8201, phone, serverSerial++, Buffer.alloc(0)));
          const trackBody = Buffer.alloc(4);
          trackBody.writeUInt16BE(5, 0);
          trackBody.writeUInt16BE(0xffff, 2);
          socket.write(buildResponse(0x8202, phone, serverSerial++, trackBody));
          log(`[${deviceId}] GPS params + tracking configured`);
        }
        break;

      case 0x0200:
        socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
        break;

      case 0x0002:
        socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
        log(`[${deviceId}] Heartbeat ack`);
        break;

      case 0x0107:
        socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
        socket.write(buildResponse(0x8104, phone, serverSerial++, Buffer.alloc(0)));
        log(`[${deviceId}] Terminal attribute report, queried all params`);
        break;

      case 0x0001: {
        const bodyLen = frame.readUInt16BE(2) & 0x03ff;
        const respBody = frame.subarray(12, 12 + bodyLen);
        if (respBody.length >= 5) {
          const ackId = respBody.readUInt16BE(2);
          const result = respBody.readUInt8(4);
          log(`[${deviceId}] Device ack: cmd=0x${ackId.toString(16).padStart(4, "0")} result=${result === 0 ? "OK" : "FAIL(" + result + ")"}`);
          resolveDeviceAck(deviceId, ackId, result);
        }
        break;
      }

      case 0x0104: {
        const bodyLen = frame.readUInt16BE(2) & 0x03ff;
        const respBody = frame.subarray(12, 12 + bodyLen);
        log(`[${deviceId}] Terminal params: ${respBody.subarray(0, Math.min(64, respBody.length)).toString("hex")}`);
        break;
      }

      default:
        socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
        log(`[${deviceId}] Unknown 0x${msgId.toString(16).padStart(4, "0")}, ack sent`);
    }
  }
}

server.on("error", (err) => log(`Server error: ${err.message}`));
server.listen(PORT, HOST, () => log(`Bridge server listening on ${HOST}:${PORT} (TCP devices + HTTP commands)`));
