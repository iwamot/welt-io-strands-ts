import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeMessages } from "../src/index.ts";

const HI = new Uint8Array([104, 105]); // "aGk=" decoded

const rejects = (messages: unknown) =>
  assert.throws(() => decodeMessages(messages), TypeError);

describe("decodeMessages", () => {
  test("keeps text blocks of both roles", () => {
    const messages = [
      { role: "user", content: [{ text: "hello" }] },
      { role: "assistant", content: [{ text: "hi there" }] },
    ];
    assert.deepEqual(decodeMessages(messages), [
      { role: "user", content: [{ text: "hello" }] },
      { role: "assistant", content: [{ text: "hi there" }] },
    ]);
  });

  test("decodes image bytes to a Uint8Array", () => {
    const messages = [
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: "aGk=" } } }],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: HI } } }],
      },
    ]);
  });

  test("decodes a document block with its name", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            document: {
              name: "Report",
              format: "pdf",
              source: { bytes: "aGk=" },
            },
          },
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [
          {
            document: { name: "Report", format: "pdf", source: { bytes: HI } },
          },
        ],
      },
    ]);
  });

  test("maps the wire's three_gp video token to the SDK's 3gp", () => {
    const messages = [
      {
        role: "user",
        content: [
          { video: { format: "three_gp", source: { bytes: "aGk=" } } },
          { video: { format: "mp4", source: { bytes: "aGk=" } } },
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [
          { video: { format: "3gp", source: { bytes: HI } } },
          { video: { format: "mp4", source: { bytes: HI } } },
        ],
      },
    ]);
  });

  test("accepts base64 an encoder wrote its own way", () => {
    // Unpadded, and split across lines the way MIME encoders wrap: both
    // name the same bytes, so neither is the sender's mistake.
    for (const bytes of ["aGk", "aG\nk="]) {
      const messages = [
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes } } }],
        },
      ];
      assert.deepEqual(decodeMessages(messages), [
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes: HI } } }],
        },
      ]);
    }
  });

  test("keeps an empty conversation empty", () => {
    assert.deepEqual(decodeMessages([]), []);
  });

  test("passes a message with no content blocks on to the SDK", () => {
    assert.deepEqual(decodeMessages([{ role: "user", content: [] }]), [
      { role: "user", content: [] },
    ]);
  });

  test("rejects a payload that is not an array", () => {
    rejects(undefined);
    rejects(null);
    rejects("hi");
    rejects({ role: "user" });
  });

  test("rejects a message that is not an object", () => {
    rejects([null]);
    rejects(["hi"]);
    rejects([["user"]]);
  });

  test("rejects a role the contract does not carry", () => {
    rejects([{ role: "system", content: [{ text: "x" }] }]);
    rejects([{ content: [{ text: "x" }] }]);
  });

  test("rejects content that is not an array", () => {
    rejects([{ role: "user", content: "hi" }]);
    rejects([{ role: "assistant", content: "hi" }]);
  });

  test("rejects a content block that is not an object", () => {
    rejects([{ role: "user", content: ["x"] }]);
  });

  test("rejects a block carrying no key the contract defines", () => {
    rejects([{ role: "user", content: [{}] }]);
    rejects([{ role: "user", content: [{ toolUse: { name: "t" } }] }]);
  });

  test("rejects non-text in an assistant message", () => {
    rejects([
      {
        role: "assistant",
        content: [{ image: { format: "png", source: { bytes: "aGk=" } } }],
      },
    ]);
  });

  test("rejects a text block whose text is not a string", () => {
    rejects([{ role: "user", content: [{ text: 5 }] }]);
  });

  test("rejects a media block that is not an object", () => {
    rejects([{ role: "user", content: [{ image: "x" }] }]);
    rejects([{ role: "user", content: [{ document: 5 }] }]);
    rejects([{ role: "user", content: [{ video: 5 }] }]);
  });

  test("rejects a media block without a usable format", () => {
    rejects([{ role: "user", content: [{ image: { source: {} } }] }]);
    rejects([
      {
        role: "user",
        content: [{ image: { format: "bmp", source: { bytes: "aGk=" } } }],
      },
    ]);
    rejects([
      {
        role: "user",
        content: [
          { document: { name: "n", format: "rtf", source: { bytes: "aGk=" } } },
        ],
      },
    ]);
    rejects([
      {
        role: "user",
        content: [{ video: { format: "avi", source: { bytes: "aGk=" } } }],
      },
    ]);
  });

  test("rejects a media block without usable source bytes", () => {
    rejects([{ role: "user", content: [{ image: { format: "png" } }] }]);
    rejects([
      { role: "user", content: [{ image: { format: "png", source: "x" } }] },
    ]);
    rejects([
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: 5 } } }],
      },
    ]);
    rejects([
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: "" } } }],
      },
    ]);
  });

  test("rejects bytes that were never valid base64", () => {
    // Buffer.from would drop the "*" and return plausible bytes instead.
    rejects([
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: "a*Gk=" } } }],
      },
    ]);
    rejects([
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: "a" } } }],
      },
    ]);
  });

  test("rejects a document without a name", () => {
    rejects([
      {
        role: "user",
        content: [{ document: { format: "pdf", source: { bytes: "aGk=" } } }],
      },
    ]);
    rejects([
      {
        role: "user",
        content: [
          { document: { format: "pdf", name: "", source: { bytes: "aGk=" } } },
        ],
      },
    ]);
  });

  test("leaves the input untouched", () => {
    const source = { bytes: "aGk=" };
    const messages = [
      { role: "user", content: [{ image: { format: "png", source } }] },
    ];
    decodeMessages(messages);
    assert.equal(source.bytes, "aGk=");
  });
});
