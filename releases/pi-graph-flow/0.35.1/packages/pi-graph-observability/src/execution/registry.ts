import type { ObservationProvider } from './contracts.ts';
export class ObservationRegistry<D = unknown> {
 private readonly providers = new Map<string,ObservationProvider<D>>();
 register(provider:ObservationProvider<D>):()=>void { if (!provider.kind.trim()) throw new Error('Observation provider kind must not be empty.'); this.providers.set(provider.kind,provider); return ()=>{if(this.providers.get(provider.kind)===provider)this.providers.delete(provider.kind);}; }
 get(kind:string):ObservationProvider<D>|undefined{return this.providers.get(kind);}
 list():ObservationProvider<D>[]{return [...this.providers.values()];}
}
