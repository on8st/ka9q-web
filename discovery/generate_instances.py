#!/usr/bin/env python3
"""Zero-config sibling-instance discovery for the instrument UI.

Runs once at container startup (see the Dockerfile ENTRYPOINT), before
exec'ing the real ka9q-web binary, so startup isn't delayed by discovery -
writes html/instrument/instances.json immediately with whatever's
reachable at that moment, then execs the real binary with the original
argv so it becomes PID 1.

Also spawns a detached background process (--daemon) that re-runs
discovery every REFRESH_INTERVAL_S and rewrites instances.json - the
three ka9q-web consumers on this station are redeployed independently,
one at a time, not together, so a sibling that wasn't up yet at THIS
container's own boot moment (confirmed live, 2026-08-12: whichever
consumer redeploys last sees all siblings, whichever redeploys first
sees only itself - a pure boot-order race, not a detection bug) would
otherwise stay invisible until this container itself happens to restart
too. The background process is unaffected by the foreground execv() call
below - it's a separate child process (subprocess.Popen), not a thread,
so replacing this process's own image doesn't touch it. Same "background
watcher via a plain child process, no supervisor" pattern already used in
this repo's HF radiod image (images/ka9q-radio-hf/Dockerfile's
start-radiod.sh).

What's zero-config: which ka9q-web containers exist, and each one's real
coverage (queried live over its own WebSocket, same protocol
tests/decode_status.py already decodes) - read from Docker and from the
running receivers themselves, never hand-maintained.

What isn't, by design (see discovery/public-hostnames.json): the mapping of
public hostnames to instances. That mapping lives on a different physical
host entirely (oldmini's Caddyfile) and cannot be read from here - the
design brief's own stated exception to zero-config.
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import time
import urllib.parse

import websockets.sync.client as ws_client
from websockets.exceptions import WebSocketException

from status_decode import (
    FIELD_FE_HIGH_EDGE,
    FIELD_FE_ISREAL,
    FIELD_FE_LOW_EDGE,
    FIELD_FIRST_LO_FREQUENCY,
    FIELD_INPUT_SAMPRATE,
    decode_channel_data_fields,
    as_bool,
    as_float32,
    as_float64,
)

DOCKER_SOCKET = "/var/run/docker.sock"
INSTANCES_JSON_PATH = "/usr/local/share/ka9q-web/html/instrument/instances.json"
HOSTNAME_MAP_PATH = os.path.join(os.path.dirname(__file__), "public-hostnames.json")
REFRESH_INTERVAL_S = 30  # background --daemon re-run cadence
FIELD_DESCRIPTION = 4
WS_CONNECT_TIMEOUT_S = 3
WS_READ_DEADLINE_S = 3


class _UnixSocketHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(DOCKER_SOCKET)


def docker_api_get(path):
    conn = _UnixSocketHTTPConnection("localhost", timeout=5)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return json.loads(resp.read())
    finally:
        conn.close()


def discover_sibling_containers():
    """Every container running this same role, via Docker's own API - not
    a hand-maintained list. Returns [{name, port, mcast}, ...].

    Filters by container NAME prefix, not `ancestor: ka9q-web:latest` (the
    original approach) - confirmed live, 2026-08-12: `ancestor` resolves
    the tag to whatever specific image ID it CURRENTLY points to and only
    matches containers bound to that exact ID. Every fix deployed this
    session rebuilt and re-tagged ka9q-web:latest, but the three consumers
    are redeployed independently, one at a time - so at any moment,
    whichever container was redeployed most recently is bound to a
    different (newer) image ID than its still-running siblings, and
    `ancestor` silently excludes them. A sibling is defined by its ROLE
    (its stable container name), not by which exact build it happens to
    be running at this moment - name-prefix matching doesn't have this
    problem."""
    filters = urllib.parse.quote(json.dumps({"name": ["ka9q-web-"]}))
    containers = docker_api_get(f"/containers/json?filters={filters}")
    own_id = socket.gethostname()  # Docker sets this to the short container ID by default
    siblings = []
    for c in containers:
        if c["Id"].startswith(own_id):
            # Skip self - the frontend already adds a "self" entry from its
            # own live connection (isSelf: true, shown as "here"). Only
            # matters for the background --daemon refresh: the one-shot
            # run at boot (before this container's own ka9q-web binary is
            # listening) never found itself anyway, but a later daemon
            # refresh - running once the real server is up - can
            # successfully WS-connect to itself, which would otherwise add
            # a redundant, clickable-to-itself duplicate of "self" for
            # every consumer running the daemon fix (confirmed live).
            continue
        detail = docker_api_get(f"/containers/{c['Id']}/json")
        name = detail["Name"].lstrip("/")
        cmd = detail["Config"]["Cmd"] or []
        port = mcast = None
        for i, arg in enumerate(cmd):
            if arg == "-p" and i + 1 < len(cmd):
                port = cmd[i + 1]
            elif arg == "-m" and i + 1 < len(cmd):
                mcast = cmd[i + 1]
        if port:
            siblings.append({"name": name, "port": port, "mcast": mcast})
    return siblings


def query_coverage(container_name, port):
    """Opens a brief WS connection to a sibling (container-name DNS
    resolution works within the shared Docker network) and reads enough
    Channel Data frames to answer: front-end description, real tuned
    centre, and IF window. Returns None if nothing usable arrives in time -
    that instance is simply omitted from instances.json, per the brief's
    'if it cannot be read, mark it as such rather than guess.'"""
    url = f"ws://{container_name}:{port}/"
    fields = {}
    try:
        with ws_client.connect(url, open_timeout=WS_CONNECT_TIMEOUT_S) as ws:
            needed = {FIELD_FIRST_LO_FREQUENCY, FIELD_FE_LOW_EDGE, FIELD_FE_HIGH_EDGE, FIELD_DESCRIPTION}
            while not needed.issubset(fields.keys()):
                frame = ws.recv(timeout=WS_READ_DEADLINE_S)
                if isinstance(frame, str):
                    continue
                decoded = decode_channel_data_fields(frame)
                if decoded:
                    fields.update(decoded)
    except (OSError, TimeoutError, WebSocketException) as e:
        print(f"discovery: {container_name}: no coverage data ({e})", file=sys.stderr)
        return None

    if FIELD_FIRST_LO_FREQUENCY not in fields:
        return None
    frontend_hz = as_float64(fields[FIELD_FIRST_LO_FREQUENCY])
    low_if = as_float32(fields.get(FIELD_FE_LOW_EDGE, b"")) or 0.0
    high_if = as_float32(fields.get(FIELD_FE_HIGH_EDGE, b"")) or 0.0
    return {
        "fe": fields.get(FIELD_DESCRIPTION, b"").decode("utf-8", "replace") or None,
        "lowHz": frontend_hz + low_if,
        "highHz": frontend_hz + high_if,
    }


def load_hostname_map():
    try:
        with open(HOSTNAME_MAP_PATH) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return {k: v for k, v in data.items() if not k.startswith("_")}


def band_id_from_container_name(name):
    return name.removeprefix("ka9q-web-") or name


def generate():
    hostnames = load_hostname_map()
    instances = []
    for sibling in discover_sibling_containers():
        coverage = query_coverage(sibling["name"], sibling["port"])
        if coverage is None:
            continue
        band_id = band_id_from_container_name(sibling["name"])
        instances.append({
            "id": band_id,
            "name": sibling["name"],
            "fe": coverage["fe"],
            "lowHz": coverage["lowHz"],
            "highHz": coverage["highHz"],
            "url": (
                f"https://{hostnames[sibling['port']]}/instrument/index.html"
                if sibling["port"] in hostnames else None
            ),
        })
    return instances


def run_once():
    try:
        instances = generate()
        os.makedirs(os.path.dirname(INSTANCES_JSON_PATH), exist_ok=True)
        with open(INSTANCES_JSON_PATH, "w") as f:
            json.dump(instances, f)
        print(f"discovery: wrote {len(instances)} instance(s) to {INSTANCES_JSON_PATH}", file=sys.stderr)
    except Exception as e:
        # Discovery must never block the actual receiver from starting -
        # the switcher just won't appear, exactly like a fetch() failure
        # the mockup already handles client-side.
        print(f"discovery: failed, continuing without instances.json ({e})", file=sys.stderr)


def run_daemon():
    """Background loop for the detached refresher process (see the module
    docstring) - re-runs discovery every REFRESH_INTERVAL_S for the life
    of the container, so a sibling that boots after this one still shows
    up eventually instead of staying invisible until this container's own
    next restart."""
    while True:
        time.sleep(REFRESH_INTERVAL_S)
        run_once()


if __name__ == "__main__":
    if "--daemon" in sys.argv:
        run_daemon()
        sys.exit(0)

    run_once()

    # Detached background refresher, separate from the foreground exec
    # below - see module docstring. start_new_session=True so it isn't
    # tied to this process's controlling terminal/session; it remains a
    # normal child of PID 1 either way, since execv() doesn't fork - it
    # replaces this process's own image in place, so the PID that spawned
    # this child is the same PID that becomes ka9q-web.
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--daemon"],
        stdout=sys.stderr, stderr=sys.stderr,
        start_new_session=True,
    )

    # Replace this process with the real binary - it becomes PID 1, normal
    # signal handling, this script (the foreground copy) never stays
    # resident - the daemon copy above does, deliberately.
    os.execv("/usr/local/sbin/ka9q-web", ["/usr/local/sbin/ka9q-web"] + sys.argv[1:])
