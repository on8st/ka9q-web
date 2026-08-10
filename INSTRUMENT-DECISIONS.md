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
