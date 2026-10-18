# MeetSphere – Real-Time Communication App

## Run

```bash
npm install
npm start
npm test
```

App: http://localhost:3000

## How to use

1. Register or Login.
2. Select **New Meeting** and share the meeting code or link.
3. Other participants should open the same website, log in, enter the meeting code, and join.

Maximum participants can be configured using `MAX_PARTICIPANTS`.

## Controls

Mic, Camera, Screen Share, Board, Hand Raise, Chat, People, and Leave.

- Participants can leave the meeting.
- The host can end the meeting for everyone.
- Chat should be closable without leaving the meeting.
- Host controls include muting or removing participants.

## Security

- JWT authentication and bcrypt password hashing.
- WebRTC DTLS-SRTP for media security.
- Chat encryption and rate limiting.

## Multiple networks

For camera and microphone access, use HTTPS or localhost. A TURN server may be required on restrictive networks.
