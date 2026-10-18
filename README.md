# MeetSphere – Real-Time Communication App (CodeAlpha Task 4)

## Run
    npm install
    npm start          -> http://localhost:3000
    npm test           -> auth + realtime + validation tests

## How to use
1. Register / Login. 2. "New meeting" -> share the code (abc-defg-hij) or link.
3. Others: Login -> type the code in "Join" -> Join now. Max 6 people (MAX_PARTICIPANTS env).
Everyone must open the SAME website address (same server).

## Controls
Mic, Camera, Share screen (desktop only), Board, Hand, Chat, People, Leave.
- Leave -> menu: Leave meeting / Stay. Host also gets "End meeting for everyone".
- Browser/phone Back: closes the chat panel; otherwise asks "Leave?" (never drops the call silently).
- Host: Mute / Remove people (removed people cannot rejoin).

## Security
Meeting id = SHA-256(code), server never sees the code. Chat/files: AES-256-GCM key derived from the code.
Video/audio: WebRTC DTLS-SRTP. JWT + bcrypt, rate limits, logout revokes the token.

## 4+ people on different networks
Camera needs HTTPS (or localhost):
    winget install Cloudflare.cloudflared
    cloudflared tunnel --url http://localhost:3000
Share the https://xxxx.trycloudflare.com link. Strict networks need a TURN server (TURN_URL, TURN_USER, TURN_PASS).
