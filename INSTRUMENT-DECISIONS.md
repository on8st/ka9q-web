# Instrument UI — build decisions

Running log of decisions made while building the new instrument UI in this
fork, for whoever picks this back up. Not served (lives outside `html/`).
See the design brief and staged implementation prompt this work follows for
the invariants these decisions have to satisfy.

## Coexistence: subdirectory in the fork, not a separate service (2026-08-10)

`html/instrument/` is a second, independent static tree served alongside
stock `html/`, in the same fork/image. Rejected a wholly separate
repo/service (would have stayed upstream-eligible-adjacent and avoided ever
touching the shared `ka9q-web:latest` image) because keeping this
upstreamable to `wa2n-code/ka9q-web` mattered more than the operational
convenience of never rebuilding the shared image. Confirmed live via
`docker inspect` that all three running instances share one image with zero
volume mounts, so "coexist" here means "bake into the same image," not
"mount a live-writable directory."

## Makefile install line had to change (2026-08-10)

`install -m 644 -D html/* -t $(RESOURCES_BASE_DIR)/html/` doesn't recurse
into subdirectories - confirmed in isolation (empty scratch dir, no
container involved) that it exits non-zero with "omitting directory" the
moment `html/` contains one, which fails the Docker build outright.
Switched to `mkdir -p` + `cp -r` + explicit `chmod` (755 dirs, 644 files,
matching the original permissions). This is the one non-byte-identical
change to an existing file that adding a real subdirectory under `html/`
required - approved explicitly rather than assumed.

## /instrument/ is a directory listing, not the app - use /instrument/index.html (2026-08-10)

Onion's generic static file exporter has no built-in "serve index.html for
a directory" behaviour - confirmed live (isolated test container, `docker
build` from this branch, throwaway port, never touching the three
production instances): `GET /instrument/` returns an auto-generated
directory listing, `GET /instrument/index.html` returns the real page. The
stock page only works at bare `/` because of an explicit
`onion_url_add(urls, "^$", home)` registration in `ka9q-web.c` - not
because the exporter serves index files by default.

Decided **against** adding an equivalent route for `/instrument` in
`ka9q-web.c`, even though it would be a small, additive, non-behaviour
-changing diff: the brief specifically requires the C server to stay
byte-identical to its starting state, and the Makefile change above was
already the one exception granted. **Canonical URL is `/instrument/index.html`,
not `/instrument/`** - anything that links to this UI (docs, the eventual
receiver switcher, bookmarks) must use the full path. If this UI is ever
promoted to be the default interface, that promotion is exactly the moment
to revisit `ka9q-web.c`'s routes - not before.

## Discovery: startup-time script + Docker socket, not a live daemon (2026-08-10)

`discovery/generate_instances.py` is the container's `ENTRYPOINT`. It runs
once per container start, writes `html/instrument/instances.json`, then
`os.execv`s the real `ka9q-web` binary with the original argv so it becomes
PID 1 - the discovery script never stays resident and is not in the request
path at runtime. Refresh cadence is therefore "on container start" only,
not continuous; acceptable because this station's receiver set changes on
the order of months, not minutes.

Two things learned only by testing against the real system rather than
assuming:

- **`/status` (the existing HTTP route) carries no coverage data** - just a
  session count. Getting `fe`/`lowHz`/`highHz` per instance requires
  actually opening a brief WebSocket connection to each sibling and reading
  the same TLV fields the frequency-offset fix forwards
  (`FIRST_LO_FREQUENCY`, `FE_LOW_EDGE`/`FE_HIGH_EDGE`, `DESCRIPTION`) - not
  something reasonable to hand-roll in a shell script, hence the new
  `python3-websockets` runtime dependency (approved explicitly - see the
  Dockerfile comment).
- **The public hostname mapping genuinely lives outside this host.**
  Checked `oldmini`'s (192.168.36.68) real `/etc/caddy/Caddyfile` directly
  rather than guess: it does reverse-proxy `sdr-vhf/uhf/hf.on8st.be` to this
  host's `8081/8082/8083` exactly as the design mockup assumed. That
  mapping is `discovery/public-hostnames.json`, the brief's own stated
  zero-config exception, keyed by this instance's own `-p` port.

Verified genuinely end-to-end before touching any live container: built an
isolated test image, ran a throwaway container joined to the **real**
`ubersdr_sdr-network` (a new container added to that bridge network doesn't
affect its other members) with the Docker socket mounted read-only. Its
discovery step correctly found all three real production containers via
Docker's `ancestor` filter, resolved their real container names over that
network's own DNS, queried each one's real live coverage over a real
WebSocket connection, and produced exactly the mockup's expected JSON
shape with real data (2m/70cm/HF ranges all correct) and working
`sdr-*.on8st.be` URLs. Confirmed the real binary took over afterward (its
own startup banner appears immediately after discovery's log line) and
both stock `/` and the new `instances.json` served correctly. Torn down
afterward; the three live containers' `Id`/`Created`/image ID were
confirmed unchanged throughout.

One real property of this design worth flagging: Docker socket access is
**not scoped to a compose project or network** - a container with the
socket mounted can see and query every container on the host, not just its
own siblings. The `ancestor=ka9q-web:latest` filter is what actually scopes
this to the right containers, not network membership. Mounting the socket
into the three live containers is a materially bigger trust grant than
anything else added so far, and is the one remaining step that requires
touching those containers' compose files directly (and recreating them to
pick up the new image) - deliberately not done as part of this decision,
pending explicit sign-off.

**Rolled out live (2026-08-10)**: compose files updated, image rebuilt,
all three containers recreated with `--no-deps` (radiod-vhf/radiod-uhf/
ka9q-radio confirmed untouched - `Id`/`Created` unchanged). Found one more
thing only visible from a real multi-instance rollout: because discovery
runs once, before this instance's own `ka9q-web` binary is listening, **an
instance can never successfully query its own coverage and so never
appears in its own `instances.json`** - each one's `instances.json` lists
its two siblings only, never itself. Not a rollout glitch (did a
`docker restart` pass, not recreate, once all three were on the new image
so their lists reflect each other consistently) - it's inherent to
one-shot, pre-exec discovery.

**Decided against** turning discovery into a resident background
supervisor (fork the real binary instead of exec, retry its own query
once it's listening, refresh periodically) to fix this - real added
complexity for a gap with a much simpler fix. **The eventual instrument
UI itself already knows it's loaded on this exact instance** (it's about
to open its own WebSocket connection to itself for real receiver data
anyway) - it should synthesize its own `{id, fe, lowHz, highHz}` entry
client-side from that connection and merge it with whatever
`instances.json` reports about its siblings, rather than expecting
`instances.json` to ever describe the instance serving it. No server or
discovery-script change needed; this is a note for whoever builds the
actual switcher UI, not a task for this discovery step.

## Visual rework to match the approved mockup, and two real canvas bugs found in the process (2026-08-10)

The UI built through the tuning/mode/step/band/meter/rare-things commits
was functionally verified at every step but never checked against the
approved design mockup's actual visual target - a plain stacked settings-
form page (`<dl>`, separate `<form>`, full-page "Memories"/"Other
receivers" sections, default browser styling) instead of the mockup's
tight, single dockslot instrument bar. Caught only when asked to compare
screenshots directly against the mockup - a real process gap: functional
correctness was verified continuously, visual fidelity to the mockup
wasn't checked after the initial scaffolding step.

Reworked to adopt the mockup's CSS design system and segment+popover
interaction pattern close to verbatim (`.sgm`/`.cap`/`.val`, anchored
`.pop`-style panels with above/below flip positioning, `.digits` LCD
styling with lead-zero dimming, `#ident`/`#toolbar` chrome, a slide-in
`#drawer` for rare-things). Deliberately did NOT add visual chrome for
features `tests/check-parity.mjs` still marks unbuilt (audio, zoom,
colormap, CW shift, bandwidth/filter-edge control) - an inert-looking
control that does nothing would be worse than the plain page it replaced.

