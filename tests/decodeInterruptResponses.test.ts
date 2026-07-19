import { describe, expect, test } from "bun:test";
import { decodeInterruptResponses } from "../src/index.ts";

describe("decodeInterruptResponses", () => {
  test("returns no responses for a non-object payload", () => {
    expect(decodeInterruptResponses(undefined)).toEqual([]);
    expect(decodeInterruptResponses(null)).toEqual([]);
    expect(decodeInterruptResponses("y")).toEqual([]);
    expect(decodeInterruptResponses([["a", "y"]])).toEqual([]);
  });

  test("decodes answers in payload order", () => {
    const responses = {
      "interrupt-1": "y",
      "interrupt-2": "do it differently",
    };
    expect(decodeInterruptResponses(responses)).toEqual([
      { interruptResponse: { interruptId: "interrupt-1", response: "y" } },
      {
        interruptResponse: {
          interruptId: "interrupt-2",
          response: "do it differently",
        },
      },
    ]);
  });

  test("skips non-string answers", () => {
    const responses = { a: 1, b: "ok", c: null };
    expect(decodeInterruptResponses(responses)).toEqual([
      { interruptResponse: { interruptId: "b", response: "ok" } },
    ]);
  });
});
