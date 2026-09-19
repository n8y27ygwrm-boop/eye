export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".")) {
    if (!/\.[a-zA-Z0-9]+$/.test(specifier)) {
      try {
        return await nextResolve(specifier + ".ts", context)
      } catch (e) {
        // Fall back to default
      }
    }
  }
  return nextResolve(specifier, context)
}
