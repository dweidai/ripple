import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/app.js', 'utf8');

let failed = false;

// 1. JS syntax check
execFileSync('node', ['--check', 'public/app.js'], { stdio: 'inherit' });

// 2. Check for undefined identifiers (TS2304: Cannot find name) via tsc --checkJs
try {
  execFileSync(
    'npx',
    ['tsc', '--noEmit', '--allowJs', '--checkJs', '--target', 'es2022', '--lib', 'es2022,dom', 'public/app.js'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (err) {
  const out = `${err.stdout || ''}\n${err.stderr || ''}`;
  const undefs = out
    .split('\n')
    .filter((line) => /TS2304:\s+Cannot find name/.test(line));
  if (undefs.length > 0) {
    console.error('FAIL: Undefined identifiers in public/app.js:\n' + undefs.join('\n'));
    failed = true;
  }
}

// 3. Every data-action used in HTML/JS must have a handler in app.js
const actionsUsed = new Set([
  ...[...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]),
  ...[...js.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]),
]);
const actionsHandled = new Set([
  ...[...js.matchAll(/case\s+'([^']+)':/g)].map((m) => m[1]),
  ...[...js.matchAll(/data-action="([^"]+)"\]/g)].map((m) => m[1]),
]);
const unhandled = [...actionsUsed].filter((a) => !actionsHandled.has(a));
if (unhandled.length > 0) {
  console.error('FAIL: Unhandled data-action attributes:', unhandled);
  failed = true;
}

// 4. Every getElementById('...') in app.js must exist in index.html
const idsInJs = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const missingIds = [...idsInJs].filter((id) => !idsInHtml.has(id));
if (missingIds.length > 0) {
  console.error('FAIL: Missing DOM IDs in public/index.html:', missingIds);
  failed = true;
}

// 5. Strict CSP compliance: no inline event handlers or inline scripts in index.html
if (/\son(?:click|change|submit|input|keydown|keyup|load)=/i.test(html)) {
  console.error('FAIL: Inline event handler found in public/index.html (violates strict CSP)');
  failed = true;
}
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
  console.error('FAIL: Inline <script> tag found in public/index.html (violates strict CSP)');
  failed = true;
}

if (failed) process.exit(1);
console.log('PASS: UI static audit (syntax, checkJs undefineds, DOM IDs, data-actions, strict CSP)');
