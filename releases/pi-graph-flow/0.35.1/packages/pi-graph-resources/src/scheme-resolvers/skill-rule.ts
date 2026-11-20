import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
export interface ResourceSchemeHost { homeDir(): string; trimOutput(text: string): string }
/** Preserves each scheme's existing lexical path policy; not a realpath sandbox. */
export function createResourceSchemeResolver(host: ResourceSchemeHost) {
async function skillDirCandidates(cwd: string): Promise<string[]> {
  const dirs = [
    resolve(cwd, ".pi", "skills"),
    resolve(cwd, ".agents", "skills"),
    resolve(host.homeDir(), ".pi", "skills"),
    resolve(host.homeDir(), ".agents", "skills"),
  ];
  const existing: string[] = [];
  for (const dir of dirs) {
    try {
      if ((await stat(dir)).isDirectory()) existing.push(dir);
    } catch {
      // skip missing dirs
    }
  }
  return existing;
}

/** 拒绝 . / .. 段，防 name 拼接逃逸预期目录。 */
function assertSafeNameSegments(name: string, scheme: string): void {
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid ${scheme}:// name "${name}": segments must not be empty, ".", or "..".`);
    }
  }
}

/** 词法包含性检查：candidate 必须位于 root 之下（防 ../ 逃逸）。 */
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function readSkill(name: string, cwd: string): Promise<{ content: string; title: string }> {
  assertSafeNameSegments(name, "skill");
  const dirs = await skillDirCandidates(cwd);
  for (const dir of dirs) {
    const skillFile = resolve(dir, name, "SKILL.md");
    if (!isWithin(dir, skillFile)) continue;
    try {
      const content = await readFile(skillFile, "utf8");
      return { content: host.trimOutput(`# Skill: ${name}\n\n${content}`), title: `skill://${name}` };
    } catch {
      // continue searching
    }
  }
  // Fallback: list available skills so the model can pick a valid name.
  const available: string[] = [];
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) available.push(entry.name);
      }
    } catch {
      // skip unreadable dirs
    }
  }
  const unique = [...new Set(available)].sort();
  throw new Error(
    `Skill "${name}" not found in ${dirs.join(", ") || "no skill directories"}.\n` +
    `Available skills: ${unique.join(", ") || "(none)"}`,
  );
}

const RULE_LOOKUP_TABLE: Record<string, string[]> = {
  agents: ["AGENTS.md"],
  rules: ["RULES.md"],
  cursor: [".cursorrules"],
  cline: [".clinerules"],
};

async function readRule(name: string, cwd: string): Promise<{ content: string; title: string }> {
  assertSafeNameSegments(name, "rule");
  const normalized = name.toLowerCase();
  const fixed = RULE_LOOKUP_TABLE[normalized] ?? [];
  const candidates = [
    ...fixed.map((file) => resolve(cwd, file)),
    resolve(cwd, ".pi", "rules", `${name}.md`),
    resolve(cwd, ".pi", "rules", `${name}`),
    resolve(cwd, "docs", `${name}.md`),
    resolve(cwd, `${name}.md`),
  ].filter((file) => isWithin(cwd, file));
  for (const file of candidates) {
    try {
      const content = await readFile(file, "utf8");
      return { content: host.trimOutput(`# Rule: ${name}\n\n${content}`), title: `rule://${name}` };
    } catch {
      // continue
    }
  }
  const existing: string[] = [];
  for (const file of [resolve(cwd, "AGENTS.md"), resolve(cwd, "RULES.md"), resolve(cwd, ".cursorrules"), resolve(cwd, ".clinerules")]) {
    try {
      if ((await stat(file)).isFile()) existing.push(file);
    } catch {
      // skip
    }
  }
  throw new Error(
    `Rule "${name}" not found.\n` +
    `Candidates tried: ${candidates.map((c) => c.replace(cwd, ".")).join(", ")}.\n` +
    `Existing rule files: ${existing.map((e) => e.replace(cwd, ".")).join(", ") || "(none)"}`,
  );
}

return { readSkill, readRule };
}
