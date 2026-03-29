"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unescape808 = unescape808;
exports.escape808 = escape808;
exports.calcChecksum = calcChecksum;
exports.buildResponse = buildResponse;
exports.buildAck = buildAck;
exports.buildRegisterAck = buildRegisterAck;
exports.extractFrames = extractFrames;
exports.parseLBS = parseLBS;
exports.parseLocation = parseLocation;
// ─── Escape / Unescape ──────────────────────────────────────────────────────
function unescape808(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x7d && i + 1 < buf.length) {
            if (buf[i + 1] === 0x02) {
                out.push(0x7e);
                i++;
            }
            else if (buf[i + 1] === 0x01) {
                out.push(0x7d);
                i++;
            }
            else
                out.push(buf[i]);
        }
        else {
            out.push(buf[i]);
        }
    }
    return Buffer.from(out);
}
function escape808(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x7e) {
            out.push(0x7d, 0x02);
        }
        else if (buf[i] === 0x7d) {
            out.push(0x7d, 0x01);
        }
        else
            out.push(buf[i]);
    }
    return Buffer.from(out);
}
function calcChecksum(buf) {
    let cs = 0;
    for (let i = 0; i < buf.length; i++)
        cs ^= buf[i];
    return cs;
}
// ─── Frame Building ─────────────────────────────────────────────────────────
function buildResponse(msgId, phone, serial, body) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(msgId, 0);
    header.writeUInt16BE(body.length, 2);
    phone.copy(header, 4);
    header.writeUInt16BE(serial, 10);
    const payload = Buffer.concat([header, body]);
    const cs = calcChecksum(payload);
    const escaped = escape808(Buffer.concat([payload, Buffer.from([cs])]));
    return Buffer.concat([Buffer.from([0x7e]), escaped, Buffer.from([0x7e])]);
}
function buildAck(phone, serial, ackSerial, ackMsgId, result) {
    const body = Buffer.alloc(5);
    body.writeUInt16BE(ackSerial, 0);
    body.writeUInt16BE(ackMsgId, 2);
    body.writeUInt8(result, 4);
    return buildResponse(0x8001, phone, serial, body);
}
function buildRegisterAck(phone, serial, ackSerial, result, authCode) {
    const authBuf = Buffer.from(authCode, "ascii");
    const body = Buffer.alloc(3 + authBuf.length);
    body.writeUInt16BE(ackSerial, 0);
    body.writeUInt8(result, 2);
    authBuf.copy(body, 3);
    return buildResponse(0x8100, phone, serial, body);
}
// ─── Frame Extraction ───────────────────────────────────────────────────────
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
// ─── Parsing ────────────────────────────────────────────────────────────────
function parseExtras(body) {
    const extras = {};
    let offset = 28;
    while (offset < body.length) {
        const id = body.readUInt8(offset++);
        if (offset >= body.length)
            break;
        const len = body.readUInt8(offset++);
        if (offset + len > body.length)
            break;
        extras[id] = body.subarray(offset, offset + len);
        offset += len;
    }
    return extras;
}
function parseLBS(buf) {
    if (buf.length < 4)
        return null;
    const mcc = buf.readUInt16BE(0);
    const mnc = buf.readUInt16BE(2);
    const towers = [];
    let offset = 4;
    while (offset + 8 <= buf.length) {
        towers.push({
            mcc, mnc,
            lac: buf.readUInt16BE(offset + 1),
            cellId: buf.readUInt16BE(offset + 4),
            signal: buf.readUInt8(offset + 6),
            rssi: buf.readUInt8(offset + 7),
        });
        offset += 8;
    }
    return towers;
}
function parseLocation(body) {
    if (body.length < 28)
        return null;
    const alarm = body.readUInt32BE(0);
    const status = body.readUInt32BE(4);
    const lat = body.readUInt32BE(8) / 1e6;
    const lng = body.readUInt32BE(12) / 1e6;
    const altitude = body.readUInt16BE(16);
    const speed = body.readUInt16BE(18) / 10;
    const direction = body.readUInt16BE(20);
    const ts = body.subarray(22, 28);
    const time = `20${ts[0].toString(16).padStart(2, "0")}-${ts[1].toString(16).padStart(2, "0")}-${ts[2].toString(16).padStart(2, "0")} ${ts[3].toString(16).padStart(2, "0")}:${ts[4].toString(16).padStart(2, "0")}:${ts[5].toString(16).padStart(2, "0")}`;
    const extras = parseExtras(body);
    return {
        lat, lng, altitude, speed, direction, time, alarm, status,
        towers: extras[0xe1] ? parseLBS(extras[0xe1]) : null,
        odometer: extras[0x01] ? extras[0x01].readUInt32BE(0) / 10 : null,
        signalStrength: extras[0x30] ? extras[0x30].readUInt8(0) : null,
        satellites: extras[0x31] ? extras[0x31].readUInt8(0) : null,
        battery: extras[0xe4] ? extras[0xe4].readUInt16BE(0) : null,
        charging: extras[0xe5] ? extras[0xe5].readUInt8(0) : null,
        acc: extras[0xe6] ? extras[0xe6].readUInt8(0) : null,
        deviceMode: extras[0xe7] ? extras[0xe7].toString("hex") : null,
        posMode: extras[0xf5] ? extras[0xf5].readUInt8(0) : null,
    };
}
