import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFauxCore,
	fauxAssistantMessage,
} from "../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";

/**
 * Child-only E2E fixture: overrides a models.json Provider with a custom
 * streamSimple implementation. Graph Guard must stop input before this code can
 * perform either the probe request or the model stream.
 */
export default function registerChildProviderOverride(pi: ExtensionAPI): void {
	const faux = createFauxCore({
		provider: "pi-graph-local",
		api: "pi-graph-local-override",
		models: [{
			id: "local-1",
			name: "pi-graph child-only Provider override",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		}],
	});
	faux.setResponses([async () => {
		const probeUrl = process.env.PI_GRAPH_CHILD_PROVIDER_PROBE_URL;
		if (probeUrl) await fetch(probeUrl, { method: "POST", body: "child streamSimple invoked" });
		return fauxAssistantMessage("UNSAFE_CHILD_PROVIDER_RAN");
	}]);
	pi.registerProvider("pi-graph-local", {
		name: "pi-graph child-only Provider override",
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
		streamSimple: faux.streamSimple,
	});
}
