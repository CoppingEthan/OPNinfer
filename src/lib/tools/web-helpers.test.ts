import { describe, expect, it } from "vitest";
import {
  inferFilename,
  isForbiddenHostname,
  isPrivateIp,
  truncateText,
} from "./web-helpers";

describe("isPrivateIp (SSRF guard)", () => {
  it("blocks the classics", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.0.1", "172.31.255.255",
      "169.254.169.254", // cloud metadata
      "0.0.0.0", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.187.206", "2606:4700::6810:84e5", "172.32.0.1", "172.15.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it("treats garbage as unsafe", () => {
    expect(isPrivateIp("999.1.1.1")).toBe(true);
    expect(isPrivateIp("not-an-ip")).toBe(true);
  });
});

describe("isForbiddenHostname", () => {
  it("blocks local names regardless of DNS", () => {
    expect(isForbiddenHostname("localhost")).toBe(true);
    expect(isForbiddenHostname("foo.localhost")).toBe(true);
    expect(isForbiddenHostname("db.internal")).toBe(true);
    expect(isForbiddenHostname("printer.local")).toBe(true);
  });
  it("allows normal domains", () => {
    expect(isForbiddenHostname("github.com")).toBe(false);
    expect(isForbiddenHostname("localhost.example.com")).toBe(false);
  });
});

describe("inferFilename", () => {
  it("prefers RFC 5987 filename*", () => {
    expect(
      inferFilename("https://x.test/dl", `attachment; filename="fallback.pdf"; filename*=UTF-8''r%C3%A9port.pdf`),
    ).toBe("réport.pdf");
  });
  it("uses plain filename= when no star form", () => {
    expect(inferFilename("https://x.test/dl", 'attachment; filename="report.xlsx"')).toBe("report.xlsx");
  });
  it("falls back to the URL basename", () => {
    expect(inferFilename("https://x.test/files/data%20set.csv?sig=abc", null)).toBe("data set.csv");
  });
  it("falls back to 'download' when nothing usable", () => {
    expect(inferFilename("https://x.test/", null)).toBe("download");
  });
});

describe("truncateText", () => {
  it("passes short text through", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });
  it("cuts with an explicit marker", () => {
    const out = truncateText("a".repeat(100), 40);
    expect(out).toContain("truncated 60 characters");
    expect(out.startsWith("a".repeat(40))).toBe(true);
  });
});

describe("isPrivateIp — IPv6 spellings the old regex missed (audit 2026-09-05)", () => {
  it("catches hex-form IPv4-mapped addresses, which is how Node serialises them", () => {
    for (const ip of ["::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:a9fe:a9fe", "::ffff:ac11:2", "::ffff:127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::127.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it("still allows public IPv6 and IPv4", () => {
    for (const ip of ["2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808", "2606:4700::1111", "8.8.8.8", "1.1.1.1"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it("treats multicast, reserved, broadcast and benchmarking IPv4 as private", () => {
    for (const ip of ["224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.0.8"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it("treats site-local, multicast and documentation IPv6 as private, garbage as unsafe", () => {
    for (const ip of ["fec0::1", "ff02::1", "2001:db8::1", "fe80::1%eth0", ":::", "12345::1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
});
