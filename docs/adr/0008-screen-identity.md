# ADR 0008: screen identity (registered rooms)

Status: proposed. It ships with module 5 (registered screens and the IT export). Until then, every screen is unregistered.

## Context
The phone shows the room name so a user knows the screen is the right one. This is the main defense against a relay or phishing screen (threat model PAIR-03). A name is only worth something if an attacker's screen cannot claim it. The screen must still hold no account.

## Decision
- **Registration:** IT creates a room (`name`, optional `allowed_cidrs`, guest policy, link binding) with an enrollment key (`ROOM_ENROLL_KEY` at MVP, Entra app roles later). bloop returns a one-time enrollment link `https://<host>/s#enroll=<key>`.
- **Enrollment:** on the lectern browser, `/s` reads the fragment, removes it with `history.replaceState`, and posts it to `/api/rooms/enroll`. The response sets `__Host-bloop_room` (HttpOnly, Secure, SameSite=Strict, the longest lifetime the browser allows) holding the room id and a 256-bit room key. Only the key's hash is stored.
- **Use:** `POST /api/screens` with a valid room cookie, and a source IP inside `allowed_cidrs` when that is set, binds the screen to the room's `screen_ref`. The phone then shows the registered name. Any other screen shows "Unregistered screen" plus the warning card.
- **Rotation:** IT can rotate a key at any time; the old cookie stops working at once. The audit records enrollments and rotations.

## Consequences
- The screen holds one more item, a room cookie. It names a room and grants only "show this room's codes"; it can read nothing. `/it` lists it in "What the PC holds".
- On PCs that wipe browser data at sign-out, enrollment needs a managed browser policy or a kiosk profile. This is an open item for the first IT contact.
- A stolen room key lets an attacker show that room's name elsewhere. `allowed_cidrs` (the campus egress range) and rotation limit that.
