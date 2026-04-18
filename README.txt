NEON MODES ONLINE PATCH

This keeps your original Neon Modes HTML file as the client and adds:
- Public matchmaking by mode
- Private rooms by code
- Global online play after deployment
- Local solo/offline still works

Run locally:
1) npm install
2) npm start
3) open http://localhost:3000

How it works:
- Offline: your original game works like before.
- Online: click the new Online button in the menu, connect, and create/join rooms.
- Public tries to match another player in the same selected mode.
- Private starts immediately and others can join later by code.

Important honesty note:
- This patch keeps your exact Neon Modes client base, but the multiplayer sync is a host-authoritative patch layered on top of the original code.
- It is not a full server-authoritative rewrite of all mechanics.
- Across-the-world play works after deploying the server to a public host.
