"use strict";

// Stay under the EVE client's chat-line limit after UTF-8 and markup expansion.
const SYSTEM_MESSAGE_CHUNK_BYTE_LIMIT = 768;

function splitSystemMessage(message) {
  const text = String(message || "");
  const rendered = text.replace(/\r?\n/g, "<br>");
  if (Buffer.byteLength(rendered, "utf8") <= SYSTEM_MESSAGE_CHUNK_BYTE_LIMIT) {
    return [rendered];
  }

  const chunks = [];
  let current = "";
  let currentBytes = 0;
  const append = (token) => {
    const tokenBytes = Buffer.byteLength(token, "utf8");
    if (current && currentBytes + tokenBytes > SYSTEM_MESSAGE_CHUNK_BYTE_LIMIT) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += token;
    currentBytes += tokenBytes;
  };

  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lineIndex > 0) append("<br>");
    const line = lines[lineIndex];
    for (let index = 0; index < line.length;) {
      const codePoint = String.fromCodePoint(line.codePointAt(index));
      if (codePoint === "<") {
        const tagEnd = line.indexOf(">", index + 1);
        const tag = tagEnd > index ? line.slice(index, tagEnd + 1) : "";
        if (tag && Buffer.byteLength(tag, "utf8") <= SYSTEM_MESSAGE_CHUNK_BYTE_LIMIT) {
          append(tag);
          index = tagEnd + 1;
          continue;
        }
      }
      append(codePoint);
      index += codePoint.length;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  splitSystemMessage,
  SYSTEM_MESSAGE_CHUNK_BYTE_LIMIT,
};
