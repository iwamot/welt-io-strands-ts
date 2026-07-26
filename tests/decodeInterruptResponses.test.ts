import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeInterruptResponses } from "../src/index.ts";

describe("decodeInterruptResponses", () => {
  test("returns no responses for a non-object payload", () => {
    assert.deepEqual(decodeInterruptResponses(undefined), []);
    assert.deepEqual(decodeInterruptResponses(null), []);
    assert.deepEqual(decodeInterruptResponses("y"), []);
    assert.deepEqual(decodeInterruptResponses([["a", "y"]]), []);
  });

  test("decodes answers in payload order", () => {
    const responses = {
      "interrupt-1": "y",
      "interrupt-2": "do it differently",
    };
    assert.deepEqual(decodeInterruptResponses(responses), [
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
    assert.deepEqual(decodeInterruptResponses(responses), [
      { interruptResponse: { interruptId: "b", response: "ok" } },
    ]);
  });
});
