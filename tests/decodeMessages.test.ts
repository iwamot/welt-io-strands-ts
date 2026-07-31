import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WireMessage } from "../src/index.ts";
import { decodeMessages } from "../src/index.ts";

const HI = new Uint8Array([104, 105]); // "aGk=" decoded

describe("decodeMessages", () => {
  test("keeps text blocks of both roles", () => {
    assert.deepEqual(
      decodeMessages([
        { role: "user", content: [{ text: "hello" }] },
        { role: "assistant", content: [{ text: "hi there" }] },
      ]),
      [
        { role: "user", content: [{ text: "hello" }] },
        { role: "assistant", content: [{ text: "hi there" }] },
      ],
    );
  });

  test("decodes image bytes to a Uint8Array", () => {
    assert.deepEqual(
      decodeMessages([
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes: "aGk=" } } }],
        },
      ]),
      [
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes: HI } } }],
        },
      ],
    );
  });

  test("decodes a document block with its name", () => {
    assert.deepEqual(
      decodeMessages([
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
      ]),
      [
        {
          role: "user",
          content: [
            {
              document: {
                name: "Report",
                format: "pdf",
                source: { bytes: HI },
              },
            },
          ],
        },
      ],
    );
  });

  test("maps the wire's three_gp video token to the SDK's 3gp", () => {
    assert.deepEqual(
      decodeMessages([
        {
          role: "user",
          content: [
            { video: { format: "three_gp", source: { bytes: "aGk=" } } },
            { video: { format: "mp4", source: { bytes: "aGk=" } } },
          ],
        },
      ]),
      [
        {
          role: "user",
          content: [
            { video: { format: "3gp", source: { bytes: HI } } },
            { video: { format: "mp4", source: { bytes: HI } } },
          ],
        },
      ],
    );
  });

  test("accepts base64 an encoder wrote its own way", () => {
    // Unpadded, and split across lines the way MIME encoders wrap: both
    // name the same bytes, so neither is the sender's mistake.
    for (const bytes of ["aGk", "aG\nk="]) {
      assert.deepEqual(
        decodeMessages([
          {
            role: "user",
            content: [{ image: { format: "png", source: { bytes } } }],
          },
        ]),
        [
          {
            role: "user",
            content: [{ image: { format: "png", source: { bytes: HI } } }],
          },
        ],
      );
    }
  });

  test("throws where the bytes are not base64, which decoding finds out", () => {
    // Buffer.from would drop the "*" and return plausible bytes instead.
    for (const bytes of ["a*Gk=", "a"]) {
      const messages: WireMessage[] = [
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes } } }],
        },
      ];
      assert.throws(() => decodeMessages(messages), DOMException);
    }
  });

  test("returns a copy, leaving the input untouched", () => {
    const source = { bytes: "aGk=" };
    const text = { text: "hello" };
    const messages: WireMessage[] = [
      { role: "user", content: [text, { image: { format: "png", source } }] },
    ];
    const decoded = decodeMessages(messages);
    assert.equal(source.bytes, "aGk=");
    // Every block of the copy is the decoder's own, text included.
    assert.notEqual(decoded[0]?.content[0], text);
  });

  test("decodes an empty conversation into an empty one", () => {
    assert.deepEqual(decodeMessages([]), []);
  });
});
