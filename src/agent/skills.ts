/**
 * First-party Agent skills: one `<name>/SKILL.md` per directory under the
 * skills root, advertised to the model by name, description, and location.
 *
 * The frontmatter rules, diagnostics, and the system-prompt block are ported
 * from `@earendil-works/pi-agent-core` 0.83.0 (`src/harness/skills.ts` and
 * `src/harness/system-prompt.ts`, MIT, https://github.com/earendil-works/pi),
 * which pi-agent-core 1.0 removed. Only the fixed Hatch layout is supported:
 * no root-level skill files, nested skill trees, or ignore files.
 */
import { parse } from 'yaml';
import type { ExecutionEnv, FileInfo } from './execution-env';
import { SKILLS_DIR } from './paths';

export type Skill = {
  /** Stable skill name used for lookup and model-visible listings. */
  name: string;
  /** Short model-visible description of when to use the skill. */
  description: string;
  /** Full skill instructions (the body after the frontmatter). */
  content: string;
  /** Absolute path of the skill file, shown to the model as its location. */
  filePath: string;
  /** Excluded from the model-visible listing. */
  disableModelInvocation?: boolean;
};

export type SkillDiagnostic = {
  code:
    | 'file_info_failed'
    | 'list_failed'
    | 'read_failed'
    | 'parse_failed'
    | 'invalid_metadata';
  message: string;
  path: string;
};

const SKILL_FILE_NAME = 'SKILL.md';
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

const REQUIRED_SKILL_NAMES = [
  'building-apps',
  'building-workflows',
  'importing-apps',
  'importing-workflows',
  'app-compatibility',
  'workflow-compatibility',
] as const;

const WORKFLOW_SKILL_NAMES = new Set([
  'building-workflows',
  'importing-workflows',
  'workflow-compatibility',
]);

/** File or directory behind `info`, following a symlink once. */
async function resolveKind(
  env: ExecutionEnv,
  info: FileInfo,
  diagnostics: SkillDiagnostic[],
): Promise<'file' | 'directory' | undefined> {
  if (info.kind === 'file' || info.kind === 'directory') return info.kind;
  const canonical = await env.canonicalPath(info.path);
  const target = canonical.ok ? await env.fileInfo(canonical.value) : canonical;
  if (!target.ok) {
    if (target.error.code !== 'not_found') {
      diagnostics.push({
        code: 'file_info_failed',
        message: target.error.message,
        path: info.path,
      });
    }
    return undefined;
  }
  return target.value.kind === 'file' || target.value.kind === 'directory'
    ? target.value.kind
    : undefined;
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---'))
    return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const parsed: unknown = parse(normalized.slice(4, endIndex));
  return {
    frontmatter:
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: normalized.slice(endIndex + 4).trim(),
  };
}

function validateName(name: string, directoryName: string): string[] {
  const errors: string[] = [];
  if (name !== directoryName) {
    errors.push(
      `name "${name}" does not match parent directory "${directoryName}"`,
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(
      'name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)',
    );
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('name must not start or end with a hyphen');
  }
  if (name.includes('--')) {
    errors.push('name must not contain consecutive hyphens');
  }
  return errors;
}

function validateDescription(description: string | undefined): string[] {
  if (!description || description.trim() === '') {
    return ['description is required'];
  }
  return description.length > MAX_DESCRIPTION_LENGTH
    ? [
        `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
      ]
    : [];
}

async function loadSkillFile(
  env: ExecutionEnv,
  filePath: string,
  directoryName: string,
  diagnostics: SkillDiagnostic[],
): Promise<Skill | undefined> {
  const raw = await env.readTextFile(filePath);
  if (!raw.ok) {
    diagnostics.push({
      code: 'read_failed',
      message: raw.error.message,
      path: filePath,
    });
    return undefined;
  }
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(raw.value);
  } catch (error) {
    diagnostics.push({
      code: 'parse_failed',
      message: error instanceof Error ? error.message : String(error),
      path: filePath,
    });
    return undefined;
  }
  const { frontmatter, body } = parsed;
  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description
      : undefined;
  const name =
    typeof frontmatter.name === 'string' && frontmatter.name
      ? frontmatter.name
      : directoryName;
  for (const message of [
    ...validateDescription(description),
    ...validateName(name, directoryName),
  ]) {
    diagnostics.push({ code: 'invalid_metadata', message, path: filePath });
  }
  if (!description || description.trim() === '') return undefined;
  return {
    name,
    description,
    content: body,
    filePath,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
  };
}

/**
 * Load `<dir>/<name>/SKILL.md` for every directory under `skillsDir`, in name
 * order. Hidden directories and `node_modules` are skipped.
 */
export async function loadSkills(
  env: ExecutionEnv,
  skillsDir: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const entries = await env.listDir(skillsDir);
  if (!entries.ok) {
    if (entries.error.code !== 'not_found') {
      diagnostics.push({
        code: 'list_failed',
        message: entries.error.message,
        path: skillsDir,
      });
    }
    return { skills, diagnostics };
  }
  const directories = entries.value
    .filter(
      (entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules',
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of directories) {
    if ((await resolveKind(env, entry, diagnostics)) !== 'directory') continue;
    const skillPath = `${entry.path.replace(/\/+$/, '')}/${SKILL_FILE_NAME}`;
    const info = await env.fileInfo(skillPath);
    if (!info.ok) {
      if (info.error.code !== 'not_found') {
        diagnostics.push({
          code: 'file_info_failed',
          message: info.error.message,
          path: skillPath,
        });
      }
      continue;
    }
    if ((await resolveKind(env, info.value, diagnostics)) !== 'file') continue;
    const skill = await loadSkillFile(env, skillPath, entry.name, diagnostics);
    if (skill) skills.push(skill);
  }
  return { skills, diagnostics };
}

function formatDiagnostic(diagnostic: SkillDiagnostic): string {
  return `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`;
}

/** Load and validate the first-party skills required by the Hatch Agent. */
export async function loadAgentSkills(
  env: ExecutionEnv,
  options: {
    workflowBetaEnabled: boolean;
    skillsDir?: string;
  },
): Promise<Skill[]> {
  const skillsDir = options.skillsDir ?? SKILLS_DIR;
  const { skills, diagnostics } = await loadSkills(env, skillsDir);
  const problems = diagnostics.map(formatDiagnostic);
  const names = new Set<string>();

  for (const skill of skills) {
    if (names.has(skill.name)) {
      problems.push(`duplicate skill name: ${skill.name}`);
    }
    names.add(skill.name);
  }

  for (const required of REQUIRED_SKILL_NAMES) {
    if (!names.has(required)) {
      problems.push(`missing required skill: ${required}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid Agent skill configuration:\n${problems
        .map((problem) => `- ${problem}`)
        .join('\n')}`,
    );
  }

  return options.workflowBetaEnabled
    ? skills
    : skills.filter((skill) => !WORKFLOW_SKILL_NAMES.has(skill.name));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The `<available_skills>` system-prompt block (agentskills.io format). */
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return '';

  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    'Read the full skill file when the task matches its description.',
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  for (const skill of visibleSkills) {
    lines.push(
      '  <skill>',
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      '  </skill>',
    );
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}
