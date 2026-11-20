/**
 * Read-only action/command names. Doubles as:
 * - SessionOverlay UI action names (brief/check are read; pause/resume/decision/next/done write)
 * - bash `maestro run <action>` classification for workflow opt-in (isWorkflowOptInCommand)
 */
export const RUN_CONTROL_READ_ACTIONS: ReadonlySet<string> = new Set([
  "status",
  "brief",
  "prepare",
  "check",
  "recall",
  "skill",
  "mutations",
  "list",
  "show",
  "capabilities",
]);

/** Maestro CLI subcommands classified as read-only by the passthrough shell. */
const RUN_CONTROL_READ_COMMANDS: ReadonlySet<string> = new Set([
  ...RUN_CONTROL_READ_ACTIONS,
  "evidence",
  "graph",
  "skills",
  "search",
  "load",
  "review",
  "help",
]);

export type RunControlMutationScope =
  | "read"
  | "session"
  | "run"
  | "execution"
  | "execution-acquire"
  | "execution-lease"
  | "compatibility-start"
  | "plan-publish"
  | "artifact-republish";

export type RunControlLeaseIntent = "none" | "required" | "acquire" | "command-aware";

export interface RunControlClassification {
  write: boolean;
  /** Compatibility field: legacy entry command that may run without a held host lease. */
  sessionless: boolean;
  mutation: RunControlMutationScope;
  lease: RunControlLeaseIntent;
}

const READ_CLASSIFICATION: RunControlClassification = {
  write: false,
  sessionless: false,
  mutation: "read",
  lease: "none",
};

export function classifyRunControlArgv(argv: readonly string[]): RunControlClassification {
  if (argv.length === 0 || argv.some((argument) => argument === "-h" || argument === "--help")) {
    return { ...READ_CLASSIFICATION };
  }

  const family = argv[0] ?? "";
  const command = argv[1] ?? "";
  if (family === "capabilities") return { ...READ_CLASSIFICATION };

  if (family === "artifact") {
    if (["inspect", "list", "show"].includes(command)) return { ...READ_CLASSIFICATION };
    if (command === "republish") return writeClassification("artifact-republish", "none");
    return writeClassification("artifact-republish", "none");
  }

  if (family === "execution") {
    if (["status", "show", "list"].includes(command)) return { ...READ_CLASSIFICATION };
    if (command === "lease") {
      const leaseCommand = argv[2] ?? "";
      if (leaseCommand === "status") return { ...READ_CLASSIFICATION };
      if (leaseCommand === "recover") return writeClassification("execution-lease", "acquire");
      return writeClassification("execution-lease", "required");
    }
    if (command === "handoff") {
      const handoffCommand = argv[2] ?? "";
      if (handoffCommand === "accept") return writeClassification("execution-acquire", "acquire");
      return writeClassification("execution", "required");
    }
    if (["start", "attach", "resume"].includes(command)) {
      return writeClassification("execution-acquire", "acquire");
    }
    if (command === "resolve") return writeClassification("execution", "none");
    return writeClassification("execution", "required");
  }

  if (family === "session") {
    if (["status", "show", "list", "evidence", "graph"].includes(command)) {
      return { ...READ_CLASSIFICATION };
    }
    // session/3.0 Session mutations use Session/orchestration CAS and no
    // legacy lease. The coordinator restores the shared commands' historical
    // lease classification after selecting a non-v3 authority mode.
    // v3 has no pause/chain-audit/participant surface (core batch A/B removed them), so those
    // argv fall through to the shared/default classifications below and fail closed at the core.
    if (command === "open") return writeClassification("session", "none", true);
    if (["complete", "archive", "unarchive", "migrate"].includes(command)) {
      return writeClassification("session", "none");
    }
    if (command === "chain" && ["insert", "skip", "replace", "update"].includes(argv[2] ?? "")) {
      return writeClassification("session", "none");
    }
    if (command === "resume-view") return { ...READ_CLASSIFICATION };
    if (command === "create") return writeClassification("session", "none", true);
    if (["start", "attach", "resume"].includes(command)) {
      return command === "start"
        ? writeClassification("compatibility-start", "command-aware", true)
        : writeClassification("execution-acquire", "acquire");
    }
    if (command === "resolve") return writeClassification("execution", "none");
    return writeClassification("execution", "required");
  }

  if (family === "run") {
    if (RUN_CONTROL_READ_COMMANDS.has(command)) return { ...READ_CLASSIFICATION };
    if (command === "start") {
      return writeClassification("compatibility-start", "command-aware", true);
    }
    if (["next", "create", "decide"].includes(command)) {
      return writeClassification("session", "none");
    }
    // Run-entity mutations use Run CAS. run complete also advances the
    // Session chain, which the coordinator adds as a second v3 fence.
    if (["complete", "transition", "cancel", "seal"].includes(command)) {
      return writeClassification("run", "none");
    }
    return writeClassification("execution", "required");
  }

  if (family === "plan" && command === "publish") {
    return writeClassification("plan-publish", "required");
  }
  if (RUN_CONTROL_READ_COMMANDS.has(family)) return { ...READ_CLASSIFICATION };
  if (family === "start") return writeClassification("compatibility-start", "command-aware", true);
  if (family === "create") return writeClassification("execution", "required", true);
  return writeClassification("execution", "required");
}

function writeClassification(
  mutation: Exclude<RunControlMutationScope, "read">,
  lease: RunControlLeaseIntent,
  sessionless = false,
): RunControlClassification {
  return { write: true, sessionless, mutation, lease };
}

export function isRunControlReadAction(action: string): boolean {
  return RUN_CONTROL_READ_ACTIONS.has(action);
}

export function isRunControlReadArgv(argv: readonly string[]): boolean {
  return !classifyRunControlArgv(argv).write;
}

