#!/usr/bin/env python3
"""Sample Internet endpoints for one controlled acceptance process; never log addresses.

This is a bounded snapshot check, not packet capture or proof about unobserved
input/import paths. The positive control is a separate loopback HTTP listener.
"""

import argparse
import ctypes
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def windows_endpoint_count(output, process_id):
    count = 0
    rows = 0
    for line in output.splitlines():
        fields = line.split()
        if not fields or fields[0].upper() not in ("TCP", "UDP"):
            continue  # Header words are localized; protocol names are not.
        minimum = 5 if fields[0].upper() == "TCP" else 4
        if len(fields) < minimum or not fields[-1].isdigit():
            raise ValueError("unrecognized netstat endpoint row")
        rows += 1
        count += int(fields[-1]) == process_id
    if not rows:
        raise ValueError("netstat returned no recognizable system endpoint rows")
    return count


def macos_endpoint_count(output, process_id):
    current_id = None
    count = 0
    for line in output.splitlines():
        if line.startswith("p"):
            if not line[1:].isdigit():
                raise ValueError("invalid lsof process field")
            current_id = int(line[1:])
        elif line.startswith("f"):
            if current_id != process_id or not line[1:]:
                raise ValueError("lsof returned an unexpected process/descriptor")
            count += 1
        elif line and not line.startswith("P"):
            raise ValueError("unexpected lsof field")
    return count


def endpoint_count(process_id):
    if sys.platform == "win32":
        result = subprocess.run(["netstat", "-ano"], capture_output=True,
                                timeout=4, check=False)
        if result.returncode or result.stderr.strip():
            raise RuntimeError("netstat endpoint enumeration failed")
        # Protocol and PID columns are ASCII even on localized Windows.
        return windows_endpoint_count(result.stdout.decode("ascii", errors="replace"), process_id)
    if sys.platform == "darwin":
        result = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(process_id),
                                 "-i", "-FpfP"], capture_output=True, timeout=4, check=False)
        if result.returncode not in (0, 1) or result.stderr.strip():
            raise RuntimeError("lsof endpoint enumeration failed")
        if result.returncode == 1 and result.stdout.strip():
            raise RuntimeError("lsof returned incomplete output")
        return macos_endpoint_count(result.stdout.decode("ascii", errors="strict"), process_id)
    raise RuntimeError("only native Windows and macOS endpoint tools are supported")


class ProcessGuard:
    def __init__(self, process_id):
        self.process_id = process_id
        self.handle = None
        if sys.platform == "win32":
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
            self.kernel.OpenProcess.restype = ctypes.c_void_p
            self.kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
            self.kernel.GetExitCodeProcess.restype = ctypes.c_int
            self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            self.kernel.CloseHandle.restype = ctypes.c_int
            self.handle = self.kernel.OpenProcess(0x1000, False, process_id)
            if not self.handle:
                raise RuntimeError("could not open acceptance process for liveness checks")

    def require_alive(self):
        if self.handle:
            code = ctypes.c_uint32()
            if not self.kernel.GetExitCodeProcess(self.handle, ctypes.byref(code)) or code.value != 259:
                raise RuntimeError("acceptance process ended during endpoint observation")
        else:
            # os.kill(pid, 0) is used only on POSIX; on Windows it can terminate a process.
            os.kill(self.process_id, 0)

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def parser_self_test():
    windows = """  Proto  Local Address  Foreign Address  State  PID
  TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    321
  TCP    [::1]:80      [::1]:123    ESTABLISHED  322
  UDP    [::]:53       *:*                       321
"""
    assert windows_endpoint_count(windows, 321) == 2
    assert windows_endpoint_count(windows, 322) == 1
    assert windows_endpoint_count(windows, 999) == 0
    assert macos_endpoint_count("p321\nf3\nPTCP\nf4\nPUDP\n", 321) == 2
    assert macos_endpoint_count("", 321) == 0
    for parse, fixture in ((windows_endpoint_count, "TCP malformed"),
                           (windows_endpoint_count, "no recognizable rows"),
                           (macos_endpoint_count, "p322\nf3\n"),
                           (macos_endpoint_count, "p321\nnunexpected\n")):
        try:
            parse(fixture, 321)
        except ValueError:
            pass
        else:
            raise AssertionError("malformed endpoint output was accepted")


def control_self_test():
    parser_self_test()
    # Bind only loopback, send no HTTP request, and use no client data. This
    # separate pair proves TCP and UDP listeners cannot look like empty tables.
    commands = [[sys.executable, "-m", "http.server", "0", "--bind", "127.0.0.1"],
                [sys.executable, "-c", "import socketserver; "
                 "socketserver.UDPServer(('127.0.0.1', 0), socketserver.BaseRequestHandler).serve_forever()"]]
    listeners = []
    guards = []
    try:
        for command in commands:
            listener = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            listeners.append(listener)
            guard = ProcessGuard(listener.pid)
            guards.append(guard)
            deadline = time.monotonic() + 8
            detected = False
            while time.monotonic() < deadline:
                guard.require_alive()
                if listener.poll() is not None:
                    raise RuntimeError("network observation positive control exited early")
                if endpoint_count(listener.pid) > 0:
                    detected = True
                    break
                time.sleep(0.1)
            if not detected:
                raise RuntimeError("network observation missed its loopback positive control")
        if endpoint_count(os.getpid()) != 0:
            raise RuntimeError("network observation negative control unexpectedly owns endpoints")
    finally:
        for listener in listeners:
            if listener.poll() is None:
                listener.terminate()
            listener.wait(timeout=5)
        for guard in guards:
            guard.close()
    print("RUNTIME_NETWORK_CONTROL_PASSED tcp=detected udp=detected negative=0")


def observe(process_id, seconds, report_path):
    report = {"scope": "controlled-preview-only-internet-endpoint-snapshots",
              "target_pid": process_id, "status": "error", "samples": 0,
              "detected_endpoints": 0, "requested_seconds": seconds,
              "started_utc": dt.datetime.now(dt.timezone.utc).isoformat()}
    started = time.monotonic()
    guard = None
    try:
        guard = ProcessGuard(process_id)
        while time.monotonic() - started < seconds:
            guard.require_alive()
            count = endpoint_count(process_id)
            guard.require_alive()
            report["samples"] += 1
            report["detected_endpoints"] += count
            if count:
                raise RuntimeError("acceptance client owns an Internet endpoint")
            time.sleep(0.25)
        if report["samples"] < 3:
            raise RuntimeError("too few completed endpoint snapshots")
        report["status"] = "passed"
    finally:
        if guard:
            guard.close()
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"RUNTIME_NETWORK_SAMPLING_PASSED samples={report['samples']} endpoints=0")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parser-self-test", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--duration", type=float, default=7)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.self_test:
        control_self_test()
    elif args.parser_self_test:
        parser_self_test()
        print("RUNTIME_NETWORK_PARSERS_PASSED")
    elif not args.pid or args.pid <= 0 or not args.report or not 1 <= args.duration <= 9:
        parser.error("supply a positive --pid, --report and a --duration from 1 to 9 seconds")
    else:
        observe(args.pid, args.duration, args.report)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Utility output may contain other system addresses. Never print it.
        print(f"RUNTIME_NETWORK_OBSERVATION_FAILED ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