Rebuilt the spectrum/waterfall as one canvas (matching the mockup's
`#scope` exactly) instead of two, with real gridlines/frequency-axis
labels and genuine autoranging (smoothed min/max computed from the
actual incoming bin data) replacing the earlier fixed `-100/-20dB`
guess. Two real bugs found and fixed via direct pixel inspection, not
just visual inspection:

1. **The whole canvas was being cleared every frame**, including the
   waterfall's own scrolled history, immediately before trying to scroll
   it - so the waterfall could only ever show the single newest row.
   Fixed by only clearing the trace region each frame.
2. **`putImageData`/`createImageData` ignore the canvas's current
   transform entirely** (unlike `fillRect`/`lineTo`/`stroke`, which
   respect it) - mixing `ctx.setTransform(dpr,...)` for crisp high-DPI
   drawing with raw pixel-space `putImageData` calls silently wrote
   waterfall rows at the wrong scale and vertical position on any
   display with `devicePixelRatio != 1`. Fixed by doing all drawing math
   in raw `canvas.width`/`canvas.height` pixels throughout, no transform.

Both fixes verified directly via `getImageData` pixel sampling (not just
screenshots) against the real live VHF instance.

**A third issue, found the same way and now resolved**: even with both
bugs fixed, the waterfall still looked nearly empty in practice -
confirmed via a real WS frame count that this server sent real 0x7F
spectrum frames to an idle session at roughly 1 per 7.5 seconds, not the
~10/sec implied by `spectrum_poll_us`'s own 100ms default
(`ka9q-web.c:667`). Root-caused with a live packet capture (`sudo tcpdump`
on the station's Docker bridge, correlated with a real WS connection),
which showed the actual bottleneck wasn't radiod (broadcasting
constantly, independent of ka9q-web) or ka9q-web's response handling - it
was that **`ka9q-web` itself was barely sending spectrum requests at
all**. Read `ka9q-web.c`'s `case 'S':` handler to find out why:
`spectrum_thread()` - the dedicated 100ms poller - **only starts when the
client sends an explicit raw `S:` command**, not automatically on
connect. `html/radio.js`'s own `on_ws_open()` (`html/radio.js:702-704`)
does exactly this - `ws.send("S:STOP")` immediately (clearing stale
spectrum state a reattached session might still have - PROTOCOL-TEXT.md's
"sessions reattach by client IP" finding again), then `ws.send("S:")`
after an 80ms delay - sent **raw, not wrapped** in the `C:<clientId>:<seq>:`
envelope every other outbound command uses. This instrument UI's
`ws-client.js` never sent it at all, so `spectrum_thread` never started;
whatever slow trickle of frames was arriving came from some other,
incidental path (very likely a stale/reattached session from earlier
testing, given the "sessions reattach" behaviour already documented).

