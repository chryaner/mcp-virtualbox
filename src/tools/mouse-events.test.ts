import { describe, it, expect } from "vitest";
import { clickEvents, dragEvents } from "./input.js";

describe("clickEvents", () => {
  it("arrives, presses and releases", () => {
    expect(clickEvents(10, 20, "left", false)).toEqual([
      { x: 10, y: 20, buttons: 0 },
      { x: 10, y: 20, buttons: 1 },
      { x: 10, y: 20, buttons: 0 },
    ]);
  });

  it("uses the button asked for", () => {
    expect(clickEvents(1, 1, "right", false)[1].buttons).toBe(2);
    expect(clickEvents(1, 1, "middle", false)[1].buttons).toBe(4);
  });

  it("presses twice for a double click, and ends released", () => {
    const events = clickEvents(5, 5, "left", true);
    expect(events.map((e) => e.buttons)).toEqual([0, 1, 0, 1, 0]);
    expect(events.every((e) => e.x === 5 && e.y === 5)).toBe(true);
  });
});

describe("dragEvents", () => {
  it("presses at the start, travels with the button held and releases at the end", () => {
    const events = dragEvents(0, 0, 100, 50, "left", 4);
    expect(events).toEqual([
      { x: 0, y: 0, buttons: 0 },
      { x: 0, y: 0, buttons: 1 },
      { x: 25, y: 13, buttons: 1 },
      { x: 50, y: 25, buttons: 1 },
      { x: 75, y: 38, buttons: 1 },
      { x: 100, y: 50, buttons: 1 },
      { x: 100, y: 50, buttons: 0 },
    ]);
  });

  it("reaches the end exactly whatever the number of steps", () => {
    for (const steps of [1, 3, 7, 100]) {
      const events = dragEvents(13, 977, 1001, 3, "right", steps);
      expect(events).toHaveLength(steps + 3);
      expect(events.at(-2)).toEqual({ x: 1001, y: 3, buttons: 2 });
      expect(events.at(-1)).toEqual({ x: 1001, y: 3, buttons: 0 });
    }
  });

  it("drags backwards and straight up as well", () => {
    const events = dragEvents(100, 100, 100, 0, "left", 2);
    expect(events.map((e) => [e.x, e.y])).toEqual([[100, 100], [100, 100], [100, 50], [100, 0], [100, 0]]);
  });
});
