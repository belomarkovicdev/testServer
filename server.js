const net = require("net");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.RAILWAY_TCP_APPLICATION_PORT || process.env.PORT || "9000", 10);
const HOST = "0.0.0.0";
const API_HOST = process.env.API_HOST ||
  "https://pet-tracker-gfe7aygtbbhhb3b3.westeurope-01.azurewebsites.net";
const API_PATH = "/api/location/raw";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
const ICAR_HOST = process.env.ICAR_HOST || "a.icargps.net";
const ICAR_PORT = parseInt(process.env.ICAR_PORT || "7700", 10);
const PROXY_MODE = process.env.PROXY_MODE === "true";
// ──────────────────────────────────────────────────────────────────────────────

function log(text) { console.log(`[${new Date().toISOString()}] ${text}`); }

// ─── Device socket registry: IMEI → { socket, phone } ────────────────────────
const deviceRegistry = new Map();

// ─── JT808 helpers ───────────────────────────────────────────────────────────
function unescape808(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d && i + 1 < buf.length) {
      if (buf[i + 1] === 0x02) { out.push(0x7e); i++; }
      else if (buf[i + 1] === 0x01) { out.push(0x7d); i++; }
      else out.push(buf[i]);
    } else out.push(buf[i]);
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

// ─── Pending ack registry ─────────────────────────────────────────────────────
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
    const timer = setTimeout(() => { pendingAcks.delete(key); resolve("timeout"); }, timeoutMs);
    pendingAcks.set(key, { resolve, timer });
  });
}

// ─── Frame decoder (human-friendly log) ──────────────────────────────────────
function decode8105Body(body) {
  if (body.length === 0) return "no body";
  const b0 = body[0];
  if (b0 === 0x0c) return `[${body.toString("hex")}] : find lost device (continuous sound)`;
  if (b0 === 0x0d) return `[${body.toString("hex")}] : night light`;
  if (b0 === 0x0f) return `[${body.toString("hex")}] : training sound`;
  if (b0 === 0x0e && body.length >= 2) {
    const lvl = body[1] - 0x30;
    return `[${body.toString("hex")}] : shock level ${lvl}`;
  }
  return `[${body.toString("hex")}] : unknown 0x8105 subtype`;
}

function decode8103Body(body) {
  if (body.length < 6) return `[${body.toString("hex")}] : set params`;
  const paramId = body.readUInt32BE(1);
  const paramLen = body[5];
  if (paramId === 0x00000029 && paramLen === 4 && body.length >= 10) {
    const seconds = body.readUInt32BE(6);
    return `[${body.toString("hex")}] : set interval ${seconds}s`;
  }
  if (paramId === 0x0000f159) return `[${body.toString("hex")}] : low power ${body[body.length - 1] === 0x08 ? "ON" : "OFF"}`;
  if (paramId === 0x0000f160) return `[${body.toString("hex")}] : shutdown lock ${body[body.length - 1] === 0x33 ? "ON" : "OFF"}`;
  return `[${body.toString("hex")}] : set params id=0x${paramId.toString(16).padStart(8,"0")}`;
}

function decodeCommandFrame(msgId, body) {
  switch (msgId) {
    case 0x8105: return decode8105Body(body);
    case 0x8103: return decode8103Body(body);
    case 0x8155: return `[] : restart device`;
    case 0x8201: return `[] : wake up / request location`;
    case 0x8116: return `[${body.toString("hex")}] : voice monitor on (30s)`;
    case 0x8131: return `[${body.toString("hex")}] : timer boot`;
    case 0x8001: return `[${body.toString("hex")}] : server ack`;
    default:     return `[${body.toString("hex")}] : msgId=0x${msgId.toString(16).padStart(4,"0")}`;
  }
}

function decodeDeviceAck(ackMsgId, result) {
  const resultStr = result === 0 ? "OK" : `FAIL(${result})`;
  switch (ackMsgId) {
    case 0x8105: return `device ack → 0x8105 (sound/shock/light) : ${resultStr}`;
    case 0x8103: return `device ack → 0x8103 (set params) : ${resultStr}`;
    case 0x8155: return `device ack → 0x8155 (restart) : ${resultStr}`;
    case 0x8201: return `device ack → 0x8201 (wake up) : ${resultStr}`;
    case 0x8116: return `device ack → 0x8116 (voice monitor) : ${resultStr}`;
    case 0x8131: return `device ack → 0x8131 (timer boot) : ${resultStr}`;
    default:     return `device ack → 0x${ackMsgId.toString(16).padStart(4,"0")} : ${resultStr}`;
  }
}


