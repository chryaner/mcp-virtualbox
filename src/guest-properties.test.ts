import { describe, it, expect } from "vitest";
import { guestIPv4Addresses, parseGuestProperties } from "./guest-properties.js";

// Captured from VBoxManage 7.2 against an Ubuntu 24.04 guest.
const V7 = [
  "/VirtualBox/GuestAdd/Version             = '7.0.16'                       @ 2026-11-26T03:49:25.211Z",
  "/VirtualBox/GuestInfo/Net/0/MAC          = '080027C8DAD8'                 @ 2026-11-26T03:49:25.213Z",
  "/VirtualBox/GuestInfo/Net/0/V4/IP        = '10.0.2.15'                    @ 2026-11-26T03:49:25.213Z",
  "/VirtualBox/GuestInfo/Net/0/V4/Netmask   = '255.255.255.0'                @ 2026-11-26T03:49:25.213Z",
  "/VirtualBox/GuestInfo/OS/LoggedInUsers   = '0'                            @ 2026-11-26T03:49:25.213Z TRANSIENT, TRANSRESET",
  "",
].join("\n");

const V6 = [
  "Name: /VirtualBox/GuestInfo/Net/0/V4/IP, value: 10.0.2.15, timestamp: 1700000000000000000, flags: ",
  "Name: /VirtualBox/GuestInfo/Net/1/V4/IP, value: 192.168.56.101, timestamp: 1700000000000000001, flags: ",
  "Name: /VirtualBox/GuestInfo/OS/Product, value: Linux, timestamp: 1700000000000000002, flags: ",
  "",
].join("\n");

describe("parseGuestProperties", () => {
  it("reads the VirtualBox 7 format", () => {
    const props = parseGuestProperties(V7);
    expect(props["/VirtualBox/GuestInfo/Net/0/V4/IP"]).toBe("10.0.2.15");
    expect(props["/VirtualBox/GuestAdd/Version"]).toBe("7.0.16");
    expect(props["/VirtualBox/GuestInfo/OS/LoggedInUsers"]).toBe("0");
    expect(Object.keys(props)).toHaveLength(5);
  });

  it("reads the VirtualBox 6 format", () => {
    const props = parseGuestProperties(V6);
    expect(props["/VirtualBox/GuestInfo/Net/1/V4/IP"]).toBe("192.168.56.101");
    expect(props["/VirtualBox/GuestInfo/OS/Product"]).toBe("Linux");
    expect(Object.keys(props)).toHaveLength(3);
  });

  it("reads Windows line endings and an empty value", () => {
    const props = parseGuestProperties("/a/b = '' @ 2026-01-01T00:00:00.000Z\r\n/a/c = 'x y' @ 2026-01-01T00:00:00.000Z\r\n");
    expect(props).toEqual({ "/a/b": "", "/a/c": "x y" });
  });

  it("ignores anything that is not a property line", () => {
    expect(parseGuestProperties("No value set!\n\nVBoxManage: error: something\n")).toEqual({});
  });
});

describe("guestIPv4Addresses", () => {
  it("finds the address in VirtualBox 7 output", () => {
    expect(guestIPv4Addresses(V7)).toEqual(["10.0.2.15"]);
  });

  it("finds every adapter's address in VirtualBox 6 output", () => {
    expect(guestIPv4Addresses(V6)).toEqual(["10.0.2.15", "192.168.56.101"]);
  });

  it("orders by adapter number, not by line", () => {
    const out =
      "/VirtualBox/GuestInfo/Net/10/V4/IP = '10.0.10.1' @ t\n" +
      "/VirtualBox/GuestInfo/Net/2/V4/IP = '10.0.2.1' @ t\n" +
      "/VirtualBox/GuestInfo/Net/0/V4/IP = '10.0.0.1' @ t\n";
    expect(guestIPv4Addresses(out)).toEqual(["10.0.0.1", "10.0.2.1", "10.0.10.1"]);
  });

  it("does not count an adapter that is down", () => {
    expect(guestIPv4Addresses("/VirtualBox/GuestInfo/Net/0/V4/IP = '0.0.0.0' @ t\n")).toEqual([]);
  });

  it("does not mistake a netmask or broadcast for an address", () => {
    const out =
      "/VirtualBox/GuestInfo/Net/0/V4/Netmask = '255.255.255.0' @ t\n" +
      "/VirtualBox/GuestInfo/Net/0/V4/Broadcast = '10.0.2.255' @ t\n";
    expect(guestIPv4Addresses(out)).toEqual([]);
  });

  it("has nothing to report before the guest has published anything", () => {
    expect(guestIPv4Addresses("")).toEqual([]);
  });
});
