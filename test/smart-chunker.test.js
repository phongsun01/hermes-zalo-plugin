// test/smart-chunker.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { findSplitIndex, splitMessage, chunkTextAndStyles } from "../lib/smart-chunker.js";

test("findSplitIndex: respects paragraph boundary (\\n\\n)", () => {
  const p1 = "A".repeat(100);
  const p2 = "B".repeat(100);
  const text = `${p1}\n\n${p2}`;
  const splitIdx = findSplitIndex(text, 150);

  // Should split right after p1\n\n (102 characters)
  assert.equal(splitIdx, 102);
  assert.equal(text.slice(0, splitIdx), `${p1}\n\n`);
});

test("findSplitIndex: respects sentence boundary (. )", () => {
  const s1 = "This is a complete sentence that gives useful information";
  const s2 = "This is a second sentence following the first one";
  const text = `${s1}. ${s2}.`;
  // maxLen set so sentence 1 fits but not sentence 2
  const splitIdx = findSplitIndex(text, s1.length + 15);

  assert.equal(splitIdx, s1.length + 2); // includes ". "
  assert.equal(text.slice(0, splitIdx), `${s1}. `);
});

test("findSplitIndex: falls back to word boundary when no punctuation is present", () => {
  const text = "apple banana orange cherry grape mango strawberry pineapple";
  const maxLen = 25;
  const splitIdx = findSplitIndex(text, maxLen);

  const chunk = text.slice(0, splitIdx);
  assert.ok(chunk.endsWith(" "), `Expected chunk to end with space: '${chunk}'`);
  assert.ok(chunk.length <= maxLen);
});

test("findSplitIndex: hard cutoff when a monolithic token exceeds maxLen", () => {
  const text = "A".repeat(300);
  const splitIdx = findSplitIndex(text, 150);
  assert.equal(splitIdx, 150);
});

test("splitMessage: keeps short message intact", () => {
  const text = "Xin chào, đây là tin nhắn ngắn dưới ngưỡng chunk.";
  const chunks = splitMessage(text, 1500);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], text);
});

test("splitMessage: correctly splits multi-paragraph text", () => {
  const p1 = "Đoạn văn 1: Xin chào các bạn.".padEnd(800, ".");
  const p2 = "Đoạn văn 2: Tiếp tục nội dung phân tích.".padEnd(900, ".");
  const fullText = `${p1}\n\n${p2}`;

  const chunks = splitMessage(fullText, 1000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(""), fullText);
  assert.ok(chunks[0].length <= 1000);
  assert.ok(chunks[1].length <= 1000);
});

test("chunkTextAndStyles: properly adjusts style offsets across chunks", () => {
  // Chunk size 50
  // Chunk 1: "0123456789 0123456789 0123456789 0123456789\n" (45 chars)
  // Chunk 2: "Second chunk starts here with styled content"
  const line1 = "0123456789 0123456789 0123456789 0123456789\n";
  const line2 = "Second chunk starts here with styled content";
  const fullText = `${line1}${line2}`;

  // Style 1: inside chunk 1 (chars 0 to 10)
  // Style 2: inside chunk 2 (chars line1.length + 7 to line1.length + 12)
  const styles = [
    { start: 0, len: 10, st: "b" },
    { start: line1.length + 7, len: 5, st: "c_db342e" },
  ];

  const chunks = chunkTextAndStyles(fullText, styles, 48);

  assert.equal(chunks.length, 2);

  // Chunk 1 styles:
  assert.equal(chunks[0].text, line1);
  assert.equal(chunks[0].styles.length, 1);
  assert.deepEqual(chunks[0].styles[0], { start: 0, len: 10, st: "b" });

  // Chunk 2 styles: start should be relative to chunk 2 (start: 7, len: 5)
  assert.equal(chunks[1].text, line2);
  assert.equal(chunks[1].styles.length, 1);
  assert.deepEqual(chunks[1].styles[0], { start: 7, len: 5, st: "c_db342e" });
});

test("chunkTextAndStyles: clips style that spans across chunk boundary", () => {
  const part1 = "A".repeat(40);
  const part2 = "B".repeat(40);
  const fullText = `${part1} ${part2}`;

  // Style starts at 30, length 20 (ends at 50, crossing into chunk 2)
  const styles = [{ start: 30, len: 20, st: "u" }];

  const chunks = chunkTextAndStyles(fullText, styles, 45);
  assert.equal(chunks.length, 2);

  // In chunk 1 (0 to 41): style should cover [30, 41) -> len 11
  assert.equal(chunks[0].styles.length, 1);
  assert.deepEqual(chunks[0].styles[0], { start: 30, len: 11, st: "u" });

  // In chunk 2 (41 to 81): style should cover [0, 9) -> start 0, len 9
  assert.equal(chunks[1].styles.length, 1);
  assert.deepEqual(chunks[1].styles[0], { start: 0, len: 9, st: "u" });
});
