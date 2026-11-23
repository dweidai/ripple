import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { Errors } from '../errors.js';

const execFileAsync = promisify(execFile);

const GH_BIN = '/opt/antigravity/bin/gh';
const GDRIVE_BIN = '/opt/antigravity/bin/gdrive';
const GDOCS_BIN = '/opt/antigravity/bin/gdocs';
const DEFAULT_REPO = process.env.RIPPLE_GITHUB_REPO ?? 'dweidai/ripple';
const CLI_TIMEOUT_MS = 30_000;
const MAX_SECTIONS = 20;
const MAX_TITLE_LEN = 200;
const MAX_HEADING_LEN = 200;
const MAX_BODY_LEN = 50_000;

export type PluginService = 'gh' | 'gdrive' | 'gdocs';

const REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,120}$/;
const FILE_PATH_RE = /^docs\/subagents\/[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,120}$/;
const DOC_ID_RE = /^[a-zA-Z0-9_-]{10,128}$/;

function getAllowedRepos(): string[] {
  const raw = process.env.RIPPLE_ALLOWED_REPOS;
  if (raw && raw.trim()) {
    const parsed = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return [DEFAULT_REPO];
}

function getAllowedDriveDocIds(): string[] | null {
  const raw = process.env.RIPPLE_ALLOWED_DRIVE_DOC_IDS;
  if (!raw || !raw.trim()) return null;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : null;
}

export function assertValidRepo(repo: string): string {
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.includes('..')) {
    throw Errors.badRequest(`Invalid GitHub repository format: ${repo}`);
  }
  const allowed = getAllowedRepos();
  if (!allowed.includes(repo)) {
    throw Errors.forbidden(`Repository '${repo}' is not in RIPPLE_ALLOWED_REPOS allowlist`);
  }
  return repo;
}

export function assertValidBranch(branch: string): string {
  if (
    typeof branch !== 'string' ||
    !BRANCH_RE.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock')
  ) {
    throw Errors.badRequest(`Invalid GitHub branch name: ${branch}`);
  }
  return branch;
}

export function assertValidFilePath(filePath: string): string {
  if (
    typeof filePath !== 'string' ||
    filePath.includes('\0') ||
    filePath.includes('?') ||
    filePath.includes('#') ||
    filePath.includes('..')
  ) {
    throw Errors.badRequest(`Invalid file path: ${filePath}`);
  }
  const normalized = path.posix.normalize(filePath);
  if (!FILE_PATH_RE.test(normalized) || normalized.includes('..')) {
    throw Errors.badRequest(`File path must stay under docs/subagents/: ${filePath}`);
  }
  return normalized;
}

export function assertValidDocId(docId: string): string {
  if (typeof docId !== 'string' || docId.startsWith('-') || !DOC_ID_RE.test(docId)) {
    throw Errors.badRequest(`Invalid Google Doc ID: ${docId}`);
  }
  return docId;
}

function assertSafePositionalArg(value: string, field: string, maxLen?: number): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw Errors.badRequest(`Invalid ${field}`);
  }
  if (value.startsWith('-') || value.trimStart().startsWith('-')) {
    throw Errors.badRequest(`${field} must not start with '-'`);
  }
  if (maxLen !== undefined && value.length > maxLen) {
    throw Errors.badRequest(`${field} exceeds maximum length of ${maxLen}`);
  }
  return value;
}

