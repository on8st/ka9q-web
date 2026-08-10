# ka9q-web's text WebSocket protocol

The binary RTP+TLV "Channel Data"/"Spectrum Data" stream (documented in
`tests/decode_status.py`) carries front-end telemetry - front-end coverage,
signal power, sample rates. It does **not** carry tuned frequency or mode.
Those travel over a second, informal text protocol layered on the same
WebSocket connection - reverse-engineered here from `html/radio.js`
directly and confirmed against real traffic captured live from all three
running instances (2026-08-10), before any instrument-UI code depends on
it, per this fork's own "tests before code" convention (see
`INSTRUMENT-DECISIONS.md`).

## Inbound (server -> client), colon-delimited text frames

| Prefix | Example | Meaning |
|---|---|---|
| `S:<ssrc>` | `S:1234567890` | Assigns this connection's SSRC. |
| `BFREQ:<val>` | `BFREQ:10000000.000` | Current backend (tuned) frequency. **Unit is ambiguous by design** - `radio.js` treats `val > 1000000` as already-Hz, otherwise kHz (`html/radio.js:~1284`). **Not a reliable on-connect snapshot** - see "Sessions are reattached, not recreated" below. |
| `BFREQ_FORCE:<val>` | same as `BFREQ` | Same meaning, but the client must apply it unconditionally (used after reconnect/session recovery to override any locally-adopted value). |
| `SHIFT:<hz>` | `SHIFT:0.000` | BFO/shift frequency in Hz. Confirmed always sent on connect (`process_status_packet()` in `ka9q-web.c` sends it unconditionally whenever the backend's shift value differs from what this session was last told - and a freshly attached session has never been told anything). |
| `M:<mode>` | `M:usb` | Current demod mode/preset, lowercase. Not observed on any of the three live instances during this research (no active session currently has a mode set - see "Confirmed live" below). |
| `M_FORCE:<mode>` | same as `M` | Forced mode update, applied unconditionally (same reconnect-recovery purpose as `BFREQ_FORCE`). |
| `ACK:<clientId>:<seq>` | `ACK:ab12cd34:7` | Acknowledges a command this client sent with that `clientId`/`seq` (see outbound envelope below). |
| `BUSY:<reason>` | `BUSY:session limit reached` | Session rejected; client shows a popup and stops reconnecting. |
| `ZSIZE:...` | - | Zoom-table size/state; not yet decoded here (out of scope for this pass - only frequency/mode were researched). |
| `PING` | `PING` | Keepalive, sent by the server every ~2s (a dedicated ping thread in `ka9q-web.c`). No reply expected. |

## Outbound (client -> server): `C:<clientId>:<seq>:<rawCommand>`

Every command is wrapped: `wrapControlMessage(cid, seq, raw)` = `'C:' + cid
+ ':' + seq + ':' + raw` (`html/radio.js:35`). The server ACKs each one by
echoing `clientId`/`seq` back. Raw command formats seen in `radio.js`
(only the tuning/mode-relevant ones catalogued in this pass - many more
exist for zoom, spectrum settings, memories, etc., out of scope here):

| Raw command | Example | Meaning |
|---|---|---|
| `F:<khz>` | `F:14250.000` | Set frequency, in **kHz**, 3 decimals (Hz precision) - `ws.send('F:' + (Math.round(fVal)/1000.0).toFixed(3))`. Note this is kHz even though the inbound `BFREQ` echo of the same value is ambiguous-by-magnitude - the outbound format is NOT ambiguous. |
| `Z:SIZE` | `Z:SIZE` | Requests current zoom table size (out of scope - zoom/spectrum display work is separate from this pass). |

Mode-setting's raw wire command was not directly located as a `ws.send()`
call site during this pass (only `F:` and `Z:*` were confirmed as
send-side) - `setMode()` in `radio.js` needs a closer read before any
instrument-UI mode-setting code is written. **Flagging as unverified
rather than guessing the format.**

## Sessions are reattached by client IP, not recreated per connection (2026-08-10, corrects an earlier wrong reading of this doc)

**Earlier revisions of this doc claimed `BFREQ` is "sent unprompted right
after connect" and that a `BFREQ:10000000.000` reading means "no active
session." Both were wrong** - inferred from a handful of observations
before reading the actual server logic. Verified against `ka9q-web.c`
directly instead:

- `home()` (`ka9q-web.c:~1820`) looks up a session by `client_desc`
  (derived from the connection's source address, `client_desc_from_request()`)
  and **reattaches** the existing session struct if one exists for that
  client, rather than allocating a fresh one per WebSocket connection.
- `process_status_packet()`'s unconditional `BFREQ` send is gated on
  `*last_sent_backend_frequency` - `NaN` for a genuinely brand-new session
  (so it fires once), otherwise only when `Channel.tune.freq` differs from
  what *this specific session* was last told (`ka9q-web.c:~3950`). A
  reattached session already "knows" its last-told frequency, so nothing
  gets resent unless the real backend frequency actually changes.
- `SHIFT`, by contrast, is sent unconditionally whenever it differs from
  `sp->shift` (also fresh-`NaN` on a new session) - confirmed via repeated
  live reconnects to always arrive, unlike `BFREQ`.
- **Operationally significant, pre-existing behaviour, not something this
  fork's work introduced**: the code's own comment at `ka9q-web.c:~1836`
  explicitly anticipates "clients all sharing client_desc=127.0.0.1."
  Combined with `oldmini`'s Caddy doing hairpin NAT for LAN clients (its
  own Caddyfile comments note LAN traffic all appears to Caddy as the
  router's IP), **multiple simultaneous real listeners behind the same
  NAT could reattach to the same session and share/steal each other's
  tuning** in stock ka9q-web. Out of scope to fix as part of this
  instrument UI - flagging it here because it's a real characteristic of
  the protocol this UI has to work with, discovered while researching it.

**Practical consequence for any client**: don't assume a `BFREQ` arrives
on connect at all. The only message reliably sent to a freshly attached
session is `SHIFT`. A UI must treat "no `BFREQ` yet" as "not yet reported"
- not as a meaningful state itself, and not as "no session," which isn't
a real concept this protocol has.

## Outbound F: confirmed live (2026-08-10, explicit go-ahead)

Sent `C:ctest001:1:F:145500.000` to the live VHF instance from a throwaway
connection: got `ACK:ctest001:1` immediately, then `BFREQ:145500000.000`
(echoed in Hz - `145500000 > 1000000` so the magnitude-based ambiguity
rule above resolves correctly). Envelope, ACK, and the `F:`/`BFREQ`
round-trip are verified against real behaviour. **Correction**: this pass
originally also claimed the subsequent stale-default reading on reconnect
proved "each client gets its own independent channel" - given the
client-IP reattach mechanism above, that reconnect (same source IP, same
`client_desc`) almost certainly reattached to the *same* session, and the
channel's real frequency was reset by something else in the meantime (the
code's own comments point to `ka9q_ubersdr`'s orphan-channel reaper, which
zeroes unrecognized channels roughly every 60s) - not by session
isolation. Not re-verified further; flagging the original claim as
unconfirmed rather than leaving it stated as fact.

## Explicitly not yet done in this pass

- Mode-setting's raw outbound command format - not located as a `ws.send()`
  call site, and not guessed at. `setMode()` in `radio.js` needs a closer
  read before any instrument-UI mode-setting code is written.
- Zoom/spectrum-display commands (`Z:*` beyond `Z:SIZE`), memory slots, and
  the rest of the broader control surface - deliberately out of scope for
  this pass, which targeted only what a minimal live-status + basic-tuning
  UI needs.
- The mode-setting raw command format (see table above).
- Zoom/spectrum-display commands, memory slots, and the rest of the
  broader control surface - deliberately out of scope for this pass, which
  targeted only what a minimal live-status + basic-tuning UI needs.
