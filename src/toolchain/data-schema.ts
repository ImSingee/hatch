/** Output contract of the Data Table schema evaluator, for both toolchains. */
export const DATA_SCHEMA_SENTINEL = '[[hatch-data-schema]]';

/** Return the descriptor JSON text an evaluator printed after the sentinel. */
export function dataSchemaFromOutput(output: string): string {
  const line = output
    .split('\n')
    .find((value) => value.startsWith(DATA_SCHEMA_SENTINEL));
  if (!line) {
    throw new Error('Data Table schema did not produce a descriptor.');
  }
  return line.slice(DATA_SCHEMA_SENTINEL.length);
}