export function getPluginEnv(service: PluginService): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `/opt/antigravity/bin:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR ?? '/opt/antigravity',
  };
  for (const key of ['HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR'] as const) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  if (service === 'gh') {
    env.GITHUB_TOKEN_FILE = process.env.GITHUB_TOKEN_FILE ?? '/opt/antigravity/tokens/github/token.json';
  } else if (service === 'gdrive') {
    env.GDRIVE_TOKEN_FILE = process.env.GDRIVE_TOKEN_FILE ?? '/opt/antigravity/tokens/gdrive/token.json';
  } else if (service === 'gdocs') {
    env.GDOCS_TOKEN_FILE = process.env.GDOCS_TOKEN_FILE ?? '/opt/antigravity/tokens/gdocs/token.json';
  }
  return env;
}

let activeCliCount = 0;
const cliWaitQueue: Array<() => void> = [];

function getMaxConcurrentCli(): number {
  const raw = process.env.RIPPLE_CLI_MAX_CONCURRENCY;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
}

async function withCliSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  const max = getMaxConcurrentCli();
  if (activeCliCount >= max) {
    await new Promise<void>((resolve) => cliWaitQueue.push(resolve));
  }
  activeCliCount += 1;
  try {
    return await fn();
  } finally {
    activeCliCount -= 1;
    const next = cliWaitQueue.shift();
    if (next) next();
  }
}

async function runCli(
  service: PluginService,
  bin: string,
  args: string[],
  cwd = process.cwd(),
): Promise<{ stdout: string; stderr: string }> {
  return withCliSemaphore(async () => {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      env: getPluginEnv(service),
      maxBuffer: 10 * 1024 * 1024,
      timeout: CLI_TIMEOUT_MS,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  });
}

export interface GitHubStatusResult {
  repo: string;
  url: string;
  defaultBranch: string;
  headSha: string;
  openPrs: Array<{ number: number; title: string; url: string; headRefName: string; state: string }>;
}

export interface GitHubPrResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  commitSha: string;
  title: string;
  filePath: string;
}

export interface DriveFileSummary {
  id: string;
  name: string;
  modified?: string;
  url: string;
}

export interface GoogleDocResult {
  docId: string;
  docUrl: string;
  title: string;
  summary: string;
}

export async function inspectGitHubRepo(repoInput = DEFAULT_REPO): Promise<GitHubStatusResult> {
  const repo = assertValidRepo(repoInput);
  const [repoRes, prRes, refRes] = await Promise.all([
    runCli('gh', GH_BIN, ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef', '--', repo]),
    runCli('gh', GH_BIN, ['pr', 'list', '--repo', repo, '--limit', '10', '--json', 'number,title,url,headRefName,state']),
    runCli('gh', GH_BIN, ['api', `repos/${repo}/git/ref/heads/main`, '--jq', '.object.sha']),
  ]);
  const repoInfo = JSON.parse(repoRes.stdout || '{}');
  const openPrs = JSON.parse(prRes.stdout || '[]');
  return {
    repo: repoInfo.nameWithOwner ?? repo,
    url: repoInfo.url ?? `https://github.com/${repo}`,
    defaultBranch: repoInfo.defaultBranchRef?.name ?? 'main',
    headSha: refRes.stdout || 'main',
    openPrs,
  };
}

/**
 * Safely creates a real branch, commit, and Pull Request on GitHub using `gh` CLI
 * without modifying or dirtying the running local working tree on `main`.
 */