Fixed in `Ka9qWebClient.connect()`: replicates `on_ws_open()`'s exact
STOP-then-START-after-80ms sequence via a new `_sendRaw()` (unwrapped,
distinct from `_sendCommand()`'s envelope) plus public
`startSpectrum()`/`stopSpectrum()` methods. Verified live: real spectrum
frame rate went from ~2 in 15s to **91 in 10s** (~9.1/sec, matching the
100ms default almost exactly) - confirmed via both a fresh packet count
and a screenshot showing the waterfall actually filling in with real
colour instead of staying black.

**A fourth issue, reported live by the station operator with a
screenshot**: HF's spectrum/waterfall showed a hard, one-pixel-wide
discontinuity exactly at the centre gridline - looked like the two halves
of the band were swapped. Root cause was server-side this time, not in
this instrument UI's own code: `ka9q-web.c`'s `handle_bin_data()`
unconditionally applies a DC-centring circular shift written for a
complex→complex FFT's wrapped bin order, but a real→complex FFT
(`Frontend.isreal`, sent to the browser as `FE_ISREAL` - see
`status-decode.js`'s `FIELD_FE_ISREAL`) has no negative-frequency half at
all; its bins already arrive monotonic 0..Nyquist, so the same shift
splices the Nyquist bin directly onto DC instead of centring anything.
Confirmed live: HF and UHF's front ends both report `isreal=true`, VHF
reports `false`. Fixed by branching `handle_bin_data()` on
`Frontend.isreal` - real front ends now get a plain in-order fill,
complex front ends keep the original (correct, for them) shift unchanged.
Full derivation and the exact diff rationale: `PROTOCOL-SPECTRUM.md`'s
"Bin order bug for real-sampled front ends" section. Because this fix is
gated on the wire-confirmed `isreal` flag rather than a demod-type guess,
it's provably inert for VHF (unchanged code path) regardless of whether
the original "HF-specific legacy demod" hypothesis was the full story.

**A fifth issue, found while re-checking the HF "type an exact frequency"
flow** (`html/instrument/freq-digits.js`'s double-click-to-type input,
`freq-entry`): typing a value and hitting Enter intermittently failed to
take effect, and a Playwright check driving the same flow intermittently
timed out waiting on `#freq-entry` mid-fill. Root cause: `app.js` re-renders
the whole digit display (`digitDisplay.render(hz)`, a full
`container.innerHTML` replacement) on every `tunedFreq` event from the
server - the periodic status echo documented in `PROTOCOL-TEXT.md`, which
arrives independently of anything the user is doing. If one of those
echoes lands while the exact-value input is open, it silently destroys the
live, focused `<input>` out from under the user's typing - a real race,
not a flake, and consistently reproducible on a live receiver with regular
status traffic. Fixed with an `editing` flag in `createDigitDisplay`:
`render()` still records the incoming value but skips the DOM rebuild
while `editing` is true; the flag clears on commit (Enter/blur) or Escape,
so the *next* render (typically the server's own echo of the just-typed
value) redraws normally. Covered by a DOM-stub unit test in
`tests/js/freq-digits.test.mjs` (same minimal-stub pattern as
`meter.test.mjs`, no jsdom dependency) rather than only a live Playwright
check, since the race is about `render()`'s own contract and doesn't need
a real browser to verify.

**A sixth issue, reported by the station operator during a functionality
review**: VHF and UHF appeared to open on a brand-new session showing
`000.000.000` MHz, while HF opened correctly at 10.000.000 MHz (WWV).
Investigated by forcing fresh sessions (container restart drops
ka9q-web's in-memory, per-client-IP session state) - this did NOT
reproduce reliably: 6 separate fresh-restart attempts (3 on unmodified
code, 3 on an in-progress fix) all showed VHF opening at a clean
`010.000.000`, never `000.000.000`. The original report was most likely
a one-off race or a transient artifact of that specific test run (all
three containers restarted simultaneously), not a deterministic bug -
recorded here rather than silently dropped, since it couldn't be
conclusively ruled out either.

What IS real and worth fixing regardless: `ka9q-web.c`'s session-init
code (`sp->frequency = 10000000`) hardcodes 10 MHz - a genuinely good
default for HF (a real, known signal) - for every front end
unconditionally, including VHF (~144-146 MHz) and UHF (~430-440 MHz)
where it's nowhere near the receivable range. The channel does still
tune and echo back correctly (confirmed: the digits reliably show
`010000000`, not garbage), so this was never actually "stuck" - just a
meaningless out-of-coverage default a new visitor would have to
immediately re-tune away from. Fixed by keeping the 10 MHz default only
when it actually falls within the front end's real coverage
(`Frontend.frequency + frontend_if_bounds()`, the same bound calculation
`check_frequency()` already uses); otherwise defaulting to the centre of
that coverage. This only takes effect once `Frontend` has real data
(true for effectively every real-world connection - front ends here run
for weeks between restarts - but not the very first connection right
after a fresh container restart, before any status traffic has flowed).
Also fixed along the way: the correction math read `Frontend.frequency`
without checking it for NaN first (it's NAN-initialized until real data
arrives - see its init a few hundred lines up) - casting NaN to
`int64_t` is undefined behaviour in C, and an earlier version of this
fix hit exactly that, which is what actually produced a genuine
`000000000` freeze during testing. Guarded with `!isnan(...)` alongside
the existing `Frontend.samprate > 0` check.

## Audio playback (2026-08-11)

Ported the stock UI's entire audio pipeline - the single largest gap in
the parity manifest (4 of 43 features). Wire protocol and client
architecture researched from `html/radio.js`/`html/pcm-player.js`/
`html/opus-decoder.min.js` before writing anything, since audio's wire
behaviour has real, non-obvious differences from spectrum/channel data
already documented elsewhere in this fork:

- Audio, Channel Data (0x7E), and Spectrum Data (0x7F) all share the same
  RTP-style header; audio has no fixed payload shape of its own - the RTP
  **payload-type byte** carries the codec (`0x6F` = Opus, 48kHz mono) and,
  for PCM, the sample rate/channel combination (`0x70`-`0x7D`, per
  `audio-decode.js`'s `PCM_PT_HINTS`, ported from `radio.js`'s own table).
  New `html/instrument/audio-decode.js`, covered by
  `tests/js/audio-decode.test.mjs`.
- Unlike spectrum's raw `S:`/`S:STOP`, audio commands (`O:PCM`/`O:OPUS`/
  `A:START`/`A:STOP`) are wrapped in the normal `C:<clientId>:<seq>:`
  envelope, and every one needs this session's numeric SSRC - which
  arrives as its own inbound `S:<ssrc>` text message (same letter as the
  outbound raw spectrum command, unrelated context) that this UI's
  `ws-client.js` previously ignored entirely. Added SSRC capture plus
  `setAudioEncoding()`/`startAudio()`/`stopAudio()` to `Ka9qWebClient`,
  covered by new tests in `tests/js/ws-client.test.mjs`.
- Start sequence is order-sensitive: select encoding (`O:PCM`/`O:OPUS`)
  *then* `A:START`. Stop is also order-sensitive the other way: `A:STOP`
  *then* re-send the encoding selector, to keep the backend's per-session
  encoding state aligned even while audio is stopped. Toggling PCM<->Opus
  **while already playing** is neither of those - ported from
  `radio.js`'s `onPcmCheckboxChange()`, it's a single `O:PCM`/`O:OPUS`
  command with no `A:START`/`A:STOP` touched at all, confirmed by reading
  that exact handler after an initial (wrong) assumption that it did a
  full stop/restart cycle - caught by a failing test before it ever
  shipped, not by manual testing.
- PCM sample rate/channel count must come from the backend's own
  `OUTPUT_SAMPRATE`(20)/`OUTPUT_CHANNELS`(49) Channel Data TLV fields
  (added to `status-decode.js`, tracked as `client.audioOutput` in
  `ws-client.js`), never guessed from mode - stock's own code comment
  warns stereo modes like ISB/user1 need the real backend-reported
  layout, not a GUI-mode guess.
- The actual playback/decode engines are **reused, not reimplemented**:
  `html/pcm-player.js` (raw S16BE PCM -> `AudioContext`, `PCMPlayer`
  global) and the vendored `html/opus-decoder.min.js` (WASM Opus decoder,
  `window["opus-decoder"].OpusDecoder`) are loaded as plain classic
  `<script>` tags by `html/instrument/index.html` (same files the stock
  page already uses, referenced via `../` since `html/instrument/` is a
  subdirectory) - no duplicate/parallel audio-decoding code exists in
  this fork now.
- New `html/instrument/audio.js` (`createAudioPlayer(client)`) is the
  glue: PCM/Opus player lifecycle, the volume curve (perceptual `x^2.5`
  into an over-unity `[0,4]` gain range, ported exactly from
  `radio.js`'s `setPlayerVolume()` - a plain linear gain would sound
  quieter than stock), and recording (delegates to `PCMPlayer`'s own
  `startRecording()`/`stopRecording()`, which capture already-decoded
  audio via `MediaRecorder` + re-encode to `.wav` on stop - no server
  involvement, exactly matching stock). Covered by
  `tests/js/audio.test.mjs` using fake `PCMPlayer`/`OpusDecoder`
  globals (no real `AudioContext`/WASM in the test run) - command
  *sequencing* (what gets sent, in what order, under what state) is what
  these tests verify, not real audio output, which was checked live
  after deploying (see the parity manifest's `audio-toggle`/
  `audio-volume`/`audio-pcm`/`audio-record` entries).
- UI: new `#sgm-audio` segment in the instrument bar (matches the
  existing segment+popover pattern used by Mode/Meter/Band/etc.) with
  Start/Stop, a PCM/Opus checkbox, a volume slider, and a Record button
  that's disabled until audio is actually playing (mirrors stock's own
  "please start audio before recording" guard, but as a disabled state
  rather than an alert dialog).

## Zoom + spectrum display size (2026-08-11)

`PROTOCOL-TEXT.md` had explicitly flagged `Z:*` commands beyond `Z:SIZE`
as out of scope for its pass - researched and derived fresh from
`html/radio.js`/`html/spectrum.js` before porting:

- Zoom level is an **integer zoom-table index** (0..N-1), not a target
  span/Hz-per-bin value - `Z:<index>`, wrapped in the `C:` envelope. The
  table size is front-end-specific and queried once via a **raw**
  `Z:SIZE` (unwrapped, like spectrum's `S:`/`S:STOP` - not every command
  uses the envelope), reply `ZSIZE:<n>`. Sent once on connect
  (`ws-client.js`'s `connect()`, alongside the existing spectrum-thread
  kickstart) and used to set the zoom slider's `max`.
- `zoomin()`/`zoomout()` (stock's In/Out buttons) send a relative step
  command that also carries the currently-tuned frequency: `Z:+:<khz>` /
  `Z:-:<khz>` - `client.zoomStep(direction, freqHz)`.
- "Zoom to a clicked centre" in the parity manifest turned out to name
  the stock **`zoomcenter` button** ("Zoom Center", re-centers on the
  *currently tuned* frequency: `Z:c:<khz>`) - not literally clicking the
  spectrum canvas. That's a separate stock mechanism (`ckKeepFreqCentered`
  / "AZC", which changes what a canvas click does) belonging with "Keep
  frequency centred" instead, since the instrument UI doesn't have
  click-to-tune on the canvas yet either - left for that feature's own
  pass rather than half-building click-to-tune here just to gate it.
- Spectrum display size (`spectrum_size_up`/`down`) is confirmed
  **client-side only** - no WS traffic in stock at all, just a
  `canvas.height * spectrumPercent/100` trace/waterfall split ratio
  persisted to `localStorage`. Ported as `spectrum-canvas.js`'s
  `setSpectrumPercent()`/`increment`/`decrementSpectrumPercent()`,
  replacing the previous hardcoded `h * 0.46` split; the display now
  remembers its size across reloads the same way stock does
  (`instrument_spectrum_percent` key, matching this fork's existing
  `instrument_*` localStorage naming).
- UI placement: all three live in the drawer's new "Spectrum display"
  card, not the main instrument bar - these are setup-once adjustments,
  not per-tune interaction, matching the brief's "rare things are one
  action away" philosophy already applied to telemetry/pause/export.

## Autoscale + baseline/ceiling adjust (2026-08-11)

Researched `html/spectrum.js`'s `forceAutoscale()`/`measureMinMax()`/
`baselineUp()`/`baselineDown()`/`rangeIncrease()`/`rangeDecrease()`
before porting - all confirmed **purely client-side** (no WS traffic;
stock only ever streams raw dB bins, never a range/autoscale concept).

Two findings that changed scope from what the manifest literally lists:

- **`freeze_min_max` doesn't do what its name suggests.** It only gates
  whether the Max-Hold/Min-Hold *overlay trace arrays* keep updating -
  those traces don't exist in this instrument UI at all yet (tracked
  separately as "Max/min hold"). Porting a `freeze_min_max` checkbox now
  would ship a control with nothing to freeze. Moved into the Max/min
  hold task instead of building a dead checkbox here - see that task's
  own notes when it lands.
