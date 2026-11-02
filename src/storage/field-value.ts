/** Read a conflict field path, including environment entries identified by name. */
export function conflictFieldValue(object: unknown, path: string): unknown {
  const parts = path.match(/\["(?:[^"\\]|\\.)*"\]|[^.[\]]+/g) ?? [];
  let value = object;
  for (const part of parts) {
    if (part.startsWith('[')) {
      const name: unknown = JSON.parse(part.slice(1, -1));
      value = Array.isArray(value)
        ? (value as unknown[]).find(
            entry =>
              !!entry &&
              typeof entry === 'object' &&
              (entry as Record<string, unknown>).name === name
          )
        : undefined;
    } else {
      value =
        value && typeof value === 'object' && Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part]
          : undefined;
    }
  }
  return value;
}
