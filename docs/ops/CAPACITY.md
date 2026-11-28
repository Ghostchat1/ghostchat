# Raazdar server capacity and stress test (28 Nov 2026)

## Test setup
- A copy of the v7.0 relay, pinned to **one CPU core** (like the 1 vCPU droplet). The load generator ran on a different core.
- Real ECDSA P-384 accounts with proof-of-work, real authenticated inbox sockets, anonymous drop sockets, padded 2–4 KB envelopes, and acks.
- The proxy in front was tested with both **Caddy** (what the droplet runs) and **nginx**, plain HTTP. TLS adds a little more memory per connection.

## Results

| Test | Result |
|---|---|
| 500 users online, 200 msg/s | p50 1 ms, p99 6 ms, CPU 2%, RAM 98 MB |
| 5,000 users online, 1,000 msg/s (4 KB) | p50 3 ms, p99 14 ms, CPU 8%, RAM 155 MB |
| 3,000 users online, 4,000 msg/s | p50 11 ms, p99 41 ms, CPU 23%, RAM 138 MB |
| 3,000 users online, **12,000 msg/s** | p50 31 ms, p99 177 ms, CPU 57%, RAM 240 MB, 0 lost |
| 12,000 sockets connected, 2,000 msg/s | p50 5 ms, p99 15 ms, CPU 12%, RAM 233 MB |
| RAM per registered ID (Raazdar) | ~6–10 KB |
| RAM per open socket (Raazdar) | ~3–4 KB |
| **RAM per open socket (Caddy)** | **~80 KB** (8,000 sockets = 640 MB) |
| RAM per open socket (nginx) | ~19 KB (8,000 sockets = 160 MB) |

Every message was delivered in every test, with no losses and no "busy" refusals.

## What limits the 1 GB droplet
1. **Memory, through Caddy.** Each online phone keeps 2 sockets (inbox + anonymous sending). With Caddy using ~80 KB per socket, 1 GB of RAM fits roughly **2,000 phones online at the same moment**. That usually means about 10,000–20,000 daily users.
2. **Monthly data transfer.** Texts are tiny: 1 TB is ~250 million messages. **Video calls and large files** use the transfer allowance: one hour of relayed video call is about 1.5–2 GB.
3. **CPU is not the limit.** One core handled 12,000 messages a second at about 60%.

## Fixes made in v7.0.1 (so the server slows down instead of crashing)
- Caps now scale with the machine's RAM:
  - On 1 GB: ~4,000 sockets, ~30,000 registered IDs, waiting messages ~150 MB, large-file store ~200 MB.
  - Before this fix, the queue and file stores alone could reach 812 MB on a 1 GB machine.
- A "memory tight" check covers the whole machine (MemAvailable). When memory is short, the server refuses new connections, uploads and messages to offline users with a temporary "busy". Phones retry automatically, so nothing is lost.
- The owner panel shows free memory, connections against capacity, and ID capacity.

## When to upgrade
| Online at once | Do this | Approx. cost |
|---|---|---|
| up to ~2,000 | current 1 vCPU / 1 GB | ~$6–8/month |
| ~5,000 | resize to 2 vCPU / 4 GB (DigitalOcean → Resize, ~1 min downtime) | ~$24/month |
| ~10,000+ | 4 GB **and** replace Caddy with nginx (4× lighter per connection) | ~$24–48/month |
| ~50,000+ | several relays plus a shared message bus (an architecture change, plan ahead) | — |

Watch the owner panel. When "connections" passes about 70% of capacity on busy evenings, or "⚠️ LOW" memory appears, it's time to resize.
