/** Stop fixture writers before saving evidence; neither failure may hide the other. */
export async function cleanupThenSaveEvidence(cleanup: () => Promise<void>, saveEvidence: () => Promise<void>): Promise<void> {
 const errors: unknown[] = [];
 try { await cleanup(); } catch (error) { errors.push(error); }
 try { await saveEvidence(); } catch (error) { errors.push(error); }
 if (errors.length === 1) throw errors[0];
 if (errors.length > 1) throw new AggregateError(errors, "Fixture cleanup and evidence saving both failed");
}
