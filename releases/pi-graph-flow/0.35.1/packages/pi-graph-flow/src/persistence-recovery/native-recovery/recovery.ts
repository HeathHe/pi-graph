import { randomUUID } from "node:crypto";
import { fingerprint, sameInput, type RecoveryContract, type RecoveryHead, type RestoredClosedExecution, type OutputAssociation } from "./contracts.ts";
import type { NativeRecoveryStore } from "./sqlite-store.ts";

export class ClosedSettlementRecovery {
  readonly #issued=new Map<string,{descriptor:RestoredClosedExecution;guard:()=>void}>();
  constructor(readonly store:NativeRecoveryStore){}
  claim(contract:RecoveryContract,guard:()=>void,outputChain?:readonly RecoveryContract[],ownerGuard:()=>void=guard):RestoredClosedExecution {
    const claimId=randomUUID(),ownerId=randomUUID();let associationId:string|undefined;
    const [head]=this.store.transact([contract.taskId],([old])=>{
      if(!old || old.state!=="closed-settled" || !old.executed || !old.work || !old.close || !old.candidate?.invocationId
        || old.work.exitCode!==0 || old.work.terminalStatus!=="completed" || (old.close.code!==0&&!old.close.cleanupRequested)
        || !sameInput(old.executed,contract) || !sameInput(old.contract,contract) || old.contract.version>contract.version)throw new Error("settlement-unknown: latest visible-slot head is not matching closed settled work");
      associationId=old.associationId;
      const associations:OutputAssociation[]=[];
      if(old.contract.digest!==contract.digest || old.contract.version!==contract.version){
        const chain=outputChain??[];let previous=old.contract;
        for(const item of chain){if(!sameInput(old.executed,item)||item.version!==previous.version+1||item.digest===previous.digest)throw new Error("Native recovery output-only transition chain is incomplete/reopened/reverted");previous=item;}
        if(previous.digest!==contract.digest||previous.version!==contract.version)throw new Error("Native recovery output association missing");
        associationId=randomUUID();associations.push({id:associationId,kind:"current-root-rechecked-output-only",executed:old.executed,reviewed:contract,transitionDigest:fingerprint(chain)});
      }
      return {heads:[{...old,revision:old.revision+1,ownerGeneration:old.ownerGeneration+1,ownerId,contract,...(associationId?{associationId}:{}),claim:{id:claimId,source:contract.source,...(associationId?{associationId}:{})}}],associations};
    },guard);
    const h=head!;
    const descriptor:RestoredClosedExecution={kind:"restored-closed",slot:h.slot,revision:h.revision,ownerGeneration:h.ownerGeneration,claimId,
      taskInstanceId:contract.instanceId,executedContractVersion:h.executed!.version,executedContractDigest:h.executed!.digest,
      reviewedContractVersion:contract.version,reviewedContractDigest:contract.digest,inputDigest:contract.inputDigest,nativeInvocationId:h.candidate!.invocationId!,work:h.work!,close:h.close!,...(associationId?{associationId}:{})};
    this.#issued.set(claimId,{descriptor,guard:ownerGuard});return structuredClone(descriptor);
  }
  assert(descriptor:RestoredClosedExecution,contract:RecoveryContract):void {
    const issued=this.#issued.get(descriptor.claimId);if(!issued||fingerprint(issued.descriptor)!==fingerprint(descriptor))throw new Error("Native restoration is not currently host-issued");issued.guard();
    const head=this.store.read(descriptor.slot);
    if(!head||head.revision!==descriptor.revision||head.ownerGeneration!==descriptor.ownerGeneration||head.claim?.id!==descriptor.claimId
      ||head.state!=="closed-settled"||head.contract.instanceId!==contract.instanceId||head.contract.version!==contract.version||head.contract.digest!==contract.digest||!sameInput(head.contract,contract))throw new Error("Native restoration/source/contract/high-water changed");
  }
}
