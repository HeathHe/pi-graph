/** Host composition facade: SDK discovery and M09 configuration stay with Flow. */
import { homedir } from "node:os";
import { DefaultResourceLoader, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { configureSkillResourceHost } from "pi-graph-resources/skills/loader";
import { loadSkillConfig, renderSkillConfigDefaults } from "./skill-config.ts";
configureSkillResourceHost({
  getAgentDir,
  homeDir: () => homedir(),
  createResourceLoader: options => new DefaultResourceLoader(options),
  parseFrontmatter,
  loadSkillConfig,
  renderSkillConfigDefaults,
});
export * from "pi-graph-resources/skills/loader";
