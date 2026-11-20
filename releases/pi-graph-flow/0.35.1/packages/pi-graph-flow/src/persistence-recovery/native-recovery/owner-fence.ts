import { validateTaskClearWitness, taskClearHeadCoreHash, type TaskClearIntent, type TaskClearWitness } from "./task-clear.ts";
import { validateNativeBefore, validatePlanReplacementWitness, planReplacementHeadCoreHash, type NativeBeforePin, type PlanReplacementIntent, type PlanReplacementWitness } from "./plan-replacement.ts";
import { randomUUID } from "node:crypto";
import { fingerprint, jsonCopy, sameInput, type RecoveryContract, type RecoveryHead, type RecoveryCandidate, type RecoveryWork, type RecoveryClose, type OutputAssociation, type RecoveryInput, type GoalDetachJournalIntent, type GoalDetachJournalWitness, recoveryHeadCoreHash, validateGoalDetachWitness } from "./contracts.ts";
import type { NativeRecoveryStore } from "./sqlite-store.ts";

interface Attempt { slots: string[]; generations: number[]; admission: number[]; candidate: RecoveryCandidate; guard: () => void; factGuard:()=>void; unknown?: boolean; }
interface Permit { attempt: object; revisions: number[]; payloadDigest:string; consumed: boolean; }
export interface RecoveryTransition {before?:RecoveryContract;after?:RecoveryContract;kind:"ordinary"|"reopen"|"delete"|"create"|"admit";/** Internal fresh-create restriction, never an authorization. */requireAbsent?:true;}
/** Private host handles, never reconstituted from a journal DTO. */
export class NativeRecoveryOwner {
  readonly id = randomUUID();
  readonly #attempts = new WeakMap<object, Attempt>();
  readonly #permits = new WeakMap<object, Permit>();
  #replacementHold?: object;
  #holdDomain?: "plan-replacement" | "task-clear";
  #replacementWitnessId?: string;
  #assertBusiness(): void { if (this.#replacementHold) throw new Error("plan-replacement-pending: native owner held"); }
  constructor(readonly store: NativeRecoveryStore) {}
  /** Transactions are synchronous. Installing this hold cannot interleave an entered local transaction. */
  holdPlanReplacement(): { token: object; witnessId: string; release(): void } {
    if (this.#replacementHold) throw new Error("Native replacement hold already installed");
    const token = Object.freeze({}); this.#replacementHold = token; this.#holdDomain = "plan-replacement"; this.#replacementWitnessId = randomUUID();
    return { token, witnessId: this.#replacementWitnessId, release: () => { if (this.#replacementHold === token) { this.#replacementHold = undefined; this.#replacementWitnessId = undefined; this.#holdDomain = undefined; } } };
  }
  #assertReplacementHold(token: object): void {
    if (this.#replacementHold !== token || this.#holdDomain !== "plan-replacement") throw new Error("Unissued native replacement hold");
  }
  samplePlanReplacementBefore(slots: readonly string[], token: object): NativeBeforePin[] {
    this.#assertReplacementHold(token);
    return this.#sampleBefore(slots, token);
  }
  #sampleBefore(slots: readonly string[], token: object): NativeBeforePin[] {
    if (this.#replacementHold !== token) throw new Error("Unissued native publication hold");
    const pins = slots.map(slot => {
      const head = this.store.read(slot), revision = head?.revision ?? 0;
      const event = this.store.readEvent(slot, head ? revision : 1);
      if (head ? !event || fingerprint(event) !== fingerprint(head) || this.store.readEvent(slot, revision + 1) : event) throw new Error("Native replacement before event evidence differs");
      return { slot, headPresent: !!head, revision, headHash: head ? fingerprint(head) : null, eventHash: event ? fingerprint(event) : null,
        admission: head?.admission ?? 0, ownerGeneration: head?.ownerGeneration ?? 0 };
    });
    validateNativeBefore(pins, slots); return pins;
  }
  assertPlanReplacementBefore(pins: readonly NativeBeforePin[], token: object): void {
    validateNativeBefore(pins);
    if (fingerprint(this.samplePlanReplacementBefore(pins.map(pin => pin.slot), token)) !== fingerprint(pins)) throw new Error("Native replacement exact-before changed; reconciliation required");
  }
  planReplacementTransition(changes: readonly { before?: RecoveryContract; after: RecoveryContract; kind: "supersede" | "create" }[], intent: PlanReplacementIntent, token: object, guard: () => void): PlanReplacementWitness {
    this.#assertReplacementHold(token);
    const slots = changes.map(change => change.after.taskId);
    validateNativeBefore(intent.nativeBefore, slots);
    let witness: PlanReplacementWitness | undefined;
    this.store.transact(slots, values => {
      this.assertPlanReplacementBefore(intent.nativeBefore, token);
      const heads = values.map((before, i): RecoveryHead => {
        const change = changes[i]!, pin = intent.nativeBefore[i]!;
        if (change.kind === "create" && (before || change.before) || change.kind === "supersede" && (!change.before || before && (before.contract.instanceId !== change.before.instanceId || before.contract.version !== change.before.version || before.contract.digest !== change.before.digest || before.contract.submissionId !== change.before.submissionId))) throw new Error("Native replacement contract differs from reservation");
        return { slot: pin.slot, revision: pin.revision + 1, admission: pin.admission + 1, ownerGeneration: pin.ownerGeneration + 1,
          ownerId: this.id, state: "invalidated", contract: jsonCopy(change.after), inputSequence: 0, ...(before?.tombstone ? {tombstone:true as const} : {}) };
      });
      witness = { ...jsonCopy(intent), version: 1, reason: "plan-replacement", id: this.#replacementWitnessId!, members: heads.map((head, i) => ({
        slot: head.slot, kind: changes[i]!.kind, before: changes[i]!.before ? jsonCopy(changes[i]!.before!) : null, after: jsonCopy(changes[i]!.after),
        beforeRevision: intent.nativeBefore[i]!.revision, beforeHeadHash: intent.nativeBefore[i]!.headHash,
        afterRevision: head.revision, admission: head.admission, ownerGeneration: head.ownerGeneration, afterCoreHash: planReplacementHeadCoreHash(head),
      })) };
      validatePlanReplacementWitness(witness);
      const coordinator = heads.filter((_head, i) => changes[i]!.kind === "supersede").sort((a,b) => a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0)[0]!;
      const ref = { version: 1 as const, id: witness.id, coordinatorSlot: coordinator.slot, coordinatorRevision: coordinator.revision, digest: fingerprint(witness) };
      for (const head of heads) head.planReplacementWitness = jsonCopy(ref);
      coordinator.planReplacementRecord = jsonCopy(witness);
      return { heads };
    }, () => { this.#assertReplacementHold(token); guard(); });
    return witness!;
  }
  /** Exact DB-issued after evidence only. Does not issue a permit or repeat a transition. */
  readPlanReplacementAfter(pins: readonly NativeBeforePin[], replacementId: string, requestDigest: string, token: object): PlanReplacementWitness | undefined {
    this.#assertReplacementHold(token); validateNativeBefore(pins);
    const heads = pins.map(pin => this.store.read(pin.slot));
    if (heads.every((head, i) => (head ? fingerprint(head) : null) === pins[i]!.headHash)) { this.assertPlanReplacementBefore(pins, token); return undefined; }
    const ref = heads[0]?.planReplacementWitness;
    if (!ref) throw new Error("Native replacement mixed/unknown heads require reconciliation");
    const coordinator = this.store.read(ref.coordinatorSlot), w = coordinator?.planReplacementRecord;
    validatePlanReplacementWitness(w);
    if (w.replacementId !== replacementId || w.requestDigest !== requestDigest || fingerprint(w.nativeBefore) !== fingerprint(pins) || fingerprint(w) !== ref.digest) throw new Error("Native replacement witness reservation differs");
    for (const [i, member] of w.members.entries()) {
      const head = heads[i];
      if (!head || head.slot !== member.slot || fingerprint(head.planReplacementWitness) !== fingerprint(ref) || head.revision !== member.afterRevision
        || head.admission !== member.admission || head.ownerGeneration !== member.ownerGeneration || head.state !== "invalidated"
        || planReplacementHeadCoreHash(head) !== member.afterCoreHash || fingerprint(head.contract) !== fingerprint(member.after)
        || fingerprint(this.store.readEvent(head.slot, head.revision)) !== fingerprint(head) || this.store.readEvent(head.slot, head.revision + 1)) throw new Error("Native replacement exact-after changed");
      const before = this.store.readEvent(head.slot, member.beforeRevision);
      if (member.beforeRevision ? !before || fingerprint(before) !== member.beforeHeadHash : before !== undefined) throw new Error("Native replacement predecessor event differs");
    }
    return jsonCopy(w);
  }
  holdTaskClear(): {token:object;witnessId:string;release():void} {
    const held=this.holdPlanReplacement(); this.#holdDomain="task-clear"; return held;
  }
  #assertClearHold(token:object):void { if(this.#replacementHold!==token || this.#holdDomain!=="task-clear")throw new Error("Unissued native Task clear hold"); }
  sampleTaskClearBefore(slots:readonly string[],token:object):NativeBeforePin[] {this.#assertClearHold(token);return this.#sampleBefore(slots,token);}
  assertTaskClearBefore(pins:readonly NativeBeforePin[],token:object):void {
    this.#assertClearHold(token);validateNativeBefore(pins);
    if(fingerprint(this.#sampleBefore(pins.map(p=>p.slot),token))!==fingerprint(pins))throw new Error("Task clear native before changed; reconciliation required");
  }
  taskClearTransition(contracts:readonly RecoveryContract[],intent:TaskClearIntent,token:object,guard:()=>void):TaskClearWitness {
    this.#assertClearHold(token);const slots=contracts.map(c=>c.taskId);validateNativeBefore(intent.nativeBefore,slots);let witness:TaskClearWitness|undefined;
    this.store.transact(slots,values=>{
      this.assertTaskClearBefore(intent.nativeBefore,token);
      const heads=contracts.map((contract,i):RecoveryHead=>{
        const before=values[i],pin=intent.nativeBefore[i]!;
        if(before && (before.contract.instanceId!==contract.instanceId || before.contract.version!==contract.version || before.contract.digest!==contract.digest || before.contract.submissionId!==contract.submissionId))throw new Error("Task clear native contract differs");
        return {slot:contract.taskId,revision:pin.revision+1,admission:pin.admission+1,ownerGeneration:pin.ownerGeneration+1,ownerId:this.id,state:"invalidated",tombstone:true,contract:jsonCopy(contract),inputSequence:0};
      });
      witness={...jsonCopy(intent),version:1,reason:"task-clear",id:this.#replacementWitnessId!,members:heads.map((head,i)=>({slot:head.slot,before:jsonCopy(contracts[i]!),afterRevision:head.revision,admission:head.admission,ownerGeneration:head.ownerGeneration,afterCoreHash:taskClearHeadCoreHash(head)}))};
      validateTaskClearWitness(witness);
      const coordinator=[...heads].sort((a,b)=>a.slot<b.slot?-1:a.slot>b.slot?1:0)[0]!;
      const ref={version:1 as const,id:witness.id,coordinatorSlot:coordinator.slot,coordinatorRevision:coordinator.revision,digest:fingerprint(witness)};
      for(const head of heads)head.taskClearWitness=jsonCopy(ref);coordinator.taskClearRecord=jsonCopy(witness);return {heads};
    },()=>{this.#assertClearHold(token);guard();});return witness!;
  }
  readTaskClearAfter(pins:readonly NativeBeforePin[],clearId:string,requestDigest:string,token:object):TaskClearWitness|undefined {
    this.#assertClearHold(token);validateNativeBefore(pins);const heads=pins.map(p=>this.store.read(p.slot));
    if(heads.every((h,i)=>(h?fingerprint(h):null)===pins[i]!.headHash)){this.assertTaskClearBefore(pins,token);return undefined;}
    const ref=heads[0]?.taskClearWitness;if(!ref)throw new Error("Task clear mixed native heads require reconciliation");
    const witness=this.store.read(ref.coordinatorSlot)?.taskClearRecord;validateTaskClearWitness(witness);
    if(witness.clearId!==clearId || witness.requestDigest!==requestDigest || fingerprint(witness.nativeBefore)!==fingerprint(pins) || fingerprint(witness)!==ref.digest)throw new Error("Task clear native witness differs");
    for(const [i,member] of witness.members.entries()){
      const head=heads[i],pin=pins[i]!;
      if(!head || head.slot!==member.slot || head.tombstone!==true || head.state!=="invalidated" || head.claim || head.candidate || fingerprint(head.taskClearWitness)!==fingerprint(ref)
        || head.revision!==member.afterRevision || head.admission!==member.admission || head.ownerGeneration!==member.ownerGeneration || taskClearHeadCoreHash(head)!==member.afterCoreHash
        || fingerprint(head.contract)!==fingerprint(member.before) || fingerprint(this.store.readEvent(head.slot,head.revision))!==fingerprint(head) || this.store.readEvent(head.slot,head.revision+1))throw new Error("Task clear exact-after native evidence changed");
      const before=this.store.readEvent(head.slot,pin.revision);
      if(pin.revision ? !before || fingerprint(before)!==pin.headHash : before!==undefined)throw new Error("Task clear native before event changed");
    }
    return jsonCopy(witness);
  }
  transition(before: RecoveryContract | undefined, after: RecoveryContract | undefined, kind: RecoveryTransition["kind"], guard: () => void): void {
    this.transitions([{before,after,kind}],guard);
  }
  transitions(changes:readonly RecoveryTransition[],guard:()=>void,journalIntent?:GoalDetachJournalIntent):void {
    this.#assertBusiness();
    if(!changes.length)return;
    const slots=changes.map(({before,after,kind,requireAbsent})=>{
      if (requireAbsent !== undefined && (requireAbsent !== true || kind !== "create" || !after || before !== undefined)) {
        throw new Error("Native fresh-slot restriction requires create with after and no before");
      }
      const contract=after??before;
      if(!contract||before&&after&&before.taskId!==after.taskId)throw new Error("Native recovery transition has no consistent slot");
      if(kind==="admit"&&(!after?.submissionId||after.submissionId===before?.submissionId))throw new Error("Native recovery requires a new trusted submission");
      return contract.taskId;
    });
    if(new Set(slots).size!==slots.length)throw new Error("Native recovery duplicate transition slot");
    this.store.transact(slots, values => {
      // Check the actual heads under the existing transaction before producing any writes.
      if (changes.some((change, index) => change.requireAbsent === true && values[index] != null)) {
        throw new Error("Native fresh Task slot is no longer absent");
      }
      const associations:OutputAssociation[]=[];
      const heads=values.map((head,i):RecoveryHead=>{
      const {before,after,kind}=changes[i]!,slot=slots[i]!;
      const fresh=(revision:number,admission:number,ownerGeneration:number):RecoveryHead=>({slot,revision,admission,ownerGeneration,ownerId:this.id,state:kind==="admit"?"admitted":"invalidated",contract:(after??before)!,inputSequence:0,...(kind==="delete"?{tombstone:true as const}:{})});
      if (!head) return fresh(1,1,1);
      const matches=!!before&&head.contract.instanceId===before.instanceId&&head.contract.version===before.version&&head.contract.digest===before.digest&&head.contract.submissionId===before.submissionId;
      const next: RecoveryHead = {...head,revision:head.revision+1};
      if (kind === "create" && after && after.instanceId !== head.contract.instanceId && head.tombstone===true && (matches || !before)) {
        return fresh(next.revision,head.admission+1,head.ownerGeneration+1);
      }
      if (!matches) throw new Error("Native recovery Task journal is behind/different from the durable visible-slot head");
      if(kind==="admit"&&head.tombstone)throw new Error("Native recovery deleted Task cannot be admitted");
      if(kind==="admit")return fresh(next.revision,head.admission+1,head.ownerGeneration+1);
      // M03 prepare assigns the admitted submission before any candidate exists.
      if(after&&kind==="ordinary"&&head.state==="admitted"&&head.ownerId===this.id&&!head.executed&&!head.candidate&&after.submissionId===head.contract.submissionId){next.contract=after;return next;}
      if (after && kind === "ordinary" && sameInput(head.contract,after) && after.version >= head.contract.version) {
        next.contract=after;
        if (head.executed && head.contract.digest !== after.digest) {next.associationId=randomUUID();associations.push({id:next.associationId,kind:"original-M03-output-only",executed:head.executed,reviewed:after,transitionDigest:fingerprint([head.contract,after])});}
        return next;
      }
      if(kind==="delete")next.tombstone=true;
      next.state="invalidated";next.ownerGeneration++;next.admission++;next.ownerId=this.id;delete next.claim;
      if(after)next.contract=after;
      return next;
      });
      for (const head of heads) { delete head.journalWitness; delete head.planReplacementWitness; delete head.planReplacementRecord; delete head.taskClearWitness; delete head.taskClearRecord; }
      if (journalIntent) {
        const witness: GoalDetachJournalWitness = {
          ...jsonCopy(journalIntent), version: 1, id: randomUUID(),
          members: heads.map((head, i) => ({
            slot: slots[i]!, kind: changes[i]!.kind,
            before: changes[i]!.before ? jsonCopy(changes[i]!.before!) : null,
            after: changes[i]!.after ? jsonCopy(changes[i]!.after!) : null,
            beforeRevision: values[i]?.revision ?? 0,
            beforeHeadHash: values[i] ? fingerprint(values[i]) : null,
            afterRevision: head.revision, admission: head.admission,
            ownerGeneration: head.ownerGeneration, afterCoreHash: recoveryHeadCoreHash(head),
          })),
        };
        validateGoalDetachWitness(witness);
        for (const head of heads) head.journalWitness = jsonCopy(witness);
      }
      return {heads,associations};
    },guard);
  }
  /** Reads a complete, current DB-issued witness. Never takes a caller witness/permit. */
  #journalWitness(slots: readonly string[]): GoalDetachJournalWitness {
    const heads = slots.map(slot => this.store.read(slot));
    const witness = heads[0]?.journalWitness;
    validateGoalDetachWitness(witness);
    if (fingerprint(witness.members.map(member => member.slot)) !== fingerprint(slots)) throw new Error("Native journal witness batch differs");
    for (const [index, slot] of slots.entries()) {
      const head = heads[index], member = witness.members[index]!;
      if (!head || !head.journalWitness || fingerprint(head.journalWitness) !== fingerprint(witness)
        || head.revision !== member.afterRevision || head.admission !== member.admission || head.ownerGeneration !== member.ownerGeneration
        || recoveryHeadCoreHash(head) !== member.afterCoreHash || fingerprint(head.contract) !== fingerprint(member.after)) throw new Error("Native journal witness head changed");
      const event = this.store.readEvent(slot, member.afterRevision);
      if (!event || fingerprint(event) !== fingerprint(head)) throw new Error("Native journal witness event differs from current head");
      const before = this.store.readEvent(slot, member.beforeRevision);
      if (member.beforeRevision === 0 ? before !== undefined || member.beforeHeadHash !== null : !before || fingerprint(before) !== member.beforeHeadHash) throw new Error("Native journal witness predecessor differs");
      if (before ? member.admission < before.admission || member.ownerGeneration < before.ownerGeneration : member.admission !== 1 || member.ownerGeneration !== 1) throw new Error("Native journal witness counters regressed");
    }
    return jsonCopy(witness);
  }
  /** Only resolves an already-applied transition, never advances a head or admits work. */
  goalDetachJournalOnly(changes: readonly RecoveryTransition[], intent: GoalDetachJournalIntent): { witness: GoalDetachJournalWitness; assertCurrent(): void } | undefined {
    const slots = changes.map(change => (change.after ?? change.before)!.taskId);
    const heads = slots.map(slot => this.store.read(slot));
    const matchesBefore = heads.every((head, index) => {
      const before = changes[index]!.before;
      return !head || !!before && head.contract.instanceId === before.instanceId && head.contract.version === before.version && head.contract.digest === before.digest && head.contract.submissionId === before.submissionId;
    });
    if (matchesBefore) return undefined;
    const witness = this.#journalWitness(slots);
    if (witness.goalId !== intent.goalId || fingerprint(witness.source) !== fingerprint(intent.source)
      || witness.normalizedBeforeDigest !== intent.normalizedBeforeDigest || witness.afterSemanticDigest !== intent.afterSemanticDigest
      || changes.some((change, index) => change.kind !== witness.members[index]!.kind
        || fingerprint(change.before ?? null) !== fingerprint(witness.members[index]!.before)
        || fingerprint(change.after ?? null) !== fingerprint(witness.members[index]!.after))) throw new Error("Native journal witness does not authorize this exact semantic publication");
    const pin = fingerprint(witness);
    return {witness, assertCurrent: () => {if (fingerprint(this.#journalWitness(slots)) !== pin) throw new Error("Native journal witness changed during publication");}};
  }
  begin(contracts: readonly RecoveryContract[], candidate: RecoveryCandidate, guard: () => void, factGuard:()=>void=guard): object {
    this.#assertBusiness();
    const slots=contracts.map(contract=>contract.taskId);
    const heads=this.store.transact(slots, values=>({heads:values.map((head,i)=>{
      const contract=contracts[i]!;
      if(!head || head.tombstone || !contract.submissionId || head.state==="invalidated" || head.ownerId!==this.id || head.claim || head.contract.instanceId!==contract.instanceId || head.contract.submissionId!==contract.submissionId
        || head.contract.version!==contract.version || head.contract.digest!==contract.digest || (head.executed&&!sameInput(head.executed,contract))) throw new Error("Native recovery admission/owner/contract mismatch; existing work is not replayable");
      return {...head,revision:head.revision+1,state:"pending",candidate,executed:head.executed??contract,inputSequence:head.inputSequence+1,pendingInput:undefined,modelInput:undefined,work:undefined,close:undefined};
    })}),guard);
    const handle=Object.freeze({});this.#attempts.set(handle,{slots,generations:heads.map(head=>head.ownerGeneration),admission:heads.map(head=>head.admission),candidate:jsonCopy(candidate),guard,factGuard});return handle;
  }
  #owned(handle:object, heads:readonly (RecoveryHead|undefined)[],facts=false): Attempt {
    this.#assertBusiness();
    const attempt=this.#attempts.get(handle);if(!attempt||attempt.unknown)throw new Error("Unissued/unknown native recovery attempt; no input retry");(facts?attempt.factGuard:attempt.guard)();
    heads.forEach((head,i)=>{if(!head || head.ownerId!==this.id || head.ownerGeneration!==attempt.generations[i] || head.admission!==attempt.admission[i]
      || head.candidate?.id!==attempt.candidate.id || head.state==="invalidated" || head.claim)throw new Error("Native recovery owner/candidate was fenced");});return attempt;
  }
  assertAttempt(handle: object, facts = false): void {
    const attempt = this.#attempts.get(handle);
    if (!attempt) throw new Error("Unissued native recovery attempt");
    this.#owned(handle, attempt.slots.map(slot => this.store.read(slot)), facts);
  }
  unknown(handle:object):void {const attempt=this.#attempts.get(handle);if(attempt)attempt.unknown=true;}
  beforeWrite(handle:object,input:RecoveryInput):object {
    const attempt=this.#attempts.get(handle);if(!attempt)throw new Error("Unissued native recovery input");
    if(!input.command||!/^[a-f0-9]{64}$/.test(input.payloadDigest))throw new Error("Native recovery input identity invalid");
    const captured=jsonCopy(input);
    const heads=this.store.transact(attempt.slots, values=>{this.#owned(handle,values);return {heads:values.map(head=>{
      const model=["prompt","steer","follow_up"].includes(captured.command),turn=captured.turn,original=head!.modelInput?.turn;
      const continuation=["extension_ui_response","set_steering_mode","set_follow_up_mode"].includes(captured.command)
        &&turn&&["queued","running"].includes(turn.state)&&original&&turn.inputGeneration===original.inputGeneration&&turn.requestId===original.requestId;
      return {...head!,revision:head!.revision+1,inputSequence:head!.inputSequence+1,state:"pending",pendingInput:captured,modelInput:model?captured:continuation?head!.modelInput:undefined,work:undefined,close:undefined};
    })};},attempt.guard);
    const permit=Object.freeze({});this.#permits.set(permit,{attempt:handle,revisions:heads.map(head=>head.revision),payloadDigest:captured.payloadDigest,consumed:false});return permit;
  }
  consume(handle:object,permit:object,payloadDigest:string):void {
    const value=this.#permits.get(permit),attempt=this.#attempts.get(handle);
    if(!value||!attempt||value.attempt!==handle||value.consumed||value.payloadDigest!==payloadDigest)throw new Error("Unissued/reused/mismatched native write permit");
    value.consumed=true;const heads=attempt.slots.map(slot=>this.store.read(slot));this.#owned(handle,heads);
    if(heads.some((head,i)=>head?.revision!==value.revisions[i]||head.state!=="pending"||head.pendingInput?.payloadDigest!==payloadDigest))throw new Error("Native input permit high-water changed");
  }
  record(handle:object, invocationId:string, work:RecoveryWork|undefined, close:RecoveryClose|undefined, pending:boolean):void {
    const attempt=this.#attempts.get(handle);if(!attempt)return;
    const current=attempt.slots.map(slot=>this.store.read(slot));
    // Late candidates remain in M04 audit history; they cannot overwrite this head.
    try{this.#owned(handle,current,true);}catch{return;}
    this.store.transact(attempt.slots, values=>{this.#owned(handle,values,true);return {heads:values.map(head=>{
      const next:RecoveryHead={...head!,revision:head!.revision+1,candidate:{...head!.candidate!,invocationId}};
      if(pending){next.state="pending";delete next.work;delete next.close;return next;}
      if(work){const input=next.modelInput,turn=input?.turn;
        // The queued boundary precedes accept/begin and any actual loop advances.
        // M04 supplies the final settled epoch; only this same admitted input may reach it.
        if(!input||!["prompt","steer","follow_up"].includes(input.command)||!turn||!["queued","running"].includes(turn.state)||turn.epoch>work.epoch||turn.inputGeneration!==work.inputGeneration||turn.requestId!==work.requestId||turn.loopSeq===undefined||turn.loopSeq>work.loopSeq){next.state="unknown";delete next.work;delete next.close;return next;}
        next.work=work;next.state=work.exitCode===0&&work.terminalStatus==="completed"?"settled":"failed";}
      if(close)next.close=close;
      if(next.work&&next.close&&next.state==="settled")next.state=(next.close.code===0||next.close.cleanupRequested)?"closed-settled":"unknown";
      return next;
    })};},attempt.factGuard);
  }
}
