'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const file of ['index.js', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => `lib/${f}`)]) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'config.schema.json')));
JSON.parse(fs.readFileSync(path.join(root, 'config.example.json')));
if (schema.pluginAlias !== 'LedvanceNative' || pkg.name !== 'homebridge-ledvance-native') throw new Error('Plugin identity mismatch');
for (const file of [pkg.main, 'lib/platform.js', 'lib/cloud.js', 'lib/local.js', 'lib/model.js', 'lib/accessory.js', 'lib/store.js', 'README.md', 'LICENSE', 'NOTICE']) {
  if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing release file: ${file}`);
}
console.log('JavaScript, JSON and release files checked.');