const COMMAND_FRAMES = {
  TRAINING_SOUND:    { msgId: 0x8105, body: () => Buffer.from([0x0f]) },
  FIND_SOUND:        { msgId: 0x8105, body: () => Buffer.from([0x0c]) },
  NIGHT_LIGHT:       { msgId: 0x8105, body: () => Buffer.from([0x0d]) },
  SHOCK:             { msgId: 0x8105, body: (lvl) => { const l = (lvl >= 1 && lvl <= 9) ? lvl : 1; return Buffer.from([0x0e, 0x30 + l]); } },
  RESTART:           { msgId: 0x8155, body: () => Buffer.alloc(0) },
  WAKE_UP:           { msgId: 0x8201, body: () => Buffer.alloc(0) },
  LOW_POWER_ON:      { msgId: 0x8103, body: () => Buffer.from([0x01, 0x00, 0x00, 0xf1, 0x59, 0x01, 0x08]) },
  LOW_POWER_OFF:     { msgId: 0x8103, body: () => Buffer.from([0x01, 0x00, 0x00, 0xf1, 0x59, 0x01, 0x09]) },
  SHUTDOWN_LOCK_ON:  { msgId: 0x8103, body: () => Buffer.from([0x01, 0x00, 0x00, 0xf1, 0x60, 0x01, 0x33]) },
  SHUTDOWN_LOCK_OFF: { msgId: 0x8103, body: () => Buffer.from([0x01, 0x00, 0x00, 0xf1, 0x60, 0x01, 0x32]) },
  VOICE_MONITOR_ON:  { msgId: 0x8116, body: () => Buffer.from([0x1e, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31]) },
  TIMER_BOOT:        { msgId: 0x8131, body: () => Buffer.from([0x01, 0x01, 0x23, 0x01, 0x24, 0x00, 0x9a]) },
};

function buildSetIntervalBody(seconds) {
  // 0x8103: 1 param, paramId=0x00000029 (default interval), len=4, value=seconds
  const body = Buffer.alloc(10);
  body.writeUInt8(0x01, 0);        // param count
  body.writeUInt32BE(0x00000029, 1); // param id
  body.writeUInt8(0x04, 5);        // param length
  body.writeUInt32BE(seconds, 6);  // value
  return body;
}