- **`ckonlyAutoscaleButton` doesn't map onto this UI's architecture.**
  Stock's autorange is normally a *fixed* range that only moves when
  autoscale/baseline/range buttons are pressed or something calls the
  internal `autoAutoscale()` (span change, mode change, etc.) - the
  checkbox suppresses just those automatic internal calls. This
  instrument UI's `spectrum-canvas.js` already auto-ranges *continuously*
  by design (`updateAutorange()`, every frame, `AUTORANGE_SMOOTHING`) -
  there is no automatic-trigger call site for the checkbox to gate.
  Left unbuilt as architecturally moot rather than added as an inert
  control.

What WAS ported, faithfully: `measureAutoscaleRange()` (real min/max of
the current frame's bins, ceiling rounded up to a 5 dB step, stock's own
rounding) backs a new `forceAutoscale()` - a one-shot snapshot-fit that
then holds fixed via the existing `manualRange`, matching stock's actual
behaviour (not this UI's usual continuous smoothing) exactly, just
computed instantly instead of stock's 5-frame settle wait (there's
nothing to wait for - the data is already in hand). `baselineUp/Down()`
nudge the floor and `rangeIncrease/Decrease()` the ceiling by 5 dB each,
both materializing whatever the current range is (auto or manual) into a
fixed one first, same as stock always operating on a concrete pair of
numbers. `rangeDecrease()` keeps stock's 10 dB minimum-span guard. New
"Range" row in the drawer's "Spectrum display" card.

