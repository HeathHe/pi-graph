import type { TodoSourceAvailability } from "./todo-snapshot.ts";
import { tuiT } from "./tui-i18n.ts";
export function todoAvailabilityLabel(value: TodoSourceAvailability | undefined): string | undefined {
	return value === "unavailable" ? tuiT("todo.source.unavailable")
		: value === "unsupported" ? tuiT("todo.source.unsupported") : undefined;
}
