"use strict";

// ---------------------------------------------------------------------------
// queue — session/global queue CRUD: read, write, enqueue, remove, move,
// clear. All mutations are serialised by per-queue directory locks.
//
// dispatchPayload and chooseRoundRobinSession live in session-status.js
// because they depend on sessionSummary (which needs status/presence reads).
// ---------------------------------------------------------------------------

const shared = require("../runtime/shared.js");
const { makeQueueItem, normalizeQueue } = shared;
const { readJsonCached, writeJsonAtomic, appendJsonl, withDirectoryLock } = require("./fs-utils.js");
const { sessionPaths } = require("./paths.js");
const { readSettings } = require("./settings.js");
const { readSessionsIndex } = require("./sessions.js");

function readQueue(filePath) {
  return normalizeQueue(readJsonCached(filePath, []));
}

function writeQueue(filePath, queue) {
  writeJsonAtomic(filePath, queue);
}

function enqueueToSession(paths, sessionId, payload, source = "panel") {
  const settings = readSettings(paths);
  const sp = sessionPaths(paths, sessionId);
  return withDirectoryLock(sp.queueLock, () => {
    const queue = readQueue(sp.queue);
    if (queue.length >= settings.perSessionQueueLimit) {
      throw new Error(`${sp.id} 的队列已达到上限 ${settings.perSessionQueueLimit}。`);
    }
    const item = makeQueueItem(payload, source, sp.id);
    queue.push(item);
    writeQueue(sp.queue, queue);
    appendJsonl(sp.history, { type: "queued", ...item }, settings.historyLimit);
    appendJsonl(paths.history, { type: "queued_session", session_id: sp.id, ...item }, settings.historyLimit);
    return item;
  });
}

function enqueueGlobal(paths, payload, source = "panel") {
  const settings = readSettings(paths);
  return withDirectoryLock(paths.globalQueueLock, () => {
    const queue = readQueue(paths.globalQueue);
    if (queue.length >= settings.globalQueueLimit) {
      throw new Error(`空闲优先队列已达到上限 ${settings.globalQueueLimit}。`);
    }
    const item = makeQueueItem(payload, source, "idle-first");
    queue.push(item);
    writeQueue(paths.globalQueue, queue);
    appendJsonl(paths.history, { type: "queued_global", ...item }, settings.historyLimit);
    return item;
  });
}

function removeQueued(paths, sessionId, itemId, scope = "session") {
  const settings = readSettings(paths);
  if (scope === "global") {
    return withDirectoryLock(paths.globalQueueLock, () => {
      const queue = readQueue(paths.globalQueue);
      const next = queue.filter((item) => item.id !== itemId);
      writeQueue(paths.globalQueue, next);
      if (next.length !== queue.length) appendJsonl(paths.history, { type: "global_queue_removed", id: itemId, at: new Date().toISOString() }, settings.historyLimit);
      return queue.length - next.length;
    });
  }
  const sp = sessionPaths(paths, sessionId);
  return withDirectoryLock(sp.queueLock, () => {
    const queue = readQueue(sp.queue);
    const next = queue.filter((item) => item.id !== itemId);
    writeQueue(sp.queue, next);
    if (next.length !== queue.length) appendJsonl(sp.history, { type: "queue_removed", id: itemId, at: new Date().toISOString() }, settings.historyLimit);
    return queue.length - next.length;
  });
}

function moveQueued(paths, sessionId, itemId, direction, scope = "session") {
  const delta = direction === "up" ? -1 : 1;
  const reorder = (queue) => {
    const index = queue.findIndex((item) => item.id === itemId);
    if (index < 0) return false;
    const next = index + delta;
    if (next < 0 || next >= queue.length) return false;
    const [item] = queue.splice(index, 1);
    queue.splice(next, 0, item);
    return true;
  };
  if (scope === "global") {
    return withDirectoryLock(paths.globalQueueLock, () => {
      const queue = readQueue(paths.globalQueue);
      if (!reorder(queue)) return false;
      writeQueue(paths.globalQueue, queue);
      return true;
    });
  }
  const sp = sessionPaths(paths, sessionId);
  return withDirectoryLock(sp.queueLock, () => {
    const queue = readQueue(sp.queue);
    if (!reorder(queue)) return false;
    writeQueue(sp.queue, queue);
    return true;
  });
}

function clearQueue(paths, scope, sessionId) {
  const settings = readSettings(paths);
  if (scope === "global" || scope === "all") {
    withDirectoryLock(paths.globalQueueLock, () => writeQueue(paths.globalQueue, []));
    appendJsonl(paths.history, { type: "global_queue_cleared", at: new Date().toISOString() }, settings.historyLimit);
  }
  if (scope === "session" || scope === "all") {
    const sessions = scope === "all" ? readSessionsIndex(paths).sessions.map((item) => item.id) : [sessionId];
    for (const id of sessions) {
      const sp = sessionPaths(paths, id);
      withDirectoryLock(sp.queueLock, () => writeQueue(sp.queue, []));
      appendJsonl(sp.history, { type: "queue_cleared", at: new Date().toISOString() }, settings.historyLimit);
    }
  }
}

module.exports = {
  readQueue,
  writeQueue,
  enqueueToSession,
  enqueueGlobal,
  removeQueued,
  moveQueued,
  clearQueue,
};
