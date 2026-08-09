# Tingle — prototype

"Meet. Talk. Connect." A free, minimal, 18+ random 1-to-1 video call prototype.
₹0 / $0 to run — no Firebase, Supabase, Twilio, Agora, or any paid API.

## What's included

- **Backend** (`server.js`): Node.js + Express (static file serving) + `ws`
  (WebSocket signaling). Pure in-memory state — no database.
- **Frontend** (`public/`): vanilla HTML/CSS/JS + native WebRTC. No build step.
- Full flow: landing → 18+ gate → name entry → safety notice → camera preview
  → matchmaking → video call with a 30-minute timer → result screen → find
  another. Plus block, report, and prototype Privacy/Terms/Guidelines/Safety pages.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two different browser tabs/windows (or
two devices on the same network, using your machine's LAN IP instead of
`localhost`) to test a real match between two "users."

WebRTC on real mobile browsers over the open internet generally requires
HTTPS — `localhost` is exempted for local testing, but for anything beyond
your own machine you'll want a TLS certificate (e.g. a free one from Let's
Encrypt) in front of this in production.

## Architecture

```
Browser A                                    Browser B
   |                                              |
   |---- WebSocket (signaling only) -------------->|
   |<--- WebSocket (signaling only) ---------------|
   |                                              |
   |=========== WebRTC peer connection ===========|
   |         (audio/video, direct, via STUN)      |
```

Audio/video **never** touches `server.js` — it only relays the WebRTC offer,
answer, and ICE candidates between the two matched browsers, plus lightweight
matchmaking/safety messages (join queue, block, report, end call).

### Server-enforced call limit

The client runs its own countdown for a responsive UI, but the *authoritative*
30-minute cap lives on the server (`MAX_CALL_SECONDS` in `server.js`), which
sets its own timer when a call starts and force-ends it — regardless of what
the client's JavaScript does. A modified client cannot extend a call.

### Safety-relevant behavior already implemented

- Self-match and duplicate-match prevention in `tryMatch()`.
- Block: mutual, session-scoped, prevents rematching for the rest of the session.
- Report: categorized, stored server-side only, never exposed to any client.
- Idle sessions are swept out of the queue automatically.
- Basic per-connection rate limiting on all WebSocket messages.
- No recording: only transient `MediaStream` tracks exist client-side; nothing
  is written to disk anywhere in this codebase.
- Signaling messages are only forwarded between the two verified participants
  of an active call — a client can't inject signaling into someone else's call.

## What this prototype deliberately leaves out (by design)

Per the brief, this intentionally skips payments, subscriptions, complex
profiles, AI moderation, permanent chat, and real identity/age verification —
the 18+ gate is a **self-attestation checkbox**, not legal age verification.

## Native Android app — scope note

I did not generate a compiled `.apk` or a full native Android project here.
Building one for real requires an actual Android SDK/Gradle toolchain and a
device or emulator to verify WebRTC + camera/mic permission behavior — none
of which exist in this environment, and shipping un-compiled, untested Kotlin
"as if" it were a working app would be worse than not providing it. The
straightforward path to an Android version of this exact prototype:

1. Wrap this same web app in a WebView-based shell *only if* you first confirm
   WebRTC works acceptably in it (the brief itself flags this risk) — or,
   more reliably,
2. Build a small native Kotlin app using `org.webrtc:google-webrtc` (the
   open-source WebRTC Android library, free) that connects to this same
   `server.js` WebSocket endpoint for signaling, reusing all the matchmaking/
   safety logic as-is.

Either path is a real, separate engineering effort (Android Studio project,
Gradle build, a device/emulator to test camera+mic+WebRTC on). Happy to help
scaffold that Kotlin project in a follow-up if useful.

## Before any production use

Add: HTTPS/WSS, real authentication, a shared state store (e.g. Redis) if you
scale beyond one server process, persistent moderation storage and an actual
moderation workflow, real age verification, and a security review — none of
which this prototype implements, by design.
