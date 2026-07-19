import { describe, expect, test } from "bun:test";
import { decodeMessages } from "../src/index.ts";

const HI = new Uint8Array([104, 105]); // "aGk=" decoded

describe("decodeMessages", () => {
  test("returns no messages for a non-array payload", () => {
    expect(decodeMessages(undefined)).toEqual([]);
    expect(decodeMessages(null)).toEqual([]);
    expect(decodeMessages("hi")).toEqual([]);
    expect(decodeMessages({ role: "user" })).toEqual([]);
  });

  test("skips non-object entries and unknown roles", () => {
    const messages = [
      null,
      "hi",
      ["user"],
      { role: "system", content: [{ text: "x" }] },
      { role: "user", content: [{ text: "kept" }] },
    ];
    expect(decodeMessages(messages)).toEqual([
      { role: "user", content: [{ text: "kept" }] },
    ]);
  });

  test("keeps text blocks of both roles", () => {
    const messages = [
      { role: "user", content: [{ text: "hello" }] },
      { role: "assistant", content: [{ text: "hi there" }] },
    ];
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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

  test("skips a document without a name", () => {
    const messages = [
      {
        role: "user",
        content: [
          { document: { format: "pdf", source: { bytes: "aGk=" } } },
          { document: { format: "pdf", name: "", source: { bytes: "aGk=" } } },
        ],
      },
    ];
    expect(decodeMessages(messages)).toEqual([]);
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
    expect(decodeMessages(messages)).toEqual([
      {
        role: "user",
        content: [
          { video: { format: "3gp", source: { bytes: HI } } },
          { video: { format: "mp4", source: { bytes: HI } } },
        ],
      },
    ]);
  });

  test("skips blocks with a format the SDK does not know", () => {
    const messages = [
      {
        role: "user",
        content: [
          { image: { format: "bmp", source: { bytes: "aGk=" } } },
          { document: { name: "n", format: "rtf", source: { bytes: "aGk=" } } },
          { video: { format: "avi", source: { bytes: "aGk=" } } },
        ],
      },
    ];
    expect(decodeMessages(messages)).toEqual([]);
  });

  test("skips malformed media blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          "x",
          { image: "x" },
          { image: { format: "png" } },
          { image: { format: "png", source: "x" } },
          { image: { format: "png", source: { bytes: 5 } } },
          { image: { format: "png", source: { bytes: "" } } },
          { image: { source: { bytes: "aGk=" } } },
          { document: 5 },
          { document: { name: "n", format: "pdf" } },
          { video: 5 },
          { video: { format: "mp4" } },
          {},
          { text: "kept" },
        ],
      },
    ];
    expect(decodeMessages(messages)).toEqual([
      { role: "user", content: [{ text: "kept" }] },
    ]);
  });

  test("keeps only text in assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { text: "here you go" },
          { image: { format: "png", source: { bytes: "aGk=" } } },
          { toolUse: { name: "t", toolUseId: "1", input: {} } },
        ],
      },
    ];
    expect(decodeMessages(messages)).toEqual([
      { role: "assistant", content: [{ text: "here you go" }] },
    ]);
  });

  test("drops messages left with no blocks", () => {
    const messages = [
      { role: "user", content: [] },
      { role: "user", content: "hi" },
      { role: "user", content: [{ image: "x" }] },
      { role: "assistant", content: "hi" },
      { role: "assistant", content: [{ toolUse: {} }] },
    ];
    expect(decodeMessages(messages)).toEqual([]);
  });

  test("leaves the input untouched", () => {
    const source = { bytes: "aGk=" };
    const messages = [
      { role: "user", content: [{ image: { format: "png", source } }] },
    ];
    decodeMessages(messages);
    expect(source.bytes).toBe("aGk=");
  });
});
