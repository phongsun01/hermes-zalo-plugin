// lib/smart-chunker.js
// Smart chunking for long Zalo messages with style recalculation.
//
// DESIGN RATIONALE:
// Theoretical Zalo message limit is 3,000 UTF-16 units. However:
// 1. Vietnamese text with diacritics expands significantly in UTF-8.
// 2. Formatted messages include JSON style arrays ({ start, len, st }) and metadata.
// 3. Zalo WAF triggers Error 112 or drops requests when payload exceeds internal thresholds.
// Therefore, we set a safe ceiling of ~1,500 characters and split on natural grammatical
// boundaries (paragraphs, newlines, sentence ends, clause delimiters, spaces).

export const DEFAULT_CHUNK_SIZE = 1500;

/**
 * Find the optimal split index in text <= maxLen.
 * Searches in priority order:
 *  1. Paragraph break (\n\n)
 *  2. Line break (\n)
 *  3. Sentence end (. / ? / ! followed by space or newline)
 *  4. Clause delimiter (; / , followed by space)
 *  5. Word boundary (space)
 *  6. Hard split at maxLen
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {number} split index in text (exclusive of delimiter if preferred)
 */
export function findSplitIndex(text, maxLen = DEFAULT_CHUNK_SIZE) {
  if (text.length <= maxLen) return text.length;

  const candidate = text.slice(0, maxLen);

  // Search boundaries in descending order of syntactic importance.
  // Prefer splits located in the upper 70% of the slice (i.e. >= maxLen * 0.3)
  // to avoid creating unnaturally tiny fragments.
  const minPreferredIndex = Math.floor(maxLen * 0.3);

  // 1. Paragraph breaks
  const lastDoubleNewline = candidate.lastIndexOf("\n\n");
  if (lastDoubleNewline >= minPreferredIndex) {
    return lastDoubleNewline + 2;
  }

  // 2. Single newlines
  const lastNewline = candidate.lastIndexOf("\n");
  if (lastNewline >= minPreferredIndex) {
    return lastNewline + 1;
  }

  // 3. Sentence boundaries (. / ? / ! / 。 followed by space or newline)
  const sentenceRegex = /[.?!。][ \n]/g;
  let lastSentenceEnd = -1;
  let m;
  while ((m = sentenceRegex.exec(candidate)) !== null) {
    if (m.index >= minPreferredIndex) {
      lastSentenceEnd = m.index + 2; // include punctuation + space
    }
  }
  if (lastSentenceEnd !== -1) {
    return lastSentenceEnd;
  }

  // 4. Clause delimiters (, / ; followed by space)
  const clauseRegex = /[,;][ \t]/g;
  let lastClauseEnd = -1;
  while ((m = clauseRegex.exec(candidate)) !== null) {
    if (m.index >= minPreferredIndex) {
      lastClauseEnd = m.index + 2;
    }
  }
  if (lastClauseEnd !== -1) {
    return lastClauseEnd;
  }

  // 5. Word boundaries (space)
  const lastSpace = candidate.lastIndexOf(" ");
  if (lastSpace >= minPreferredIndex) {
    return lastSpace + 1;
  }

  // If no good boundary in the upper portion, fallback to ANY boundary in the slice
  if (lastDoubleNewline > 0) return lastDoubleNewline + 2;
  if (lastNewline > 0) return lastNewline + 1;
  if (lastSpace > 0) return lastSpace + 1;

  // 6. Hard cutoff if text has no whitespace (e.g. monolithic token/URL)
  return maxLen;
}

/**
 * Split plain text into chunks <= maxLen at natural boundaries.
 *
 * @param {string} text
 * @param {number} [maxLen=DEFAULT_CHUNK_SIZE]
 * @returns {string[]}
 */
export function splitMessage(text, maxLen = DEFAULT_CHUNK_SIZE) {
  if (!text || typeof text !== "string") return [];
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    const splitIdx = findSplitIndex(remaining, maxLen);
    const chunk = remaining.slice(0, splitIdx);
    chunks.push(chunk);
    remaining = remaining.slice(splitIdx);
  }

  return chunks;
}

/**
 * Split text and adjust style offsets for each chunk.
 * If style adjustment encounters any irregularity, caller can fallback to plain text chunks.
 *
 * @param {string} text Plain text
 * @param {Array<{ start: number, len: number, st: string }>} [styles=[]]
 * @param {number} [maxLen=DEFAULT_CHUNK_SIZE]
 * @returns {Array<{ text: string, styles: Array<{ start: number, len: number, st: string }> }>}
 */
export function chunkTextAndStyles(text, styles = [], maxLen = DEFAULT_CHUNK_SIZE) {
  if (!text || typeof text !== "string") return [];
  if (text.length <= maxLen) {
    return [{ text, styles: Array.isArray(styles) ? styles : [] }];
  }

  const rawChunks = [];
  let offset = 0;
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      rawChunks.push({
        text: remaining,
        startOffset: offset,
        endOffset: offset + remaining.length,
      });
      break;
    }

    const splitIdx = findSplitIndex(remaining, maxLen);
    const chunkText = remaining.slice(0, splitIdx);
    rawChunks.push({
      text: chunkText,
      startOffset: offset,
      endOffset: offset + chunkText.length,
    });
    offset += splitIdx;
    remaining = remaining.slice(splitIdx);
  }

  // Adjust style offsets for each chunk
  const validStyles = Array.isArray(styles) ? styles : [];

  return rawChunks.map((chunk) => {
    const chunkStyles = [];
    for (const s of validStyles) {
      const sStart = s.start;
      const sEnd = s.start + s.len;

      // Check for overlap: [sStart, sEnd) intersects [chunk.startOffset, chunk.endOffset)
      if (sEnd > chunk.startOffset && sStart < chunk.endOffset) {
        const adjStart = Math.max(0, sStart - chunk.startOffset);
        const adjEnd = Math.min(chunk.text.length, sEnd - chunk.startOffset);
        const adjLen = adjEnd - adjStart;
        if (adjLen > 0) {
          chunkStyles.push({
            start: adjStart,
            len: adjLen,
            st: s.st,
          });
        }
      }
    }

    return {
      text: chunk.text,
      styles: chunkStyles,
    };
  });
}
