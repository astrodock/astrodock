'use strict';

// Which files `deploy --local` may upload.
//
// The archive is stored on the server under /data/repos/<slug>, so anything in it
// leaves this machine. Matching exact names (.env, .env.local) let .env.production,
// private/, keys and .npmrc through. Inside a git repo the list starts from what
// git would commit (tracked plus untracked-but-not-ignored); outside one it is the
// whole directory. Either way the hard rules below are applied on top.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Never uploaded, at any depth.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'private', '.aws', '.ssh', '.gnupg', '.docker', '.terraform']);
const SKIP_NAMES = new Set([
  '.DS_Store', '.npmrc', '.env.astrodock', '.netrc', '.git-credentials', '.pypirc', '.htpasswd',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials.json', 'terraform.tfstate', 'terraform.tfstate.backup'
]);
// Key and credential files by extension: TLS and signing keys, Apple push
// (.p8) and code-signing (.p12) keys, Java keystores.
const SKIP_EXT = /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i;

/** Is this repo-relative path one that must not leave the machine? */
function isExcluded(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const base = parts[parts.length - 1] || '';
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return true;
  if (SKIP_DIRS.has(base)) return true;
  if (SKIP_NAMES.has(base)) return true;
  if (base.startsWith('._')) return true;                   // macOS AppleDouble
  if (base.startsWith('.env') && !base.endsWith('.example')) return true;
  if (SKIP_EXT.test(base)) return true;
  // Cloud service-account keys (Google, Firebase): service-account.json,
  // service-account-prod.json, firebase-adminsdk-*.json.
  if (/^(service-account|firebase-adminsdk).*\.json$/i.test(base)) return true;
  if (/^AuthKey_.*$/i.test(base)) return true;              // Apple push key, any extension
  return false;
}

/** Repo-relative paths git would commit, or null when cwd is not in a git repo. */
function gitFiles(cwd) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walk(root) {
  const out = [];
  (function visit(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (isExcluded(rel)) continue;
      if (ent.isDirectory()) visit(abs);
      else out.push(rel);
    }
  })(root);
  return out;
}

/** The files to put in the upload archive, relative to cwd. */
function filesToUpload(cwd) {
  const fromGit = gitFiles(cwd);
  if (!fromGit) return walk(cwd);
  // ls-files still lists a tracked file that was deleted from the working tree.
  return fromGit.filter((rel) => !isExcluded(rel) && fs.existsSync(path.join(cwd, rel)));
}

module.exports = { filesToUpload, isExcluded };
