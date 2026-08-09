import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InterruptAnswer } from "../src/index.ts";
import { decodeInterruptResponses } from "../src/index.ts";

describe("decodeInterruptResponses", () => {
  test("decodes answers in payload order", () => {
    const responses: Record<string, InterruptAnswer> = {
      "interrupt-1": { value: true, source: "option" },
      "interrupt-2": { value: "do it differently", source: "input" },
    };
    assert.deepEqual(decodeInterruptResponses(responses), [
      { interruptResponse: { interruptId: "interrupt-1", response: true } },
      {
        interruptResponse: {
          interruptId: "interrupt-2",
          response: "do it differently",
        },
      },
    ]);
  });

  test("carries an answer on as the value it was given", () => {
    const responses: Record<string, InterruptAnswer> = {
      "interrupt-1": { value: false, source: "option" },
      "interrupt-2": { value: null, source: "option" },
      "interrupt-3": { value: { decision: "hold" }, source: "option" },
    };

    assert.deepEqual(
      decodeInterruptResponses(responses).map(
        (item) => item.interruptResponse.response,
      ),
      [false, null, { decision: "hold" }],
    );
  });

  test("decodes no answers into no resume input", () => {
    assert.deepEqual(decodeInterruptResponses({}), []);
  });
});
