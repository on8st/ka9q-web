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
| 4 | 4 | BE | `centerHz` | Centre of the displayed span, **baseband-relative** - see "Baseband-relative, not absolute RF" below. |
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

## Baseband-relative, not absolute RF

`centerHz` is relative to the front end's own baseband, **not** an
absolute RF frequency - confirmed directly: HF's fixture shows
`centerHz=16,200,000`, exactly half of `binWidthHz * binCount`
(`20,000 * 1620 = 32,400,000`), consistent with a baseband window
centred on 0 Hz (HF's RX888 is direct-sampling, so baseband centre ==
absolute RF centre there). This is **exactly the same 0-Hz assumption**
this fork's frequency-offset fix (`ka9q-web.c`/`radio.js`, `on8st-vhf-uhf`
branch) already had to correct for the *tuned-frequency* display - the
same correction applies here: an instrument UI must add the front end's
real tuned centre (`FIRST_LO_FREQUENCY`, `tests/decode_status.py` /
`html/instrument/status-decode.js`) to `centerHz` to get the real
absolute RF frequency axis for the spectrum display. Not yet re-derived
independently for VHF/UHF in this pass (their fixtures' `centerHz` values
reflect this specific test session's leftover zoom/pan state, not a clean
baseline) - the HF cross-check is what actually confirms the relationship,
and the existing frequency-offset fix's own client-side math
(`getIfBounds()`, `spectrum.js`) is the reference implementation to follow
for the general (possibly-asymmetric) case.

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
(complex/IQ-sampled Airspy tuner). The fix branches `handle_bin_data()` on
`Frontend.isreal` directly - real front ends get a plain in-order copy
(same shape as `handle_bin_byte_data()`'s), complex front ends keep the
original shift unchanged. This is why VHF never showed the bug (never took
the wrong branch) and why UHF's identical `isreal=true` didn't visibly show
it either - UHF's live band was too quiet/uniform during comparison
screenshots for a one-bin seam to be visually obvious, not evidence the bug
was absent there.
