import { graphql, getIntrospectionQuery } from "graphql";
import { schema } from "./schema.js";
import { makeRoot, type GraphQLDataSource } from "./resolvers.js";

export { schema } from "./schema.js";
export type { GraphQLDataSource } from "./resolvers.js";

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute a GraphQL request against the Cred402 read surface. */
export async function executeGraphQL(src: GraphQLDataSource, req: GraphQLRequest) {
  return graphql({
    schema,
    source: req.query,
    rootValue: makeRoot(src),
    variableValues: req.variables,
    operationName: req.operationName,
  });
}

/** The introspection query string (for tooling / a GET handler). */
export const introspectionQuery = getIntrospectionQuery();
