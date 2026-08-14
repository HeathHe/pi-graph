import { randomUUID } from "node:crypto";
import type { RequiredParentRoute } from "./types.ts";

const PRODUCT_PERSPECTIVE = /(?:站在|从|以).{0,10}产品(?:的)?(?:经理|负责人|视角|角度)|产品定位|目标用户|成功指标|用户场景|业务规则|product\s+(?:perspective|strategy|requirements?)/iu;
const INTERACTION_REVIEW = /交互|信息层级|布局|排版|对齐|间距|遮挡|视觉层级|按钮|控件|操作流程|反馈状态|错误恢复|可访问性|响应式|用户体验|界面.{0,12}(?:优化|问题|不对|异常|评估|分析|检查)|页面.{0,12}(?:优化|问题|不对|异常|评估|分析|检查)|截图.{0,12}(?:优化|问题|不对|异常|评估|分析|检查)|红圈.{0,12}(?:优化|问题|不对|异常|评估|分析|检查)|(?:分析|检查|评估|看看|审查).{0,12}(?:页面|界面|截图)/iu;
const VISUAL_FACT_EXTRACTION = /\bOCR\b|(?:读取|识别|提取|抄录|转写).{0,12}(?:文字|文本|数字|内容)|(?:图片|图中|照片).{0,12}(?:是什么|有什么|内容)/iu;
const ROUTING_META_QUESTION = /(?:为什么|为何|是否|怎么|解释).{0,40}(?:调用|路由|派工|agent|角色)|(?:调用|路由|派工).{0,40}(?:产品|product-manager)/iu;

export function classifyRequiredParentRoute(input: {
	prompt: string;
	turnId?: string;
	hasVisualEvidence?: boolean;
	visualEvidenceId?: string;
	visualFollowUpAgent?: string;
}): RequiredParentRoute | undefined {
	const prompt = input.prompt.trim();
	if (!prompt) return undefined;
	if (ROUTING_META_QUESTION.test(prompt)) return undefined;
	const turnId = input.turnId ?? randomUUID();
	if (PRODUCT_PERSPECTIVE.test(prompt)) {
		return {
			decisionId: randomUUID(),
			turnId,
			prompt,
			lane: "direct_subagent",
			capabilityId: "define.product",
			agent: "product-manager",
			...(input.visualEvidenceId ? { visualEvidenceId: input.visualEvidenceId } : {}),
			reasonCode: "EXPLICIT_PRODUCT_PERSPECTIVE",
			status: "required",
			repairCount: 0,
		};
	}
	if (input.hasVisualEvidence && INTERACTION_REVIEW.test(prompt) && !VISUAL_FACT_EXTRACTION.test(prompt)) {
		return {
			decisionId: randomUUID(),
			turnId,
			prompt,
			lane: "direct_subagent",
			capabilityId: "design.interaction",
			agent: "interaction-designer",
			...(input.visualEvidenceId ? { visualEvidenceId: input.visualEvidenceId } : {}),
			reasonCode: "EXPLICIT_VISUAL_INTERACTION_REVIEW",
			status: "required",
			repairCount: 0,
		};
	}
	if (input.hasVisualEvidence && ["interaction-designer", "product-manager"].includes(input.visualFollowUpAgent ?? "")) {
		const agent = input.visualFollowUpAgent!;
		return {
			decisionId: randomUUID(),
			turnId,
			prompt,
			lane: "direct_subagent",
			capabilityId: agent === "product-manager" ? "define.product" : "design.interaction",
			agent,
			...(input.visualEvidenceId ? { visualEvidenceId: input.visualEvidenceId } : {}),
			reasonCode: "VISUAL_CONTEXT_FOLLOW_UP",
			status: "required",
			repairCount: 0,
		};
	}
	return undefined;
}

export function requiredRoutePrompt(route: RequiredParentRoute): string {
	return [
		"<required_parent_route>",
		`decisionId=${route.decisionId}`,
		`reasonCode=${route.reasonCode}`,
		`requiredCapability=${route.capabilityId}`,
		`requiredAgent=${route.agent}`,
		...(route.visualEvidenceId ? [`visualEvidenceId=${route.visualEvidenceId}`] : []),
		"This explicit specialist request must be delegated before the parent gives the domain answer.",
		`Call routed_subagent with agent='${route.agent}'${route.visualEvidenceId ? ` and visualEvidenceId='${route.visualEvidenceId}'` : ""}, and pass the original request plus any collected evidence.`,
		...(route.visualEvidenceId ? ["The visualEvidenceId is a sealed handle, not image content. Do not alter it, omit it, or replace it with a path."] : []),
		"Do not replace this delegation with parent bash/read/search or with a mention of the Agent.",
		"If launch preflight rejects the Agent, report that exact failure instead of silently doing the specialist work yourself.",
		"</required_parent_route>",
	].join("\n");
}
