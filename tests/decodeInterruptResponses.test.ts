import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeInterruptResponses } from "../src/index.ts";

const rejects = (responses: unknown) =>
  assert.throws(() => decodeInterruptResponses(responses), TypeError);

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

  test("decodes an empty payload to no responses", () => {
    assert.deepEqual(decodeInterruptResponses({}), []);
  });

  test("rejects a payload that is not an object", () => {
    rejects(undefined);
    rejects(null);
    rejects("y");
    rejects([["a", "y"]]);
  });

  test("rejects an answer that is not a string", () => {
    rejects({ a: 1 });
    rejects({ a: null });
    rejects({ a: "ok", b: 1 });
  });
});
