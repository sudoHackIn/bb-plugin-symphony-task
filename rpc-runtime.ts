// `defineRpcContract` is an identity helper. Keeping the identity local lets
// the official Tasks contract live in a standalone plugin package, where the
// monorepo-only `@bb/plugin-sdk` runtime package is not installed.
export function defineRpcContract<const Contract>(contract: Contract): Contract {
  return contract;
}
