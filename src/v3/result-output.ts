/** The same authenticated completion text must be hashed and paged. */
export function completionOutput(value:Record<string,any>):string {
 const output=value.results.map((r:Record<string,any>)=>r.finalOutput).join('\n\n');
 return output || (typeof value.error==='string'?value.error:'')
  || value.results.map((r:Record<string,any>)=>typeof r.error==='string'?r.error:'').filter(Boolean).join('\n\n')
  || (typeof value.summary==='string'?value.summary:'');
}
/** Older receipts did not include per-child failure text in their output digest. */
export function legacyCompletionOutput(value:Record<string,any>):string {
 return value.results.map((r:Record<string,any>)=>r.finalOutput).join('\n\n')
  || (typeof value.error==='string'?value.error:typeof value.summary==='string'?value.summary:'');
}
