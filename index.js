import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

dotenv.config();

// ---------- Config ----------

const PORT = process.env.PORT || 3000;

const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_LOGIN_URL = process.env.SF_LOGIN_URL;
const SF_API_VERSION = process.env.SF_API_VERSION || 'v66.0';
const SF_PRIVATE_KEY = (process.env.SF_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Only for local testing in a browser. Never set this on a server behind a proxy:
// the proxy makes every request look local, which would disable the API key check.
const ALLOW_LOCAL_NO_KEY = process.env.ALLOW_LOCAL_NO_KEY === 'true';

// One key per consumer, so each can be revoked on its own: "teamA:key1,teamB:key2"
const API_KEYS = parseApiKeys(process.env.API_KEYS);

const MAX_LEARNER_LIMIT = 50;
const MAX_OFFSET = 2000; // Salesforce SOQL OFFSET limit
const TOKEN_CACHE_MS = 30 * 60 * 1000;

const LEARNER_FIELDS = [
  'Id',
  'Learner_ID__c',
  'Learner_Name__c',
  'SDP_Branch__c',
  'SDP_Branch__r.Name',
  'Trade_Name_Generalized__c'
];

function parseApiKeys(raw) {
  const keys = new Map();
  for (const entry of (raw || '').split(',')) {
    const [name, key] = entry.split(':').map((s) => s?.trim());
    if (name && key) keys.set(key, name);
  }
  return keys;
}

function checkConfig() {
  const missing = ['SF_CLIENT_ID', 'SF_USERNAME', 'SF_LOGIN_URL', 'SF_PRIVATE_KEY'].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (API_KEYS.size === 0 && !ALLOW_LOCAL_NO_KEY) {
    console.error('API_KEYS is empty, so no one could call the API. Set API_KEYS in .env.');
    process.exit(1);
  }
}

// ---------- Salesforce ----------

let cachedToken = null;

async function requestSalesforceToken() {
  const assertion = jwt.sign(
    {
      iss: SF_CLIENT_ID,
      sub: SF_USERNAME,
      aud: SF_LOGIN_URL,
      exp: Math.floor(Date.now() / 1000) + 300
    },
    SF_PRIVATE_KEY,
    { algorithm: 'RS256' }
  );

  const response = await axios.post(
    `${SF_LOGIN_URL}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return response.data;
}

// Reuses one token instead of logging in to Salesforce on every request.
async function getSalesforceToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken;
  }
  const { access_token, instance_url } = await requestSalesforceToken();
  cachedToken = { access_token, instance_url, expiresAt: Date.now() + TOKEN_CACHE_MS };
  return cachedToken;
}

async function querySalesforce(soql) {
  const run = ({ access_token, instance_url }) =>
    axios.get(`${instance_url}/services/data/${SF_API_VERSION}/query`, {
      params: { q: soql },
      headers: { Authorization: `Bearer ${access_token}` }
    });

  try {
    return (await run(await getSalesforceToken())).data;
  } catch (error) {
    // The session can expire before our cache does; log in again once and retry.
    if (error.response?.status === 401) {
      return (await run(await getSalesforceToken({ forceRefresh: true }))).data;
    }
    throw error;
  }
}

// ---------- Auth ----------

function isLocalRequest(req) {
  const ip = req.socket.remoteAddress;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function findConsumer(apiKey) {
  if (!apiKey) return null;
  const given = Buffer.from(apiKey);
  for (const [key, name] of API_KEYS) {
    const expected = Buffer.from(key);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      return name;
    }
  }
  return null;
}

function requireApiKey(req, res, next) {
  const consumer = findConsumer(req.get('x-api-key'));
  if (consumer) {
    req.consumer = consumer;
    return next();
  }
  if (ALLOW_LOCAL_NO_KEY && isLocalRequest(req)) {
    req.consumer = 'local';
    return next();
  }
  res.status(401).json({ success: false, message: 'Invalid or missing API key.' });
}

// ---------- Routes ----------

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.json({ success: true, message: 'Server is running.' });
});

app.get('/learners', requireApiKey, async (req, res) => {
  const limit = req.query.limit === undefined ? MAX_LEARNER_LIMIT : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEARNER_LIMIT ||
      !Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    return res.status(400).json({
      success: false,
      message: `limit must be 1-${MAX_LEARNER_LIMIT} and offset must be 0-${MAX_OFFSET}.`
    });
  }

  try {
    const soql = `SELECT ${LEARNER_FIELDS.join(', ')} FROM BISD_Learners__c ORDER BY CreatedDate DESC LIMIT ${limit} OFFSET ${offset}`;
    const data = await querySalesforce(soql);

    const learners = data.records.map(({ attributes, SDP_Branch__r, ...fields }) => ({
      ...fields,
      SDP_Branch_Name: SDP_Branch__r?.Name ?? null
    }));

    console.log(`${new Date().toISOString()} ${req.consumer} GET /learners limit=${limit} offset=${offset} -> ${learners.length}`);

    res.json({ success: true, count: learners.length, limit, offset, learners });
  } catch (error) {
    // Full details stay in the server log; callers get a generic message.
    console.error(`${new Date().toISOString()} ${req.consumer} GET /learners failed:`,
      error.response?.data || error.message);
    res.status(502).json({ success: false, message: 'Failed to fetch learners from Salesforce.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found.' });
});

checkConfig();
app.listen(PORT, () => {
  console.log(`Learner API running on port ${PORT} (${API_KEYS.size} API key(s) loaded)`);
  if (ALLOW_LOCAL_NO_KEY) console.warn('WARNING: ALLOW_LOCAL_NO_KEY is on. Turn it off on the server.');
});
