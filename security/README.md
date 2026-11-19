# Security test kit (OWASP + VAPT)

- `attack_server.py`: 28 black-box attacks on the relay (HTTP + WebSocket). Run: `python3 attack_server.py 3000`
- `attack_client.py`: 13 attacks by a malicious user against other users in real browsers (needs Playwright and Chrome)
- `before_*.txt` / `after_*.txt`: results before and after the fixes

Requires: `pip install cryptography websocket-client playwright`. Start the server first (`npm start`).
For the connection-cap test, start it with `MAX_CONNS=300`.
