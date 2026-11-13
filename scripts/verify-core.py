#!/usr/bin/env python3
"""Test the built plugin against an isolated real core, without coding agents."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--core", default="herdr-core")
parser.add_argument("--plugin", default="bin/herdr-team")
options = parser.parse_args()
plugin = str(Path(options.plugin).resolve())

PROGRAM = r'''
import os, subprocess, sys, tty
tty.setraw(0)
mode, receipts, core, caller = sys.argv[1:]
def report(state):
    os.write(1, ('\x1b]7501;state=' + state + ':app=team-verification\x1b\\').encode())
os.write(1, b'\x1b[?2004h')
report('idle' if mode == 'message' else mode)
data = b''
while True:
    chunk = os.read(0, 65536)
    if not chunk:
        break
    data += chunk
    if data.endswith(b'\r'):
        report('working')
        with open(receipts, 'a') as output:
            output.write('delivered\n')
        if mode == 'message':
            subprocess.run([core, 'send', caller, 'Isolated verification message'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           check=True, timeout=20)
        os.write(1, b'role acknowledged\r\n')
        report('done')
        data = b''
'''

# Explicit socket and private config/state prevent inherited core settings from
# reaching the user's session. Short paths also fit macOS Unix socket limits.
with tempfile.TemporaryDirectory(prefix="ht", dir="/tmp") as temporary:
    root = Path(temporary).resolve()
    env = dict(os.environ, HC_SESSION="verify", HC_SOCKET=str(root / "core.sock"),
               HC_TERMINAL_ID="", HERDR_CORE_BIN_PATH=options.core,
               HERDR_PLUGIN_STATE_DIR=str(root / "team-state"))
    for name in ["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"]:
        directory = root / name.lower()
        directory.mkdir(mode=0o700)
        env["XDG_" + name + ("_DIR" if name == "RUNTIME" else "_HOME")] = str(directory)
    program = root / "program.py"
    program.write_text(PROGRAM)

    def call(*args):
        result = subprocess.run([options.core, "--json", *args], env=env,
                                text=True, capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return json.loads(result.stdout)

    def terminals():
        # ls JSON is intentionally abbreviated; get returns the complete record.
        return [call("get", row["address"]) for row in call("ls", "--all")["terminals"]]

    def invoke(project, *flags):
        result = subprocess.run([plugin, "--backend", "core", "--project", str(project), *flags],
                                env=env, text=True, capture_output=True, timeout=90)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout

    def receipts():
        return {str(path): path.read_text().count("delivered\n")
                for path in root.glob("receipt-*")}

    try:
        call("server", "status")
        caller = call("run", "--bg", "--no-parent", "--no-notify", "--name", "verification-caller",
                      "--cwd", str(root), "--", "/usr/bin/env", "python3", str(program),
                      "working", str(root / "caller-receipts"), "", "")["address"]
        for mode in ["idle", "done", "message"]:
            project = root / mode
            (project / ".team" / "members").mkdir(parents=True)
            (project / ".team" / "team.md").write_text(
                "---\nname: verification\nleader: leader\nmembers: [members/leader.md, members/dev.md]\n---\nVerification only\n")
            for member in ["leader", "dev"]:
                arguments = [str(program), mode, str(root / ("receipt-" + mode + "-" + member)), options.core, caller]
                (project / ".team" / "members" / (member + ".md")).write_text(
                    "---\nid: " + member + "\nkind: python3\nargs: " + json.dumps(arguments) + "\n---\nFixture only\n")
            env["HC_TERMINAL_ID"] = caller if mode == "message" else ""
            output = invoke(project)
            assert "Team ready" in output, output
            if mode == "message":
                assert "continuing the same turn" in output, output
            live = terminals()
            before = receipts()
            assert all(before.get(str(root / ("receipt-" + mode + "-" + member))) == 1
                       for member in ["leader", "dev"]), before
            status = invoke(project, "--status")
            assert "Team startup: ready" in status and "done" in status, status
            assert "Team ready" in invoke(project)
            assert len(terminals()) == len(live), "reuse created terminals"
            assert receipts() == before, "reuse or status resent a role"
            print("PASS:", mode, "initialization, status, reuse, one delivery per member")
            for terminal in live:
                if terminal["labels"].get("herdr-team"):
                    call("kill", terminal["address"])
                    call("rm", terminal["address"])
    finally:
        env["HC_TERMINAL_ID"] = ""
        for terminal in terminals():
            # This socket and every terminal on it were created by this test.
            if terminal["state"] == "live":
                call("kill", terminal["address"])
            call("rm", terminal["address"])
        call("server", "stop")
        print("Cleaned up the isolated verification core and terminals")