## Waterfall colour bias + colormap selection (2026-08-11)

Both confirmed purely client-side (no WS traffic, no protocol doc hits
for "colormap"/"bias" anywhere). Colormap selection was the interesting
one: 8 of stock's 10 colormaps (`html/colormap.js`) are ~256-entry
numeric RGB tables copied wholesale from known external palettes
(matplotlib's viridis/inferno/magma, MATLAB jet, Google's turbo,
KiwiSDR/OpenWebRX's kiwi - the default) - not simple gradients that are
sanely hand-re-derived. Reused `html/colormap.js` as-is via a classic
`<script>` tag (same pattern as `pcm-player.js`/`opus-decoder.min.js` -
loaded once, `window.colormaps` referenced from `spectrum-canvas.js`)
rather than re-deriving ~2500 RGB triples or vendoring a duplicate copy.

`pickColormapColor(cmap, scaled)` is the only new pure logic - nearest-
stop lookup into whichever palette array is selected. Bias is ported
exactly per the formula found in `spectrum.js`'s `setRange()`: added to
the **floor only**, and **only for the waterfall's colour mapping** -
the trace's own range is untouched by it (confirmed: stock's
`wf_min_db = min_db + waterfallBias`, trace keeps plain `min_db`).
`waterfallColor()` in `spectrum-canvas.js` implements exactly that,
falling back to the built-in `HEATMAP_STOPS` gradient if `colormap.js`
somehow hasn't loaded (defensive only).

