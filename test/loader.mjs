import path from "node:path"
import { pathToFileURL } from "node:url"

export async function resolve(specifier, context, nextResolve) {
  let target = specifier
  if (target === "next/headers" || target === "next/server") {
    target = target + ".js"
  } else if (target.startsWith("@/")) {
    const relativePath = target.slice(2)
    const absolutePath = path.resolve(process.cwd(), relativePath)
    target = pathToFileURL(absolutePath).href
  }

  if (target.startsWith(".") || target.startsWith("file://")) {
    if (!/\.[a-zA-Z0-9]+$/.test(target)) {
      try {
        return await nextResolve(target + ".ts", context)
      } catch (e) {
        try {
          return await nextResolve(target + ".tsx", context)
        } catch (e2) {
          // Fall back to default
        }
      }
    }
  }
  return nextResolve(target, context)
}
