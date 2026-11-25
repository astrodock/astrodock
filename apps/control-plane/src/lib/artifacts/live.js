'use strict';

// Live updates for artifact collections. One process serves every artifact, so
// an in-process emitter reaches every open stream. Each subscriber filters
// changes through its own read grant before anything is sent (routes/artifacts-public).

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

const channel = (artifactId, collection) => `${artifactId}:${collection}`;

/** change: { type: 'create'|'update'|'delete', record } — record in stored form. */
function publish(artifactId, collection, change) {
  bus.emit(channel(artifactId, collection), change);
}

function subscribe(artifactId, collection, fn) {
  const ch = channel(artifactId, collection);
  bus.on(ch, fn);
  return () => bus.off(ch, fn);
}

function listenerCount(artifactId, collection) {
  return bus.listenerCount(channel(artifactId, collection));
}

module.exports = { publish, subscribe, listenerCount };
