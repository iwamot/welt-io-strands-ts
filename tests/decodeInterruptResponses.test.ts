import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeInterruptResponses, WireContractError } from "../src/index.ts";

const rejects = (responses: unknown) =>
  assert.throws(() => decodeInterruptResponses(responses), WireContractError);

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

  test("rejects a payload that is not an object of answers", () => {
    rejects(undefined);
    rejects(null);
    rejects("y");
    rejects([["a", "y"]]);
  });

  test("rejects a resume with nothing answered", () => {
    // Welt resumes only once every pending question has an answer.
    rejects({});
  });

  test("rejects an answer that is not a string", () => {
    rejects({ a: 1 });
    rejects({ a: null });
    rejects({ a: "ok", b: 1 });
  });

  test("names the answer that broke", () => {
    assert.throws(() => decodeInterruptResponses({ "interrupt-1": 1 }), {
      name: "WireContractError",
      path: "$.interrupt-1",
    });
  });
});
