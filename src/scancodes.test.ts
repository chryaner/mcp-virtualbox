import { describe, it, expect } from "vitest";
import { resolveScancodes, getAvailableKeys } from "./scancodes.js";

describe("resolveScancodes", () => {
  it("resolves single key (enter)", () => {
    const codes = resolveScancodes("enter");
    expect(codes).toEqual(["1c", "9c"]); // make + break
  });

  it("resolves key combo (ctrl+alt+delete)", () => {
    const codes = resolveScancodes("ctrl+alt+delete");
    // Make: ctrl(1d) alt(38) delete(e0,53) - Break: delete(e0,d3) alt(b8) ctrl(9d)
    expect(codes).toEqual(["1d", "38", "e0", "53", "e0", "d3", "b8", "9d"]);
  });

  it("is case-insensitive", () => {
    expect(resolveScancodes("Enter")).toEqual(resolveScancodes("enter"));
    expect(resolveScancodes("CTRL+ALT+DELETE")).toEqual(resolveScancodes("ctrl+alt+delete"));
  });

  it("handles spaces around plus signs", () => {
    expect(resolveScancodes("ctrl + alt + delete")).toEqual(resolveScancodes("ctrl+alt+delete"));
  });

  it("throws for unknown keys", () => {
    expect(() => resolveScancodes("nonexistent")).toThrow('Unknown key: "nonexistent"');
  });

  it("resolves function keys", () => {
    const codes = resolveScancodes("f8");
    expect(codes).toEqual(["42", "c2"]);
  });

  it("resolves multi-byte keys (arrow keys)", () => {
    const codes = resolveScancodes("up");
    expect(codes).toEqual(["e0", "48", "e0", "c8"]);
  });

  it("resolves shift+a combo", () => {
    const codes = resolveScancodes("shift+a");
    // Make: shift(2a) a(1e) - Break: a(9e) shift(aa)
    expect(codes).toEqual(["2a", "1e", "9e", "aa"]);
  });

  it("resolves numeric-keypad digit keys", () => {
    expect(resolveScancodes("kp_1")).toEqual(["4f", "cf"]);
    expect(resolveScancodes("kp_0")).toEqual(["52", "d2"]);
    expect(resolveScancodes("kp_9")).toEqual(["49", "c9"]);
    expect(resolveScancodes("kp_dot")).toEqual(["53", "d3"]);
  });

  it("resolves multi-byte keypad keys (kp_enter, kp_slash)", () => {
    expect(resolveScancodes("kp_enter")).toEqual(["e0", "1c", "e0", "9c"]);
    expect(resolveScancodes("kp_slash")).toEqual(["e0", "35", "e0", "b5"]);
  });

  it("distinguishes keypad digits from main-row digits", () => {
    expect(resolveScancodes("kp_1")).not.toEqual(resolveScancodes("1"));
  });
});

describe("getAvailableKeys", () => {
  it("returns sorted array of key names", () => {
    const keys = getAvailableKeys();
    expect(keys.length).toBeGreaterThan(50);
    expect(keys).toContain("enter");
    expect(keys).toContain("ctrl");
    expect(keys).toContain("f1");
    expect(keys).toContain("kp_0");
    expect(keys).toContain("kp_enter");
    // Should be sorted
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i] >= keys[i - 1]).toBe(true);
    }
  });
});
