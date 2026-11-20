/** Derived from upstream title-gen; both model and rule text use this sanitizer. */
const FIRST_PERSON_LEADS=[/^我(?:们|的)?\s*/,/^帮我\s*/,/^请(?:你)?(?:帮)?我\s*/,/^(?:I|We|You|My|Our|Your)\s+(?:need to |want to |should |can |will |am |are )?/i];
export function cleanTitle(title:string):string {
 let text=title.replace(/```[\s\S]*?```/g,' ').replace(/`[^`]*`/g,' ').replace(/https?:\/\/\S+/g,' ').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim();
 for(const lead of FIRST_PERSON_LEADS)text=text.replace(lead,'');
 text=text.replace(/^["'“”「」『』]+|["'“”「」『』]+$/g,'').trim();
 if(!text||/^[\p{P}\p{S}\s]+$/u.test(text))return '';
 return text.length>20?text.slice(0,20).trimEnd()+'…':text;
}
export function suggestTitle(text:string):string|undefined {const result=cleanTitle(text);return result.length>=3?result:undefined;}
