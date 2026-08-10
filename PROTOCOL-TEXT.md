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
| `BFREQ:<val>` | `BFREQ:10000000.000` | Current backend (tuned) frequency. **Unit is ambiguous by design** - `radio.js` treats `val > 1000000` as already-Hz, otherwise kHz (`html/radio.js:~1284`). Sent unprompted right after connect (a state snapshot), not only on change. |
| `BFREQ_FORCE:<val>` | same as `BFREQ` | Same meaning, but the client must apply it unconditionally (used after reconnect/session recovery to override any locally-adopted value). |
| `SHIFT:<hz>` | `SHIFT:0.000` | BFO/shift frequency in Hz. Also sent unprompted on connect. |
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

## Confirmed live (2026-08-10, read-only capture, all three instances)

Connecting and listening for ~5s with no commands sent, on all three
(`ws://localhost:8081/`, `:8082/`, `:8083/`):

```
'SHIFT:0.000'
'BFREQ:10000000.000'
'PING'  (repeating every ~2s)
```

Identical on VHF, UHF, and HF - no `M:` message at all. This is a stale/
no-active-session default (the well-known hardcoded "WWV 10MHz" default
this fork's own frequency-offset fix already deals with client-side), not
real per-band state - confirming that **without an active browsing
session, these three receivers currently report no meaningful tuned
frequency at all**. Any instrument-UI code reading `BFREQ` needs to treat
this specific value as "no real session yet," not as VHF/UHF suddenly
being tuned to 10MHz (which is outside both bands' coverage entirely).

## Outbound F: confirmed live (2026-08-10, explicit go-ahead)

Sent `C:ctest001:1:F:145500.000` to the live VHF instance from a throwaway
connection: got `ACK:ctest001:1` immediately, then `BFREQ:145500000.000`
(echoed in Hz - `145500000 > 1000000` so the magnitude-based ambiguity
rule above resolves correctly). Confirmed a completely independent session:
reconnecting fresh afterward showed the stale `BFREQ:10000000.000` default
again, not stuck at 145.5MHz - each client genuinely gets its own channel,
torn down cleanly on disconnect with zero effect on any other listener.
Envelope, ACK, and the `F:`/`BFREQ` round-trip are now verified against
real behaviour, not just read from source.

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
