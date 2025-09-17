#!/usr/bin/env node
const path = require('path');

const common = require(path.resolve(__dirname, '../packages/common/src'));

const service = process.argv[2] || 'local-cli';

const report = common.buildConfigReport(service);
const validation = common.validateEnv();

console.log(`Config report for ${service}`);
console.log('Status:', report.status.toUpperCase());

console.log('\nRequired keys:');
Object.entries(report.required).forEach(([key, status]) => {
  console.log(`  ${key}: ${status}`);
});

console.log('\nOptional keys:');
Object.entries(report.optional).forEach(([key, status]) => {
  console.log(`  ${key}: ${status}`);
});

if (!validation.valid) {
  console.log('\nValidation errors:');
  validation.errors.forEach((err) => {
    console.log(`  - ${err.instancePath || '/'} ${err.message}`);
  });
} else {
  console.log('\nValidation errors: none');
}
