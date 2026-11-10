// node --test skills/pipedrive-config-sync/redact-creds.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactCreds, redactString, REDACTED_CREDENTIAL, REDACTED_TOKEN } from './redact-creds.mjs';

const HEX64 = 'a'.repeat(32) + '1'.repeat(32);

test('a token in the query string is redacted, the rest of the URL is kept', () => {
  const out = redactString(`https://app.example.lovable.app/api/public/a10?token=${HEX64}&x=1`);
  assert.equal(out, `https://app.example.lovable.app/api/public/a10?token=${REDACTED_TOKEN}&x=1`);
  assert.ok(!out.includes(HEX64));
});

test('a trailing ampersand (the saved A10 webhook URL ends in one) does not hide the token', () => {
  const out = redactString(`https://h/p?token=${HEX64}&`);
  assert.equal(out, `https://h/p?token=${REDACTED_TOKEN}&`);
});

test('the token is not the first parameter', () => {
  const out = redactString(`https://h/p?a=1&token=${HEX64}`);
  assert.equal(out, `https://h/p?a=1&token=${REDACTED_TOKEN}`);
});

test('every secret-looking name is covered, in any case', () => {
  for (const name of ['token', 'TOKEN', 'access_token', 'api_token', 'apikey', 'api_key', 'key', 'secret', 'password', 'auth', 'signature', 'sig']) {
    const out = redactString(`https://h/p?${name}=abc123def456`);
    assert.equal(out, `https://h/p?${name}=${REDACTED_TOKEN}`, name);
  }
});

test('a parameter that only starts like a secret name is left alone', () => {
  assert.equal(redactString('https://h/p?token_type=bearer'), 'https://h/p?token_type=bearer');
  assert.equal(redactString('https://h/p?keyboard=1&monkey=2'), 'https://h/p?keyboard=1&monkey=2');
  assert.equal(redactString('https://h/p?author=jay'), 'https://h/p?author=jay');
});

test('the value stops before the markup around a URL', () => {
  assert.equal(redactString(`"url": "https://h/p?token=${HEX64}"`), `"url": "https://h/p?token=${REDACTED_TOKEN}"`);
  assert.equal(redactString(`| hook | \`https://h/p?token=${HEX64}\` | yes |`), `| hook | \`https://h/p?token=${REDACTED_TOKEN}\` | yes |`);
  assert.equal(redactString(`[link](https://h/p?token=${HEX64})`), `[link](https://h/p?token=${REDACTED_TOKEN})`);
  assert.equal(redactString(`<a href="https://h/p?token=${HEX64}">x</a>`), `<a href="https://h/p?token=${REDACTED_TOKEN}">x</a>`);
});

test('Basic and Bearer values are still redacted', () => {
  assert.equal(redactString('Basic eDpzZWNyZXRwYXNzd29yZA=='), REDACTED_CREDENTIAL);
  assert.equal(redactString('Bearer abcdefghijklmnop'), REDACTED_CREDENTIAL);
  assert.equal(redactString('a Bearer abcdefghijklmnop b'), `a ${REDACTED_CREDENTIAL} b`);
});

test('text without a secret comes back unchanged, and non-strings pass through', () => {
  assert.equal(redactString('https://h/p?a=1&b=2'), 'https://h/p?a=1&b=2');
  assert.equal(redactString(''), '');
  assert.equal(redactString(undefined), undefined);
  assert.equal(redactCreds(42), 42);
  assert.equal(redactCreds(null), null);
});

test('redactCreds walks nested objects and arrays but keeps keys', () => {
  const out = redactCreds({
    token: 'k',
    steps: [{ url: `https://h/p?token=${HEX64}`, headers: [{ name: 'Authorization', value: 'Bearer abcdefghijklmnop' }] }],
  });
  assert.equal(out.token, 'k');
  assert.equal(out.steps[0].url, `https://h/p?token=${REDACTED_TOKEN}`);
  assert.equal(out.steps[0].headers[0].value, REDACTED_CREDENTIAL);
});

test('running it twice changes nothing (a refreshed mirror stays stable)', () => {
  const once = redactString(`https://h/p?token=${HEX64}&Basic eDpzZWNyZXRwYXNzd29yZA==`);
  assert.equal(redactString(once), once);
});
