'use strict';

const { LedvancePlatform, PLATFORM_NAME, PLUGIN_NAME } = require('./lib/platform');

module.exports = api => api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LedvancePlatform);
