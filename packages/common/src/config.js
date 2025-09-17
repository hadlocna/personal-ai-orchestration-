const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const dotenv = require('dotenv');

const ENV_PATH = path.resolve(process.cwd(), '.env');
if (fs.existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH });
}

const schemaPath = path.resolve(__dirname, '../../../infra/config.schema.json');
const schemaRaw = fs.readFileSync(schemaPath, 'utf-8');
const schema = JSON.parse(schemaRaw);
const requiredKeys = new Set(schema.required || []);
const optionalKeys = Object.keys(schema.properties || {}).filter((key) => !requiredKeys.has(key));

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validateFn = ajv.compile(schema);

function validateEnv(env = process.env) {
  const snapshot = buildEnvObject(env);
  const valid = validateFn(snapshot);
  return {
    valid,
    errors: valid ? [] : (validateFn.errors || []).map(normalizeError),
    snapshot
  };
}

function ensureConfig() {
  const { valid, errors } = validateEnv();
  if (!valid) {
    const error = new Error('CONFIG_VALIDATION_FAILED');
    error.cause = errors;
    throw error;
  }
  return buildEnvObject(process.env);
}

function buildConfigReport(service) {
  const env = buildEnvObject(process.env);
  const required = {};
  const optional = {};

  requiredKeys.forEach((key) => {
    required[key] = env[key] ? 'present' : 'missing';
  });

  optionalKeys.forEach((key) => {
    optional[key] = env[key] ? 'present' : 'absent';
  });

  const { valid, errors } = validateEnv();

  return {
    service,
    status: valid ? 'ok' : 'error',
    required,
    optional,
    errors
  };
}

function buildEnvObject(source) {
  const env = {};
  Object.keys(schema.properties || {}).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      env[key] = source[key];
    }
  });
  return env;
}

function normalizeError(err) {
  return {
    instancePath: err.instancePath,
    message: err.message,
    keyword: err.keyword,
    params: err.params
  };
}

module.exports = {
  ensureConfig,
  validateEnv,
  buildConfigReport,
  requiredKeys,
  optionalKeys
};
