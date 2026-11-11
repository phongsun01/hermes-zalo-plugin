// markdownToZalo.js
// Convert Markdown inline formatting to Zalo MessageContent styles array.
// Sequential accumulative parser based on stable pattern to ensure exact
// character offset alignment (fixing 1-2 character offset errors).

const TextStyle = {
  Bold: "b",
  Italic: "i",
  Underline: "u",
  StrikeThrough: "s",
  Red: "c_db342e",
  Orange: "c_f27806",
  Yellow: "c_f7b503",
  Green: "c_15a85f",
  Big: "f_18",
  Small: "f_13",
};

const COLOR_MAP = {
  red: TextStyle.Red,
  orange: TextStyle.Orange,
  yellow: TextStyle.Yellow,
  green: TextStyle.Green,
};

function jsStrLen(s) {
  return String(s || "").length;
}

/**
 * Parse markdown text, return clean text + styles array for Zalo.
 *
 * @param {string} md - Markdown text with inline formatting
 * @returns {{ text: string, styles: Array<{start:number, len:number, st:string}> }}
 */
function markdownToZalo(md) {
  if (!md) return { text: "", styles: [] };

  // Normalize Unicode NFC for consistent character indexing across Vietnamese tone marks
  let src = String(md).normalize("NFC");

  // Step 1: Clean structural markdown tags that shouldn't appear in Zalo chat
  // Inline/fenced code: strip backticks, keep code text
  src = src.replace(/`{1,3}([\s\S]+?)`{1,3}/g, "$1");
  // Links: [text](url) -> text (url)
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // Blockquotes: > text -> text
  src = src.replace(/^>\s+/gm, "");
  // Horizontal rules: --- -> empty
  src = src.replace(/^---+$/gm, "");
  // Collapse excessive newlines (3+ -> 2)
  src = src.replace(/\n{3,}/g, "\n\n");

  const styles = [];
  let plain = "";

  // Order of regex patterns is critical:
  // 1. Heading: (^|\n)#{1,6}\s+([^\n]+)
  // 2. Triple asterisk/underscore: ***bold italic*** or ___bold italic___
  // 3. Bold: **bold**
  // 4. Underline: __underline__
  // 5. StrikeThrough: ~~strikethrough~~
  // 6. Italic: *italic* or _italic_ (with word/boundary constraints, NEVER matching bullet items)
  // 7. Color: {color:text}
  const pattern = new RegExp(
    [
      /(?:^|\n)#{1,6}\s+([^\n]+)/.source,
      /(\*{3}|___)(?!\s)([\s\S]+?)(?<!\s)\2/.source,
      /\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/.source,
      /__([^_]+?)__/.source,
      /~~(?!\s)([\s\S]+?)(?<!\s)~~/.source,
      /(?:(?<=\s|^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?=\s|[^\w*]|$)|(?<=\s|^|[^\w_])_(?!\s)(.+?)(?<!\s)_(?=\s|[^\w_]|$))/.source,
      /\{(red|orange|yellow|green):([\s\S]+?)\}/.source,
    ].join("|"),
    "gu"
  );

  let lastIndex = 0;

  for (const match of src.matchAll(pattern)) {
    // Add text preceding the match
    let pre = src.slice(lastIndex, match.index);

    // If it's a heading that matched with a leading newline, preserve the newline in pre
    const matchedStr = match[0];
    if (match[1] !== undefined && matchedStr.startsWith("\n")) {
      pre += "\n";
    }

    plain += pre;

    let inner = "";
    const styleTypes = [];

    if (match[1] !== undefined) {
      // Heading
      inner = match[1];
      styleTypes.push(TextStyle.Big);
    } else if (match[3] !== undefined) {
      // ***bold italic***
      inner = match[3];
      styleTypes.push(TextStyle.Bold, TextStyle.Italic);
    } else if (match[4] !== undefined) {
      // **bold**
      inner = match[4];
      styleTypes.push(TextStyle.Bold);
    } else if (match[5] !== undefined) {
      // __underline__
      inner = match[5];
      styleTypes.push(TextStyle.Underline);
    } else if (match[6] !== undefined) {
      // ~~strikethrough~~
      inner = match[6];
      styleTypes.push(TextStyle.StrikeThrough);
    } else if (match[7] !== undefined) {
      // *italic*
      inner = match[7];
      styleTypes.push(TextStyle.Italic);
    } else if (match[8] !== undefined) {
      // _italic_
      inner = match[8];
      styleTypes.push(TextStyle.Italic);
    } else if (match[10] !== undefined) {
      // {color:text}
      inner = match[10];
      const c = COLOR_MAP[match[9]];
      if (c) styleTypes.push(c);
    }

    const start = plain.length;
    plain += inner;
    const len = inner.length;

    for (const st of styleTypes) {
      styles.push({ start, len, st });
    }

    lastIndex = match.index + matchedStr.length;
  }

  plain += src.slice(lastIndex);

  // Sort and merge adjacent identical styles
  styles.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of styles) {
    const prev = merged[merged.length - 1];
    if (prev && prev.st === s.st && prev.start + prev.len === s.start) {
      prev.len += s.len;
    } else {
      merged.push({ ...s });
    }
  }

  return { text: plain, styles: merged };
}

