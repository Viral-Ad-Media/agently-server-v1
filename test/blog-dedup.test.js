"use strict";
// Public blog articles used to render paste-duplicated paragraphs 2-3x.
// dedupeContentBlocks removes only blocks deeply identical to the block
// immediately before them; intentional repeats separated by other content
// are preserved, and admin read paths keep the raw stored blocks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { dedupeContentBlocks } = require("../api/routes/blog");

const para = (text, id = "a") => ({ id, type: "paragraph", text });

test("removes adjacent identical blocks", () => {
  const blocks = [para("Hello", "1"), para("Hello", "2"), para("Hello", "3")];
  const result = dedupeContentBlocks(blocks);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "Hello");
});

test("keeps non-adjacent repeats (intentional structure)", () => {
  const blocks = [
    para("Intro", "1"),
    para("Body", "2"),
    para("Intro", "3"),
  ];
  const result = dedupeContentBlocks(blocks);
  assert.equal(result.length, 3);
});

test("treats different block types as different even with same text", () => {
  const blocks = [
    { id: "1", type: "paragraph", text: "Same" },
    { id: "2", type: "heading", text: "Same" },
  ];
  assert.equal(dedupeContentBlocks(blocks).length, 2);
});

test("compares full block payload, not just text", () => {
  const blocks = [
    { id: "1", type: "image", url: "a.png", caption: "one" },
    { id: "2", type: "image", url: "a.png", caption: "two" },
  ];
  assert.equal(dedupeContentBlocks(blocks).length, 2);
});

test("passes through non-arrays and empty arrays untouched", () => {
  assert.equal(dedupeContentBlocks(undefined), undefined);
  assert.deepEqual(dedupeContentBlocks([]), []);
});