export async function createGitHubPullRequest(input: {
  repo?: string;
  title: string;
  body?: string;
  branch?: string;
  filePath?: string;
  fileContent?: string;
  commitMessage?: string;
}): Promise<GitHubPrResult> {
  const repo = assertValidRepo(input.repo ?? DEFAULT_REPO);
  const title = assertSafePositionalArg(input.title, 'title', MAX_TITLE_LEN);
  if (!title.trim()) throw Errors.badRequest('title is required');
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'subagent-update';
  const suffix = crypto.randomBytes(2).toString('hex');
  const branch = assertValidBranch(input.branch ?? `subagent/${slug}-${suffix}`);
  const filePath = assertValidFilePath(input.filePath ?? `docs/subagents/${slug}-${suffix}.md`);
  const commitMessage = input.commitMessage ?? `feat(subagent): ${title}`;
  const fileContent =
    input.fileContent ??
    `# ${title}\n\n` +
      `- **Generated by**: Ripple GitHub Sub-Agent (\`agy-sub-github\`)\n` +
      `- **Branch**: \`${branch}\`\n` +
      `- **Timestamp**: ${new Date().toISOString()}\n\n` +
      `## Context & Summary\n\n` +
      `${input.body ?? 'Automated sub-agent architectural specification and implementation proposal.'}\n`;

  // 1. Get current main branch SHA via gh api
  const { stdout: baseSha } = await runCli('gh', GH_BIN, [
    'api',
    `repos/${repo}/git/ref/heads/main`,
    '--jq',
    '.object.sha',
  ]);
  if (!baseSha) {
    throw new Error(`Could not resolve base SHA for ${repo}/main`);
  }

  // 2. Create remote branch ref via gh api
  await runCli('gh', GH_BIN, [
    'api',
    '--method',
    'POST',
    `repos/${repo}/git/refs`,
    '-f',
    `ref=refs/heads/${branch}`,
    '-f',
    `sha=${baseSha}`,
  ]);

  // 3. Commit file to the new branch via gh api contents endpoint
  const contentB64 = Buffer.from(fileContent, 'utf8').toString('base64');
  const { stdout: commitJson } = await runCli('gh', GH_BIN, [
    'api',
    '--method',
    'PUT',
    `repos/${repo}/contents/${filePath}`,
    '-f',
    `message=${commitMessage}`,
    '-f',
    `content=${contentB64}`,
    '-f',
    `branch=${branch}`,
  ]);
  const commitParsed = JSON.parse(commitJson || '{}');
  const commitSha: string = commitParsed?.commit?.sha ?? baseSha;

  // 4. Create the Pull Request using gh pr create (or gh api pulls)
  const prBody =
    (input.body ?? `Automated Pull Request created by Ripple Sub-Agent on branch \`${branch}\`.`) +
    `\n\n---\n*Created via Ripple Sub-Agent (\`gh\` CLI) · Commit \`${commitSha.slice(0, 7)}\`*`;

  const { stdout: prJson } = await runCli('gh', GH_BIN, [
    'api',
    '--method',
    'POST',
    `repos/${repo}/pulls`,
    '-f',
    `title=${title}`,
    '-f',
    `head=${branch}`,
    '-f',
    'base=main',
    '-f',
    `body=${prBody}`,
  ]);
  const prParsed = JSON.parse(prJson || '{}');
  const prNumber = Number(prParsed.number ?? 0);
  const prUrl = prParsed.html_url ?? `https://github.com/${repo}/pull/${prNumber}`;

  return {
    prNumber,
    prUrl,
    branch,
    commitSha,
    title,
    filePath,
  };
}

function parseDriveTable(stdout: string): DriveFileSummary[] {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const results: DriveFileSummary[] = [];
  for (const line of lines) {
    if (line.startsWith('ID ') || line.startsWith('---')) continue;
    const parts = line.split(/\s{2,}/);
    if (parts.length >= 2 && parts[0].length >= 15) {
      const id = parts[0].trim();
      const name = parts[1].trim();
      const modified = parts[2]?.trim();
      results.push({
        id,
        name,
        modified,
        url: `https://drive.google.com/open?id=${id}`,
      });
    }
  }
  return results;
}

export async function listRecentDriveFiles(limit = 8): Promise<DriveFileSummary[]> {
  try {
    const { stdout } = await runCli('gdrive', GDRIVE_BIN, ['readonly', 'recent']);
    return parseDriveTable(stdout).slice(0, limit);
  } catch {
    return [];
  }
}

export async function searchDriveFiles(query: string, limit = 8): Promise<DriveFileSummary[]> {
  if (typeof query !== 'string') throw Errors.badRequest('query must be a string');
  const trimmed = query.trim();
  if (!trimmed) return listRecentDriveFiles(limit);
  assertSafePositionalArg(trimmed, 'query', MAX_TITLE_LEN);
  try {
    const { stdout } = await runCli('gdrive', GDRIVE_BIN, ['readonly', 'search', '--name-contains', trimmed]);
    const found = parseDriveTable(stdout);
    return found.length > 0 ? found.slice(0, limit) : listRecentDriveFiles(limit);
  } catch {
    return listRecentDriveFiles(limit);
  }
}

