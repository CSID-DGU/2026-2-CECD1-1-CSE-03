'use strict';
// 인프로세스 이벤트 버스. index.js가 구독해 SSE로 흘린다. 이벤트 이름·payload는 spec §5.1.
const { EventEmitter } = require('node:events');

const bus = new EventEmitter();
bus.setMaxListeners(200);

const emit = (name, data) => bus.emit('event', { name, data, at: new Date().toISOString() });
const subscribe = (fn) => { bus.on('event', fn); return () => bus.off('event', fn); };

module.exports = { emit, subscribe };
