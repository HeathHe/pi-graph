/** Policy-call quota only. Goal token accounting and M04 retry settlement remain external authorities. */
export interface BudgetFact { readonly owner:string;readonly scope:string;readonly used:number;readonly limit?:number; }
export interface BudgetFactsPort { read():readonly BudgetFact[]; }
export function createPolicyCallBudgets(){
 const scopes=new Map<string,{classification:number;advice:number}>();
 return {reserve(scope:string,kind:"classification"|"advice",limit:number):void {
  let row=scopes.get(scope);if(!row){row={classification:0,advice:0};scopes.set(scope,row);}
  if(row[kind]>=limit)throw new Error(`Policy ${kind} budget exhausted`);
  row[kind]++;
 }};
}
