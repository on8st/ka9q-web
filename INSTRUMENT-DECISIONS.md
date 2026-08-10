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
