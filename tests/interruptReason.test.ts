import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InterruptInput, InterruptOption } from "../src/index.ts";
import { interruptReason, WireContractError } from "../src/index.ts";

const rejects = (
  message: string,
  options?: readonly InterruptOption[],
  input?: InterruptInput,
) =>
  assert.throws(
    () => interruptReason(message, options, input),
    WireContractError,
  );

describe("interruptReason", () => {
  test("builds a message with options", () => {
    assert.deepEqual(interruptReason("Deploy?", [{ value: "y" }]), {
      message: "Deploy?",
      options: [{ value: "y" }],
    });
  });

  test("builds a message with an input field", () => {
    assert.deepEqual(interruptReason("Name?", undefined, {}), {
      message: "Name?",
      input: {},
    });
  });

  test("builds a message with both widgets", () => {
    assert.deepEqual(
      interruptReason(
        "Deploy?",
        [
          { value: "y", label: "Deploy", style: "primary" },
          { value: "n", label: "Cancel" },
        ],
        { label: "Or type your answer", multiline: true },
      ),
      {
        message: "Deploy?",
        options: [
          { value: "y", label: "Deploy", style: "primary" },
          { value: "n", label: "Cancel" },
        ],
        input: { label: "Or type your answer", multiline: true },
      },
    );
  });

  for (const style of ["primary", "danger"] as const) {
    test(`accepts the ${style} style`, () => {
      assert.deepEqual(interruptReason("m", [{ value: "v", style }]), {
        message: "m",
        options: [{ value: "v", style }],
      });
    });
  }

  for (const multiline of [true, false]) {
    test(`accepts multiline ${multiline}`, () => {
      assert.deepEqual(interruptReason("m", undefined, { multiline }), {
        message: "m",
        input: { multiline },
      });
    });
  }

  test("throws on an empty message", () => {
    rejects("", [{ value: "y" }]);
  });

  test("throws when neither options nor input is given", () => {
    rejects("m");
  });

  test("throws on empty options", () => {
    rejects("m", []);
  });

  test("throws on an unknown widget key", () => {
    rejects("m", [{ value: "y", text: "Yes" }] as unknown as InterruptOption[]);
    rejects("m", undefined, { placeholder: "x" } as unknown as InterruptInput);
  });

  const badOptions: unknown[] = [
    {},
    { value: "" },
    { value: 5 },
    { value: "y", label: "" },
    { value: "y", label: 5 },
    { value: "y", style: "default" },
    { value: "y", style: 5 },
  ];
  for (const option of badOptions) {
    test(`throws on an invalid option: ${JSON.stringify(option)}`, () => {
      rejects("m", [option] as unknown as InterruptOption[]);
    });
  }

  for (const input of [{ label: "" }, { label: 5 }, { multiline: "yes" }]) {
    test(`throws on an invalid input: ${JSON.stringify(input)}`, () => {
      rejects("m", undefined, input as InterruptInput);
    });
  }

  test("holds options to what one Slack actions block renders", () => {
    const options = Array.from({ length: 25 }, (_, index) => ({
      value: `v${index}`,
    }));
    assert.equal(interruptReason("m", options).options?.length, 25);
    rejects("m", [...options, { value: "v25" }]);
    rejects("m", [{ value: "v".repeat(1801) }]);
  });

  test("names the widget that broke", () => {
    assert.throws(() => interruptReason("m", [{ value: "y" }, { value: "" }]), {
      name: "WireContractError",
      path: "$.options[1].value",
    });
  });
});
