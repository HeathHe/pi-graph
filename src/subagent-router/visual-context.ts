import { resolve } from "node:path";
import type { VisualAssetExpiryReason, VisualEvidenceAsset } from "./visual-evidence.ts";

const DEFAULT_MAX_FOLLOW_UPS = 3;
const OMITTED_IMAGE_NOUN_REFERENCE = /(?:(?:刚才|方才)(?:那|这)?|上|这|那)(?:一|两|几)?张/iu;
const EXPLICIT_VISUAL_REFERENCE = /(?:刚才|方才|上一张|上张|这张|那张|原图|前面).{0,12}(?:图|图片|截图|页面|界面)|(?:图|图片|截图).{0,8}(?:里|中|上|的|呢|再|继续)|\b(?:previous|last|earlier|same|that)\s+(?:image|screenshot|picture)\b/iu;
const EXPLICIT_PRIOR_IMAGE_REFERENCE = /(?:刚才|方才|上一张|上张|这张|那张|原图|前面).{0,12}(?:图|图片|截图)|(?:图|图片|截图)(?:\s*\d+|.{0,8}(?:里|中|上|的|呢|再|继续))|(?:不用|无需|不需要).{0,8}(?:重新)?(?:看|打开|查看)(?:图|图片|截图)|(?:刚才|上次|此前|之前).{0,12}文字(?:结论|分析|建议|方案|思路)|\b(?:previous|last|earlier|same|that)\s+(?:image|screenshot|picture)\b/iu;
const VISUAL_DOMAIN = /分组|交互|按钮|控件|开关|选项|图标|弹窗|布局|排版|对齐|间距|层级|结构|遮挡|页面|界面|截图|红圈|产品角度|产品视角|流程|功能逻辑|用户体验/iu;
const CONTINUATION_MARKER = /(?:呢|吗|什么|是否|有没有|有无|哪|哪个|几|怎么样|怎么办|怪怪|不对|还有|继续|再看|再分析|另外|右上角|左上角|这里|那里|这个|那个|刚才|上一张|这张|那张)/iu;
const CONTEXTUAL_DESIGN_CONTINUATION = /为什么.{0,8}(?:这样|这么)(?:设计|安排)|还有.{0,8}(?:方案|选择|做法)|(?:这个|这种)方案|怎么(?:改|调整|优化).{0,8}(?:更好|合适)|如果.{0,16}(?:换成|改成)|把.{0,16}(?:会不会|是否).{0,8}(?:更好|合适)/iu;
const FRESH_VISUAL_FACT = /颜色|几个|多少|数量|像素|px\b|间距|坐标|位置|左边|右边|上面|下面|报错|原文|OCR|识别|读取|核对|重新看|再看图|遗漏|是否一致|比较|对比|区别|哪个更好|截图里|图中|禁用|启用|开着|关着|选中|未选中|控件状态|按钮状态|开关状态|\b(?:colou?r|how many|count|pixels?|spacing|coordinates?|position|left|right|above|below|error text|exact text|ocr|read|verify|look again|compare|difference|disabled|enabled|selected|checked|on|off)\b/iu;
const EXPLICIT_TEXT_ONLY_CONTINUATION = /^(?:(?:请)?(?:基于|按照|沿用).{0,24}文字(?:结论|分析|建议|方案|思路).{0,16}(?:继续|完善|讨论|展开|总结|给出|优化).{0,12}(?:方案|建议|思路|结论)|.*(?:不用|无需|不需要).{0,8}(?:重新)?(?:看|打开|查看)(?:图|图片|截图).*(?:基于|按照|沿用|继续).*|.*(?:without|do not need).{0,12}(?:reopen|look at).{0,8}(?:image|screenshot).*)$/iu;
const TEXT_ONLY_DIRECTIVE_FRAGMENT = /(?:基于|按照|沿用).{0,24}文字(?:结论|分析|建议|方案|思路)|(?:不用|无需|不需要).{0,8}(?:重新)?(?:看|打开|查看)(?:图|图片|截图)|(?:without|do not need).{0,12}(?:reopen|look at).{0,8}(?:image|screenshot)/iu;
const HYPOTHETICAL_DESIGN_CONTINUATION = /^(?:.{0,16}还有.{0,8}(?:方案|选择|做法)(?:呢|吗)?|(?:这个|这种)方案(?:呢|怎么样|好不好|是否可行|可行吗)|为什么.{0,8}(?:这样|这么)(?:设计|安排)(?:呢|吗)?|(?:继续|完善|讨论|展开).{0,12}(?:方案|建议|思路|结论)(?:呢|吗)?|怎么(?:改|调整|优化).{0,8}(?:更好|合适)(?:呢|吗)?|如果.{0,16}(?:换成|改成).{1,16}(?:呢|吗|怎么样|会不会更好|是否更好|更好吗)|.{0,12}(?:放|改|调整|换成|改成).{1,16}(?:怎么样|如何)|(?:把.{0,12})?(?:放|改|调整).{0,16}(?:会不会|是否).{0,8}(?:更好|合适)(?:呢|吗)?)[？?!！。]*$/iu;
const CLAUSE_BOUNDARY = /(?:[\n\r，,；;。？！!?]|同时|另外|并且|以及|而且|且|\b(?:and|while)\b)/iu;

