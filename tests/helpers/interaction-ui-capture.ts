import assert from "node:assert/strict";

/** Real extension command / Inspector callbacks; only native terminal I/O is simulated. */
export function interactionUiCapture(scripts: string[][], options: {
 stepDelayMs?:number;
 afterStep?: (step:{key:string;before:string;read:()=>string})=>Promise<void>;
 input?: (index:number, title:string, placeholder?:string) => Promise<string|undefined>|string|undefined;
 confirm?: (index:number, title:string, message:string) => Promise<boolean>|boolean;
} = {}) {
 const trace: Array<{kind:string; [key:string]:unknown}> = [];
 let overlayOpen=false, inputCount=0, confirmCount=0, customCount=0;
 const theme={fg:(_color:string,text:string)=>text,bg:(_color:string,text:string)=>text,bold:(text:string)=>text,italic:(text:string)=>text,underline:(text:string)=>text};
 const ui:any={
  notify(text:string,level?:string){trace.push({kind:"notify",text,level});},
  setStatus(){},setWidget(){},setWorkingMessage(){},
  async input(title:string,placeholder?:string){assert.equal(overlayOpen,false,"native input must follow overlay close");trace.push({kind:"input",title,placeholder});return options.input?.(inputCount++,title,placeholder);},
  async confirm(title:string,message:string){assert.equal(overlayOpen,false,"native confirm must follow overlay close");trace.push({kind:"confirm",title,message});return options.confirm?.(confirmCount++,title,message)??false;},
  async select(_title:string,choices:string[]){return choices[0];},
  async custom(factory:any,customOptions:any){
   assert.equal(overlayOpen,false,"overlays must not stack");overlayOpen=true;
   const script=scripts[customCount++]??["q"];
   trace.push({kind:"overlay-open",options:customOptions});
   let resolved=false,value:unknown;
   const component=await factory({terminal:{rows:40,columns:120},requestRender(){}},theme,undefined,(result:unknown)=>{assert.equal(resolved,false,"overlay done must occur once");resolved=true;value=result;overlayOpen=false;trace.push({kind:"overlay-close",value:result});});
   try{
    for(const key of script){const before=component.render(10000).join("\n");trace.push({kind:"render",text:component.render(120).join("\n")});component.handleInput(key);await options.afterStep?.({key,before,read:()=>component.render(10000).join("\n")});await new Promise(resolve=>setTimeout(resolve,options.stepDelayMs??0));}
    assert.ok(resolved,"script must close actual Inspector overlay");return value;
   }finally{component.dispose?.();overlayOpen=false;}
  },
 };
 return {ui,trace,get inputCount(){return inputCount;},get confirmCount(){return confirmCount;},get customCount(){return customCount;}};
}
