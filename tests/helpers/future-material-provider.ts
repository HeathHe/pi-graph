import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai";

const COMMAND_PREFIX = "PI_GRAPH_PUBLIC_RPC_E2E ";

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => {
		if (!block || typeof block !== "object") return "";
		const record = block as Record<string, unknown>;
		return typeof record.text === "string" ? record.text : "";
	}).join("\n");
}

function latestUser(context: Context): { index: number; text: string } | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "user") {
   const text = textOfContent(message.content);
   if (text.startsWith(COMMAND_PREFIX) || text.startsWith("PI_GRAPH_REPLY ") || text === "ORDINARY_PI_CHECK" || text.includes("PI_GRAPH_CHILD_DELAY_MS=")) return {index,text};
  }
	}
	return undefined;
}

function graphArguments(text: string): Record<string, unknown> | undefined {
	const marker = text.indexOf(COMMAND_PREFIX);
	if (marker < 0) return undefined;
	const source = text.slice(marker + COMMAND_PREFIX.length).trim();
	const value = JSON.parse(source) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("E2E graph arguments must be a JSON object.");
	return value as Record<string, unknown>;
}

const response: FauxResponseFactory = async (context, options) => {
	const probeUrl = process.env.PI_GRAPH_FAUX_PROVIDER_PROBE_URL;
	if (probeUrl) await fetch(probeUrl, { method: "POST", body: "streamSimple invoked" });
	const user = latestUser(context);
	if (!user) return fauxAssistantMessage("No user task was supplied.");
	if (user.text.startsWith("PI_GRAPH_REPLY ")) {
  const seen = context.messages.slice(user.index + 1).some(message => message.role === "toolResult");
  return seen ? fauxAssistantMessage("MAILBOX_REPLY_SENT") : fauxAssistantMessage(fauxToolCall("graph", {action:"mailbox",id:JSON.parse(user.text.slice("PI_GRAPH_REPLY ".length)).graphId,mailbox:{action:"reply",messageId:JSON.parse(user.text.slice("PI_GRAPH_REPLY ".length)).messageId,text:"CONTINUE_REAL_CHILD",idempotencyKey:"fixture-parent-reply"}}), {stopReason:"toolUse"});
 }
 if (user.text === "ORDINARY_PI_CHECK") return fauxAssistantMessage("ORDINARY_PI_OK");
 const arguments_ = graphArguments(user.text);
	if (arguments_) {
		const toolResultSeen = context.messages.slice(user.index + 1).some((message) => message.role === "toolResult");
		return toolResultSeen
			? fauxAssistantMessage("The requested public graph action returned.")
			: fauxAssistantMessage(fauxToolCall("graph", JSON.parse(JSON.stringify(arguments_))), { stopReason: "toolUse" });
	}
	const delayMatch = /PI_GRAPH_CHILD_DELAY_MS=(\d+)/u.exec(user.text);
	if (delayMatch) {
		const delay = Math.min(Number(delayMatch[1]), 30_000);
		await new Promise<void>((resolvePromise) => {
			const timer = setTimeout(resolvePromise, delay);
			options?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				resolvePromise();
			}, { once: true });
		});
	}
	return fauxAssistantMessage(`Faux child completed: ${user.text.slice(0, 200)}`);
};

export default function registerV3FauxProvider(pi: ExtensionAPI): void {
	const faux = createFauxCore({
		provider: "pi-graph-faux",
		api: "pi-graph-faux",
		models: [{
			id: "faux-1",
			name: "pi-graph deterministic E2E model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		}],
	});
	faux.setResponses(Array.from({ length: 256 }, () => response));
	pi.registerProvider("pi-graph-faux", {
		name: "pi-graph deterministic E2E provider",
		baseUrl: "http://127.0.0.1:1",
		apiKey: "pi-graph-e2e",
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: faux.api,
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
		// Newer Pi includes a separate system message; the pinned faux helper predates it.
		streamSimple: (model, context, options) => faux.streamSimple(model, { ...context, messages: context.messages.filter((message) => (message as { role: string }).role !== "system") }, options),
	});
}
