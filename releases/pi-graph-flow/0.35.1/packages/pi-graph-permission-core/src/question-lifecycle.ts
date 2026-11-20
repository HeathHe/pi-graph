export interface QuestionInput { question:string;header?:string;options?:{label:string;description?:string;recommended?:boolean}[];multiSelect?:boolean; }
export interface QuestionAnswer { questionIndex?:number;question:string;header?:string;selected:string[];details?:Record<string,string>;text?:string; }
export interface QuestionEndpoint {
 promise:Promise<{status:"answered";answers:QuestionAnswer[]}|{status:"cancelled"}>;
 cancel(reason:"remote_answered"|"tui_answered"|"cancelled"|"aborted"|"transport_error"):void|Promise<void>;
 reportCancelError(error:unknown):void;
}
const NONE_OPTION_LABEL="以上都不是";
export interface AutoQuestionPorts<Result,Timer> {
 signal?:AbortSignal;
 timeoutMs?:number;
 selected?:string[][];
 fresh():Promise<boolean>;
 dialog(signal?:AbortSignal):Promise<Result>;
 cancelled():Result;
 stale():Result;
 recommend(selected:string[][],timeoutMs:number):Result;
 notifyTimeout(timeoutMs:number):void;
 schedule(callback:()=>void,ms:number):Timer;
 clear(timer:Timer):void;
}
/** Only this operation owns timeout-vs-dialog settlement. Recommendations are not human answers. */
export async function runAutoQuestion<Result,Timer>(ports:AutoQuestionPorts<Result,Timer>):Promise<Result> {
 if(ports.timeoutMs===undefined||!ports.selected)return ports.dialog(ports.signal);
 const controller=new AbortController();
 const signal=ports.signal?AbortSignal.any([ports.signal,controller.signal]):controller.signal;
 let settled=false,timedOut=false,timer:Timer|undefined;
 try {
  const pending=ports.dialog(signal).finally(()=>{settled=true;});
  ports.notifyTimeout(ports.timeoutMs);
  timer=ports.schedule(()=>{void ports.fresh().then(valid=>{if(!valid||settled||ports.signal?.aborted)return;timedOut=true;controller.abort();});},ports.timeoutMs);
  const result=await pending;
  if(!timedOut)return result;
  if(ports.signal?.aborted)return ports.cancelled();
  if(!await ports.fresh())return ports.stale();
  return ports.recommend(ports.selected,ports.timeoutMs);
 } finally {if(timer!==undefined)ports.clear(timer);}
}
export function createQuestionAttentionOwner(){let sequence=0;return {nextId:()=>`question:${++sequence}`};}
interface QuestionRaceAnswered {
  status: "answered";
  answers: QuestionAnswer[];
}

interface QuestionRaceCancelled {
  status: "cancelled";
}

function cancelRemote(remote: QuestionEndpoint, reason: Parameters<QuestionEndpoint["cancel"]>[0]): void {
  try {
    void Promise.resolve(remote.cancel(reason)).catch((error) => {
      remote.reportCancelError(error);
    });
  } catch (error) {
    remote.reportCancelError(error);
  }
}

function validRemoteAnswers(value: unknown, questions: readonly QuestionInput[]): value is QuestionAnswer[] {
  if (!Array.isArray(value) || value.length !== questions.length) return false;
  return value.every((answer: unknown, index) => {
    const question = questions[index];
    if (typeof answer !== "object" || answer === null) return false;
    const item = answer as Record<string, unknown>;
    if (item.question !== question.question || item.header !== question.header) return false;
    const selected = item.selected;
    if (!Array.isArray(selected) || !selected.every((choice: unknown) => typeof choice === "string")) return false;
    const selectedLabels = selected as string[];
    const options = question.options ?? [];
    const labels = new Set(options.map((option) => option.label));
    if (options.length > 0) labels.add(NONE_OPTION_LABEL);
    if (selectedLabels.some((choice) => !labels.has(choice))) return false;
    if (selectedLabels.includes(NONE_OPTION_LABEL) && selectedLabels.length > 1) return false;
    if (!question.multiSelect && selectedLabels.length > 1) return false;
    if (item.text !== undefined && typeof item.text !== "string") return false;
    if (item.details !== undefined && (
      typeof item.details !== "object" || item.details === null || Array.isArray(item.details)
      || Object.entries(item.details).some(([key, detail]) => !selectedLabels.includes(key) || typeof detail !== "string")
    )) return false;
    return true;
  });
}

export async function raceQuestionEndpoints(
  local: (signal: AbortSignal) => Promise<QuestionAnswer[] | undefined>,
  remote: QuestionEndpoint,
  questions: readonly QuestionInput[],
  parentSignal?: AbortSignal,
): Promise<QuestionRaceAnswered | QuestionRaceCancelled> {
  const localController = new AbortController();
  const localSignal = parentSignal
    ? AbortSignal.any([parentSignal, localController.signal])
    : localController.signal;
  let localPending = true;
  let remotePending = true;
  let aborted = parentSignal?.aborted === true;

  const localPromise = local(localSignal).then(
    (answers) => ({ source: "local" as const, outcome: answers ? "answered" as const : "cancelled" as const, answers }),
    (error) => ({ source: "local" as const, outcome: "failed" as const, error }),
  );
  const remotePromise = remote.promise.then(
    (result) => ({ source: "remote" as const, outcome: result.status, ...(result.status === "answered" ? { answers: result.answers } : {}) }),
    (error) => ({ source: "remote" as const, outcome: "failed" as const, error }),
  );

  let abortResolve!: () => void;
  const abortPromise = new Promise<{ source: "abort"; outcome: "cancelled" }>((resolve) => {
    abortResolve = () => resolve({ source: "abort", outcome: "cancelled" });
  });
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    localController.abort();
    cancelRemote(remote, "aborted");
    abortResolve();
  };
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  if (aborted) onAbort();

  try {
    while (localPending || remotePending) {
      const candidates: Array<Promise<{
        source: "local" | "remote" | "abort";
        outcome: "answered" | "cancelled" | "disconnected" | "failed";
        answers?: QuestionAnswer[];
        error?: unknown;
      }>> = [abortPromise];
      if (localPending) candidates.push(localPromise);
      if (remotePending) candidates.push(remotePromise);
      const winner = await Promise.race(candidates);
      if (aborted || winner.source === "abort") return { status: "cancelled" };
      if (winner.source === "local") localPending = false;
      else remotePending = false;

      if (winner.source === "local" && winner.outcome === "cancelled") {
        cancelRemote(remote, "cancelled");
        return { status: "cancelled" };
      }
      if (winner.source === "remote" && winner.outcome === "cancelled") {
        localController.abort();
        return { status: "cancelled" };
      }

      // A remote disconnect only removes that projection. The TUI remains the
      // operation authority and continues waiting until it answers or is cancelled.
      if (winner.source === "remote" && winner.outcome === "disconnected") {
        continue;
      }
      if (winner.source === "remote" && winner.outcome === "failed") {
        // A rejected transport promise is not an explicit user cancellation.
        // Leave the pending request registered so a reconnect can replay it.
        continue;
      }
      if (winner.outcome === "answered") {
        if (winner.source === "local" || validRemoteAnswers(winner.answers, questions)) {
          if (winner.source === "remote") localController.abort();
          else cancelRemote(remote, "tui_answered");
          return { status: "answered", answers: winner.answers! };
        }
        cancelRemote(remote, "transport_error");
      }
    }
  } finally {
    parentSignal?.removeEventListener("abort", onAbort);
  }

  return { status: "cancelled" };
}
