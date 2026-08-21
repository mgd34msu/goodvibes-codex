/**
 * Static spec-vs-routes comparison for `api_validate`.
 *
 * This validation is entirely static. It never issues live HTTP requests,
 * because probing a running server needs credentials, and credentials are
 * connect's trust model rather than intel's.
 *
 * It compares the OpenAPI spec's declared paths, methods and path parameters
 * against the routes `api_routes` found in source. Every issue carries a
 * `json_path` pointing into the spec DOCUMENT, for example
 * `$.paths['/api/users/{id}'].get`, rather than into a response body.
 *
 * Scope is deliberately route, method and path-parameter existence, NOT a
 * request/response body schema diff. Regex-based schema inference would produce
 * false positives if used as a hard mismatch signal, and the bar here is zero
 * false alarms on correct routes, which a deterministic structural comparison
 * holds more easily.
 *
 * @module lib/api/validate-static
 */

import type { ApiRoute, OpenApiSpecForValidation, ValidationIssue } from './types.js';
import { convertRoutePathToOpenApi } from './openapi.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/** Replace every `{param}` segment with a placeholder so paths compare by shape, not param names. */
function toCanonicalPath(openApiPath: string): string {
  return openApiPath.replace(/\{[^}]+\}/g, '{param}');
}

/** Extract `{param}` names, in order of appearance. */
function extractParamNames(openApiPath: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(openApiPath)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/** JSONPath bracket-quote form for a spec path key (may contain `/`, `{`, `}`). */
function jsonPathForSpecPath(specPath: string): string {
  return `$.paths['${specPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

interface SpecEntry {
  specPath: string;
  params: string[];
}
interface RouteEntry {
  routePath: string;
  params: string[];
}

/**
 * Compare parsed routes against a loaded OpenAPI spec. Reports:
 *  - `missing_route`: the spec declares a path+method with no matching route implementation.
 *  - `undocumented_route`: a route is implemented but absent from the spec.
 *  - `parameter_mismatch`: the path exists in both but path-parameter names differ.
 *
 * @param routes - routes discovered by `scanFrameworkRoutes` (framework-native path syntax)
 * @param spec - the loaded OpenAPI/Swagger spec (already parsed from JSON/YAML)
 */
export function validateRoutesAgainstSpec(
  routes: ApiRoute[],
  spec: OpenApiSpecForValidation
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const specEntries = new Map<string, Map<string, SpecEntry>>();
  for (const [specPath, pathItem] of Object.entries(spec.paths ?? {})) {
    const canonical = toCanonicalPath(specPath);
    const params = extractParamNames(specPath);
    let methodMap = specEntries.get(canonical);
    if (!methodMap) {
      methodMap = new Map();
      specEntries.set(canonical, methodMap);
    }
    const item = pathItem as unknown as Record<string, unknown>;
    for (const method of METHODS) {
      if (item[method]) {
        methodMap.set(method.toUpperCase(), { specPath, params });
      }
    }
  }

  const routeEntries = new Map<string, Map<string, RouteEntry>>();
  for (const route of routes) {
    const openApiPath = convertRoutePathToOpenApi(route.path);
    const canonical = toCanonicalPath(openApiPath);
    const params = extractParamNames(openApiPath);
    let methodMap = routeEntries.get(canonical);
    if (!methodMap) {
      methodMap = new Map();
      routeEntries.set(canonical, methodMap);
    }
    methodMap.set(route.method.toUpperCase(), { routePath: route.path, params });
  }

  const allCanonicalPaths = new Set<string>([...specEntries.keys(), ...routeEntries.keys()]);

  for (const canonical of allCanonicalPaths) {
    const specMethods = specEntries.get(canonical) ?? new Map<string, SpecEntry>();
    const routeMethods = routeEntries.get(canonical) ?? new Map<string, RouteEntry>();
    const allMethods = new Set<string>([...specMethods.keys(), ...routeMethods.keys()]);

    for (const method of allMethods) {
      const specEntry = specMethods.get(method);
      const routeEntry = routeMethods.get(method);

      if (specEntry && !routeEntry) {
        issues.push({
          path: specEntry.specPath,
          method,
          type: 'missing_route',
          message: `Spec declares ${method} ${specEntry.specPath} but no matching route implementation was found.`,
          json_path: `${jsonPathForSpecPath(specEntry.specPath)}.${method.toLowerCase()}`,
          expected: `${method} ${specEntry.specPath}`,
          actual: null,
        });
      } else if (!specEntry && routeEntry) {
        issues.push({
          path: routeEntry.routePath,
          method,
          type: 'undocumented_route',
          message: `Route ${method} ${routeEntry.routePath} is implemented but not declared in the spec.`,
          json_path: '$.paths',
          expected: null,
          actual: `${method} ${routeEntry.routePath}`,
        });
      } else if (specEntry && routeEntry) {
        const specParams = specEntry.params;
        const routeParams = routeEntry.params;
        const mismatch =
          specParams.length !== routeParams.length ||
          specParams.some((name, i) => name !== routeParams[i]);
        if (mismatch) {
          issues.push({
            path: specEntry.specPath,
            method,
            type: 'parameter_mismatch',
            message:
              `Path parameter names differ between spec (${specParams.join(', ') || '(none)'}) and route ` +
              `implementation (${routeParams.join(', ') || '(none)'}) for ${method} ${specEntry.specPath}.`,
            json_path: `${jsonPathForSpecPath(specEntry.specPath)}.${method.toLowerCase()}.parameters`,
            expected: specParams,
            actual: routeParams,
          });
        }
      }
    }
  }

  issues.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method) ||
      a.type.localeCompare(b.type)
  );
  return issues;
}
