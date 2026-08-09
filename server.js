/**
 * TINGLE - prototype signaling & matchmaking server
 *
 * - Zero paid services. Just Express (static files) + ws (WebSocket signaling).
 * - All state is in-memory. Nothing here is persisted to disk or a database.
 * - Audio/video media NEVER passes through this server - only WebRTC signaling
 *   (offer/answer/ICE) does. Calls run for as long as both sides stay
 *   connected - there is no server-side time cap.
 *
 * This is a PROTOTYPE. Before any production use you would need to add:
 * real authentication, HTTPS/WSS, persistent moderation storage, horizontal
 * scaling (e.g. Redis-backed matchmaking), and a real safety/moderation team.
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 3000;
// No call duration cap - calls run unlimited as long as both sides stay connected.
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // expire idle sessions
const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX_MSGS = 40; // generous but bounds abuse/flooding
const MAX_NAME_LEN = 30;
const MIN_NAME_LEN = 2;
const MAX_REPORT_DESC_LEN = 500;
const MIN_AGE = 18;

// Categories serious enough that a single report ends the call and bans
// the reported device immediately, pending human review - this errs on
// the side of caution rather than waiting for a report count threshold.
const IMMEDIATE_BAN_CATEGORIES = new Set(["possible_minor", "sexual_misconduct", "threat"]);
const IMMEDIATE_BAN_MS = 48 * 60 * 60 * 1000; // 48h pending-review ban
const REPORT_THRESHOLD_BAN_COUNT = 3; // lower-severity reports still stack toward a ban
const THRESHOLD_BAN_MS = 24 * 60 * 60 * 1000;

/**
 * IMPORTANT PROTOTYPE LIMITATION:
 * Age here is self-attested (the birth date the client sends) - there is
 * no ID/document verification. deviceId is a client-generated identifier
 * persisted in localStorage, not a verified identity - clearing storage
 * or using another browser/device creates a new one. This layer raises
 * the bar (persistent bans, no fully-anonymous re-entry after a ban)
 * but is NOT a substitute for real age verification.
 */

/** deviceId -> {
 *   birthDate: "YYYY-MM-DD", ageVerifiedAtLeast18: boolean,
 *   blockedDeviceIds: Set<deviceId>, reportsAgainst: number,
 *   bannedUntil: number|null, banReason: string|null, firstSeen: number
 * } */
const deviceIdentities = new Map();

function getOrCreateIdentity(deviceId) {
  let identity = deviceIdentities.get(deviceId);
  if (!identity) {
    identity = {
      birthDate: null,
      ageVerifiedAtLeast18: false,
      blockedDeviceIds: new Set(),
      reportsAgainst: 0,
      bannedUntil: null,
      banReason: null,
      firstSeen: Date.now(),
    };
    deviceIdentities.set(deviceId, identity);
  }
  return identity;
}

function calcAge(birthDateStr) {
  const birthDate = new Date(birthDateStr);
  if (Number.isNaN(birthDate.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const monthDiff = now.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birthDate.getDate())) age--;
  return age;
}

function isValidDeviceId(raw) {
  return typeof raw === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(raw);
}

const app = express();
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/** sessionId -> {
 *   ws, name, deviceId:string|null, callId:string|null,
 *   inQueue:boolean, lastSeen:number, msgTimestamps:number[]
 * } */
const sessions = new Map();

/** ordered list of sessionIds currently waiting for a match */
const queue = [];

/** callId -> { a, b, startedAt, timer } */
const calls = new Map();

/** very small in-memory report log - never exposed to clients */
const reports = [];

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function safeSend(sessionId, payload) {
  const s = sessions.get(sessionId);
  if (s && s.ws.readyState === WebSocket.OPEN) {
    try {
      s.ws.send(JSON.stringify(payload));
    } catch (_) {
      /* ignore broken pipe */
    }
  }
}

function removeFromQueue(sessionId) {
  const idx = queue.indexOf(sessionId);
  if (idx !== -1) queue.splice(idx, 1);
  const s = sessions.get(sessionId);
  if (s) s.inQueue = false;
}

