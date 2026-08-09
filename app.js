(function () {
  "use strict";

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];

  const MIN_AGE = 18;
  const DEVICE_ID_KEY = "tingle_device_id";

  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : "dev-" + Math.random().toString(36).slice(2) + Date.now());
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
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

  const state = {
    ws: null,
    sessionId: null,
    deviceId: getDeviceId(),
    name: null,
    localStream: null,
    pc: null,
    callId: null,
    role: null, // "initiator" | "receiver"
    timerInterval: null,
    elapsedSeconds: 0,
    pendingCandidates: [],
    facingMode: "user",
    endedByMe: false,
  };

  const screens = document.querySelectorAll(".screen");
  function showScreen(id) {
    screens.forEach((s) => s.classList.toggle("active", s.id === "screen-" + id));
    window.scrollTo(0, 0);
  }

  function $(id) { return document.getElementById(id); }

  // ---------- Navigation: back links ----------
  document.querySelectorAll("[data-back]").forEach((el) => {
    el.addEventListener("click", () => showScreen(el.dataset.back));
  });

  // ---------- Landing ----------
  $("btn-start-tingle").addEventListener("click", () => showScreen("agegate"));
  $("btn-how").addEventListener("click", () => showScreen("how"));

  // ---------- Legal links ----------
  const LEGAL_CONTENT = {
    privacy: {
      title: "Prototype Privacy Policy",
      html: `
        <p>This is a <strong>prototype</strong>, not a production legal document. It does not represent full legal compliance.</p>
        <h3>What we use</h3>
        <ul>
          <li><strong>Date of birth</strong> — self-reported, used to check you meet the 18+ minimum. We do not verify this against an ID.</li>
          <li><strong>Device identifier</strong> — a random ID stored in your browser (not tied to your name or any account) so that a block or ban survives you reopening the app. Clearing your browser storage or using a different device creates a new identifier.</li>
          <li><strong>Display name</strong> — shown to the person you're matched with, for this session only.</li>
          <li><strong>Camera / microphone</strong> — used only to power your live video call; never recorded.</li>
          <li><strong>WebRTC connection data</strong> — technical info (like network candidates) needed to connect two browsers directly.</li>
          <li><strong>Temporary matchmaking data</strong> — your place in the queue and call state, held in server memory only.</li>
          <li><strong>Basic technical logs</strong> — for debugging and abuse prevention.</li>
          <li><strong>Reports</strong> — if you report someone, we keep a record of the report category/description and apply it to their device identifier, including immediate temporary bans for the most serious categories.</li>
        </ul>
        <h3>What we don't do</h3>
        <ul>
          <li>No call recording — video/audio is never saved.</li>
          <li>No location collection.</li>
          <li>No access to contacts, SMS, or call logs.</li>
        </ul>
        <h3>Data lifetime</h3>
        <p>Matchmaking and call data are removed when you disconnect, end a call, or your session expires. As a prototype, we don't yet offer a formal data-deletion request flow.</p>
      `,
    },
    terms: {
      title: "Prototype Terms of Use",
      html: `
        <p>By using this prototype you agree that:</p>
        <ul>
          <li>You are 18 years of age or older.</li>
          <li>You will use Tingle appropriately — no harassment, threats, illegal activity, sexual exploitation, or involving minors.</li>
          <li>You will not scam, impersonate, or abuse other users.</li>
        </ul>
        <p>We reserve the right to terminate prototype access for any user, at any time, for any reason.</p>
        <p>This is a prototype and is provided as-is, without warranties of any kind.</p>
      `,
    },
    guidelines: {
      title: "Tingle Community Guidelines",
      html: `
        <p>Tingle prohibits:</p>
        <ul>
          <li>Underage users of any kind</li>
          <li>Sexual exploitation</li>
          <li>Harassment, threats, hate, or violence</li>
          <li>Scams, fraud, or spam</li>
          <li>Doxxing, blackmail, or impersonation</li>
          <li>Any illegal activity</li>
        </ul>
        <p>If someone violates these guidelines, you can <strong>Block</strong> them, <strong>Report</strong> them, or simply <strong>End the Call</strong> — at any time, no explanation needed.</p>
      `,
    },
    safety: {
      title: "Safety",
      html: `
        <p>A few reminders to keep your conversations safe:</p>
        <ul>
          <li>Never share passwords, OTPs, bank details, your home address, or private documents with someone you just met.</li>
          <li>You are never obligated to stay in a call — you can end it instantly.</li>
          <li>Use Block to prevent being matched with someone again this session.</li>
          <li>Use Report for anything that violates our Community Guidelines — including if you believe you're talking to a minor.</li>
        </ul>
      `,
    },
  };

  document.querySelectorAll("[data-legal]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const key = el.dataset.legal;
      const content = LEGAL_CONTENT[key];
      if (!content) return;
      $("legal-title").textContent = content.title;
      $("legal-body").innerHTML = content.html;
      showScreen("legal");
    });
  });

  // ---------- Age gate (self-reported birth date, checked server-side) ----------
  $("input-birthdate").addEventListener("input", () => {
    $("agegate-error").textContent = "";
    const val = $("input-birthdate").value;
    $("btn-agegate-continue").disabled = !val;
  });

  $("btn-agegate-continue").addEventListener("click", () => {
    const birthDate = $("input-birthdate").value;
    if (!birthDate) return;
    const age = calcAge(birthDate);
    if (age === null) {
      $("agegate-error").textContent = "Please enter a valid date of birth.";
      return;
    }
    // Client-side check is only for fast feedback — the server independently
    // re-checks this and is the actual enforcement point (see register handler).
    if (age < MIN_AGE) {
      showScreen("agedenied");
      return;
    }
    $("btn-agegate-continue").disabled = true;
    $("agegate-error").textContent = "";
    connectWebSocket(() => {
      send({ type: "register", deviceId: state.deviceId, birthDate });
    });
  });

  // ---------- Name entry ----------
  $("btn-name-continue").addEventListener("click", () => {
    const raw = $("input-name").value;
    const cleaned = raw.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
    if (cleaned.length < 2 || cleaned.length > 30) {
      $("name-error").textContent = "Please enter a name between 2 and 30 characters.";
      return;
    }
    $("name-error").textContent = "";
    state.name = cleaned;
    showScreen("safety");
  });

  // ---------- Safety notice ----------
  $("btn-safety-continue").addEventListener("click", () => {
    showScreen("preview");
    initPreview();
  });

  // ---------- Camera preview / permissions ----------
  let previewCamOn = true;
  let previewMicOn = true;

  async function initPreview() {
    $("preview-error").textContent = "";
    $("preview-denied").hidden = true;
    $("btn-start-tingle-real").disabled = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.facingMode },
        audio: true,
      });
      state.localStream = stream;
      $("local-preview").srcObject = stream;
      $("btn-start-tingle-real").disabled = false;
    } catch (err) {
      $("preview-denied").hidden = false;
      $("preview-error").textContent = "Camera and microphone access are required for a video conversation.";
    }
  }

  $("btn-request-permission").addEventListener("click", initPreview);

  $("toggle-cam-preview").addEventListener("click", () => {
    previewCamOn = !previewCamOn;
    $("toggle-cam-preview").dataset.on = String(previewCamOn);
    if (state.localStream) {
      state.localStream.getVideoTracks().forEach((t) => (t.enabled = previewCamOn));
    }
  });
  $("toggle-mic-preview").addEventListener("click", () => {
    previewMicOn = !previewMicOn;
    $("toggle-mic-preview").dataset.on = String(previewMicOn);
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach((t) => (t.enabled = previewMicOn));
    }
  });

  $("btn-start-tingle-real").addEventListener("click", () => {
    connectWebSocket(() => {
      showScreen("searching");
      send({ type: "set_name", name: state.name });
      send({ type: "join_queue" });
    });
  });

  $("btn-cancel-search").addEventListener("click", () => {
    send({ type: "cancel_queue" });
    showScreen("landing");
  });

  // ---------- WebSocket ----------
  function connectWebSocket(onOpen) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      onOpen && onOpen();
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    state.ws = new WebSocket(`${proto}//${location.host}`);

    state.ws.addEventListener("open", () => onOpen && onOpen());
    state.ws.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (_) { return; }
      handleServerMessage(msg);
    });
    state.ws.addEventListener("close", () => {
      if (document.getElementById("screen-call").classList.contains("active")) {
        showResult("peer_disconnected", state.elapsedSeconds);
      }
    });
    state.ws.addEventListener("error", () => {
      showScreen("error");
    });
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }
\n  // Keep the signaling connection alive on mobile networks.
  setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      send({ type: "heartbeat" });
    }
  }, 25000);


  function handleServerMessage(msg) {
    switch (msg.type) {
      case "welcome":
        state.sessionId = msg.sessionId;
        break;
      case "registered":
        showScreen("name");
        break;
      case "age_denied":
        showScreen("agedenied");
        break;
      case "banned": {
        const until = msg.until ? new Date(msg.until) : null;
        $("banned-reason").textContent = msg.reason ? `Reason: ${msg.reason}` : "";
        $("banned-until").textContent = until ? `This restriction lifts on ${until.toLocaleString()}.` : "";
        showScreen("banned");
        break;
      }
      case "matched":
        state.callId = msg.callId;
        state.role = msg.role;
        $("match-peer-name").textContent = `You're talking with ${msg.peerName}`;
        showScreen("matchfound");
        setTimeout(() => startCall(), 900);
        break;
      case "signal":
        handleSignal(msg);
        break;
      case "call_ended":
        teardownCall();
        showResult(msg.reason, msg.durationSeconds);
        break;
      case "block_ok":
      case "report_ok":
      case "queue_cancelled":
      case "name_ok":
      case "heartbeat_ack":
        break;
      case "queue_timeout":
        showScreen("result");
        $("result-reason").textContent =
          msg.message || "Matchmaking timed out. Please try again.";
        $("result-duration").textContent = "";
        break;
      case "error":
        console.warn("Server error:", msg.message);
        if (document.getElementById("screen-agegate").classList.contains("active")) {
          $("agegate-error").textContent = msg.message || "Something went wrong. Please try again.";
          $("btn-agegate-continue").disabled = false;
        }
        break;
      default:
        break;
    }
  }

  // ---------- WebRTC call ----------
  async function startCall() {
    showScreen("call");
    $("local-video").srcObject = state.localStream;
    $("remote-video").srcObject = null;
    $("call-banner").hidden = true;
    state.endedByMe = false;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.pc = pc;
    state.pendingCandidates = [];

    state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

    pc.ontrack = (evt) => {
      $("remote-video").srcObject = evt.streams[0];
    };

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        send({ type: "signal", callId: state.callId, signalType: "candidate", data: evt.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const status = { connected: "Good", connecting: "Connecting", disconnected: "Weak", failed: "Reconnecting" }[pc.connectionState];
      if (status) $("net-status").textContent = status;
      if (pc.connectionState === "connected") startCallTimer();
      // A "failed" state usually means the original ICE negotiation
      // couldn't establish a path (e.g. a network change mid-call).
      // An ICE restart re-gathers candidates without tearing down the
      // whole call, instead of leaving the user stuck on a dead connection.
      if (pc.connectionState === "failed" && state.role === "initiator") {
        restartIce();
      }
    };

    if (state.role === "initiator") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: "signal", callId: state.callId, signalType: "offer", data: offer });
    }
  }

  async function restartIce() {
    const pc = state.pc;
    if (!pc) return;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      send({ type: "signal", callId: state.callId, signalType: "offer", data: offer });
    } catch (_) {
      // Fail quietly - the connection banner already reflects the bad state.
    }
  }

  // ICE candidates can arrive over the WebSocket before the matching
  // setRemoteDescription() call has resolved (offer/answer processing is
  // async, so message events can interleave). Calling addIceCandidate()
  // before a remote description exists throws and silently drops the
  // candidate, which was causing calls to intermittently fail to connect.
  // Queue candidates until a remote description is set, then flush them.
  async function flushPendingCandidates() {
    const pc = state.pc;
    if (!pc) return;
    const queued = state.pendingCandidates;
    state.pendingCandidates = [];
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch (_) {}
    }
  }

  async function handleSignal(msg) {
    const pc = state.pc;
    if (!pc) return;
    if (msg.signalType === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      await flushPendingCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "signal", callId: state.callId, signalType: "answer", data: answer });
    } else if (msg.signalType === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      await flushPendingCandidates();
    } else if (msg.signalType === "candidate") {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(msg.data); } catch (_) {}
      } else {
        state.pendingCandidates.push(msg.data);
      }
    }
  }

  function startCallTimer() {
    if (state.timerInterval) return; // already running
    state.elapsedSeconds = 0;
    updateTimerDisplay();
    state.timerInterval = setInterval(() => {
      state.elapsedSeconds += 1;
      updateTimerDisplay();
    }, 1000);
  }

  function updateTimerDisplay() {
    const s = state.elapsedSeconds;
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    $("call-timer").textContent = `${mm}:${ss}`;
  }

  function teardownCall() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    if (state.pc) {
      state.pc.getSenders().forEach((s) => { try { s.track && s.track.stop(); } catch (_) {} });
      state.pc.close();
      state.pc = null;
    }
    $("remote-video").srcObject = null;
    state.callId = null;
    state.role = null;
  }

  // ---------- Call controls ----------
  let micOn = true;
  let camOn = true;

  $("btn-toggle-mic").addEventListener("click", () => {
    micOn = !micOn;
    $("btn-toggle-mic").dataset.on = String(micOn);
    if (state.localStream) state.localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  });

  $("btn-toggle-cam").addEventListener("click", () => {
    camOn = !camOn;
    $("btn-toggle-cam").dataset.on = String(camOn);
    if (state.localStream) state.localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    if (!camOn) {
      $("call-banner").hidden = false;
      $("call-banner").textContent = "Video unavailable — camera is off";
    } else {
      $("call-banner").hidden = true;
    }
  });

  $("btn-switch-cam").addEventListener("click", async () => {
    if (!state.localStream) return;
    state.facingMode = state.facingMode === "user" ? "environment" : "user";
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.facingMode },
        audio: true,
      });
      const newVideoTrack = newStream.getVideoTracks()[0];
      const sender = state.pc && state.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(newVideoTrack);
      state.localStream.getVideoTracks().forEach((t) => t.stop());
      state.localStream.removeTrack(state.localStream.getVideoTracks()[0]);
      state.localStream.addTrack(newVideoTrack);
      $("local-video").srcObject = state.localStream;
    } catch (_) {
      // Fail quietly - camera switch isn't critical to core functionality.
    }
  });

  // End call
  $("btn-end-call").addEventListener("click", () => { $("modal-endcall").hidden = false; });
  $("btn-endcall-stay").addEventListener("click", () => { $("modal-endcall").hidden = true; });
  $("btn-endcall-confirm").addEventListener("click", () => {
    $("modal-endcall").hidden = true;
    state.endedByMe = true;
    send({ type: "end_call" });
  });

  // Block
  $("btn-block").addEventListener("click", () => { $("modal-block").hidden = false; });
  $("btn-block-cancel").addEventListener("click", () => { $("modal-block").hidden = true; });
  $("btn-block-confirm").addEventListener("click", () => {
    $("modal-block").hidden = true;
    send({ type: "block" });
  });

  // Report
  $("btn-report").addEventListener("click", () => { $("modal-report").hidden = false; });
  $("btn-report-cancel").addEventListener("click", () => { $("modal-report").hidden = true; });
  $("btn-report-submit").addEventListener("click", () => {
    send({
      type: "report",
      category: $("report-category").value,
      description: $("report-description").value,
    });
    $("report-description").value = "";
    $("modal-report").hidden = true;
  });

  // ---------- Result screen ----------
  const REASON_TEXT = {
    you_ended: "You ended the call",
    peer_ended: "The other person ended the call",
    peer_disconnected: "Other user disconnected",
  };

  function showResult(reason, durationSeconds) {
    $("result-reason").textContent = REASON_TEXT[reason] || "Call ended";
    $("result-duration").textContent = typeof durationSeconds === "number"
      ? `Call length: ${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, "0")}`
      : "";
    showScreen("result");
  }

  $("btn-find-another").addEventListener("click", () => {
    showScreen("searching");
    send({ type: "join_queue" });
  });
  $("btn-result-home").addEventListener("click", () => {
    stopAllMedia();
    showScreen("landing");
  });

  function stopAllMedia() {
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = null;
    }
  }

  // ---------- Error / offline ----------
  $("btn-error-retry").addEventListener("click", () => showScreen("landing"));
  $("btn-offline-retry").addEventListener("click", () => {
    if (navigator.onLine) showScreen("landing");
  });
  window.addEventListener("offline", () => showScreen("offline"));
  window.addEventListener("online", () => {
    if (document.getElementById("screen-offline").classList.contains("active")) showScreen("landing");
  });

  // Clean up media if the tab is closed mid-call.
  window.addEventListener("beforeunload", () => {
    stopAllMedia();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      send({ type: "end_call" });
    }
  });
})();
