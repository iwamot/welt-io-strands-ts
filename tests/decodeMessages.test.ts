import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeMessages, WireContractError } from "../src/index.ts";

const HI = new Uint8Array([104, 105]); // "aGk=" decoded

const rejects = (messages: unknown) =>
  assert.throws(() => decodeMessages(messages), WireContractError);

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

  test("names where a payload broke", () => {
    const messages = [
      { role: "user", content: [{ text: "hello" }] },
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: "" } } }],
      },
    ];
    assert.throws(() => decodeMessages(messages), {
      name: "WireContractError",
      path: "$[1].content[0].image.source.bytes",
      message:
        "$[1].content[0].image.source.bytes: must NOT have fewer than 1 characters",
    });
  });

  test("names the payload itself when that is what broke", () => {
    assert.throws(() => decodeMessages("hi"), { path: "$" });
  });

  test("rejects a payload that is not an array of messages", () => {
    rejects(undefined);
    rejects(null);
    rejects("hi");
    rejects({ role: "user" });
    rejects([null]);
    rejects(["hi"]);
    rejects([["user"]]);
  });

  test("rejects a conversation with nothing in it", () => {
    // Welt sends a turn to answer; an empty one is not a conversation.
    rejects([]);
    rejects([{ role: "user", content: [] }]);
  });

  test("rejects a conversation that does not open with the human", () => {
    rejects([{ role: "assistant", content: [{ text: "hi" }] }]);
  });

  test("rejects a role the contract does not carry", () => {
    rejects([{ role: "system", content: [{ text: "x" }] }]);
    rejects([{ content: [{ text: "x" }] }]);
  });

  test("rejects content that is not an array", () => {
    rejects([{ role: "user", content: "hi" }]);
    rejects([{ role: "assistant", content: "hi" }]);
  });

  test("rejects a block carrying no key the contract defines", () => {
    rejects([{ role: "user", content: ["x"] }]);
    rejects([{ role: "user", content: [{}] }]);
    rejects([{ role: "user", content: [{ toolUse: { name: "t" } }] }]);
    rejects([{ role: "user", content: [{ text: "hi", cachePoint: {} }] }]);
  });

  test("rejects non-text in an assistant message", () => {
    rejects([
      { role: "user", content: [{ text: "hi" }] },
      {
        role: "assistant",
        content: [{ image: { format: "png", source: { bytes: "aGk=" } } }],
      },
    ]);
  });

  test("rejects a text block that carries no text", () => {
    rejects([{ role: "user", content: [{ text: 5 }] }]);
    rejects([{ role: "user", content: [{ text: "" }] }]);
  });

  test("rejects a media block that is not an object", () => {
    rejects([{ role: "user", content: [{ image: "x" }] }]);
    rejects([{ role: "user", content: [{ document: 5 }] }]);
    rejects([{ role: "user", content: [{ video: 5 }] }]);
  });

  test("rejects a media block without a format the wire carries", () => {
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

  test("throws where the base64 is not, which no schema keyword asserts", () => {
    // Buffer.from would drop the "*" and return plausible bytes instead.
    for (const bytes of ["a*Gk=", "a"]) {
      const messages = [
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes } } }],
        },
      ];
      assert.throws(() => decodeMessages(messages), DOMException);
    }
  });

  test("rejects a document without a name Converse accepts", () => {
    const named = (name: unknown) => [
      {
        role: "user",
        content: [
          { document: { name, format: "pdf", source: { bytes: "aGk=" } } },
        ],
      },
    ];
    rejects([
      {
        role: "user",
        content: [{ document: { format: "pdf", source: { bytes: "aGk=" } } }],
      },
    ]);
    rejects(named(""));
    rejects(named(5));
    // Converse takes neither a dot nor a longer name than this.
    rejects(named("report.pdf"));
    rejects(named("r".repeat(201)));
  });

  test("returns a copy, leaving the input untouched", () => {
    const source = { bytes: "aGk=" };
    const text = { text: "hello" };
    const messages = [
      { role: "user", content: [text, { image: { format: "png", source } }] },
    ];
    const decoded = decodeMessages(messages);
    assert.equal(source.bytes, "aGk=");
    // Every block of the copy is the decoder's own, text included.
    assert.notEqual(decoded[0]?.content[0], text);
  });
});
