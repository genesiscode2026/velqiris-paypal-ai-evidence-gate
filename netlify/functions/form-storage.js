'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CANONICAL_SITE_URL = 'https://velqiris-acquisition.netlify.app';

function isLocalTestMode() {
  return Boolean(process.env.VELQIRIS_TEST_DATA_DIR);
}

function getAllowedOrigin(origin) {
  if (origin === CANONICAL_SITE_URL) return origin;
  if (isLocalTestMode() && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '')) return origin;
  return CANONICAL_SITE_URL;
}

function integrityHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function appendLocalTestRecord(formName, record) {
  if (!isLocalTestMode()) throw new Error('LOCAL_LEDGER_DISABLED_OUTSIDE_TEST_MODE');
  const dir = path.resolve(process.env.VELQIRIS_TEST_DATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${formName}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return { mode: 'LOCAL_TEST_LEDGER', record_id: record.record_id || record.lead_id || record.event_id };
}

async function submitNetlifyForm(formName, fields, fetchImpl = globalThis.fetch) {
  if (isLocalTestMode()) return appendLocalTestRecord(formName, fields);
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_API_UNAVAILABLE');

  const target = new URL('/', process.env.URL || CANONICAL_SITE_URL);
  const body = new URLSearchParams({ 'form-name': formName });
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    body.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const response = await fetchImpl(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'VELQIRIS-Serverless-Forms/2.0',
    },
    body: body.toString(),
    redirect: 'manual',
  });
  if (!response.ok && ![301, 302, 303].includes(response.status)) {
    throw new Error(`NETLIFY_FORMS_REJECTED_${response.status}`);
  }
  return { mode: 'NETLIFY_FORMS', http_status: response.status };
}

function readLocalTestRecords(formName) {
  if (!isLocalTestMode()) return [];
  const filePath = path.join(path.resolve(process.env.VELQIRIS_TEST_DATA_DIR), `${formName}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

module.exports = {
  CANONICAL_SITE_URL,
  getAllowedOrigin,
  integrityHash,
  isLocalTestMode,
  readLocalTestRecords,
  submitNetlifyForm,
};