Deliberately scoped to the **waterfall only**, not the trace's fill
colour - stock's colormap also drives the trace's gradient fill, but
this instrument UI's trace has its own deliberate flat phosphor-green
look matching the approved design mockup; recolouring it per-colormap
would fight that mockup rather than serve it. Both persisted to
`localStorage` (`instrument_colormap_index`, `instrument_waterfall_bias`),
default colormap index 9 ("kiwi"), matching stock's own default. New
"Colormap" row in the drawer's "Spectrum display" card: a `<select>`
built from `COLORMAP_NAMES` (same order/labels as stock) plus the bias
number input.

## FFT averaging, max/min hold, window, overlap, poll rate (2026-08-11)

The biggest single research pass of this whole build - six features,
and unlike most of the earlier ones, several of these are **real
server-side commands**, not client-only cosmetics. Checked each one
individually rather than assuming the "spectrum display size" pattern
held everywhere:

- **`fft_avg_input` (client EMA) vs `spectrum_average_input` (real
  `g:<n>` command, radiod's own `SPECTRUM_AVG`)** are two DIFFERENT
  features despite the near-identical names - confirmed by grepping for
  `sendControl` near each handler individually rather than assuming
  both behave the same way. Both ported: `alphaForAveraging()`/
  `emaStep()` for the client one (applied in `processFrame()`, feeding
  both the trace and the waterfall - matching stock, where averaging
  happens before either consumes the bins), `client.setSpectrumAverage()`
  for the real one.
- **Window type/shape (`w:<TYPE>:<PARAM>`) and spectrum overlap
  (`v:<float>`)** are both real commands that reach radiod's own status
  protocol (`WINDOW_TYPE`/`SPECTRUM_SHAPE`/`SPECTRUM_OVERLAP` TLV tags,
  confirmed against `status.h`, not invented). Window type is sent as
  the enum NAME string (`"KAISER_WINDOW"` etc, matching
  `ka9q-web.c`'s `control_set_window_type()` string mapping), not an
  index.
- **Spectrum poll rate (`r:<ms>`) is real but doesn't reach radiod at
  all** - it sets `sp->spectrum_poll_us` directly on the ka9q-web
  session struct, changing how often *ka9q-web itself* polls radiod for
  fresh spectrum data (`spectrum_thread()`, `ka9q-web.c`), not any FFT
  parameter inside radiod. Ported anyway since it's a real, working
  control the manifest lists - just documented here so it isn't
  mistaken for another radiod-side knob.
- **Max/min hold is the only one of the six that's still 100%
  client-side** - `binsMax`/`binsMin` per-bin hold arrays, updated once
  per frame in `processFrame()` via `updateHoldValue()`, ported exactly
  from `Spectrum.prototype.drawSpectrum()`'s two loops including a
  faithfully-preserved quirk: **min-hold never decays** (stock's own
  min-hold branch is `this.binsMin[i] = this.binsMin[i]`, a literal
  no-op - the `decay_list` dropdown only ever affects the max-hold
  trace). `check_live` draws the live trace **unconditionally** (not
  gated by `max_hold`), while `check_max`/`check_min` require BOTH
  `max_hold` enabled AND their own checkbox - ported as the same
  double-gate in `draw()`. `freeze_min_max` (moved here from the
  autoscale task, see that task's notes on why) now has something real
  to freeze: it skips the `processFrame()` update loop entirely while
  checked, exactly matching stock's per-frame skip.
- Verified live, not just by eye: the min-hold trace initially looked
  completely absent on a live receiver even with real, correctly-varying
  values confirmed via a temporary debug hook (`__debugGetHoldArrays()`,
  removed before the final commit) - turned out to be genuinely rendering,
  just a single pixel row exactly at the trace/waterfall boundary
  (`y = Math.floor(splitY)`), outside a naive `y < Math.floor(h*0.46)`
  pixel-scan range used to check it. Root cause of the *visual* subtlety
  itself (not a bug, an architecture interaction worth knowing): this
  UI's `minDb` continuously auto-tracks the noise floor (unlike stock's
  normally-fixed range), and the min-hold value is *also* the historical
  noise-floor minimum - the two naturally converge, so the min-hold line
  often sits right on the bottom axis rather than visibly separating from
  it the way it would against a fixed range. Confirmed correctly
  computed and drawn either way; left as-is rather than "fixed" against
  a symptom that isn't actually wrong.
- New "FFT & hold" drawer card holds all six controls - the most
  control-dense card in this UI so far, but every one of them is a
  genuine "set it once and forget it" tuning knob, squarely fitting the
  brief's "rare things" philosophy even more than the earlier cards.

## Cursor, panning, clear overlay/reset, fill style, DC spike (2026-08-11)

Two of these four manifest lines turned out to each bundle **two
unrelated stock ids** - checked individually rather than assumed:

- **"Cursor / panning"** = `cursor` (a display-only cyan frequency
  marker, `spectrum.js`'s `cursor_active`/`cursor_freq`/`drawCursor()` -
  no WS traffic) **and** `panner_control` (stereo *audio* pan, the same
  `StereoPannerNode` machinery already reused for volume in the audio
  port - also no WS traffic). Genuinely unrelated features. A third,
  pre-existing concept - left-drag panning the spectrum *view* - sends a
  real `Z:c:<khz>` on drag-release, but that's neither of these two stock
  ids and was already covered by the earlier zoom work.
- **"Clear waterfall overlay / reset"** = `clear_overlay` (clears
  *loaded CSV comparison traces* - a stock feature, "Load Data", that
  has no instrument-UI equivalent to clear, since that load feature
  itself isn't built here) **and** `reset` (`resetSettings()`:
  `localStorage.clear()` + reload - a full settings wipe). Only `reset`
  had anything meaningful to port. Narrowed its scope deliberately:
  stock's page is the only thing at its origin, so a blanket
  `localStorage.clear()` is safe there; this instrument UI shares its
  *origin* (not just similarity) with the stock page at `/`, so the same
  blanket clear would also wipe stock's own settings - surprising and
  outside this button's stated scope. Ported as "clear every
  `instrument_`-prefixed key, then reload" (all six of this UI's own
  keys already share that prefix) instead.
- **Spectrum fill style** (`ckNoSpectrumFill`) and **hide DC spike**
  (`ckHideDcSpike`, this fork's own feature) ported directly - both
  simple, single-purpose toggles, no surprises. DC-spike's
  `interpolateDcSpike()` needed a `hzToBinIndex()` counterpart to
  `hzForPixel()`/`pixelForHz()` (spectrum-canvas.js didn't have a plain
  Hz→bin-index function yet, only Hz↔pixel) and the front end's real
  tuned centre (`frontendFrequencyHz`, already tracked in `app.js` from
  the `frontend` event) - wired through a new `setFrontendFrequencyHz()`.
  Applied in `processFrame()` *before* FFT averaging and max/min hold, so
  those also render/track a spike-free trace (stock's own ordering isn't
  fully explicit here, but this is the more consistent choice - a
  "cosmetic only" feature should look cosmetic-free everywhere it's
  drawn, not just on the live trace).

## Filter edges, CW shift, keep-centred (2026-08-11)

All three are real, previously-undocumented wire commands (`PROTOCOL-
TEXT.md` only covered `F:`/`M:`/`Z:SIZE`) - researched from `radio.js`
directly before porting, since demod parameters seemed the least likely
of everything so far to turn out client-only, and that held:

- **Filter edges** (`e:<lowHz>:<highHz>`, always sent as a pair) are Hz
  *offsets from the tuned carrier*, not absolute Hz. Confirmation comes
  back via Channel Data TLV tags 39/40 - a **different** pair from
  `FIELD_FE_LOW_EDGE`/`FIELD_FE_HIGH_EDGE` (100/101, the front end's own
  IF window, already decoded) - added as new `FIELD_LOW_EDGE`/
  `FIELD_HIGH_EDGE` constants and a `filterEdges` event on the client.
- **"CW shift/offset" bundles three genuinely different things under one
  misleading id-prefix** - checked stock's actual behaviour rather than
  trusting the `cw_*` naming: `shiftInput`/`sendShiftButton` is the real
  shift (`t:<hz>`, a post-detection audio/BFO offset meaningful in any
  mode, not CW-specific despite where it's used most) - the only one
  ported as a dedicated feature. `cw_instant_button` is actually
  **QuickBW**, an alternate-bandwidth toggle for USB/LSB that reuses
  feature 1's `e:` command with no shift/CW involvement at all;
  `cw_upper_input`/`cw_lower_input`/`cw_save_button` are QuickBW's
  *offset preset editor* (`localStorage`-only, no direct wire command of
  its own beyond the conditional edges re-send when saved while active).
  Ported QuickBW as a toggle button + editable preset (default
  `{lower:300, upper:700}`, matching stock) since it's a real, useful
  feature that was already going to need `setFilterEdges()` anyway - not
  scope creep, just the accurate shape of what "CW shift" actually
  covers in stock.
- **`SHIFT:<hz>` was already a documented *inbound* message
  (`PROTOCOL-TEXT.md`) that this UI's `ws-client.js` silently dropped** -
  `_onTextMessage` had cases for `BFREQ`/`M`/`ACK`/`BUSY`/`ZSIZE`/`S:` but
  none for `SHIFT`, so it fell through to the "not yet needed" catch-all.
  now wired.
- **"Keep frequency centred" (AZC) had nothing to gate** - confirmed the
  instrument UI had *no* click-to-tune-on-canvas at all before this (the
  existing canvas click handler only ever set the display-only Cursor
  marker, never sent `F:`). Built click-to-tune as this feature's
  prerequisite rather than leaving AZC honestly-unbuilt like
  `ckonlyAutoscaleButton` earlier: unlike that case, click-to-tune is
  independently useful standard SDR UX on its own, not a dead control
  waiting on an unrelated feature. Simplified from stock's drag-distance/
  duration-threshold click-vs-drag disambiguation, since this UI has no
  drag-to-pan yet to distinguish from - a plain click tunes.
  `createSpectrumDisplay()` gained an `onTune` callback option; AZC
  itself is just `if (azcEnabled) client.zoomCenter(hz)` right after the
  tune, reusing the zoom-center command already built.
- **Caught live, not by a test: the exact same input-clobbering race this
  session already found and fixed once for the frequency digits.**
  `filter-low`/`filter-high`/`shift-input` all get reflected from server
  echoes (`filterEdges`/`shift` events, which arrive periodically,
  independent of user action - same pattern as the earlier `tunedFreq`
  echo race). The first version blindly overwrote these inputs on every
  echo; typing `50` into `filter-low` then waiting 2s reverted it back to
  the server's last-known value (`-5000`) before the Send button was ever
  clicked - confirmed live via a direct fill-then-wait test, not assumed.
  Fixed with the same guard as `freq-digits.js`: skip the overwrite while
  `document.activeElement` is the input being typed into. **That guard
  alone still wasn't enough** for filter edges specifically, caught by
  the same kind of direct live test: filter edges are TWO separate
  inputs (Low, High) that both need editing before Send is clicked, so
  Low can be blurred-but-not-yet-sent while the user is still typing
  High - an echo landing in that gap clobbered Low even with the focus
  guard in place. Stock had already solved this exact problem
  (`edgeManualDirty`, `radio.js`) with a dirty flag per field, cleared
  only on Send rather than on blur - ported that instead of the simpler
  focus-only check for these two fields.

## Memory import/export, S-meter metric, band edges, mode-by-frequency, Alt (2026-08-11)

The last five parity-manifest entries. Two turned out to be manifest-name
misnomers (again - the fourth and fifth time this build has hit that
pattern) and one needed real data-format reconciliation:

- **Memory import/export** needed a translation layer, not a straight
  port: stock's format (`frequency_memories`, fixed 50-slot array,
  `{freq: string-Hz, desc, mode}`) and this UI's own (`memories.js`,
  unbounded, `{freqHz: number, label}`, no `mode` field) are genuinely
  different shapes, on purpose (this UI's memory feature was scoped as
  "save/recall quick-select chips," not stock's full 50-slot system -
  see that module's own header comment). Export produces this UI's
  native format (round-trips with itself exactly); import accepts
  *either* that format *or* a genuine stock export (dropping empty
  slots, translating fields, discarding `mode` since there's no field to
  put it in) for interop between the two UIs on the same station.
- **"S-meter metric"** needed real new decoding, not just a UI switch:
  Signal already worked (`ifPowerDb`), but SNR and OVR both needed fields
  this UI had never decoded before - `FIELD_BASEBAND_POWER` (46, arrives
  as *linear* power unlike every other power field in this protocol - a
  new `asDbFromLinearPower()` helper) and `FIELD_NOISE_DENSITY` (47) for
  SNR; `FIELD_SAMPLES_SINCE_OVER` (108) for OVR, which is **not a count**
  - it's `inputSamprate / samplesSinceOver`, decaying hyperbolically
  toward 0 the longer no overrange occurs (1.0 right after one, 0.1 ten
  seconds later), ported exactly from `smeter.js`, not the more obvious
  but wrong guess of "count of overranges." `meter.js`'s `render()` stays
  backward-compatible with its original plain-number call shape
  (`render(-40)` still means Signal) while also accepting a values object
  for the new metrics - didn't want to break the meter-style tests
  already covering the old shape for a feature that's additive to it.
- **Band edge markers** needed a new data table
  (`band-edges.js`/`HAM_BAND_EDGES`) - confirmed `band-options.js`'s
  existing chip data (single center frequencies, no edges, missing
  several bands, collapses 60m's five channels into one) isn't reusable
  for this; ported stock's separate `getHamBands()` table verbatim
  instead, simplified by dropping its inward-pointing arrow glyphs (the
  edge lines + label already communicate the boundary).
- **`cksbFrequency`** ("Status-bar frequency display" in the manifest) is
  actually **"Switch Modes by Frequency"** - an HF auto-mode-select on
  programmatic tuning from a hardcoded band table, nothing to do with a
  status bar. Ported faithfully to what it does (`mode-by-frequency.js`),
  applied to click-to-tune and band-select (both programmatic) but not
  typed entry or step nudges (user-driven) or memory recall (stock
  itself skips auto-switch there too, in favour of a stored per-memory
  mode - this UI's memories don't have that field, so the net effect
  matches: recall never triggers it, for a different but compatible
  reason).
- **`alternate_freq_buttons`** ("Alternate frequency display" in the
  manifest) is actually the **"Alt" step-button/entry-rounding
  toggle** - no display-format change at all. Simplified from stock's
  two button pairs (±100Hz outer, ±10Hz inner) to this UI's one step
  pair, using the more precise 10Hz target; also simplified by applying
  the round-to-nearest-kHz to both digit-click nudges and typed entry
  alike (stock only rounds the latter) rather than splitting
  `freq-digits.js`'s single shared commit callback for a rarely-used,
  even-in-stock-unpersisted toggle.

**Parity manifest: 43/43 - every stock feature is now reachable in this
instrument UI.** `tests/check-parity.mjs` confirms 0 manifest errors, 0
features remaining unbuilt.