export type VisualContextState = "pending" | "ready" | "failed" | "expired";
export type VisualFollowUpStatus = "none" | "usable" | VisualAssetExpiryReason | "follow_up_limit" | "ambiguous_multiple_images" | "not_ready" | "failed" | "unrelated" | "session_mismatch";

export interface VisualContextEntry {
	assetId?: string;
	sessionId: string;
	cwd: string;
	lastAgent?: string;
	state: VisualContextState;
	expirationReason?: VisualAssetExpiryReason | "follow_up_limit" | "ambiguous_multiple_images";
	followUpCount: number;
	pendingFollowUp: boolean;
	imageCount: number;
	createdAt: number;
	idleExpiresAt: number;
	absoluteExpiresAt: number;
}

export interface VisualFollowUpEvaluation {
	status: VisualFollowUpStatus;
	assetId?: string;
	lastAgent?: string;
	followUpCount?: number;
	imageCount?: number;
}

export interface VisualContextStoreOptions {
	now?: () => number;
	maxFollowUps?: number;
}

export function isVisualFollowUpPrompt(prompt: string): boolean {
	const normalized = prompt.trim();
	if (!normalized) return false;
	if (EXPLICIT_VISUAL_REFERENCE.test(normalized) || OMITTED_IMAGE_NOUN_REFERENCE.test(normalized) || EXPLICIT_TEXT_ONLY_CONTINUATION.test(normalized)) return true;
	return normalized.length <= 120 && ((VISUAL_DOMAIN.test(normalized) && CONTINUATION_MARKER.test(normalized)) || CONTEXTUAL_DESIGN_CONTINUATION.test(normalized));
}

export function hasExplicitVisualReference(prompt: string): boolean {
	const normalized = prompt.trim();
	return EXPLICIT_PRIOR_IMAGE_REFERENCE.test(normalized) || OMITTED_IMAGE_NOUN_REFERENCE.test(normalized);
}

export function requiresFreshVisualEvidence(prompt: string): boolean {
	const normalized = prompt.trim();
	const clauses = normalized.split(CLAUSE_BOUNDARY).map((clause) => clause.trim()).filter(Boolean);
	if (clauses.length > 1) {
		const relatedClauses = clauses.filter((clause) => isVisualFollowUpPrompt(clause) || FRESH_VISUAL_FACT.test(clause));
		if (relatedClauses.some((clause) => !TEXT_ONLY_DIRECTIVE_FRAGMENT.test(clause)
			&& !EXPLICIT_TEXT_ONLY_CONTINUATION.test(clause)
			&& !HYPOTHETICAL_DESIGN_CONTINUATION.test(clause))) return true;
		if (relatedClauses.length > 0) return false;
	}
	if (EXPLICIT_TEXT_ONLY_CONTINUATION.test(normalized) || HYPOTHETICAL_DESIGN_CONTINUATION.test(normalized)) return false;
	if (FRESH_VISUAL_FACT.test(normalized)) return true;
	return hasExplicitVisualReference(normalized) || isVisualFollowUpPrompt(normalized);
}

export class VisualContextStore {
	private current: VisualContextEntry | undefined;
	private readonly now: () => number;
	private readonly maxFollowUps: number;

	constructor(options: VisualContextStoreOptions = {}) {
		this.now = options.now ?? Date.now;
		this.maxFollowUps = Number.isFinite(options.maxFollowUps) && (options.maxFollowUps ?? -1) >= 0
			? Math.min(DEFAULT_MAX_FOLLOW_UPS, Math.floor(options.maxFollowUps!))
			: DEFAULT_MAX_FOLLOW_UPS;
	}

