import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeInterruptResponses } from "../src/index.ts";

describe("decodeInterruptResponses", () => {
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

  test("decodes no answers into no resume input", () => {
    assert.deepEqual(decodeInterruptResponses({}), []);
  });
});