/**
 * Simple stripper (used as fallback).
 */
function stripMarkdown(s) {
  if (!s) return "";
  return markdownToZalo(s).text;
}

// ── Tests ────────────────────────────────────────────────────────────────
function runTests() {
  const tests = [
    {
      name: "bold",
      input: "Hello **world**!",
      expect: { text: "Hello world!", styles: [{ start: 6, len: 5, st: "b" }] },
    },
    {
      name: "italic",
      input: "Hello *world*!",
      expect: { text: "Hello world!", styles: [{ start: 6, len: 5, st: "i" }] },
    },
    {
      name: "mixed",
      input: "**Bold** and *italic*",
      expect: {
        text: "Bold and italic",
        styles: [
          { start: 0, len: 4, st: "b" },
          { start: 9, len: 6, st: "i" },
        ],
      },
    },
    {
      name: "heading + bold",
      input: "# Top 5 AI\n**Claude** and **Cursor**",
      expect: {
        text: "Top 5 AI\nClaude and Cursor",
        styles: [
          { start: 0, len: 8, st: "f_18" },
          { start: 9, len: 6, st: "b" },
          { start: 20, len: 6, st: "b" },
        ],
      },
    },
    {
      name: "strike + underline",
      input: "~~strike~~ and __underline__",
      expect: {
        text: "strike and underline",
        styles: [
          { start: 0, len: 6, st: "s" },
          { start: 11, len: 9, st: "u" },
        ],
      },
    },
    {
      name: "no markdown",
      input: "plain text",
      expect: { text: "plain text", styles: [] },
    },
    {
      name: "emoji test",
      input: "🔥 **bold** 🦞",
      expect: { text: "🔥 bold 🦞", styles: [{ start: 3, len: 4, st: "b" }] },
    },
    {
      name: "bullet lists with asterisks",
      input: "* Mục 1: **In đậm 1**\n* Mục 2: **In đậm 2**",
      expect: {
        text: "* Mục 1: In đậm 1\n* Mục 2: In đậm 2",
        styles: [
          { start: 9, len: 8, st: "b" },
          { start: 27, len: 8, st: "b" },
        ],
      },
    },
    {
      name: "triple asterisk bold+italic",
      input: "***rất quan trọng***",
      expect: {
        text: "rất quan trọng",
        styles: [
          { start: 0, len: 14, st: "b" },
          { start: 0, len: 14, st: "i" },
        ],
      },
    },
  ];

  let passed = 0;
  for (const t of tests) {
    const result = markdownToZalo(t.input);
    const ok =
      result.text === t.expect.text &&
      JSON.stringify(result.styles) === JSON.stringify(t.expect.styles);
    if (ok) {
      passed++;
    } else {
      console.log(`FAIL: ${t.name}`);
      console.log(`  input:  ${JSON.stringify(t.input)}`);
      console.log(`  got:    ${JSON.stringify(result)}`);
      console.log(`  expect: ${JSON.stringify(t.expect)}`);
    }
  }
  console.log(`Tests: ${passed}/${tests.length} passed`);
}

if (process.argv[1] && process.argv[1].includes("markdownToZalo")) {
  runTests();
}

export { markdownToZalo, TextStyle, jsStrLen, stripMarkdown };
