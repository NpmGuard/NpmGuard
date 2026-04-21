import { describe, it, expect } from "vitest";
import { parseTsharkJson } from "./pcap.js";

function wrap(layers: Record<string, unknown>, timeRelative = 0): unknown {
  return {
    _source: {
      layers: {
        frame: { "frame.time_relative": String(timeRelative) },
        ...layers,
      },
    },
  };
}

describe("parseTsharkJson", () => {
  it("returns empty on empty input", () => {
    expect(parseTsharkJson("")).toEqual([]);
    expect(parseTsharkJson("   ")).toEqual([]);
  });

  it("returns empty on malformed JSON", () => {
    expect(parseTsharkJson("not json")).toEqual([]);
    expect(parseTsharkJson("{not an array}")).toEqual([]);
  });

  it("returns empty on non-array JSON", () => {
    expect(parseTsharkJson('{"not": "array"}')).toEqual([]);
  });

  it("extracts a DNS query", () => {
    const packets = [wrap({ dns: { "dns.qry.name": "attacker.com" } }, 0.123)];
    const events = parseTsharkJson(JSON.stringify(packets));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stream: "L2:pcap",
      kind: "dns_query",
      normalized: { host: "attacker.com" },
      timestamp: 123_000_000,
    });
  });

  it("extracts an HTTP request (host + method + uri)", () => {
    const packets = [
      wrap(
        {
          http: {
            "http.host": "legit.example.com",
            "http.request.method": "POST",
            "http.request.uri": "/collect",
          },
        },
        1.5,
      ),
    ];
    const events = parseTsharkJson(JSON.stringify(packets));
    expect(events[0]).toMatchObject({
      kind: "http_request",
      normalized: { host: "legit.example.com", method: "POST", path: "/collect" },
      timestamp: 1_500_000_000,
    });
  });

  it("extracts a TLS SNI", () => {
    const packets = [
      wrap({ tls: { "tls.handshake.extensions_server_name": "attacker.com" } }),
    ];
    const events = parseTsharkJson(JSON.stringify(packets));
    expect(events[0]).toMatchObject({
      kind: "tls_sni",
      normalized: { host: "attacker.com" },
    });
  });

  it("skips packets with no DNS/HTTP/TLS layer", () => {
    const packets = [wrap({ tcp: { "tcp.port": "22" } })];
    expect(parseTsharkJson(JSON.stringify(packets))).toEqual([]);
  });

  it("tolerates tshark's array-wrapped scalars (-T json does this for some fields)", () => {
    const packets = [wrap({ dns: { "dns.qry.name": ["ns.example.com"] } })];
    const events = parseTsharkJson(JSON.stringify(packets));
    expect(events[0]!.normalized!.host).toBe("ns.example.com");
  });

  it("recursively finds nested fields (tshark's real DNS structure)", () => {
    // Real tshark output nests dns.qry.name under Queries[key] — parser must recurse.
    const packets = [
      wrap({
        dns: {
          "dns.id": "0x9493",
          Queries: {
            "example.com: type A, class IN": {
              "dns.qry.name": "example.com",
              "dns.qry.type": "1",
            },
          },
        },
      }),
    ];
    const events = parseTsharkJson(JSON.stringify(packets));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("dns_query");
    expect(events[0]!.normalized!.host).toBe("example.com");
  });

  it("recursively finds TLS SNI nested under handshake extensions", () => {
    const packets = [
      wrap({
        tls: {
          "tls.record": {
            "tls.handshake": {
              Extension: {
                "tls.handshake.extensions_server_name": "api.example.com",
              },
            },
          },
        },
      }),
    ];
    const events = parseTsharkJson(JSON.stringify(packets));
    expect(events[0]!.kind).toBe("tls_sni");
    expect(events[0]!.normalized!.host).toBe("api.example.com");
  });

  it("defaults timestamp to 0 when frame.time_relative is missing", () => {
    const bare = {
      _source: {
        layers: { dns: { "dns.qry.name": "x.com" } },
      },
    };
    const events = parseTsharkJson(JSON.stringify([bare]));
    expect(events[0]!.timestamp).toBe(0);
  });

  it("handles a mixed packet list and preserves per-packet stream tagging", () => {
    const packets = [
      wrap({ dns: { "dns.qry.name": "a.com" } }, 0),
      wrap({ http: { "http.host": "b.com", "http.request.method": "GET", "http.request.uri": "/" } }, 1),
      wrap({ tls: { "tls.handshake.extensions_server_name": "c.com" } }, 2),
    ];
    const events = parseTsharkJson(JSON.stringify(packets));
    expect(events.map((e) => e.kind)).toEqual(["dns_query", "http_request", "tls_sni"]);
    expect(events.every((e) => e.stream === "L2:pcap")).toBe(true);
  });

  it("HTTP request with only uri (no host header) still emits an event", () => {
    const packets = [
      wrap({
        http: {
          "http.request.method": "GET",
          "http.request.uri": "http://unknown/path",
        },
      }),
    ];
    const events = parseTsharkJson(JSON.stringify(packets));
    expect(events[0]!.kind).toBe("http_request");
    expect(events[0]!.normalized!.path).toBe("http://unknown/path");
  });
});