	remember(input: { asset: VisualEvidenceAsset; lastAgent?: string }): string | undefined {
		const replacedAssetId = this.current?.assetId;
		this.current = {
			assetId: input.asset.id,
			sessionId: input.asset.sessionId,
			cwd: resolve(input.asset.cwd),
			...(input.lastAgent ? { lastAgent: input.lastAgent } : {}),
			state: "pending",
			followUpCount: 0,
			pendingFollowUp: false,
			imageCount: input.asset.files.length,
			createdAt: input.asset.createdAt,
			idleExpiresAt: input.asset.idleExpiresAt,
			absoluteExpiresAt: input.asset.absoluteExpiresAt,
		};
		return replacedAssetId && replacedAssetId !== input.asset.id ? replacedAssetId : undefined;
	}

	markReady(asset: VisualEvidenceAsset, agent?: string): void {
		if (this.current?.assetId !== asset.id) return;
		if (this.current.pendingFollowUp) this.current.followUpCount += 1;
		this.current.pendingFollowUp = false;
		this.current.state = "ready";
		this.current.idleExpiresAt = asset.idleExpiresAt;
		this.current.absoluteExpiresAt = asset.absoluteExpiresAt;
		if (agent) this.current.lastAgent = agent;
	}

	markFailed(assetId: string): void {
		if (this.current?.assetId === assetId) this.current.state = "failed";
	}

	evaluate(input: { sessionId: string; cwd: string; prompt: string }): VisualFollowUpEvaluation {
		const current = this.current;
		if (!current) return { status: "none" };
		const related = isVisualFollowUpPrompt(input.prompt);
		if (current.sessionId !== input.sessionId || current.cwd !== resolve(input.cwd)) return { status: "session_mismatch" };
		if (!related) return { status: "unrelated", ...(current.assetId ? { assetId: current.assetId } : {}) };
		if (current.state === "expired") return { status: current.expirationReason ?? "expired_idle", imageCount: current.imageCount };
		const now = this.now();
		if (now >= current.absoluteExpiresAt) return { status: "expired_absolute", ...(current.assetId ? { assetId: current.assetId } : {}), imageCount: current.imageCount };
		if (now >= current.idleExpiresAt) return { status: "expired_idle", ...(current.assetId ? { assetId: current.assetId } : {}), imageCount: current.imageCount };
		if (current.followUpCount >= this.maxFollowUps) return { status: "follow_up_limit", ...(current.assetId ? { assetId: current.assetId } : {}), imageCount: current.imageCount };
		if (current.state === "failed") return { status: "failed", ...(current.assetId ? { assetId: current.assetId } : {}), imageCount: current.imageCount };
		if (current.state !== "ready") return { status: "not_ready", ...(current.assetId ? { assetId: current.assetId } : {}), imageCount: current.imageCount };
		return {
			status: "usable",
			assetId: current.assetId,
			...(current.lastAgent ? { lastAgent: current.lastAgent } : {}),
			followUpCount: current.followUpCount,
			imageCount: current.imageCount,
		};
	}

	beginFollowUp(asset: VisualEvidenceAsset, agent?: string): void {
		if (this.current?.assetId !== asset.id) return;
		this.current.pendingFollowUp = true;
		this.current.state = "pending";
		this.current.idleExpiresAt = asset.idleExpiresAt;
		this.current.absoluteExpiresAt = asset.absoluteExpiresAt;
		if (agent) this.current.lastAgent = agent;
	}

	expire(reason: VisualAssetExpiryReason | "follow_up_limit" | "ambiguous_multiple_images"): string | undefined {
		if (!this.current) return undefined;
		const assetId = this.current.assetId;
		this.current.assetId = undefined;
		this.current.state = "expired";
		this.current.expirationReason = reason;
		this.current.pendingFollowUp = false;
		return assetId;
	}

	assetId(): string | undefined {
		return this.current?.assetId;
	}

	state(): VisualContextState | undefined {
		return this.current?.state;
	}

	isSingleImage(): boolean {
		return this.current?.imageCount === 1;
	}

	discard(): string | undefined {
		const assetId = this.current?.assetId;
		this.current = undefined;
		return assetId;
	}
}
