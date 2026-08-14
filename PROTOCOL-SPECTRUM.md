# ka9q-web's SPECTRUM DATA (0x7F) binary packet

Reverse-engineered from `html/radio.js`'s own decode loop and confirmed
against real spectrum frames already present in `tests/fixtures/*.bin`
(captured 2026-08-10 for the Channel Data/text-protocol research - turns
out they already contain 0x7F frames too, no new capture needed). Same
RTP-style 12+cc*4 byte header as Channel Data (0x7E) - see
`tests/decode_status.py` - but a completely different payload layout: a
fixed-size 92-byte record, then exactly `binCount` bytes of bin data (one
byte per bin), no TLV structure at all.

## Fixed header (92 bytes, right after the RTP header)

**The first 16 bytes are big-endian; everything else is little-endian.**
Confirmed by exact match against known real values (see below), not
assumed from a consistent style - `radio.js` mixes byte order here itself
(`ntohl()` on the first three is actually a no-op, `v >>> 0`; the real
byte-order split is `getUint32(i)` with no second argument (defaults
big-endian) for the first three fields, `true` for every field after).

| Offset | Size | Endian | Field | Notes |
|---|---|---|---|---|
| 0 | 4 | BE | `binCount` | Number of bins that follow. Always 1620 on this station regardless of zoom level - matches every `zoom_table` entry in `ka9q-web.c`. |
| 4 | 4 | BE | `centerHz` | Centre of the displayed span, **absolute RF Hz** - see "centerHz is absolute, not baseband-relative" below (this entry was wrong in an earlier pass of this doc). |
| 8 | 4 | BE | `frequencyHz` | The channel's tuned frequency - same field/semantics as `BFREQ` (`PROTOCOL-TEXT.md`), just delivered via this binary packet too. Confirmed identical value (`10000000`, the stale no-session default) across all three instances' fixtures. |
| 12 | 4 | BE | `binWidthHz` | Hz per bin. `binWidthHz * binCount` = displayed span width. |
| 16 | 4 | LE | `input_samprate` | Confirmed matches each front end's real sample rate: 2,400,000 (VHF), 20,000,000 (UHF), 64,800,000 (HF). |
| 20 | 4 | LE | `rf_agc` | Not decoded further in this pass. |
| 24 | 8 | LE | `input_samples` | uint64. |
| 32 | 8 | LE | `ad_over` | uint64. |
| 40 | 8 | LE | `samples_since_over` | uint64. |
| 48 | 8 | LE | `gps_time` | uint64. |
| 56 | 4 | LE | `noise_bw` | float32. |
| 60 | 4 | LE | `rf_atten` | float32. |
| 64 | 4 | LE | `rf_gain` | float32. |
| 68 | 4 | LE | `rf_level_cal` | float32. |
| 72 | 4 | LE | `if_power` | float32, dB. **Confirmed identical to the same moment's Channel Data `IF_POWER` field** (-36.89 dB on both, same connection) - same underlying measurement, two delivery paths. |
| 76 | 4 | LE | `noise_density_audio` | float32. |
| 80 | 4 | LE | `z_level` | uint32, current zoom table index. |
| 84 | 4 | LE | `bins_autorange_offset` | float32, dB. See bin decoding below. |
| 88 | 4 | LE | `bins_autorange_gain` | float32, dB/step. **0 means no real autorange data has arrived yet** - `radio.js` falls back to `0.5` (matching radiod's own `init_chan` default) rather than dividing by zero or showing garbage. |

Then **exactly `binCount` bytes** (confirmed: `1724`-byte captured frames
minus 104 header bytes = 1620, matching `binCount` exactly on all three
instances) - one byte per bin, decoded as:

```
dB = bins_autorange_offset + (bins_autorange_gain || 0.5) * byteValue
```

Byte value `128` (the frame's actual floor in the captured fixtures) with
`offset=-150, gain=0.5` decodes to `-86 dB` - a flat noise floor, expected
since no real, currently-tuned session was active in any of the captured
fixtures.

## centerHz is absolute, not baseband-relative (corrected 2026-08-11)

**This section originally concluded the opposite - that finding was
wrong, and stayed wrong for a while because it was derived entirely from
HF data, where the mistake is invisible.** Corrected here with the full
account, since it caused a real live regression before being caught.

`centerHz` (`sp->center_frequency`, `ka9q-web.c`) is **absolute RF Hz**,
matching every other frequency field in this protocol - confirmed
definitively two ways:
1. **Stock's own client (`html/radio.js`) uses the wire value directly**,
   with no `FIRST_LO_FREQUENCY` addition anywhere in its decode path
   (`spectrum.setCenterHz(centerHz)`, unmodified).
2. **Every other server-side function that touches `sp->center_frequency`
   treats it as absolute already** - `check_frequency()`, `zoom_to()`,
   and `adjust_center_within_bounds()` all compare it directly against
   `Frontend.frequency`-derived absolute bounds (`frontend_if_bounds()`),
   with detailed comments from an earlier fix in this same fork
   explicitly reasoning about it as absolute (e.g. `check_frequency()`'s
   own comment on a `145000010 -> 4294547296` uint32 wraparound bug it
   fixed - only possible if the value being manipulated was already in
   the ~145 MHz absolute range).

The original "baseband-relative" conclusion came from HF's fixture
alone: `centerHz=16,200,000`, exactly half of `binWidthHz * binCount`
(`32,400,000`) - which looks like "a baseband window centred on 0 Hz"
*only* because HF's own `Frontend.frequency` (the RX888's LO) happens to
be ~0 Hz (direct sampling, no tuner). For HF, "absolute" and "the middle
of a 0-centred baseband window" are numerically identical, so the two
hypotheses were indistinguishable from HF data alone - the doc's own
"not yet re-derived independently for VHF/UHF" caveat correctly flagged
this as unverified, but the conclusion was still shipped as fact and
propagated into a client-side correction (`absoluteCenterHz()`,
`html/instrument/spectrum-decode.js` - since removed) that added
`FIRST_LO_FREQUENCY` on top of an already-absolute value. That extra
addition was invisible for HF (adding ~0 to an already-correct value)
and produced a plausible-*looking* result for VHF/UHF **only by
coincidence**: a separate, simultaneous server-side bug (an earlier
version of the session-init default-view fix, see `ka9q-web.c`'s own
comment there) was sending a genuinely baseband-relative `0` for
complex/IQ front ends at that specific moment, which the client's wrong
addition then "corrected" back to the right absolute number - two bugs
briefly cancelling out. The moment the server-side bug was fixed (to
correctly send an absolute value), the client's still-wrong addition
started doubling the displayed centre frequency instead - caught via a
live report (VHF showing ~300 MHz, UHF ~800 MHz, roughly double their
true ~145 MHz / ~435 MHz centres) before it was understood as two
separate, individually-necessary fixes rather than one.

**Takeaway for future work on this field**: `centerHz` needs no
correction on the client - use it exactly as received, same as stock
does. If a genuinely baseband-relative value is ever needed again for
some other purpose, derive it explicitly (`centerHz - Frontend.frequency`
via the Channel Data `FIRST_LO_FREQUENCY` field) rather than assuming the
wire field itself is relative.

## Bin order bug for real-sampled front ends (fixed, `on8st-vhf-uhf`)

Live on HF (2026-08-10): the rendered trace and waterfall showed a hard,
one-pixel-wide discontinuity exactly at the centre gridline - confirmed by
screenshot, not just a hunch. Root cause was server-side, in
`handle_bin_data()` in `ka9q-web.c` (the function that fills the `power[]`
array later encoded into the bytes described above): it unconditionally
performed a DC-centring circular shift -

```c
int i = l_count / 2; // DC
do { power[i] = ...; i++; if (i == l_count) i = 0; } while (i != l_count / 2);
```

- written for a complex→complex FFT's wrapped bin order
(`[0..+N/2-1,-N/2..-1]`), rotating it into monotonic centre-out order. A
**real→complex FFT** (`Frontend.isreal` in `radio.h`, forwarded to the
browser as `FE_ISREAL`) has no negative-frequency half at all - its bins
already arrive in monotonic 0..Nyquist order. Applying the same shift to
already-monotonic data doesn't centre anything; it splices the
Nyquist-adjacent bin directly onto the DC bin, which is exactly the seam
that was reported.

Confirmed live via each front end's own `FE_ISREAL` field: HF and UHF both
report `isreal=true` (real-sampled ADCs), VHF reports `false`
(complex/IQ-sampled Airspy tuner).

**First fix attempt (superseded - do not reimplement this):** branch
`handle_bin_data()` on `Frontend.isreal` directly, skipping the shift for
real front ends on the theory that a real→complex FFT's bins already
arrive in monotonic 0..Nyquist order. Reasonable in theory, empirically
wrong for what this station's actual `BIN_DATA` backend (HF's radiod fork
- the only front end still using this legacy format; VHF/UHF use the
newer `BIN_BYTE_DATA` encoding via the separate `handle_bin_byte_data()`,
untouched by any of this) actually puts on the wire: skipping the shift
left HF's real DC-first array completely unrotated - not a cosmetic
one-bin seam, but a full left/right half swap (the upper half of the
requested window landed in the first half of the array, the wrapped
lower half in the second), reported live as "HF spectrum display:
left/right sides swapped" (`docs/ISSUES.md` issue 1).

**Shipped fix:** `handle_bin_data()` always applies the shift, independent
of `Frontend.isreal` - `BIN_DATA` is always raw FFT order
(`[0..+N/2-1,-N/2..-1]`) and always needs it to become ascending-frequency
order, confirmed independently by on8st/omnisdr's own protocol decoder
(`src/spectrum/ka9q-protocol.js`), which found `BIN_DATA` always needs the
shift and `BIN_BYTE_DATA` never does, with no dependency on `isreal`
either way. VHF/UHF never showed the original one-pixel-seam bug because
they don't go through `handle_bin_data()` at all (see above), not because
of anything `isreal`-related.