function sanitizeName(raw) {
  if (typeof raw !== "string") return null;
  // Strip anything that looks like markup/scripts, collapse whitespace.
  const cleaned = raw.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length < MIN_NAME_LEN || cleaned.length > MAX_NAME_LEN) return null;
  return cleaned;
}

/** Try to pair up two waiting sessions that haven't blocked each other
 *  (checked at the persistent device level, not just this session). */
function tryMatch() {
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    const sa = sessions.get(a);
    if (!sa) continue;
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      if (a === b) continue; // never match a user with themselves
      const sb = sessions.get(b);
      if (!sb) continue;
      const ia = deviceIdentities.get(sa.deviceId);
      const ib = deviceIdentities.get(sb.deviceId);
      if (ia && ib && (ia.blockedDeviceIds.has(sb.deviceId) || ib.blockedDeviceIds.has(sa.deviceId))) continue;
      // Found a valid pair.
      queue.splice(j, 1);
      queue.splice(i, 1);
      sa.inQueue = false;
      sb.inQueue = false;
      startCall(a, b);
      return true;
    }
  }
  return false;
}

function startCall(a, b) {
  const callId = genId("call");
  const startedAt = Date.now();
  // No timer: calls are unlimited and only end via user_ended,
  // peer_disconnected, block, or report.
  calls.set(callId, { a, b, startedAt, timer: null });

  const sa = sessions.get(a);
  const sb = sessions.get(b);
  sa.callId = callId;
  sb.callId = callId;

  // One side is designated the WebRTC offer-creator to avoid glare.
  safeSend(a, { type: "matched", callId, role: "initiator", peerName: sb.name });
  safeSend(b, { type: "matched", callId, role: "receiver", peerName: sa.name });
}

function endCall(callId, reason, enderSessionId) {
  const call = calls.get(callId);
  if (!call) return;
  clearTimeout(call.timer);
  calls.delete(callId);

  for (const id of [call.a, call.b]) {
    const s = sessions.get(id);
    if (s) s.callId = null;
    let clientReason = reason;
    if (reason === "user_ended") {
      clientReason = id === enderSessionId ? "you_ended" : "peer_ended";
    } else if (reason === "peer_disconnected" && id === enderSessionId) {
      // enderSessionId here is the one who disconnected; the OTHER user gets this message
      clientReason = "peer_disconnected";
    }
    safeSend(id, {
      type: "call_ended",
      reason: clientReason,
      durationSeconds: Math.round((Date.now() - call.startedAt) / 1000),
    });
  }
}

function cleanupSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  removeFromQueue(sessionId);
  if (s.callId) {
    endCall(s.callId, "peer_disconnected", sessionId);
  }
  sessions.delete(sessionId);
}

function isRateLimited(session) {
  const now = Date.now();
  session.msgTimestamps = session.msgTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  session.msgTimestamps.push(now);
  return session.msgTimestamps.length > RATE_LIMIT_MAX_MSGS;
}

/** Only allow signaling messages to flow between the two participants of a real, active call. */
function forwardSignal(fromId, msg) {
  const from = sessions.get(fromId);
  if (!from || !from.callId) return; // not in an active call - drop silently
  const call = calls.get(from.callId);
  if (!call) return;
  if (typeof msg.callId !== "string" || msg.callId !== from.callId) return; // client tried to spoof a callId
  const toId = call.a === fromId ? call.b : call.a;
  safeSend(toId, {
    type: "signal",
    callId: from.callId,
    signalType: msg.signalType, // "offer" | "answer" | "candidate"
    data: msg.data,
  });
}

