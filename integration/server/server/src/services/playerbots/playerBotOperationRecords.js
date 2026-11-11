"use strict";

// Shared, uncopied views of pilot operations for scans that only filter,
// count or look up. listOperations() and listActiveOperations() copy every
// pilot's operation on each call, which dominated director passes at 500
// pilots. Callers pass their own operation runtime and must not change the
// returned records.

function listReadOnlyOperations(operationRuntime) {
  return typeof operationRuntime.listOperationRecords === "function"
    ? operationRuntime.listOperationRecords()
    : operationRuntime.listOperations();
}

function listReadOnlyActiveOperations(operationRuntime) {
  return typeof operationRuntime.listActiveOperationRecords === "function"
    ? operationRuntime.listActiveOperationRecords()
    : operationRuntime.listActiveOperations();
}

module.exports = { listReadOnlyActiveOperations, listReadOnlyOperations };
