/** Task-specific compatibility facade. Task provider registration and ALS remain in commands. */
import { createAggregateSourceOwner } from "../persistence-recovery/aggregate-source-owner.ts";
export { AggregatePublicationUnconfirmedError as TodoPublicationUnconfirmedError } from "../persistence-recovery/aggregate-source-owner.ts";
export function createTodoSourceOwner() {
  return createAggregateSourceOwner("pi-graph-next:todo-state", "Todo");
}
