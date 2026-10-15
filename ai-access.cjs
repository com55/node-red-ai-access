'use strict';

/**
 * CommonJS shim for Node-RED plugin loading.
 * Node-RED requires() this file; the implementation lives in dist/plugin.cjs.
 */
const plugin = require('./dist/plugin.cjs');
module.exports = plugin.default ?? plugin;
