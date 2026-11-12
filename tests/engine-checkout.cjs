"use strict";
// Test-only fallback for unmodified engine files absent from this overlay repo.
const Module = require("node:module"),
  path = require("node:path"),
  fs = require("node:fs");
const root = process.env.EVEJS_ROOT;
if (root) {
  const overlay = path.resolve(__dirname, "../integration/server");
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    try {
      return original.call(this, request, parent, ...rest);
    } catch (error) {
      if (
        error.code !== "MODULE_NOT_FOUND" ||
        !parent ||
        !(request.startsWith(".") || path.isAbsolute(request))
      )
        throw error;
      const target = path.resolve(path.dirname(parent.filename), request);
      const relative = path.relative(overlay, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw error;
      return original.call(
        this,
        path.join(path.resolve(root), relative),
        parent,
        ...rest,
      );
    }
  };
}
