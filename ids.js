// Small dependency-free ID helpers (built on Node's built-in crypto module —
// this project intentionally ships with zero npm dependencies so it deploys
// anywhere with nothing more than `node server/index.js`).
const crypto = require('crypto');

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function randomId(len = 12) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

// Unambiguous alphabet (no 0/O/1/I) for table codes cousins will type by hand.
const TABLE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomTableCode(len = 5) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += TABLE_CODE_ALPHABET[bytes[i] % TABLE_CODE_ALPHABET.length];
  return out;
}

module.exports = { randomId, randomTableCode };