wss.on("connection", (ws) => {
  const sessionId = genId("tingle_session");
  sessions.set(sessionId, {
    ws,
    name: null,
    deviceId: null,
    callId: null,
    inQueue: false,
    lastSeen: Date.now(),
    msgTimestamps: [],
  });

  safeSend(sessionId, { type: "welcome", sessionId });

  ws.on("message", (raw) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.lastSeen = Date.now();

    if (isRateLimited(session)) {
      safeSend(sessionId, { type: "error", message: "Too many requests. Slow down." });
      return;
    }

    let msg;
    try {
      if (raw.length > 20000) throw new Error("oversized");
      msg = JSON.parse(raw.toString());
    } catch (_) {
      safeSend(sessionId, { type: "error", message: "Invalid message." });
      return;
    }
    if (!msg || typeof msg.type !== "string") {
      safeSend(sessionId, { type: "error", message: "Invalid message." });
      return;
    }

    switch (msg.type) {
      case "register": {
        // Must happen before set_name / join_queue. Establishes (a) a
        // self-attested birth date, checked server-side, and (b) a
        // persistent deviceId so blocks/bans survive reconnects instead
        // of resetting every time someone opens a new session.
        if (!isValidDeviceId(msg.deviceId)) {
          safeSend(sessionId, { type: "error", message: "Invalid device identifier." });
          return;
        }
        const age = calcAge(msg.birthDate);
        if (age === null) {
          safeSend(sessionId, { type: "error", message: "Please enter a valid date of birth." });
          return;
        }

        const identity = getOrCreateIdentity(msg.deviceId);

        if (identity.bannedUntil && identity.bannedUntil > Date.now()) {
          safeSend(sessionId, {
            type: "banned",
            until: identity.bannedUntil,
            reason: identity.banReason || "Multiple user reports",
          });
          return;
        }

        if (age < MIN_AGE) {
          // We record that this birth date failed the check (without
          // storing anything beyond what was just submitted) so a repeat
          // attempt with the same device doesn't need re-deriving age,
          // and so this device cannot simply retry with a different
          // birth date to get a different answer moments later.
          identity.birthDate = msg.birthDate;
          identity.ageVerifiedAtLeast18 = false;
          safeSend(sessionId, { type: "age_denied" });
          return;
        }

        identity.birthDate = msg.birthDate;
        identity.ageVerifiedAtLeast18 = true;
        identity.bannedUntil = null;
        identity.banReason = null;
        session.deviceId = msg.deviceId;
        safeSend(sessionId, { type: "registered" });
        break;
      }

      case "set_name": {
        const name = sanitizeName(msg.name);
        if (!name) {
          safeSend(sessionId, { type: "error", message: "Please enter a name between 2 and 30 characters." });
          return;
        }
        session.name = name;
        safeSend(sessionId, { type: "name_ok", name });
        break;
      }

      case "join_queue": {
        if (!session.deviceId) {
          safeSend(sessionId, { type: "error", message: "Please complete the age check first." });
          return;
        }
        const identity = deviceIdentities.get(session.deviceId);
        if (!identity || !identity.ageVerifiedAtLeast18) {
          safeSend(sessionId, { type: "age_denied" });
          return;
        }
        if (identity.bannedUntil && identity.bannedUntil > Date.now()) {
          safeSend(sessionId, { type: "banned", until: identity.bannedUntil, reason: identity.banReason || "Multiple user reports" });
          return;
        }
        if (!session.name) {
          safeSend(sessionId, { type: "error", message: "Set a display name first." });
          return;
        }
        if (session.callId) {
          safeSend(sessionId, { type: "error", message: "You're already in a call." });
          return;
        }
        if (!session.inQueue) {
          session.inQueue = true;
          queue.push(sessionId);
        }
        tryMatch();
        break;
      }

      case "cancel_queue": {
        removeFromQueue(sessionId);
        safeSend(sessionId, { type: "queue_cancelled" });
        break;
      }

      case "signal": {
        // signalType: offer | answer | candidate ; data: opaque SDP/ICE payload
        if (!["offer", "answer", "candidate"].includes(msg.signalType)) return;
        forwardSignal(sessionId, msg);
        break;
      }

      case "end_call": {
        if (session.callId) {
          endCall(session.callId, "user_ended", sessionId);
        }
        break;
      }

      case "block": {
        // Block the current call partner, end the call, and prevent
        // rematching persistently (device-level, survives reconnects) -
        // not just for the rest of this in-memory session.
        if (session.callId) {
          const call = calls.get(session.callId);
          if (call) {
            const otherId = call.a === sessionId ? call.b : call.a;
            const other = sessions.get(otherId);
            if (session.deviceId && other && other.deviceId) {
              getOrCreateIdentity(session.deviceId).blockedDeviceIds.add(other.deviceId);
              getOrCreateIdentity(other.deviceId).blockedDeviceIds.add(session.deviceId);
            }
            endCall(session.callId, "user_ended", sessionId);
          }
        }
        safeSend(sessionId, { type: "block_ok" });
        break;
      }

      case "report": {
        const validCategories = [
          "harassment",
          "sexual_misconduct",
          "spam",
          "scam",
          "hate",
          "threat",
          "possible_minor",
          "other",
        ];
        const category = validCategories.includes(msg.category) ? msg.category : "other";
        const description =
          typeof msg.description === "string" ? msg.description.slice(0, MAX_REPORT_DESC_LEN) : "";

        const activeCall = session.callId ? calls.get(session.callId) : null;
        const reportedSessionId = activeCall ? (activeCall.a === sessionId ? activeCall.b : activeCall.a) : null;
        const reportedSession = reportedSessionId ? sessions.get(reportedSessionId) : null;

        reports.push({
          id: genId("report"),
          category,
          description,
          reporter: sessionId,
          reportedDeviceId: reportedSession ? reportedSession.deviceId : null,
          callId: session.callId,
          at: new Date().toISOString(),
        });

        // A report always ends the call immediately, independent of
        // whether the reporter separately taps Block - waiting for a
        // second action from a distressed user is not acceptable here.
        if (session.callId) {
          endCall(session.callId, "user_ended", sessionId);
        }

        if (reportedSession && reportedSession.deviceId && session.deviceId) {
          const reportedIdentity = getOrCreateIdentity(reportedSession.deviceId);
          const reporterIdentity = getOrCreateIdentity(session.deviceId);

          // Mutual block immediately, regardless of category.
          reportedIdentity.blockedDeviceIds.add(session.deviceId);
          reporterIdentity.blockedDeviceIds.add(reportedSession.deviceId);

          reportedIdentity.reportsAgainst += 1;

          if (IMMEDIATE_BAN_CATEGORIES.has(category)) {
            reportedIdentity.bannedUntil = Date.now() + IMMEDIATE_BAN_MS;
            reportedIdentity.banReason = "Reported for: " + category;
            safeSend(reportedSessionId, {
              type: "banned",
              until: reportedIdentity.bannedUntil,
              reason: reportedIdentity.banReason,
            });
          } else if (
            reportedIdentity.reportsAgainst >= REPORT_THRESHOLD_BAN_COUNT &&
            (!reportedIdentity.bannedUntil || reportedIdentity.bannedUntil < Date.now())
          ) {
            reportedIdentity.bannedUntil = Date.now() + THRESHOLD_BAN_MS;
            reportedIdentity.banReason = "Multiple user reports";
            safeSend(reportedSessionId, {
              type: "banned",
              until: reportedIdentity.bannedUntil,
              reason: reportedIdentity.banReason,
            });
          }
        }

        // Reports are never exposed back to any client beyond the ban
        // notice above (which goes to the reported device, not the
        // reporter, and contains no reporter-identifying information).
        safeSend(sessionId, { type: "report_ok" });
        break;
      }

      case "heartbeat": {
        safeSend(sessionId, { type: "heartbeat_ack" });
        break;
      }

      default:
        safeSend(sessionId, { type: "error", message: "Unknown message type." });
    }
  });

  ws.on("close", () => cleanupSession(sessionId));
  ws.on("error", () => cleanupSession(sessionId));
});

// Sweep idle sessions periodically so the queue never fills with ghosts.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_IDLE_TIMEOUT_MS) {
      try {
        s.ws.terminate();
      } catch (_) {}
      cleanupSession(id);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Tingle prototype server listening on http://localhost:${PORT}`);
});
