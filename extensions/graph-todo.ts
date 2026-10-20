import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { TodoController, type TodoLink, type TodoView } from "../src/v3/ui/todo.ts";
import type { GraphSnapshotV3 } from "../src/v3/types.ts";
const Id=Type.String({pattern:"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$"});
const Status=Type.Union([Type.Literal("pending"),Type.Literal("in_progress"),Type.Literal("blocked"),Type.Literal("done")]);
const Links=Type.Array(Type.Object({graphId:Id,runInstanceId:Id,taskId:Id},{additionalProperties:false}),{maxItems:128,uniqueItems:true});
const Depends=Type.Array(Id,{maxItems:128,uniqueItems:true});
export const PLAN_GUIDELINES=["目标包含三个以上阶段、依赖、跨轮次或多个Graph时，先graph_todo list，再以expectedRevision set完整目标计划。用goal表达一个总目标，items以可选parentId明确多级分组，最多8层、128项（分组也计入），不从标题猜层级或回填旧聊天。", "有子项的是分组：status必须pending，不能有assignee、Graph links或执行依赖；分组状态和进度只由后代叶汇总。assignee和dependsOn写在执行叶上，依赖只能叶到叶（可跨组），不引用分组。主会话人工工作也是叶项。", "派发时用graph start外层todoBinding={expectedRevision,bindings:[{todoId,taskIds}]}仅绑定叶项；成功后系统批量关联真实graphId/runInstanceId/taskId。每阶段与验收后先list，主会话项再CAS update；Graph结束不等于总目标完成。等待人类授权保持blocked，不建立watcher、不重放已完成任务。", "update省略parentId保持原位置，字符串移动到父项，null明确移到根；不能用update移走分组最后子项留下空组，用set显式重建并去掉空父项。set是新的计划周期，不自动转换旧flat计划或吞掉旧关联。计划依赖和责任不是派发授权；Graph验收、人工完成、分组汇总必须区分。"] ;
const Item=Type.Object({id:Id,title:Type.String({minLength:1,maxLength:400}),status:Status,links:Type.Optional(Links),dependsOn:Type.Optional(Depends),assignee:Type.Optional(Id),parentId:Type.Optional(Id)},{additionalProperties:false});
export const GraphTodoSchema=Type.Union([
 Type.Object({action:Type.Literal("list")},{additionalProperties:false}),
 Type.Object({action:Type.Literal("set"),expectedRevision:Type.Integer({minimum:0}),goal:Type.Optional(Type.String({minLength:1,maxLength:400})),items:Type.Array(Item,{maxItems:128})},{additionalProperties:false}),
 Type.Object({action:Type.Literal("update"),expectedRevision:Type.Integer({minimum:0}),id:Id,title:Type.Optional(Type.String({minLength:1,maxLength:400})),status:Type.Optional(Status),dependsOn:Type.Optional(Depends),assignee:Type.Optional(Id),parentId:Type.Optional(Type.Union([Id,Type.Null()]))},{additionalProperties:false}),
 Type.Object({action:Type.Literal("link"),expectedRevision:Type.Integer({minimum:0}),id:Id,links:Links},{additionalProperties:false}),
]);
export function registerGraphTodo(pi:ExtensionAPI, options:{controller:TodoController;read:(link:TodoLink,ctx:ExtensionContext)=>Promise<GraphSnapshotV3>;changed:(view:TodoView,ctx:ExtensionContext)=>void}):void {
 if(process.env.PI_GRAPH_CHILD==="1")return;
 pi.registerTool({name:"graph_todo",label:"Graph总计划",description:"分层总计划：goal为总目标，items可用parentId形成最多8层的树（总计128项）。分组只汇总，执行叶才能声明依赖/责任和Graph关联。不启动或控制Graph。list读取revision；set/update/link必须expectedRevision；update parentId:null明确移到根。未关联叶为人工状态；关联叶由本会话当前Graph验收派生。只写Pi原生session记录。",promptSnippet:"维护分层总目标、分组、叶任务责任与依赖，按revision关联真实Graph验收；不派发任务。",promptGuidelines:PLAN_GUIDELINES,parameters:GraphTodoSchema,
  async execute(_id,params,_signal,_update,ctx){
   if(!Check(GraphTodoSchema,params))throw new Error("graph_todo参数不符合schema");
   const assertActive=()=>{if(_signal?.aborted)throw new Error("graph_todo已取消，未提交计划");};assertActive();
   const read=(link:TodoLink)=>options.read(link,ctx);
   const view=params.action==="list"?await options.controller.view(ctx.sessionManager,read):await options.controller.mutate(ctx.sessionManager,params,read,typeof pi.appendEntry==="function"?(type,data)=>pi.appendEntry(type,data):undefined,assertActive);
   if(params.action==="list")assertActive();options.changed(view,ctx);return {content:[{type:"text",text:JSON.stringify(view)}],details:view,...(view.error?{isError:true}:{})};
  }});
}