export async function readGoogleDoc(docId: string): Promise<{ docId: string; content: string; url: string }> {
  const validId = assertValidDocId(docId);
  const allowedIds = getAllowedDriveDocIds();
  if (allowedIds && !allowedIds.includes(validId)) {
    throw Errors.forbidden(`Google Doc '${validId}' is not in RIPPLE_ALLOWED_DRIVE_DOC_IDS allowlist`);
  }
  const { stdout } = await runCli('gdocs', GDOCS_BIN, ['readonly', 'read', '--', validId]);
  return {
    docId: validId,
    content: stdout,
    url: `https://docs.google.com/document/d/${validId}/edit`,
  };
}

export async function createGoogleDoc(input: {
  title: string;
  heading?: string;
  sections?: Array<{ heading?: string; body: string }>;
  content?: string;
}): Promise<GoogleDocResult> {
  const title = assertSafePositionalArg(input.title, 'title', MAX_TITLE_LEN);
  if (!title.trim()) throw Errors.badRequest('title is required');
  if (input.heading !== undefined) {
    assertSafePositionalArg(input.heading, 'heading', MAX_HEADING_LEN);
  }
  if (input.content !== undefined && input.content.length > MAX_BODY_LEN) {
    throw Errors.badRequest(`content exceeds maximum length of ${MAX_BODY_LEN}`);
  }
  if (input.sections !== undefined) {
    if (!Array.isArray(input.sections)) {
      throw Errors.badRequest('sections must be an array');
    }
    if (input.sections.length > MAX_SECTIONS) {
      throw Errors.badRequest(`sections cannot exceed ${MAX_SECTIONS} entries`);
    }
    for (const sec of input.sections) {
      if (sec.heading !== undefined && sec.heading !== '') {
        assertSafePositionalArg(sec.heading, 'heading', MAX_HEADING_LEN);
      }
      if (sec.body !== undefined) {
        if (typeof sec.body !== 'string' || sec.body.includes('\0')) {
          throw Errors.badRequest('Invalid section body');
        }
        if (sec.body.length > MAX_BODY_LEN) {
          throw Errors.badRequest(`section body exceeds maximum length of ${MAX_BODY_LEN}`);
        }
      }
    }
  }

  const sections =
    input.sections && input.sections.length > 0
      ? input.sections
      : [
          {
            heading: input.heading ?? 'Ripple Multi-Agent Workspace Specification & Sync Report',
            body:
              input.content ??
              `Generated by Ripple Drive/Docs Sub-Agent on ${new Date().toISOString()}.\n` +
                `Collaborators: David (@dweidai), Antigravity (@agy), Muse (@muse).`,
          },
        ];

  const { stdout: createOut } = await runCli('gdocs', GDOCS_BIN, [
    'mutate',
    'create',
    '--title',
    title,
    '--json',
  ]);

  let docId = '';
  try {
    const parsed = JSON.parse(createOut);
    docId = parsed.documentId || parsed.id || parsed.docId || '';
  } catch {
    // Fallback regex extraction if non-JSON output
    const match = createOut.match(/([a-zA-Z0-9_-]{25,})/);
    if (match) docId = match[1];
  }
  if (!docId) {
    const match = createOut.match(/([a-zA-Z0-9_-]{25,})/);
    if (match) docId = match[1];
  }
  if (!docId) {
    throw new Error(`Failed to parse document ID from gdocs mutate create output: ${createOut}`);
  }
  const validDocId = assertValidDocId(docId);

  for (const sec of sections) {
    if (sec.heading) {
      await runCli('gdocs', GDOCS_BIN, ['mutate', 'heading', validDocId, sec.heading, '--level', '2']).catch(() => {});
    }
    if (sec.body) {
      await runCli('gdocs', GDOCS_BIN, ['mutate', 'append', validDocId, sec.body]).catch(() => {});
    }
  }

  const docUrl = `https://docs.google.com/document/d/${validDocId}/edit`;
  return {
    docId: validDocId,
    docUrl,
    title,
    summary: `Created Google Doc "${title}" (${docUrl}) with ${sections.length} section(s).`,
  };
}
