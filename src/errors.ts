// `catch (err)` is unknown: the message of whatever was thrown.
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
