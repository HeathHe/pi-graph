#!/usr/bin/env node
import { readRoutingObservations, routingObservationLogPath, summarizeRoutingObservations } from "../src/model-routing/observations.ts";

function valueAfter(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const path = valueAfter("--path");
const minimumValue = valueAfter("--minimum");
const minimumComparableSamples = minimumValue === undefined ? 10 : Number.parseInt(minimumValue, 10);
if (!Number.isInteger(minimumComparableSamples) || minimumComparableSamples < 1) {
	throw new Error("--minimum must be a positive integer");
}
const options = path ? { path } : {};
const observations = await readRoutingObservations(options);
const summary = summarizeRoutingObservations(observations, { minimumComparableSamples });
console.log(JSON.stringify({
	observationPath: routingObservationLogPath(options),
	minimumComparableSamples,
	...summary,
}, null, 2));
