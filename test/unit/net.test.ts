import { describe, expect, it } from "vitest";
import { network } from "../../src/worker/net.ts";

describe("PAIR-10 per-address cap keys an IPv6 host by its /64", () => {
  it("PAIR-10 network: addresses in one /64 share a key, however they are written", () => {
    const key = network("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(key).toBe("2001:db8:1:2");
    expect(network("2001:0db8:0001:0002::1")).toBe(key);
    expect(network("2001:DB8:1:2:1:2:3:4")).toBe(key);
    expect(network("2001:db8:1:3::1")).not.toBe(key);
  });

  it("PAIR-10 network: a compressed prefix expands, and IPv4 and the local default pass through", () => {
    expect(network("2001:db8::1")).toBe("2001:db8:0:0");
    expect(network("::1")).toBe("0:0:0:0");
    expect(network("203.0.113.9")).toBe("203.0.113.9");
    expect(network("local")).toBe("local");
  });

  it("PAIR-10 network: an IPv4-mapped address in any form is its IPv4 address, never the shared 0:0:0:0", () => {
    for (const ip of ["::ffff:203.0.113.9", "::FFFF:cb00:7109", "0:0:0:0:0:ffff:cb00:7109", "::ffff:CB00:7109"]) {
      expect(network(ip), ip).toBe("203.0.113.9");
    }
    expect(network("::ffff:cb00:710a")).toBe("203.0.113.10");
    expect(network("::ffff:0:0")).toBe("0.0.0.0");
    // Not mapped: IPv4-compatible and other prefixes stay IPv6.
    expect(network("::cb00:7109")).toBe("0:0:0:0");
    expect(network("64:ff9b::cb00:7109")).toBe("64:ff9b:0:0");
  });
});
