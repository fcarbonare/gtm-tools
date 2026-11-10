/* Credential redaction for the automations mirror. Kept in its own module so it can be tested
   (pipedrive-sync.mjs runs as a CLI on import).

   Two shapes of secret end up inside an automation or a webhook record:
   1. an inline `Basic <base64>` / `Bearer <token>` header value (webhook auth, custom-header actions);
   2. a secret in the query string of a URL, because a sender that can only be given a URL (a saved
      webhook, a Make hook, a Pipedrive subscription_url) carries its token there:
      `https://host/path?token=<64 hex>`. The Basic/Bearer rule never matched these, so the first
      refresh after such a webhook was wired would have committed the token (found 2026-11-09, before
      it happened for a payment-objection webhook).

   The redaction runs on the FINAL text of every file the mirror writes (the per-automation JSON,
   webhooks.json, index.json and index.md), not on the parsed objects: index.md prints the
   subscription_url of every webhook straight from the API response, and a rule that only walked the
   JSON would have missed it.

   It over-redacts on purpose. A mirror that shows `?key=<REDACTED-TOKEN>` where the value was harmless
   costs nothing; a mirror that commits a live token costs a rotation. */

const CRED_RE = /(?:Basic|Bearer)\s+[A-Za-z0-9+/._~-]{8,}={0,2}/g;

/* A query or fragment parameter whose NAME says it is a secret. The name list is a whole-name match
   (`token=` does not touch `token_type=`), case-insensitive. The value ends at the next `&`, a quote,
   whitespace, a backtick, a closing bracket or `#`, so it stops before the markup around a URL in
   JSON ("..."), Markdown (`...`, (...)) and HTML (<...>). */
const SECRET_NAMES = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_token',
  'apitoken',
  'auth_token',
  'api_key',
  'apikey',
  'api-key',
  'key',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'authorization',
  'signature',
  'sig',
  'hmac',
];
const URL_SECRET_RE = new RegExp(
  `([?&;](?:${SECRET_NAMES.join('|')})=)[^&#\\s"'\`<>)\\]]+`,
  'gi',
);

export const REDACTED_CREDENTIAL = '<REDACTED-CREDENTIAL>';
export const REDACTED_TOKEN = '<REDACTED-TOKEN>';

/** Redacts one piece of text. */
export function redactString(s) {
  if (typeof s !== 'string' || s === '') return s;
  CRED_RE.lastIndex = 0;
  URL_SECRET_RE.lastIndex = 0;
  return s.replace(CRED_RE, REDACTED_CREDENTIAL).replace(URL_SECRET_RE, `$1${REDACTED_TOKEN}`);
}

/** Redacts every string inside a parsed value (objects, arrays, strings). Keys are left alone. */
export function redactCreds(node) {
  if (typeof node === 'string') return redactString(node);
  if (Array.isArray(node)) return node.map(redactCreds);
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = redactCreds(node[k]);
    return out;
  }
  return node;
}
