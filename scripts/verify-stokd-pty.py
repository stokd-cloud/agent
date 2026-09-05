#!/usr/bin/env python3
"""Bounded Unix PTY regression for named agent shims and terminal restoration.
Build the Rust engine and TypeScript runtime first. No external model is used.
Run: python3 scripts/verify-stokd-pty.py
"""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent


def resize(fd, rows, columns):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))


with tempfile.TemporaryDirectory(prefix="stokd-pty-' ") as directory:
    directory = Path(directory)
    fixture = directory / 'model.py'
    fixture.write_text('''import sys,time
prompt=sys.stdin.read()
if "Current user message:\\nWAIT\\n" in prompt: time.sleep(30)
if prompt.startswith("Extract durable"): print('["The compass is named Juniper."]')
elif prompt.startswith("Rewrite this rolling"): print("The compass is Juniper.")
else: time.sleep(.3); print("Juniper is ready for the journey.")
''')
    # Keep a shell-like session leader alive until the child has restored its
    # terminal. Darwin revokes a controlling PTY when its leader exits, so
    # inspecting the parent's slave fd after that exit is too late.
    supervisor = directory / 'supervisor.py'
    supervisor.write_text('''import fcntl,subprocess,sys,termios
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
result = subprocess.call(sys.argv[1:])
print("\\nSTOKD_PTY_RESTORED=" + str(termios.tcgetattr(0)[3]), flush=True)
sys.exit(result)
''')
    config = directory / 'config.json'
    config.write_text(json.dumps({
        'providers': [{'name': 'fixture', 'command': 'python3', 'args': [str(fixture)], 'models': ['test-model']}],
        'models': {'workloads': {'agent': ['test-model']}},
        'agent': {'timeoutSeconds': 40},
    }))
    env = dict(os.environ, STOKD_AGENT_CONFIG=str(config), STOKD_AGENT_HOME=str(directory / 'data'),
               STOKD_AGENT_BIN_DIR=str(directory / 'bin'),
               STOKD_AGENT_ENGINE=str(ROOT / 'apps/agent-cli/target/debug/stokd-agent-engine'), TERM='xterm-256color')
    subprocess.run(['node', str(ROOT / 'bin/stokd-agent.js'), 'create', 'navigator'], env=env, check=True, capture_output=True, timeout=10)
    for fullscreen in (False, True):
        master, slave = pty.openpty()
        os.set_blocking(master, False)
        resize(slave, 24, 40)
        original = termios.tcgetattr(slave)
        process = subprocess.Popen([sys.executable, str(supervisor), str(directory / 'bin/navigator'), '--fullscreen' if fullscreen else '--inline'],
                                   env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        output = bytearray()

        def drain():
            if not select.select([master], [], [], .05)[0]:
                return
            try:
                output.extend(os.read(master, 65536))
            except BlockingIOError:
                pass
            except OSError as error:
                if error.errno != errno.EIO:
                    raise

        def wait_exit(timeout):
            deadline = time.monotonic() + timeout
            # A real terminal continues consuming output during teardown.
            # Waiting without reading can block tcdrain/close on Darwin.
            while process.poll() is None and time.monotonic() < deadline:
                drain()
            if process.poll() is None:
                raise subprocess.TimeoutExpired(process.args, timeout)
            return process.returncode

        def wait_for(fragment, timeout=10):
            start = time.monotonic()
            while time.monotonic() - start < timeout:
                if fragment in output:
                    return
                drain()
                if process.poll() is not None:
                    break
            raise AssertionError(f'PTY did not show {fragment!r} (fullscreen={fullscreen}): {output[-5000:]!r}')

        try:
            wait_for(b'navigator')
            output.clear()
            os.write(master, b'Hello\r')
            wait_for(b'Juniper')
            # Wait for memory extraction/finish using the durable state, without
            # guessing how many frames the terminal needs to paint.
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                status = subprocess.run(['node', str(ROOT / 'bin/stokd-agent.js'), 'command', 'navigator', 'status'], env=env, check=True, capture_output=True, text=True, timeout=5)
                if json.loads(status.stdout)['state'] == 'complete':
                    break
                time.sleep(.1)
            else:
                raise AssertionError('Turn did not complete')
            output.clear()
            os.write(master, b'/memories\r')
            wait_for(b'Memories')
            os.write(master, b'\x1b')
            time.sleep(.2)
            output.clear()
            os.write(master, b'WAIT\r')
            wait_for(b'Thinking')
            time.sleep(.2)
            output.clear()
            os.write(master, b'\x1b')
            wait_for(b'Cancelled')
            resize(slave, 18, 32)
            process.send_signal(signal.SIGWINCH)
            time.sleep(.2)
            os.write(master, b'\x03')
            wait_exit(8)
            drain_deadline = time.monotonic() + 1
            while time.monotonic() < drain_deadline and select.select([master], [], [], .05)[0]:
                drain()
            assert process.returncode == 0, output[-3000:]
            marker = output.rsplit(b'STOKD_PTY_RESTORED=', 1)[-1].splitlines()[0]
            assert marker.isdigit(), 'Terminal restoration was not observed'
            assert int(marker) & (termios.ICANON | termios.ECHO) == original[3] & (termios.ICANON | termios.ECHO), 'Terminal raw mode was not restored'
            if fullscreen:
                assert b'\x1b[?1049l' in output, 'Alternate screen was not restored'
            print(f'PASS named shim, chat, memory panel, cancel, resize, clean exit: {"fullscreen" if fullscreen else "inline"}', flush=True)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    wait_exit(5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    wait_exit(5)
            os.close(master)
            os.close(slave)
