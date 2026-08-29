// Resolve hook for proof-131455.mjs: redirects subagent-control-messaging.ts's
// import of the generic gateway transport (gateway/call.js) to a recording
// shim while every other module keeps the real one.
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "../../../gateway/call.js" &&
    context.parentURL?.includes("subagent-control-messaging")
  ) {
    const shim = new URL("./proof-131455-call-shim.mjs", import.meta.url);
    return { url: shim.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
