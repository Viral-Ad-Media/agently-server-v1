"use strict";
// The assistant system prompt used to state the business identity three
// times: once in the KB profile block, again in an "identity override" block,
// and again in an "active KB details" block. The model parroted the
// repetition back in answers (name/FAQ/description repeated 2-3x in the
// Messenger preview), and every repetition cost tokens on every call and
// chat. The profile block is now the single source of identity.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAssistantPrompt } = require("../lib/assistant-intelligence");

function contextWithKb() {
  return {
    faqs: [],
    chunks: [],
    products: [],
    knowledgeBases: [
      {
        id: "kb-1",
        name: "Sunshine Dental Studio",
        primary_url: "https://sunshine-dental.example",
        industry: "Dental",
        description: "A family dental clinic in Austin with evening hours.",
        location: "Austin, TX",
        phone_number: "555-0100",
      },
    ],
    organization: { id: "org-1", name: "Parent Workspace Container" },
  };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

for (const direction of ["inbound", "outbound"]) {
  test(`business identity stated once as data, once as role anchor (${direction})`, () => {
    const prompt = buildAssistantPrompt({
      context: contextWithKb(),
      message: "hello",
      mode: "text",
      direction,
      languageName: "English",
    });
    // Exactly two mentions: one in SELECTED KNOWLEDGE BASE PROFILE (the data)
    // and one in IDENTITY AND SCOPE ("receptionist for X", the role anchor).
    // It used to appear five or more times across three restated data blocks.
    assert.equal(countOccurrences(prompt, "Sunshine Dental Studio"), 2);
    assert.ok(
      prompt.includes(
        "Customer-facing business/name: Sunshine Dental Studio",
      ),
      "the single data statement should live in the profile block",
    );
    assert.equal(
      countOccurrences(
        prompt,
        "A family dental clinic in Austin with evening hours.",
      ),
      1,
    );
    assert.equal(countOccurrences(prompt, "https://sunshine-dental.example"), 1);
    // The removed duplicate sections must not come back under other names.
    assert.ok(!prompt.includes("ACTIVE BUSINESS IDENTITY OVERRIDE"));
    assert.ok(!prompt.includes("ACTIVE KNOWLEDGE BASE DETAILS"));
    // The container rule survives inside the profile block.
    assert.ok(
      prompt.includes("account container"),
      "parent-workspace container rule should remain in the profile block",
    );
    // Location/phone moved into the profile block with the merge.
    assert.ok(prompt.includes("Austin, TX"));
    assert.ok(prompt.includes("555-0100"));
  });
}
