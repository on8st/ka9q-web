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

**A third, separate, unresolved finding**: even with both bugs fixed,
the waterfall still looks nearly empty in practice - confirmed via a
real WS frame count that this server sends real 0x7F spectrum frames to
an idle session at roughly **1 per 7.5 seconds**, not the ~10/sec implied
by `spectrum_poll_us`'s own 100ms default (`ka9q-web.c:667`). The poll
loop itself (`spectrum_thread()`, `ka9q-web.c:~3185`) does run every
`spectrum_poll_us`; something between that internal poll and the actual
WebSocket broadcast to the browser is throttling much further. Not yet
traced to a root cause - needs its own investigation pass through
`process_spectrum_packet()`/`send_ws_binary_to_session()` before
concluding whether this is fixable client-side (a command this UI isn't
sending yet, e.g. a faster explicit poll-rate request - see the stock
`spectrumPollInput`/`spectrumPollButton` in the parity manifest, still
marked unbuilt here) or requires understanding server-side session
activation state.
