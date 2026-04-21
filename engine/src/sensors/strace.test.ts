import { describe, it, expect } from "vitest";
import {
  parseStraceLine,
  parseStraceLog,
  wrapWithStrace,
  straceTraceFlag,
} from "./strace.js";

describe("wrapWithStrace", () => {
  it("prepends strace options without touching the inner cmd", () => {
    const wrapped = wrapWithStrace(["node", "-e", "require('./a.js')"]);
    expect(wrapped[0]).toBe("strace");
    expect(wrapped).toContain("-f");
    expect(wrapped).toContain("-ttt");
    expect(wrapped).toContain("/tmp/strace.log");
    expect(wrapped.slice(-3)).toEqual(["node", "-e", "require('./a.js')"]);
  });

  it("trace flag includes the core syscall set", () => {
    const flag = straceTraceFlag();
    for (const sc of ["openat", "read", "write", "connect", "sendto", "execve", "clone", "unlinkat"]) {
      expect(flag).toContain(sc);
    }
  });
});

describe("parseStraceLine — syscall variants", () => {
  it("openat with AT_FDCWD and a path", () => {
    const p = parseStraceLine(
      `1700000001.123456 openat(AT_FDCWD, "/pkg/index.js", O_RDONLY) = 3`,
    );
    expect(p).not.toBeNull();
    expect(p!.syscall).toBe("openat");
    expect(p!.timestamp).toBeCloseTo(1700000001.123456);
    expect(p!.pid).toBeNull();
    expect(p!.ret).toBe("3");
  });

  it("bare PID prefix (modern strace -f) populates pid", () => {
    const p = parseStraceLine(
      `42    1700000002.000000 read(5, "data", 4096) = 4`,
    );
    expect(p!.pid).toBe(42);
    expect(p!.syscall).toBe("read");
  });

  it("bracketed [pid N] prefix (older strace) populates pid", () => {
    const p = parseStraceLine(
      `[pid 99] 1700000002.500000 write(5, "data", 4) = 4`,
    );
    expect(p!.pid).toBe(99);
    expect(p!.syscall).toBe("write");
  });

  it("connect with IPv4 and port", () => {
    const p = parseStraceLine(
      `1700000003.000000 connect(7, {sa_family=AF_INET, sin_port=htons(443), sin_addr="1.2.3.4"}, 16) = 0`,
    );
    expect(p!.syscall).toBe("connect");
    expect(p!.args).toContain(`sin_addr="1.2.3.4"`);
    expect(p!.args).toContain("htons(443)");
  });

  it("negative return values are captured", () => {
    const p = parseStraceLine(
      `1700000004.000000 openat(AT_FDCWD, "/nope", O_RDONLY) = -1`,
    );
    expect(p!.ret).toBe("-1");
  });

  it("0x hex return values are captured", () => {
    const p = parseStraceLine(
      `1700000005.000000 mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, 3, 0) = 0x7f0000000000`,
    );
    expect(p!.ret).toBe("0x7f0000000000");
  });

  it("returns null on unfinished syscalls", () => {
    expect(parseStraceLine(`1700000006.000000 read(5,  <unfinished ...>`)).toBeNull();
  });

  it("returns null on resumed lines", () => {
    expect(parseStraceLine(`1700000007.000000 <... read resumed>"data", 4096) = 4`)).toBeNull();
  });

  it("returns null on strace info lines", () => {
    expect(parseStraceLine(`strace: Process 123 attached`)).toBeNull();
    expect(parseStraceLine(`+++ exited with 0 +++`)).toBeNull();
  });

  it("returns null on blank / non-matching lines", () => {
    expect(parseStraceLine("")).toBeNull();
    expect(parseStraceLine("random garbage")).toBeNull();
  });
});

describe("parseStraceLog — Event extraction", () => {
  const runStartSec = 1_700_000_000;

  it("maps openat to kind=openat with path in normalized", () => {
    const log = `1700000001.500000 openat(AT_FDCWD, "/pkg/.npmrc", O_RDONLY) = 3\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("openat");
    expect(events[0]!.stream).toBe("L1:seccomp");
    expect(events[0]!.normalized).toMatchObject({ path: "/pkg/.npmrc", ret: "3" });
    expect(events[0]!.timestamp).toBe(1_500_000_000); // 1.5 sec × 1e9 ns
  });

  it("maps connect to kind=connect with addr+port", () => {
    const log = `1700000001.000000 connect(7, {sa_family=AF_INET, sin_port=htons(443), sin_addr="1.2.3.4"}, 16) = 0\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events[0]!.kind).toBe("connect");
    expect(events[0]!.normalized).toMatchObject({ addr: "1.2.3.4", port: 443 });
  });

  it("maps execve to kind=execve with path+argv", () => {
    const log = `1700000001.000000 execve("/bin/sh", ["sh", "-c", "bad"], 0x7ffc) = 0\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events[0]!.kind).toBe("execve");
    expect(events[0]!.normalized).toMatchObject({
      path: "/bin/sh",
      argv: ["sh", "-c", "bad"],
    });
  });

  it("maps rename to kind=rename with from+to", () => {
    const log = `1700000001.000000 rename("/tmp/src", "/tmp/dst") = 0\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events[0]!.kind).toBe("rename");
    expect(events[0]!.normalized).toMatchObject({ from: "/tmp/src", to: "/tmp/dst" });
  });

  it("maps unlink / unlinkat to kind=unlink with path", () => {
    const log =
      `1700000001.000000 unlink("/tmp/a") = 0\n` +
      `1700000002.000000 unlinkat(AT_FDCWD, "/tmp/b", 0) = 0\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events[0]!.normalized?.path).toBe("/tmp/a");
    expect(events[1]!.normalized?.path).toBe("/tmp/b");
  });

  it("read / write capture fd number", () => {
    const log =
      `1700000001.000000 read(3, "", 4096) = 0\n` +
      `1700000001.000100 write(4, "hi", 2) = 2\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events[0]!.normalized?.fd).toBe(3);
    expect(events[1]!.normalized?.fd).toBe(4);
  });

  it("assigns pid 0 to unprefixed lines and captures explicit pid otherwise", () => {
    const log =
      `1700000001.000000 openat(AT_FDCWD, "/a", O_RDONLY) = 3\n` +
      `42    1700000001.100000 openat(AT_FDCWD, "/b", O_RDONLY) = 4\n` +
      `[pid 99] 1700000001.200000 openat(AT_FDCWD, "/c", O_RDONLY) = 5\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events[0]!.pid).toBe(0);
    expect(events[1]!.pid).toBe(42);
    expect(events[2]!.pid).toBe(99);
  });

  it("skips strace info lines and unfinished syscalls", () => {
    const log =
      `strace: Process 123 attached\n` +
      `1700000001.000000 openat(AT_FDCWD, "/x", O_RDONLY) = 3\n` +
      `42    1700000002.000000 read(3,  <unfinished ...>\n` +
      `42    1700000002.500000 <... read resumed>"payload", 4096) = 7\n` +
      `+++ exited with 0 +++\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events).toHaveLength(1);
    expect(events[0]!.normalized?.path).toBe("/x");
  });

  it("clamps pre-runStart timestamps to 0", () => {
    const log = `1699999999.500000 openat(AT_FDCWD, "/a", O_RDONLY) = 3\n`;
    const events = parseStraceLog(log, runStartSec);
    expect(events[0]!.timestamp).toBe(0);
  });
});