function sendCommand(deviceId, commandType, level) {
  const entry = deviceRegistry.get(deviceId);
  if (!entry) return { ok: false, reason: "device_not_connected" };
  if (!entry.socket || entry.socket.destroyed) {
    deviceRegistry.delete(deviceId);
    return { ok: false, reason: "device_not_connected" };
  }

  const { socket, phone } = entry;
  let msgId, body;

  if (commandType === "SET_INTERVAL") {
    const seconds = level && level > 0 ? level : 10;
    msgId = 0x8103;
    body = buildSetIntervalBody(seconds);
  } else {
    const cmd = COMMAND_FRAMES[commandType];
    if (!cmd) return { ok: false, reason: "unknown_command" };
    msgId = cmd.msgId;
    body = cmd.body(level);
  }

  const frame = buildResponse(msgId, phone, serverSerial++, body);
  socket.write(frame);
  log(`[COMMAND] Sent ${commandType} → ${decodeCommandFrame(msgId, body)}`);

  return { ok: true };
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

// ─── PROXY MODE ───────────────────────────────────────────────────────────────
function handleProxyMode(deviceSocket, firstChunk, clientId) {
  log(`[PROXY] Connecting to ICAR ${ICAR_HOST}:${ICAR_PORT}`);
  const icarSocket = net.createConnection({ host: ICAR_HOST, port: ICAR_PORT }, () => {
    log(`[PROXY] Connected to ICAR server`);
    icarSocket.write(firstChunk);
  });

  deviceSocket.on("data", (chunk) => {
    const frames = extractFrames(chunk);
    for (const raw of frames) {
      const frame = unescape808(raw);
      if (frame.length < 12) continue;
      const msgId = frame.readUInt16BE(0);
      const bodyLen = frame.readUInt16BE(2) & 0x03ff;
      const phone = frame.subarray(4, 10);
      const deviceId = phone.toString("hex").replace(/^0+/, "");
      const body = frame.subarray(12, 12 + bodyLen);

      let decoded;
      switch (msgId) {
        case 0x0200: decoded = "location report"; forwardRawFrame(deviceId, chunk.toString("hex"), msgId); break;
        case 0x0002: decoded = "heartbeat"; break;
        case 0x0100: decoded = "registration"; break;
        case 0x0102: decoded = "auth"; break;
        case 0x0107: decoded = "terminal attributes"; break;
        case 0x0001: {
          if (body.length >= 5) {
            const ackId = body.readUInt16BE(2);
            const result = body.readUInt8(4);
            decoded = decodeDeviceAck(ackId, result);
          } else if (body.length >= 3) {
            decoded = `ack (short) result=${body.readUInt8(2) === 0 ? "OK" : "FAIL(" + body.readUInt8(2) + ")"}`;
          } else decoded = `ack body=${body.toString("hex")}`;
          break;
        }
        default: decoded = `msgId=0x${msgId.toString(16).padStart(4,"0")} body=${body.toString("hex")}`;
      }
      log(`[PROXY] Device→ICAR [${deviceId}] ${decoded}`);
    }
    if (!icarSocket.destroyed) icarSocket.write(chunk);
  });

  icarSocket.on("data", (chunk) => {
    const frames = extractFrames(chunk);
    for (const raw of frames) {
      const frame = unescape808(raw);
      if (frame.length < 4) continue;
      const msgId = frame.readUInt16BE(0);
      const bodyLen = frame.readUInt16BE(2) & 0x03ff;
      const body = frame.subarray(12, 12 + bodyLen);
      const decoded = decodeCommandFrame(msgId, body);
      log(`[PROXY] ICAR→Device ${decoded}`);
    }
    if (!deviceSocket.destroyed) deviceSocket.write(chunk);
  });

  icarSocket.on("error", (err) => log(`[PROXY] ICAR socket error: ${err.message}`));
  icarSocket.on("end", () => { log(`[PROXY] ICAR disconnected`); deviceSocket.end(); });
  deviceSocket.on("end", () => { log(`[PROXY] Device disconnected`); icarSocket.end(); });
  deviceSocket.on("error", (err) => { log(`[PROXY] Device error: ${err.message}`); icarSocket.end(); });
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────
async function handleHttp(socket, firstChunk) {
  let rawBuffer = firstChunk;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 500);
    socket.on("data", (chunk) => {
      rawBuffer = Buffer.concat([rawBuffer, chunk]);
      const raw = rawBuffer.toString("utf8");
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        const clMatch = raw.match(/content-length:\s*(\d+)/i);
        if (clMatch) {
          if (rawBuffer.length >= headerEnd + 4 + parseInt(clMatch[1], 10)) { clearTimeout(timeout); resolve(); }
        } else { clearTimeout(timeout); resolve(); }
      }
    });
  });

  const raw = rawBuffer.toString("utf8");
  const [method, path] = raw.split("\r\n")[0].split(" ");

  if (method === "GET" && path === "/health") {
    const body = JSON.stringify({ status: "ok", connectedDevices: deviceRegistry.size, proxyMode: PROXY_MODE });
    socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.end(); return;
  }

  if (method === "GET" && path === "/devices") {
    if (BRIDGE_SECRET && raw.match(/x-bridge-secret:\s*(.+)/i)?.[1]?.trim() !== BRIDGE_SECRET) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized");
      socket.end(); return;
    }
    const body = JSON.stringify({ devices: [...deviceRegistry.keys()] });
    socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.end(); return;
  }

  if (method === "POST" && path === "/command") {
    if (BRIDGE_SECRET && raw.match(/x-bridge-secret:\s*(.+)/i)?.[1]?.trim() !== BRIDGE_SECRET) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 12\r\n\r\nUnauthorized");
      socket.end(); return;
    }
    const bodyStart = raw.indexOf("\r\n\r\n");
    const bodyStr = bodyStart >= 0 ? raw.slice(bodyStart + 4) : "";
    let parsed;
    try { parsed = JSON.parse(bodyStr); }
    catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 12\r\n\r\nInvalid JSON");
      socket.end(); return;
    }
    const { deviceId, commandType, level } = parsed;
    if (!deviceId || !commandType) {
      const body = JSON.stringify({ ok: false, reason: "missing_deviceId_or_commandType" });
      socket.write(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.end(); return;
    }
    log(`[COMMAND] Request: deviceId=${deviceId} commandType=${commandType}${level ? " level=" + level : ""}`);
    const result = sendCommand(deviceId, commandType, level);
    const status = result.ok ? "200 OK" : result.reason === "device_not_connected" ? "404 Not Found" : "400 Bad Request";
    const body = JSON.stringify(result);
    socket.write(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.end(); return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot found");
  socket.end();
}

// ─── Normal mode device processing ───────────────────────────────────────────
let serverSerial = 0;

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

    log(`[${deviceId}] Message 0x${msgId.toString(16).padStart(4,"0")}, serial=${serial}`);

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
        {
          const makeParam = (id, val) => {
            const p = Buffer.alloc(9);
            p.writeUInt32BE(id, 0); p.writeUInt8(4, 4); p.writeUInt32BE(val, 5);
            return p;
          };
          const params = [
            makeParam(0x0020, 0), makeParam(0x0021, 0), makeParam(0x0027, 10),
            makeParam(0x0028, 5), makeParam(0x0029, 10), makeParam(0x0001, 30),
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
        log(`[${deviceId}] Terminal attribute report`);
        break;

      case 0x0001: {
        const bodyLen = frame.readUInt16BE(2) & 0x03ff;
        const respBody = frame.subarray(12, 12 + bodyLen);
        if (respBody.length >= 5) {
          const ackId = respBody.readUInt16BE(2);
          const result = respBody.readUInt8(4);
          log(`[${deviceId}] ${decodeDeviceAck(ackId, result)}`);
          resolveDeviceAck(deviceId, ackId, result);
        } else if (respBody.length >= 3) {
          // some devices send: responseSerial(2) + result(1), no ackMsgId
          const result = respBody.readUInt8(2);
          log(`[${deviceId}] device ack (short form) result=${result === 0 ? "OK" : "FAIL(" + result + ")"} body=${respBody.toString("hex")}`);
        } else {
          log(`[${deviceId}] device ack body too short: ${respBody.toString("hex")}`);
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
        log(`[${deviceId}] Unknown 0x${msgId.toString(16).padStart(4,"0")}, ack sent`);
    }
  }
}

// ─── TCP Server ───────────────────────────────────────────────────────────────
const server = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`Client connected: ${clientId} (proxyMode=${PROXY_MODE})`);
  let currentDeviceId = null;

  socket.once("data", (firstChunk) => {
    const peek = firstChunk.toString("ascii", 0, 8);
    if (peek.startsWith("GET ") || peek.startsWith("POST ") || peek.startsWith("HEAD ")) {
      handleHttp(socket, firstChunk); return;
    }
    if (PROXY_MODE) {
      handleProxyMode(socket, firstChunk, clientId); return;
    }
    processDeviceData(socket, firstChunk, clientId, (id) => { currentDeviceId = id; });
    socket.on("data", (chunk) => {
      processDeviceData(socket, chunk, clientId, (id) => { currentDeviceId = id; });
    });
  });

  socket.on("end", () => {
    log(`Client disconnected: ${clientId}`);
    if (currentDeviceId) { deviceRegistry.delete(currentDeviceId); log(`[${currentDeviceId}] Removed from registry`); }
  });
  socket.on("error", (err) => {
    log(`Socket error from ${clientId}: ${err.message}`);
    if (currentDeviceId) deviceRegistry.delete(currentDeviceId);
  });
});

server.on("error", (err) => log(`Server error: ${err.message}`));
server.listen(PORT, HOST, () => log(`Bridge server listening on ${HOST}:${PORT} (proxyMode=${PROXY_MODE})`));
