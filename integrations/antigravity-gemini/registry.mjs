import { readLocalBindings } from './local-bindings.mjs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workerConfigDigest } from './runtime-version.mjs';
import { runtimeConfig } from './runtime-config.mjs';
import { AppConfigWriterError, writeAppConfigTarget } from './app-config-writer.mjs';

const provider = 'antigravity-agentapi';
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sidecarPattern = /^[a-z0-9][a-z0-9_-]*$/i;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export class RegistryError extends Error {
  constructor(code, stage, message, next_action, details = {}) {
    super(message);
    this.name = 'RegistryError';
    Object.assign(this, { code, stage, next_action, ...details });
  }
}

function fail(code, stage, message, next_action, details) {
  throw new RegistryError(code, stage, message, next_action, details);
}

function asRegistryError(error, stage) {
  if (error instanceof RegistryError) return error;
  if (error instanceof AppConfigWriterError) {
    return new RegistryError(error.code, error.stage, error.message, error.next_action,
      Object.fromEntries(Object.entries(error).filter(([key]) => !['name', 'stage', 'next_action', 'code'].includes(key))));
  }
  return new RegistryError(
    'registry_io_error', stage,
    error?.message || String(error),
    'Check the affected local path and retry after resolving the filesystem error.',
    { cause_code: error?.code },
  );
}

function publicError(error) {
  const e = asRegistryError(error, 'catalog');
  return { code: e.code, stage: e.stage, message: e.message, next_action: e.next_action };
}

function normalizePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    fail('invalid_path', 'input_validation', `${label} must be an absolute local path.`, 'Pass an absolute local filesystem path.');
  }
  return path.resolve(value);
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function realDirectory(value, label) {
  const absolute = normalizePath(value, label);
  let real;
  try {
    real = await fs.realpath(absolute);
    if (!(await fs.stat(real)).isDirectory()) throw new Error('Path is not a directory.');
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    fail('workspace_not_found', 'path_resolution', `${label} cannot be resolved to an existing directory: ${absolute}`, 'Pass an existing directory and retry.', { path: absolute });
  }
  return real;
}

async function readOptionalBytes(file, stage) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('registry_target_not_regular_file', stage, `Expected a regular file at ${file}.`, 'Resolve the target path without a symlink or directory.');
    }
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson(bytes, file, stage, code = 'registry_json_invalid') {
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(code, stage, `Invalid JSON in ${file}: ${error.message}`, 'Repair the JSON file without discarding unrelated fields.');
  }
}

function emptyManifest() {
  return { version: 1, bindings: [] };
}

function validateManifest(value, file) {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.bindings)) {
    fail('manifest_schema_unsupported', 'manifest_read', `Manifest must retain version: 1 and a bindings array: ${file}`, 'Restore the v1 manifest envelope before connecting.');
  }
  if (value.routes_v3 !== undefined && !Array.isArray(value.routes_v3)) {
    fail('manifest_schema_unsupported', 'manifest_read', `Manifest routes_v3 must be an array when present: ${file}`, 'Repair routes_v3 or preserve the existing v1 bindings separately.');
  }
  return value;
}

function validateAppConfig(value, file) {
  if (!isRecord(value)) fail('app_config_schema_unsupported', 'app_config_read', `App config must be a JSON object: ${file}`, 'Repair config.json while preserving unrelated settings.');
  if (value.sidecars !== undefined && !isRecord(value.sidecars)) {
    fail('app_config_schema_unsupported', 'app_config_read', `App config sidecars must be an object: ${file}`, 'Repair the sidecars object while preserving unrelated settings.');
  }
  return value;
}

function decodeFileUri(uri, file, index) {
  let parsed;
  try { parsed = new URL(uri); }
  catch { fail('catalog_schema_unsupported', 'catalog_resources', `Project resource ${index} in ${file} has an invalid folder URI.`, 'Check the project resource URI and use a local file URI.'); }
  if (parsed.protocol !== 'file:' || parsed.search || parsed.hash || (parsed.hostname && parsed.hostname !== 'localhost')) {
    fail('catalog_schema_unsupported', 'catalog_resources', `Project resource ${index} in ${file} is not a local file URI.`, 'Use only local folder resources in this registry.');
  }
  try { return fileURLToPath(parsed); }
  catch (error) {
    fail('catalog_schema_unsupported', 'catalog_resources', `Project resource ${index} in ${file} cannot be decoded: ${error.message}`, 'Check percent-encoding and the local file URI.');
  }
}

function resourceShape(resource, file, index) {
  if (!isRecord(resource)) {
    fail('catalog_schema_unsupported', 'catalog_resources', `Project resource ${index} in ${file} is not an object.`, 'Inspect the project resource and add support only for a documented local shape.');
  }
  if (Object.hasOwn(resource, 'gitFolder')) {
    if (isRecord(resource.gitFolder) && typeof resource.gitFolder.folderUri === 'string') {
      return { kind: 'gitFolder', uri: resource.gitFolder.folderUri, shape_status: 'verified', source: 'local_app_project_fixture' };
    }
    fail('catalog_schema_unsupported', 'catalog_resources', `Project resource ${index} in ${file} has a malformed gitFolder shape.`, 'Inspect the App project JSON and preserve the complete resource definition.');
  }
  // The official docs confirm Local Folders as a resource category, but do not
  // publish its project-JSON wrapper. Keep these observed candidates explicit.
  if (Object.hasOwn(resource, 'localFolder')) {
    if (isRecord(resource.localFolder) && typeof resource.localFolder.folderUri === 'string') {
      return { kind: 'localFolder', uri: resource.localFolder.folderUri, shape_status: 'unverified', source: 'recognized_local_serialization_candidate' };
    }
    fail('catalog_schema_unsupported', 'catalog_resources', `Project resource ${index} in ${file} has a malformed localFolder candidate shape.`, 'Inspect the local folder serialization before using it.');
  }
  if (typeof resource.folderUri === 'string') {
    return { kind: 'localFolder', uri: resource.folderUri, shape_status: 'unverified', source: 'recognized_direct_folder_uri_candidate' };
  }
  fail('catalog_schema_unsupported', 'catalog_resources', `Project resource ${index} in ${file} has an unknown shape.`, 'Inspect the App project JSON and add only a verified or explicitly identified local resource shape.');
}

async function normalizeResourceRoots(project, file) {
  const resources = project.projectResources?.resources;
  if (Array.isArray(resources) && resources.length === 0) return [];
  if (isRecord(project.projectResources) && Object.keys(project.projectResources).length === 0) return [];
  if (!Array.isArray(resources)) {
    fail('catalog_schema_unsupported', 'catalog_resources', `Project ${project.id || '(missing id)'} in ${file} has no supported resources array.`, 'Inspect the App project JSON; do not infer a folder from its name.');
  }
  const roots = [];
  for (let i = 0; i < resources.length; i += 1) {
    const shape = resourceShape(resources[i], file, i);
    const sourcePath = decodeFileUri(shape.uri, file, i);
    let real;
    try {
      real = await fs.realpath(sourcePath);
      if (!(await fs.stat(real)).isDirectory()) throw new Error('Resource is not a directory.');
    } catch (error) {
      fail('catalog_resource_unavailable', 'catalog_resources', `Project resource ${i} in ${file} does not resolve to an existing directory: ${sourcePath}`, 'Restore the local folder or update the App project resource before connecting.', { resource_path: sourcePath, cause_code: error?.code });
    }
    roots.push({
      kind: shape.kind,
      path: real,
      uri: pathToFileURL(real).href,
      shape_status: shape.shape_status,
      source: shape.source,
    });
  }
  return roots;
}

function toRouteRoots(roots) {
  return roots.map(({ kind, path: rootPath, uri }) => ({ kind, path: rootPath, uri }))
    .sort((a, b) => compareRoot(a, b));
}

function compareText(left, right) {
  const a = process.platform === 'win32' ? left.toLowerCase() : left;
  const b = process.platform === 'win32' ? right.toLowerCase() : right;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRoot(left, right) {
  return compareText(left.path, right.path) || compareText(left.kind, right.kind);
}

function rootSetKey(roots) {
  return roots.map(root => ({ kind: root.kind, path: path.resolve(root.path) }))
    .sort(compareRoot)
    .map(root => `${process.platform === 'win32' ? root.path.toLowerCase() : root.path}\0${root.kind}`);
}

function assertStableRootSet(existingRoute, roots) {
  if (!existingRoute) return;
  const oldSet = rootSetKey(existingRoute.workspace_roots ?? []);
  const newSet = rootSetKey(roots);
  if (equalJson(oldSet, newSet)) return;
  fail('route_workspace_migration_required', 'manifest_plan',
    `The App project resource-root set changed for existing route ${existingRoute.route_id}; its task state remains at ${existingRoute.state_root}.`,
    'Keep the existing resource set or perform an explicit state migration before reconnecting; connect will not move queued tasks.',
    { route_id: existingRoute.route_id, existing_root_count: oldSet.length, requested_root_count: newSet.length });
}

async function readProjects(projectsDir) {
  let names;
  try { names = await fs.readdir(projectsDir); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const projects = [];
  const warnings = [];
  for (const name of names.filter(name => name.toLowerCase().endsWith('.json')).sort()) {
    const file = path.join(projectsDir, name);
    let value;
    try {
      const bytes = await readOptionalBytes(file, 'catalog_project_read');
      if (bytes === null) continue;
      value = parseJson(bytes, file, 'catalog_project_read', 'catalog_project_invalid');
      if (!isRecord(value) || typeof value.id !== 'string' || !uuidPattern.test(value.id)) {
        fail('catalog_schema_unsupported', 'catalog_project_read', `Project JSON ${file} has no supported UUID id.`, 'Use an existing App project file with its actual project ID; do not guess by name.');
      }
      projects.push({ project_id: value.id, name: typeof value.name === 'string' ? value.name : undefined, file, resource_roots: await normalizeResourceRoots(value, file) });
    } catch (error) {
      const e = asRegistryError(error, 'catalog_project_read');
      warnings.push({ project_id: typeof value?.id === 'string' && uuidPattern.test(value.id) ? value.id : null,
        name: typeof value?.name === 'string' ? value.name : null, file, code: e.code, stage: e.stage,
        message: e.message, next_action: e.next_action });
    }
  }
  return { projects, warnings, completeness: warnings.length === 0 ? 'complete' : 'partial' };
}

async function readProjectById(projectsDir, projectId) {
  const file = path.join(projectsDir, `${projectId}.json`);
  const bytes = await readOptionalBytes(file, 'catalog_project_read');
  if (bytes === null) fail('app_project_not_found', 'project_resolution', `No App project JSON exists for ID ${projectId}.`, 'Pass the actual ID of an existing App project; this registry never creates projects.');
  const value = parseJson(bytes, file, 'catalog_project_read', 'catalog_project_invalid');
  if (!isRecord(value) || typeof value.id !== 'string' || !uuidPattern.test(value.id) || value.id.toLowerCase() !== projectId.toLowerCase()) {
    fail('catalog_schema_unsupported', 'catalog_project_read', `The project file selected by ID ${projectId} has an unsupported or mismatched identity.`, 'Inspect the exact App project JSON ID before connecting.');
  }
  return { project_id: value.id, name: typeof value.name === 'string' ? value.name : undefined,
    file, resource_roots: await normalizeResourceRoots(value, file) };
}

function readRoutes(manifestBytes, manifestPath) {
  const manifest = validateManifest(parseJson(manifestBytes, manifestPath, 'manifest_read') ?? emptyManifest(), manifestPath);
  const routes = manifest.routes_v3 ?? [];
  for (const route of routes) {
    if (!isRecord(route) || typeof route.route_id !== 'string' || route.provider !== provider ||
        typeof route.project_id !== 'string' || !uuidPattern.test(route.project_id) ||
        typeof route.sidecar_id !== 'string' || !sidecarPattern.test(route.sidecar_id) ||
        !Array.isArray(route.workspace_roots) || typeof route.state_root !== 'string' || typeof route.sidecar_root !== 'string') {
      fail('manifest_schema_unsupported', 'manifest_read', `Manifest contains an unsupported routes_v3 entry: ${manifestPath}`, 'Repair the v3 route entry or preserve it for manual review.');
    }
    if (route.default_model !== undefined && (!isRecord(route.default_model) || typeof route.default_model.id !== 'string' || !modelIdPattern.test(route.default_model.id) ||
        typeof route.default_model.source !== 'string' || !route.default_model.source.trim() || typeof route.default_model.configured_at !== 'string' || !Number.isFinite(Date.parse(route.default_model.configured_at)))) {
      fail('manifest_schema_unsupported', 'manifest_read', `Manifest route ${route.route_id} has an unsupported default_model shape: ${manifestPath}`, 'Repair the explicit model id, source, and configured_at fields; no fallback model will be selected.');
    }
    if (route.workspace_roots.some(root => !isRecord(root) || typeof root.kind !== 'string' || !root.kind || typeof root.path !== 'string' || !path.isAbsolute(root.path) || typeof root.uri !== 'string')) {
      fail('manifest_schema_unsupported', 'manifest_read', `Manifest route ${route.route_id} has an unsupported workspace root entry: ${manifestPath}`, 'Repair workspace_roots to contain explicit local kind, absolute path, and URI values.');
    }
  }
  return { manifest, routes };
}

async function assertNoLegacyOwnerConflict(manifest, route, manifestPath) {
  for (const [index, binding] of (manifest.bindings ?? []).entries()) {
    if (!isRecord(binding) || typeof binding.project_id !== 'string' || !uuidPattern.test(binding.project_id) ||
        typeof binding.workspace_root !== 'string' || !path.isAbsolute(binding.workspace_root) ||
        typeof binding.sidecar_root !== 'string' || !path.isAbsolute(binding.sidecar_root) ||
        typeof binding.conversation_id !== 'string' || !uuidPattern.test(binding.conversation_id) ||
        (binding.sidecar_id !== undefined && (typeof binding.sidecar_id !== 'string' || !sidecarPattern.test(binding.sidecar_id)))) {
      fail('legacy_binding_schema_unsupported', 'manifest_read', `Manifest legacy binding ${index} has an unsupported shape: ${manifestPath}`, 'Repair the existing v1 binding or resolve it manually before adding an overlapping v3 route.');
    }
    if (binding.project_id === route.project_id || binding.sidecar_id === route.sidecar_id) {
      fail('legacy_route_owner_conflict', 'manifest_plan', `The App project or Sidecar ID is already owned by a legacy binding: ${manifestPath}`, 'Migrate or resolve the existing legacy route and its task state before registering this v3 route.');
    }
    try {
      const legacyRoot = await fs.realpath(binding.workspace_root);
      if (route.workspace_roots.some(root => samePath(legacyRoot, root.path))) {
        fail('legacy_route_workspace_conflict', 'manifest_plan', `A legacy binding already owns one of the requested workspace roots: ${legacyRoot}`, 'Inspect and migrate the existing route and its runtime/job state before registering a v3 route for this root.');
      }
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function assertNoV3RouteConflict(routes, route, manifestPath) {
  const wantedRoots = route.workspace_roots.map(root => root.path);
  for (const existing of routes) {
    const sameOwner = existing.project_id === route.project_id && existing.sidecar_id === route.sidecar_id;
    if (sameOwner) continue;
    if (existing.sidecar_id === route.sidecar_id) {
      fail('route_sidecar_owner_conflict', 'manifest_plan', `Sidecar ${route.sidecar_id} is already owned by another v3 project in ${manifestPath}.`, 'Resolve the existing App Sidecar owner before connecting another project.');
    }
    for (const root of existing.workspace_roots ?? []) {
      if (!isRecord(root) || typeof root.path !== 'string' || !path.isAbsolute(root.path)) continue;
      try {
        const real = await fs.realpath(root.path);
        if (wantedRoots.some(target => samePath(real, target))) {
          fail('route_workspace_conflict', 'manifest_plan', `A different v3 route already owns workspace root ${real}.`, 'Resolve the existing route for this workspace before connecting another App project; calls are routed by exact cwd.');
        }
      } catch (error) {
        if (error instanceof RegistryError) throw error;
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function routeRootsMatch(route, cwdReal) {
  for (const root of route.workspace_roots) {
    if (!isRecord(root) || typeof root.path !== 'string' || !path.isAbsolute(root.path)) continue;
    try {
      const real = await fs.realpath(root.path);
      if (samePath(real, cwdReal)) return true;
    } catch { /* A missing route root is stale, not a match. */ }
  }
  return false;
}

function routeSemantic(route) {
  const result = {
    route_id: route.route_id,
    provider: route.provider,
    project_id: route.project_id,
    sidecar_id: route.sidecar_id,
    workspace_roots: route.workspace_roots,
    state_root: route.state_root,
    sidecar_root: route.sidecar_root,
  };
  if (route.default_model !== undefined) result.default_model = route.default_model;
  return result;
}

function equalJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function targetSummary(name, file, before, after, diff) {
  return {
    name,
    path: file,
    baseline_sha256: before === null ? null : sha(before),
    target_sha256: sha(after),
    target_bytes: after.length,
    changed: before === null || !before.equals(after),
    diff,
  };
}

function buildManifestTarget(before, file, route, sidecarId) {
  const manifest = validateManifest(parseJson(before, file, 'manifest_read') ?? emptyManifest(), file);
  const routes = manifest.routes_v3 ?? [];
  const owners = routes.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.project_id === route.project_id && entry.sidecar_id === sidecarId);
  if (owners.length > 1) {
    fail('route_owner_ambiguous', 'manifest_plan', 'More than one v3 route already has this project and sidecar owner.', 'Resolve duplicate route owners manually; no route was rewritten.');
  }
  const idx = owners[0]?.index;
  const existing = idx === undefined ? null : routes[idx];
  const desired = { ...(existing ?? {}), ...route };
  if (existing?.default_model && route.default_model === undefined) desired.default_model = existing.default_model;
  const exact = existing !== null && equalJson(routeSemantic(existing), routeSemantic(desired));
  if (exact) return { bytes: before, route: existing, diff: { operation: 'unchanged', route_id: existing.route_id } };
  const next = { ...manifest, routes_v3: [...routes] };
  if (idx === undefined) next.routes_v3.push(desired);
  else next.routes_v3[idx] = desired;
  return {
    bytes: jsonBytes(next),
    route: desired,
    diff: { operation: idx === undefined ? 'add' : 'update', route_id: desired.route_id, before: existing ? routeSemantic(existing) : null, after: routeSemantic(desired) },
  };
}

function buildAppConfigTarget(before, file, sidecarId, projectId, { allowProjectRebind = false } = {}) {
  const config = validateAppConfig(parseJson(before, file, 'app_config_read') ?? {}, file);
  const currentSidecar = config.sidecars?.[sidecarId];
  if (currentSidecar !== undefined && !isRecord(currentSidecar)) {
    fail('app_sidecar_conflict', 'app_config_plan', `App config sidecars.${sidecarId} is not an object.`, 'Resolve the existing App sidecar entry manually; no existing entry was overwritten.');
  }
  if (currentSidecar?.projectId !== undefined && currentSidecar.projectId !== projectId && !allowProjectRebind) {
    fail('app_sidecar_conflict', 'app_config_plan', `App sidecar ${sidecarId} already belongs to a different project.`, 'Inspect the existing projectId and resolve the ownership conflict manually.');
  }
  const registration = { ...(currentSidecar ?? {}), enabled: true, projectId };
  if (currentSidecar?.enabled === true && currentSidecar?.projectId === projectId) {
    return { bytes: before, registration: currentSidecar, allow_project_rebind: allowProjectRebind,
      intent: { sidecar_id: sidecarId, project_id: projectId, fields: { enabled: true, projectId } },
      diff: { operation: 'unchanged', sidecar_id: sidecarId, enabled: true, project_id: projectId } };
  }
  const next = { ...config, sidecars: { ...(config.sidecars ?? {}), [sidecarId]: registration } };
  return {
    bytes: jsonBytes(next), registration, allow_project_rebind: allowProjectRebind,
    intent: { sidecar_id: sidecarId, project_id: projectId, fields: { enabled: true, projectId } },
    diff: { operation: currentSidecar ? 'merge' : 'add', sidecar_id: sidecarId, before: currentSidecar ? { enabled: currentSidecar.enabled, project_id: currentSidecar.projectId, preserved_unknown_fields: Object.keys(currentSidecar).filter(key => !['enabled', 'projectId']) } : null, after: { enabled: true, project_id: projectId } },
  };
}

function buildAppConfigEnabledTarget(before, file, sidecarId, projectId, enabled) {
  if (before === null) {
    fail('app_config_missing', 'app_config_plan', `The App config file is missing: ${file}`, 'Restore the existing App config before changing Sidecar enabled state.');
  }
  const config = validateAppConfig(parseJson(before, file, 'app_config_read') ?? {}, file);
  const currentSidecar = config.sidecars?.[sidecarId];
  if (!isRecord(currentSidecar)) {
    fail('app_sidecar_missing', 'app_config_plan', `The App config has no Sidecar object for ${sidecarId}.`, 'Connect the existing App project first; enabled-state changes do not create registrations.');
  }
  if (currentSidecar.projectId !== projectId) {
    fail('app_sidecar_owner_conflict', 'app_config_plan', `App Sidecar ${sidecarId} no longer points to the verified route project.`, 'Keep the registration unchanged and reconcile its projectId through an explicit connect operation.');
  }
  if (currentSidecar.enabled === enabled) {
    return { bytes: before, registration: currentSidecar,
      intent: { sidecar_id: sidecarId, project_id: projectId, fields: { enabled } },
      diff: { operation: 'unchanged', sidecar_id: sidecarId, enabled, project_id: projectId } };
  }
  const registration = { ...currentSidecar, enabled };
  const bytes = jsonBytes({ ...config, sidecars: { ...config.sidecars, [sidecarId]: registration } });
  return { bytes, registration, intent: { sidecar_id: sidecarId, project_id: projectId, fields: { enabled } },
    diff: { operation: 'update_enabled', sidecar_id: sidecarId, before: currentSidecar.enabled, after: enabled } };
}

function descriptorCoreMatches(value, expected) {
  return isRecord(value) && value.command === expected.command && Array.isArray(value.args) && equalJson(value.args, expected.args) && value.restart_policy === 'never';
}

function buildDescriptorTarget(before, file, expected) {
  if (before !== null) {
    const old = parseJson(before, file, 'descriptor_read');
    if (!descriptorCoreMatches(old, expected)) {
      fail('sidecar_descriptor_conflict', 'descriptor_plan', `The deterministic Sidecar descriptor already has different command settings: ${file}`, 'Inspect the existing descriptor and resolve the ownership conflict manually.');
    }
    return { bytes: before, descriptor: old, diff: { operation: 'unchanged', command: expected.command, args: expected.args, restart_policy: 'never' } };
  }
  return { bytes: jsonBytes(expected), descriptor: expected, diff: { operation: 'add', after: expected } };
}

function modelDefaultInput(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.id !== 'string' || !modelIdPattern.test(value.id.trim()) || typeof value.source !== 'string' || !value.source.trim()) {
    fail('model_default_invalid', 'model_validation', 'default_model must include an explicit nonempty id and source.', 'Pass default_model as { id, source }; the registry never selects a fallback model.');
  }
  return { id: value.id.trim(), source: value.source.trim(), configured_at: typeof value.configured_at === 'string' && Number.isFinite(Date.parse(value.configured_at)) ? value.configured_at : new Date().toISOString() };
}

function sameModelRequest(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return left.id === right.id && left.source === right.source;
}

function modelCandidateCatalog(route) {
  return {
    provider,
    dynamic_discovery: 'unavailable',
    default_model: route.default_model ?? null,
    models: [
      'gemini-4-argon-medium',
      'gemini-4-argon-high',
      'gemini-3.8-flash-medium',
    ].map(id => ({ id, label: id, source: 'official CLI docs', agentapi_accepted: 'unknown', account_observed: 'unknown' })),
  };
}

async function getOptionalJson(file, stage, validator) {
  const bytes = await readOptionalBytes(file, stage);
  const parsed = parseJson(bytes, file, stage);
  return { bytes, value: parsed === null ? null : validator(parsed, file) };
}

function transactionPaths(appConfigDir) {
  const directory = path.join(appConfigDir, '.codex-antigravity-registry');
  return {
    directory,
    lock: path.join(directory, 'registry.lock'),
    journalDir: path.join(directory, 'transactions'),
  };
}

async function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; if (error?.code === 'EPERM') return true; return null; }
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner = { pid: process.pid, hostname: os.hostname(), token: randomUUID(), started_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try { await handle.writeFile(jsonBytes(owner)); await handle.sync(); } finally { await handle.close(); }
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
          if (current.token === owner.token) await fs.unlink(lockPath);
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let current;
      try { current = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
      catch { fail('registry_lock_state_unknown', 'lock', 'The registry lock exists but its owner cannot be read.', 'Inspect the lock file and confirm its process has stopped before removing it.'); }
      const alive = current.hostname === os.hostname() ? await pidIsAlive(current.pid) : null;
      if (alive !== false) {
        fail('registry_locked', 'lock', 'Another registry transaction is active or its lock owner cannot be verified.', 'Wait for the current transaction or inspect its owner; do not remove a live lock.');
      }
      const latest = await fs.readFile(lockPath, 'utf8').catch(e => e?.code === 'ENOENT' ? null : Promise.reject(e));
      if (latest !== null && latest === JSON.stringify(current, null, 2) + '\n') await fs.unlink(lockPath).catch(e => { if (e?.code !== 'ENOENT') throw e; });
    }
  }
  fail('registry_locked', 'lock', 'Could not acquire the registry transaction lock.', 'Retry after the active registry transaction releases its lock.');
}

async function writeJournal(file, journal) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(jsonBytes(journal)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
}

async function archiveCompletedJournal(file, journal, expectedBytes, historyDir) {
  if (journal?.stage !== 'waiting_for_reload' || !Buffer.isBuffer(expectedBytes)) {
    fail('registry_journal_state_invalid', 'journal_archive', 'Only a completed waiting_for_reload journal can be archived before a new transaction.', 'Inspect the active journal and resume or resolve its recorded phase first.');
  }
  const archiveFile = path.join(historyDir, `${journal.sidecar_id}-${journal.transaction_id}.json`);
  const current = await readOptionalBytes(file, 'journal_archive_baseline');
  if (current === null || !current.equals(expectedBytes)) {
    fail('registry_external_edit_conflict', 'journal_archive_baseline', 'The completed registry journal changed before it could be archived.', 'Inspect the current journal and retry from the latest state; no configuration target was written.');
  }
  await fs.mkdir(historyDir, { recursive: true });
  const archivedJournal = structuredClone(journal);
  for (const target of Object.values(archivedJournal.targets ?? {})) {
    if (target.kind === 'app_config') {
      delete target.baseline_bytes_base64;
      delete target.target_bytes_base64;
      target.journal_bytes_redacted = true;
    }
  }
  const archivedBytes = jsonBytes(archivedJournal);
  try {
    const handle = await fs.open(archiveFile, 'wx');
    try { await handle.writeFile(archivedBytes); await handle.sync(); } finally { await handle.close(); }
  }
  catch (error) {
    if (error?.code === 'EEXIST') fail('registry_journal_archive_conflict', 'journal_archive', 'The historical transaction path already exists.', 'Inspect both transaction records and resolve the duplicate without overwriting history.');
    throw error;
  }
  const archived = await readOptionalBytes(archiveFile, 'journal_archive_verify');
  const latest = await readOptionalBytes(file, 'journal_archive_verify');
  if (archived === null || latest === null || !archived.equals(archivedBytes) || !latest.equals(expectedBytes)) {
    fail('registry_external_edit_conflict', 'journal_archive_verify', 'The active journal changed while it was being archived; both records were preserved for inspection.', 'Compare the archived and active journal before starting another registry transaction.');
  }
  await fs.unlink(file);
  return archiveFile;
}

async function currentHash(file) {
  const bytes = await readOptionalBytes(file, 'transaction_conflict_check');
  return bytes === null ? null : sha(bytes);
}

function hashMatches(actual, expected) {
  return actual === expected;
}

async function atomicReplace(file, bytes, baselineHash, targetHash, stage) {
  const before = await readOptionalBytes(file, `${stage}_baseline_check`);
  const actualBefore = before === null ? null : sha(before);
  if (hashMatches(actualBefore, targetHash)) return false;
  if (!hashMatches(actualBefore, baselineHash)) {
    fail('registry_external_edit_conflict', stage, `The target changed after this transaction prepared its baseline: ${file}`, 'Review the external edit and rerun connect to calculate a new baseline; no conflicting bytes were overwritten.', { path: file, expected_sha256: baselineHash, actual_sha256: actualBefore });
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const immediatelyBefore = await readOptionalBytes(file, `${stage}_write_check`);
  const current = immediatelyBefore === null ? null : sha(immediatelyBefore);
  if (hashMatches(current, targetHash)) {
    await fs.unlink(temp).catch(error => { if (error?.code !== 'ENOENT') throw error; });
    return false;
  }
  if (!hashMatches(current, baselineHash)) {
    await fs.unlink(temp).catch(error => { if (error?.code !== 'ENOENT') throw error; });
    fail('registry_external_edit_conflict', stage, `The target changed while this transaction was preparing its write: ${file}`, 'Review the external edit and rerun connect to calculate a new baseline; no conflicting bytes were overwritten.', { path: file, expected_sha256: baselineHash, actual_sha256: current });
  }
  if (baselineHash === null) {
    try { await fs.link(temp, file); }
    catch (error) {
      await fs.unlink(temp).catch(() => {});
      if (error?.code === 'EEXIST') fail('registry_external_edit_conflict', stage, `A new file appeared during this transaction: ${file}`, 'Review the new file and rerun connect to calculate a new baseline.', { path: file, expected_sha256: null, actual_sha256: await currentHash(file) });
      throw error;
    }
    await fs.unlink(temp);
  } else {
    await fs.rename(temp, file);
  }
  const after = await currentHash(file);
  if (after !== targetHash) fail('registry_write_verification_failed', stage, `The written target does not match its planned SHA-256: ${file}`, 'Keep the transaction journal and inspect the target before retrying.', { path: file, expected_sha256: targetHash, actual_sha256: after });
  return true;
}

function rebuildManifest(baselineBytes, target) {
  const file = target.path;
  const manifest = validateManifest(parseJson(baselineBytes, file, 'manifest_recovery') ?? emptyManifest(), file);
  const routes = [...(manifest.routes_v3 ?? [])];
  const indexes = routes.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.project_id === target.project_id && entry.sidecar_id === target.sidecar_id);
  if (indexes.length > 1) fail('registry_recovery_conflict', 'manifest_recovery', 'The baseline manifest has duplicate route owners.', 'Resolve duplicate project+sidecar route owners manually.');
  if (indexes.length === 0) routes.push(target.route);
  else routes[indexes[0].index] = { ...routes[indexes[0].index], ...target.route };
  return jsonBytes({ ...manifest, routes_v3: routes });
}

function rebuildAppConfig(baselineBytes, target) {
  const file = target.path;
  const config = validateAppConfig(parseJson(baselineBytes, file, 'app_config_recovery') ?? {}, file);
  const old = config.sidecars?.[target.sidecar_id];
  if (old !== undefined && !isRecord(old)) fail('registry_recovery_conflict', 'app_config_recovery', 'The baseline target Sidecar entry is not an object.', 'Inspect the App config entry manually before retrying.');
  if (old?.projectId !== undefined && old.projectId !== target.project_id && target.allow_project_rebind !== true) fail('registry_recovery_conflict', 'app_config_recovery', 'The Sidecar ID belongs to a different project in the baseline config.', 'Resolve the App registration conflict manually.');
  return jsonBytes({ ...config, sidecars: { ...(config.sidecars ?? {}), [target.sidecar_id]: { ...(old ?? {}), enabled: true, projectId: target.project_id } } });
}

async function bytesForResume(target, currentHashValue, stage) {
  if (currentHashValue === target.target_sha256) return null;
  if (currentHashValue !== target.baseline_sha256) {
    fail('registry_external_edit_conflict', stage, `The target no longer matches either the transaction baseline or its own completed write: ${target.path}`, 'Review the external edit; the registry will not overwrite it or roll back other targets.', { path: target.path, expected_sha256: target.baseline_sha256, target_sha256: target.target_sha256, actual_sha256: currentHashValue });
  }
  const baseline = await readOptionalBytes(target.path, `${stage}_recovery_read`);
  if ((baseline === null ? null : sha(baseline)) !== target.baseline_sha256) {
    fail('registry_external_edit_conflict', stage, `The target changed while recovering the transaction: ${target.path}`, 'Review the external edit and start a new transaction after resolving it.', { path: target.path });
  }
  let rendered;
  if (target.kind === 'descriptor') rendered = jsonBytes(target.descriptor);
  else if (target.kind === 'manifest') rendered = rebuildManifest(baseline, target);
  else rendered = rebuildAppConfig(baseline, target);
  if (sha(rendered) !== target.target_sha256) {
    fail('registry_recovery_conflict', stage, `The current baseline no longer produces the transaction's exact planned bytes: ${target.path}`, 'Preserve the journal and inspect the target; no recovery write was made.', { expected_sha256: target.target_sha256, reconstructed_sha256: sha(rendered) });
  }
  return rendered;
}

async function runJournal(journalPath, journal, appConfigWriter = writeAppConfigTarget) {
  const phases = [
    ['descriptor', 'descriptor_written'],
    ['manifest', 'manifest_written'],
    ['app_config', 'app_registration_written'],
  ].filter(([kind]) => journal.targets?.[kind]);
  for (const [kind, phase] of phases) {
    const target = journal.targets[kind];
    if (kind === 'app_config') {
      if (typeof target.baseline_bytes_base64 !== 'string' || typeof target.target_bytes_base64 !== 'string' || !isRecord(target.intent)) {
        fail('registry_recovery_required', phase, 'The active App config journal lacks its durable baseline, target, or intent.', 'Preserve the journal and App config; do not retry an incomplete writer record.');
      }
      const baselineBytes = Buffer.from(target.baseline_bytes_base64, 'base64');
      const targetBytes = Buffer.from(target.target_bytes_base64, 'base64');
      if (sha(baselineBytes) !== target.baseline_sha256 || sha(targetBytes) !== target.target_sha256) {
        fail('registry_recovery_required', phase, 'The active App config journal hashes do not match its recorded bytes.', 'Preserve the journal and App config for manual recovery.');
      }
      const recoveringAppWrite = target.write_started === true;
      target.write_started = true;
      journal.updated_at = new Date().toISOString();
      await writeJournal(journalPath, journal);
      try {
        await appConfigWriter({ path: target.path, baseline_sha256: target.baseline_sha256,
          target_sha256: target.target_sha256, target_bytes: targetBytes, intent: target.intent });
      } catch (error) {
        if (error instanceof AppConfigWriterError && error.code === 'app_config_external_edit_conflict') {
          if (recoveringAppWrite) {
            fail('registry_recovery_required', phase, 'The App config matches neither the transaction baseline nor its exact target; external bytes were preserved.', 'Inspect the current App config and journal; the registry will not overwrite or roll back this file.', {
              path: target.path, baseline_sha256: target.baseline_sha256, target_sha256: target.target_sha256,
              actual_sha256: error.actual_sha256,
            });
          }
          fail('app_config_external_edit_conflict', phase, 'The App config changed after its baseline was journaled; external bytes were preserved.', 'Review the external edit and create a new transaction from the current App config.', {
            path: target.path, baseline_sha256: target.baseline_sha256, target_sha256: target.target_sha256,
            actual_sha256: error.actual_sha256,
          });
        }
        throw error;
      }
    } else {
      const now = await currentHash(target.path);
      const bytes = await bytesForResume(target, now, phase);
      if (bytes !== null) await atomicReplace(target.path, bytes, target.baseline_sha256, target.target_sha256, phase);
    }
    journal.stage = phase;
    journal.updated_at = new Date().toISOString();
    await writeJournal(journalPath, journal);
  }
  journal.stage = 'waiting_for_reload';
  journal.updated_at = new Date().toISOString();
  for (const target of Object.values(journal.targets ?? {})) {
    if (target.kind === 'app_config') {
      delete target.baseline_bytes_base64;
      delete target.target_bytes_base64;
      target.journal_bytes_redacted = true;
    }
  }
  await writeJournal(journalPath, journal);
  return journal;
}

function defaultPaths({ manifestPath, appConfigDir, sidecarsDir, workerPath, nodeExecutable }) {
  const home = os.homedir();
  const config = appConfigDir ? normalizePath(appConfigDir, 'appConfigDir') : path.join(home, '.gemini', 'config');
  return {
    manifestPath: normalizePath(manifestPath ?? path.join(process.cwd(), 'bindings.json'), 'manifestPath'),
    appConfigDir: config,
    sidecarsDir: sidecarsDir ? normalizePath(sidecarsDir, 'sidecarsDir') : path.join(config, 'sidecars'),
    workerPath: normalizePath(workerPath ?? path.join(process.cwd(), 'worker.mjs'), 'workerPath'),
    nodeExecutable: normalizePath(nodeExecutable ?? process.execPath, 'nodeExecutable'),
  };
}

export function createRegistry(options = {}) {
  const paths = defaultPaths(options);
  async function workerArgs(route) {
    const file = options.localBindingsPath ?? process.env.ANTIGRAVITY_LOCAL_BINDINGS_FILE;
    const binding = file ? await readLocalBindings(file) : null;
    return [paths.workerPath, '--serve', paths.manifestPath, route.sidecar_id,
      ...(binding ? ['--local-bindings', file, binding.sha256] : [])];
  }
  const appConfigWriter = options.appConfigWriter ?? writeAppConfigTarget;
  const projectsDir = path.join(paths.appConfigDir, 'projects');
  const globalConfigPath = path.join(paths.appConfigDir, 'config.json');

  async function catalog({ cwd } = {}) {
    try {
      const cwdReal = await realDirectory(cwd ?? process.cwd(), 'cwd');
      const [projectCatalog, manifestBytes] = await Promise.all([
        readProjects(projectsDir),
        readOptionalBytes(paths.manifestPath, 'manifest_read'),
      ]);
      let appConfig = null;
      let appConfigError = null;
      try { ({ value: appConfig } = await getOptionalJson(globalConfigPath, 'app_config_read', validateAppConfig)); }
      catch (error) { appConfigError = publicError(error); }
      const { routes } = readRoutes(manifestBytes, paths.manifestPath);
      const matches = [];
      for (const project of projectCatalog.projects) {
        if (!project.resource_roots.some(root => samePath(root.path, cwdReal))) continue;
        const app_sidecars = Object.entries(appConfig?.sidecars ?? {}).filter(([, entry]) => isRecord(entry) && entry.projectId === project.project_id)
          .map(([sidecar_id, entry]) => ({ sidecar_id, enabled: entry.enabled === true, project_id: entry.projectId }));
        const projectRoutes = [];
        for (const route of routes) {
          if (route.project_id === project.project_id && await routeRootsMatch(route, cwdReal)) projectRoutes.push(route);
        }
        matches.push({
          project_id: project.project_id,
          ...(project.name !== undefined ? { name: project.name } : {}),
          resource_roots: project.resource_roots,
          app_sidecar: app_sidecars.length === 1 ? app_sidecars[0] : null,
          app_sidecars,
          route: projectRoutes.length === 1 ? projectRoutes[0] : null,
          routes: projectRoutes,
          project_file: project.file,
        });
      }
      return { state: matches.length === 0 ? 'no_match' : matches.length === 1 ? 'unique_match' : 'ambiguous',
        completeness: projectCatalog.completeness, warnings: projectCatalog.warnings,
        app_config: appConfigError ? { state: 'error', error: appConfigError } : { state: appConfig === null ? 'missing' : 'readable' },
        selection_requires_project_id: projectCatalog.completeness !== 'complete' || matches.length > 1,
        cwd_realpath: cwdReal, candidates: matches };
    } catch (error) {
      const e = asRegistryError(error, 'catalog');
      return { state: e.code === 'catalog_schema_unsupported' || e.code === 'catalog_resource_unavailable' || e.code === 'catalog_project_invalid' ? 'catalog_schema_unsupported' : 'error', error: publicError(e) };
    }
  }

  async function resolveRoute({ cwd } = {}) {
    try {
      const cwdReal = await realDirectory(cwd ?? process.cwd(), 'cwd');
      const { bytes } = await getOptionalJson(paths.manifestPath, 'manifest_read', validateManifest);
      const { routes } = readRoutes(bytes, paths.manifestPath);
      const matches = [];
      for (const route of routes) if (await routeRootsMatch(route, cwdReal)) matches.push(route);
      return { state: matches.length === 0 ? 'route_not_found' : matches.length === 1 ? 'unique_match' : 'ambiguous', cwd_realpath: cwdReal, routes: matches, route: matches.length === 1 ? matches[0] : null };
    } catch (error) {
      throw asRegistryError(error, 'route_resolution');
    }
  }

  async function chooseProject(cwd, projectId) {
    const found = await catalog({ cwd });
    if (found.error) {
      const e = found.error;
      throw new RegistryError(e.code, e.stage, e.message, e.next_action);
    }
    if (projectId !== undefined && (typeof projectId !== 'string' || !uuidPattern.test(projectId))) {
      fail('project_id_invalid', 'project_resolution', 'project_id must be an explicit existing App project UUID.', 'Pass the actual project ID from the App project JSON.');
    }
    if (projectId !== undefined) {
      const selected = await readProjectById(projectsDir, projectId);
      if (!selected.resource_roots.some(root => samePath(root.path, found.cwd_realpath))) {
        fail('project_id_not_candidate', 'project_resolution', 'The explicit project_id does not own the current workspace root.', 'Choose an existing App project whose verified resource roots include this workspace; names are not used for routing.');
      }
      return { project: selected, catalog: found };
    }
    if (found.completeness !== 'complete') {
      fail('app_catalog_incomplete', 'project_resolution', 'The App project catalog contains entries with unsupported or unreadable resource metadata, so automatic project selection is incomplete.', 'Inspect the catalog warnings and pass an explicit project_id whose own resource roots can be fully verified.');
    }
    if (found.state === 'no_match') fail('app_project_not_found', 'project_resolution', 'No existing App project resource resolves to this workspace.', 'Create or add the workspace to an App project in Antigravity, then retry; this registry never creates projects.');
    if (found.candidates.length !== 1) {
      fail('app_project_ambiguous', 'project_resolution', 'Multiple App projects resolve to this workspace; project_id is required.', 'Pass one exact project_id from catalog.');
    }
    return { project: found.candidates[0], catalog: found };
  }

  function makeRoute(project, defaultModel, existingRoute = null) {
    const projectId = project.project_id;
    const sidecarId = `codex-${projectId}`.toLowerCase();
    const roots = toRouteRoots(project.resource_roots);
    assertStableRootSet(existingRoute, roots);
    const routeRoots = existingRoute
      ? existingRoute.workspace_roots.map(old => roots.find(root => root.kind === old.kind && samePath(root.path, old.path)))
      : roots;
    if (routeRoots.some(root => !root)) {
      fail('route_workspace_migration_required', 'manifest_plan', `The existing route roots could not be matched to project ${projectId}.`,
        'Preserve the existing route state and resolve its resource definitions before reconnecting.');
    }
    const rootPath = routeRoots[0]?.path;
    const defaultStateRoot = path.join(rootPath, '.antigravity-gemini-mcp');
    if (existingRoute && !samePath(existingRoute.state_root, defaultStateRoot)) {
      fail('route_state_root_mismatch', 'manifest_plan', `The existing route state root is not under its stable first resource root: ${existingRoute.state_root}.`,
        'Review the existing task state location before reconnecting; connect will not move it.');
    }
    const route = {
      route_id: `codex-${projectId}`.toLowerCase(),
      provider,
      project_id: projectId,
      sidecar_id: sidecarId,
      workspace_roots: routeRoots,
      state_root: existingRoute?.state_root ?? defaultStateRoot,
      sidecar_root: path.join(paths.sidecarsDir, sidecarId),
    };
    if (defaultModel !== undefined) route.default_model = defaultModel;
    return route;
  }

  async function buildPlan(project, cwdReal, defaultModel, { allowSidecarManagedRebind = false } = {}) {
    const model = modelDefaultInput(defaultModel);
    const projectId = project.project_id;
    const sidecarId = `codex-${projectId}`.toLowerCase();
    const descriptorPath = path.join(paths.sidecarsDir, sidecarId, 'sidecar.json');
    const [manifestBefore, configBefore, descriptorBefore] = await Promise.all([
      readOptionalBytes(paths.manifestPath, 'manifest_read'),
      readOptionalBytes(globalConfigPath, 'app_config_read'),
      readOptionalBytes(descriptorPath, 'descriptor_read'),
    ]);
    const manifestExisting = validateManifest(parseJson(manifestBefore, paths.manifestPath, 'manifest_read') ?? emptyManifest(), paths.manifestPath);
    const existingOwners = (manifestExisting.routes_v3 ?? []).filter(item => item.project_id === projectId && item.sidecar_id === sidecarId);
    if (existingOwners.length > 1) {
      fail('route_owner_ambiguous', 'manifest_plan', 'More than one v3 route already has this project and sidecar owner.', 'Resolve duplicate route owners manually; no route was rewritten.');
    }
    const existingRoute = existingOwners[0] ?? null;
    const route = makeRoute(project, model, existingRoute);
    await assertNoLegacyOwnerConflict(manifestExisting, route, paths.manifestPath);
    if (existingOwners.length === 1 && existingOwners[0].default_model !== undefined) {
      const existingDefault = existingOwners[0].default_model;
      if (model === undefined || (!Object.hasOwn(defaultModel ?? {}, 'configured_at') && model.id === existingDefault.id && model.source === existingDefault.source)) {
        route.default_model = existingDefault;
      }
    }
    await assertNoV3RouteConflict(manifestExisting.routes_v3 ?? [], route, paths.manifestPath);
    const descriptorExpected = {
      command: paths.nodeExecutable,
      args: await workerArgs(route),
      restart_policy: 'never',
      description: 'Codex Antigravity project worker',
    };
    const descriptor = buildDescriptorTarget(descriptorBefore, descriptorPath, descriptorExpected);
    const manifest = buildManifestTarget(manifestBefore, paths.manifestPath, route, route.sidecar_id);
    let appConfigRebind = false;
    if (allowSidecarManagedRebind && existingOwners.length === 1 && configBefore !== null) {
      const currentConfig = validateAppConfig(parseJson(configBefore, globalConfigPath, 'app_config_read') ?? {}, globalConfigPath);
      const currentSidecar = currentConfig.sidecars?.[route.sidecar_id];
      if (currentSidecar?.schemaVersion === 1 && typeof currentSidecar.projectId === 'string' && currentSidecar.projectId !== projectId) {
        let managedProject;
        try { managedProject = await readProjectById(projectsDir, currentSidecar.projectId); }
        catch (error) {
          fail('sidecar_managed_project_unverified', 'app_config_plan', `App Sidecar ${route.sidecar_id} points to project ${currentSidecar.projectId}, whose identity and resources cannot be verified.`, 'Inspect that App project and its resource roots; no projectId rebind was planned.', { cause_code: error?.code });
        }
        const expectedRoots = project.resource_roots.map(root => [root.kind, root.path]).sort((a, b) => a[1].localeCompare(b[1]));
        const managedRoots = managedProject.resource_roots.map(root => [root.kind, root.path]).sort((a, b) => a[1].localeCompare(b[1]));
        appConfigRebind = managedProject.name === route.sidecar_id && equalJson(managedRoots, expectedRoots);
        if (!appConfigRebind) {
          fail('sidecar_managed_project_mismatch', 'app_config_plan', `App Sidecar ${route.sidecar_id} points to project ${currentSidecar.projectId}, whose name or exact resource roots do not match the selected route.`, 'Keep the App registration unchanged and resolve project ownership explicitly; no projectId rebind was planned.');
        }
      }
    }
    const appConfig = buildAppConfigTarget(configBefore, globalConfigPath, route.sidecar_id, projectId,
      { allowProjectRebind: appConfigRebind });
    const previousRoute = existingOwners.length === 1 ? existingOwners[0] : null;
    const previousDigest = previousRoute ? await workerConfigDigest(previousRoute) : null;
    const nextDigest = await workerConfigDigest(manifest.route);
    const requiresReload = !previousRoute || previousDigest.worker_config_sha256 !== nextDigest.worker_config_sha256 ||
      descriptor.diff.operation !== 'unchanged' || appConfig.diff.operation !== 'unchanged';
    const targets = {
      descriptor: { path: descriptorPath, baseline_sha256: descriptorBefore === null ? null : sha(descriptorBefore), target_sha256: sha(descriptor.bytes), bytes: descriptor.bytes, kind: 'descriptor', descriptor: descriptor.descriptor },
      manifest: { path: paths.manifestPath, baseline_sha256: manifestBefore === null ? null : sha(manifestBefore), target_sha256: sha(manifest.bytes), bytes: manifest.bytes, kind: 'manifest', project_id: projectId, sidecar_id: route.sidecar_id, route: manifest.route },
      app_config: { path: globalConfigPath, baseline_sha256: configBefore === null ? null : sha(configBefore), target_sha256: sha(appConfig.bytes), bytes: appConfig.bytes, baseline_bytes: configBefore, intent: appConfig.intent, kind: 'app_config', sidecar_id: route.sidecar_id, project_id: projectId, allow_project_rebind: appConfig.allow_project_rebind === true },
    };
    const summaries = [
      targetSummary('descriptor', descriptorPath, descriptorBefore, descriptor.bytes, descriptor.diff),
      targetSummary('manifest', paths.manifestPath, manifestBefore, manifest.bytes, manifest.diff),
      targetSummary('app_config', globalConfigPath, configBefore, appConfig.bytes, appConfig.diff),
    ];
    return { route: manifest.route, cwd_realpath: cwdReal, sidecar_id: route.sidecar_id, targets, summaries, requires_reload: requiresReload };
  }

  async function connect({ cwd, project_id: projectId, default_model: defaultModel, apply = false } = {}) {
    if (typeof apply !== 'boolean') fail('apply_invalid', 'input_validation', 'apply must be a boolean.', 'Use apply:false for preview or apply:true for the local transaction.');
    const cwdReal = await realDirectory(cwd ?? process.cwd(), 'cwd');
    const { project } = await chooseProject(cwdReal, projectId);
    if (!apply) {
      let plan;
      try { plan = await buildPlan(project, cwdReal, defaultModel, { allowSidecarManagedRebind: projectId !== undefined }); }
      catch (error) { throw asRegistryError(error, 'connect_preview'); }
      return { state: plan.summaries.some(target => target.changed) ? 'dry_run' : 'already_configured', cwd_realpath: cwdReal, project_id: project.project_id, sidecar_id: plan.sidecar_id, route: plan.route, targets: plan.summaries, config_digest: plan.summaries.find(target => target.name === 'app_config').target_sha256 };
    }
    const lock = transactionPaths(paths.appConfigDir);
    let release;
    try { release = await acquireLock(lock.lock); }
    catch (error) { throw asRegistryError(error, 'lock'); }
    try {
      // Refresh project identity and all three baselines only after acquiring the
      // shared lock. A changed catalog is not silently connected from stale data.
      const refreshed = await chooseProject(cwdReal, project.project_id);
      if (refreshed.project.project_id !== project.project_id || !equalJson(rootSetKey(refreshed.project.resource_roots), rootSetKey(project.resource_roots))) {
        fail('project_changed_during_connect', 'transaction_prepare', 'The App project resources changed between catalog and connect.', 'Refresh catalog and review the changed resource roots before applying again.');
      }
      const journalPath = path.join(lock.journalDir, `${`codex-${project.project_id}`.toLowerCase()}.json`);
      let existingJournal = null;
      let existingJournalBytes = null;
      try {
        existingJournalBytes = await readOptionalBytes(journalPath, 'journal_read');
        if (existingJournalBytes) existingJournal = JSON.parse(existingJournalBytes.toString('utf8'));
      } catch (error) { throw asRegistryError(error, 'journal_read'); }
      if (existingJournal && existingJournal.stage !== 'waiting_for_reload') {
        const requestedModel = modelDefaultInput(defaultModel);
        const previousModel = existingJournal.input_default_model ?? null;
        if (existingJournal.project_id !== project.project_id || existingJournal.sidecar_id !== `codex-${project.project_id}`.toLowerCase() ||
            existingJournal.cwd_realpath !== cwdReal || !sameModelRequest(requestedModel ?? null, previousModel)) {
          fail('registry_recovery_required', 'transaction_recovery', 'A different registry transaction is interrupted for this project.', 'Resume its exact original input or resolve its journaled conflict before starting another connect.');
        }
        if (existingJournal.operation !== 'connect') {
          fail('registry_recovery_required', 'transaction_recovery', `An interrupted ${existingJournal.operation} transaction owns this project journal.`, 'Resume that exact operation before starting connect.');
        }
        const finished = await runJournal(journalPath, existingJournal, appConfigWriter);
        const needsReload = finished.requires_reload !== false;
        return { state: needsReload ? 'configured_needs_sidecar_reload' : 'configured', transaction_id: finished.transaction_id, project_id: project.project_id, sidecar_id: finished.sidecar_id, route: finished.targets.manifest.route, workspace_roots: finished.targets.manifest.route.workspace_roots, state_root: finished.targets.manifest.route.state_root, config_digest: finished.targets.app_config.target_sha256, targets: Object.values(finished.targets).map(t => ({ path: t.path, target_sha256: t.target_sha256 })), resumed: true, next_action: needsReload ? 'Reload the Antigravity App Sidecar configuration; worker health remains unverified until a heartbeat is observed.' : 'The route default changed without changing worker configuration; no Sidecar restart is required.' };
      }
      const plan = await buildPlan(refreshed.project, cwdReal, defaultModel, { allowSidecarManagedRebind: projectId !== undefined });
      if (plan.summaries.every(target => !target.changed)) {
        return { state: 'already_configured', project_id: project.project_id, sidecar_id: plan.sidecar_id, route: plan.route, workspace_roots: plan.route.workspace_roots, state_root: plan.route.state_root, config_digest: plan.summaries.find(target => target.name === 'app_config').target_sha256, targets: plan.summaries, next_action: 'The App may still need a reload if its Sidecar worker has not yet been observed.' };
      }
      if (process.platform !== 'win32') {
        fail('app_config_writer_unsupported', 'transaction_prepare', 'Applying App config changes requires the Windows exclusive FileStream writer.', 'Run apply on Windows; no rename-based or non-Windows fallback is available.');
      }
      if (plan.targets.app_config.baseline_sha256 === null) {
        fail('app_config_missing', 'transaction_prepare', 'The App config file must already exist before this writer can apply a registration.', 'Restore the existing App config file and retry; the registry does not create or replace it.');
      }
      const journalTargets = Object.fromEntries(Object.entries(plan.targets).map(([key, target]) => {
        const { bytes, baseline_bytes, ...metadata } = target;
        if (key === 'app_config') {
          metadata.baseline_bytes_base64 = baseline_bytes?.toString('base64') ?? null;
          metadata.target_bytes_base64 = bytes.toString('base64');
          metadata.intent = target.intent;
          metadata.write_started = false;
        }
        return [key, metadata];
      }));
      const supersedesTransactionId = existingJournal?.stage === 'waiting_for_reload' ? existingJournal.transaction_id : undefined;
      if (supersedesTransactionId !== undefined) {
        await archiveCompletedJournal(journalPath, existingJournal, existingJournalBytes, path.join(lock.journalDir, 'history'));
      }
      if (await readOptionalBytes(journalPath, 'journal_write_baseline') !== null) {
        fail('registry_external_edit_conflict', 'journal_write_baseline', 'An unexpected active registry journal appeared before the new transaction could be recorded.', 'Inspect the active journal and retry without overwriting it.');
      }
      const journal = {
        version: 1,
        transaction_id: randomUUID(),
        operation: 'connect',
        ...(supersedesTransactionId !== undefined ? { supersedes_transaction_id: supersedesTransactionId } : {}),
        project_id: project.project_id,
        sidecar_id: plan.sidecar_id,
        cwd_realpath: cwdReal,
        input_default_model: (() => { const value = modelDefaultInput(defaultModel); return value ? { id: value.id, source: value.source } : null; })(),
        requires_reload: plan.requires_reload,
        stage: 'prepared',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        targets: journalTargets,
      };
      await writeJournal(journalPath, journal);
      const finished = await runJournal(journalPath, journal, appConfigWriter);
      return { state: plan.requires_reload ? 'configured_needs_sidecar_reload' : 'configured', transaction_id: finished.transaction_id, project_id: project.project_id, sidecar_id: finished.sidecar_id, route: finished.targets.manifest.route, workspace_roots: finished.targets.manifest.route.workspace_roots, state_root: finished.targets.manifest.route.state_root, config_digest: finished.targets.app_config.target_sha256, targets: plan.summaries, next_action: plan.requires_reload ? 'Reload the Antigravity App Sidecar configuration; worker health remains unverified until a heartbeat is observed.' : 'The route default changed without changing worker configuration; no Sidecar restart is required.' };
    } catch (error) {
      throw asRegistryError(error, 'connect');
    } finally {
      await release();
    }
  }

  async function status({ cwd, workerHeartbeat } = {}) {
    try {
      const cwdReal = await realDirectory(cwd ?? process.cwd(), 'cwd');
      const routeResult = await resolveRoute({ cwd: cwdReal });
      const route = routeResult.route;
      let appRegistration = { state: route ? 'missing' : 'unknown', enabled: null, project_id: null,
        sidecar_id: route?.sidecar_id ?? null, global_config: { state: 'unknown' }, descriptor: { state: 'unknown' } };
      if (route) {
        const { value: config } = await getOptionalJson(globalConfigPath, 'app_config_read', validateAppConfig);
        const entry = config?.sidecars?.[route.sidecar_id];
        const globalState = !entry ? 'missing' : entry.enabled === true && entry.projectId === route.project_id ? 'verified' : 'stale';
        const expectedDescriptor = { command: paths.nodeExecutable,
          args: await workerArgs(route), restart_policy: 'never' };
        const expectedSidecarRoot = path.join(paths.sidecarsDir, route.sidecar_id);
        let descriptorBytes = null;
        let descriptorState = 'missing';
        if (samePath(route.sidecar_root, expectedSidecarRoot)) {
          try {
            const rootInfo = await fs.lstat(route.sidecar_root);
            if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) descriptorState = 'stale';
            else {
              descriptorBytes = await readOptionalBytes(path.join(route.sidecar_root, 'sidecar.json'), 'descriptor_status_read');
              if (descriptorBytes !== null) descriptorState = 'stale';
            }
          } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        } else descriptorState = 'stale';
        if (descriptorBytes !== null) {
          try {
            const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
            if (descriptorCoreMatches(descriptor, expectedDescriptor)) descriptorState = 'verified';
          } catch { descriptorState = 'stale'; }
        }
        const registrationState = globalState === 'verified' && descriptorState === 'verified' ? 'verified' :
          globalState === 'stale' || descriptorState === 'stale' ? 'stale' : 'missing';
        appRegistration = { state: registrationState, enabled: entry?.enabled === true,
          project_id: entry?.projectId ?? null, sidecar_id: route.sidecar_id,
          global_config: { state: globalState, expected_project_id: route.project_id,
            observed_project_id: entry?.projectId ?? null, schema_version: entry?.schemaVersion ?? null },
          descriptor: { state: descriptorState,
            path: path.join(route.sidecar_root, 'sidecar.json') } };
      }
      if (workerHeartbeat === undefined && route) {
        const expectedStateRoot = path.join(route.workspace_roots[0].path, '.antigravity-gemini-mcp');
        if (!samePath(route.state_root, expectedStateRoot)) {
          workerHeartbeat = { state: 'stale', diagnostic: { code: 'state_root_mismatch' } };
        } else {
          let current = await fs.realpath(route.workspace_roots[0].path);
          let safe = true;
          for (const part of ['.antigravity-gemini-mcp', 'runtime']) {
            current = path.join(current, part);
            try {
              const stat = await fs.lstat(current);
              if (!stat.isDirectory() || stat.isSymbolicLink()) { safe = false; break; }
            } catch (error) { if (error?.code === 'ENOENT') { safe = false; break; } throw error; }
          }
          if (safe) {
            const bytes = await readOptionalBytes(path.join(route.state_root, 'runtime', 'worker-heartbeat.json'), 'heartbeat_read');
            if (bytes !== null) {
              try { workerHeartbeat = JSON.parse(bytes.toString('utf8')); }
              catch { workerHeartbeat = { state: 'stale', diagnostic: { code: 'heartbeat_json_invalid' } }; }
            } else workerHeartbeat = null;
          } else workerHeartbeat = null;
        }
      }
      let worker = { state: 'unknown', route_config_state: 'unknown', runtime_state: 'unknown', heartbeat: null };
      if (workerHeartbeat !== undefined && workerHeartbeat !== null) {
        const heartbeat = isRecord(workerHeartbeat) ? workerHeartbeat : null;
        if (!heartbeat) worker = { state: 'unknown', route_config_state: 'unknown', runtime_state: 'unknown', heartbeat: null };
        else if (!route) worker = { state: 'unknown', route_config_state: 'unknown', runtime_state: 'unknown', heartbeat };
        else {
          const expected = await workerConfigDigest(route);
          const ownerMatches = heartbeat.sidecar_id === route.sidecar_id && heartbeat.project_id === route.project_id;
          const routeConfigState = ownerMatches && heartbeat.worker_config_sha256 === expected.worker_config_sha256 ? 'verified' : 'stale';
          const runtimeState = heartbeat.runtime_sha256 === expected.runtime_sha256 ? 'verified' : 'stale';
          const stamp = Date.parse(heartbeat.at ?? heartbeat.last_seen_at ?? '');
          const age = Date.now() - stamp;
          const fresh = Number.isFinite(stamp) && age >= -60_000 && age <= runtimeConfig.workerHeartbeatStaleMs;
          const reportedState = heartbeat.state === 'ready' && fresh ? 'verified' :
            ['degraded', 'failed'].includes(heartbeat.state) ? heartbeat.state : 'stale';
          worker = {
            state: routeConfigState === 'stale' || runtimeState === 'stale' || !fresh ? 'stale' : reportedState,
            route_config_state: routeConfigState,
            runtime_state: runtimeState,
            expected_worker_config_sha256: expected.worker_config_sha256,
            expected_runtime_sha256: expected.runtime_sha256,
            expected_digest: expected.digest,
            heartbeat,
          };
        }
      }
      const nextAction = !route ? 'Connect the existing App project route.' :
        appRegistration.global_config.state === 'stale' ? `Call connect_project with explicit project_id ${route.project_id} to verify whether the App-managed project is an exact resource mirror and reconcile this Sidecar entry.` :
          appRegistration.state !== 'verified' ? 'Repair the matching Sidecar descriptor or App config entry.' :
          worker.state === 'verified' ? 'App registration and worker route/runtime digests are current.' :
            worker.state === 'degraded' || worker.state === 'failed' ? 'Inspect the worker diagnostic and App runtime before submitting new tasks.' :
              'Reload the App Sidecar configuration and wait for a fresh matching worker heartbeat.';
      return {
        cwd_realpath: cwdReal,
        route: { state: routeResult.state === 'unique_match' ? 'verified' : routeResult.state === 'ambiguous' ? 'ambiguous' : 'missing', value: route },
        app_registration: appRegistration,
        worker,
        provider,
        model_default: route?.default_model ?? null,
        next_action: nextAction,
      };
    } catch (error) {
      throw asRegistryError(error, 'status');
    }
  }

  async function modelCatalog({ cwd } = {}) {
    const result = await resolveRoute({ cwd });
    if (result.state === 'ambiguous') fail('route_ambiguous', 'model_catalog', 'Multiple v3 routes resolve to this workspace.', 'Resolve route ambiguity before reading route defaults.');
    return { ...modelCandidateCatalog(result.route), route_state: result.state };
  }

  async function setDefaultModel({ cwd, model_id: modelId, source } = {}) {
    if (typeof modelId !== 'string' || !modelIdPattern.test(modelId.trim()) || typeof source !== 'string' || !source.trim()) {
      fail('model_default_invalid', 'model_validation', 'setDefaultModel requires an explicit nonempty model_id and source.', 'Pass the exact model ID and its evidence source; no fallback is selected.');
    }
    const current = await resolveRoute({ cwd });
    return connect({ cwd, ...(current.state === 'unique_match' ? { project_id: current.route.project_id } : {}),
      default_model: { id: modelId.trim(), source: source.trim() }, apply: true });
  }

  async function setSidecarEnabled({ cwd, enabled } = {}) {
    if (typeof enabled !== 'boolean') {
      fail('sidecar_enabled_invalid', 'input_validation', 'enabled must be a boolean.', 'Pass enabled:true or enabled:false for the current verified route.');
    }
    const cwdReal = await realDirectory(cwd ?? process.cwd(), 'cwd');
    const initial = await resolveRoute({ cwd: cwdReal });
    if (initial.state !== 'unique_match' || !initial.route) {
      fail(initial.state === 'ambiguous' ? 'route_ambiguous' : 'route_not_found', 'route_resolution',
        'setSidecarEnabled requires exactly one existing v3 route for this cwd.',
        'Resolve the current route before changing App Sidecar enabled state.');
    }
    const route = initial.route;
    async function verifyProjectOwner(routeToVerify) {
      const project = await readProjectById(projectsDir, routeToVerify.project_id);
      if (!equalJson(rootSetKey(project.resource_roots), rootSetKey(routeToVerify.workspace_roots))) {
        fail('route_workspace_migration_required', 'route_resolution', 'The current App project resource roots no longer match this v3 route.',
          'Restore the route resource set or perform an explicit state migration before changing App Sidecar enabled state.');
      }
      const expectedStateRoot = path.join(routeToVerify.workspace_roots[0].path, '.antigravity-gemini-mcp');
      if (!samePath(routeToVerify.state_root, expectedStateRoot)) {
        fail('route_state_root_mismatch', 'route_resolution', 'The current route state root does not match its stable first resource root.',
          'Preserve task state and resolve the route owner before changing App Sidecar enabled state.');
      }
    }
    await verifyProjectOwner(route);
    const lock = transactionPaths(paths.appConfigDir);
    let release;
    try { release = await acquireLock(lock.lock); }
    catch (error) { throw asRegistryError(error, 'lock'); }
    try {
      const latest = await resolveRoute({ cwd: cwdReal });
      if (latest.state !== 'unique_match' || !latest.route || latest.route.route_id !== route.route_id ||
          latest.route.project_id !== route.project_id || latest.route.sidecar_id !== route.sidecar_id ||
          !samePath(latest.route.state_root, route.state_root) || !equalJson(rootSetKey(latest.route.workspace_roots), rootSetKey(route.workspace_roots))) {
        fail('route_changed_during_transaction', 'transaction_prepare', 'The verified v3 route changed while acquiring the Sidecar config lock.',
          'Resolve the current route and retry against its exact project and state owner.');
      }
      await verifyProjectOwner(latest.route);
      const journalPath = path.join(lock.journalDir, `${route.sidecar_id}.json`);
      let existingJournal = null;
      let existingJournalBytes = null;
      existingJournalBytes = await readOptionalBytes(journalPath, 'journal_read');
      if (existingJournalBytes) {
        try { existingJournal = JSON.parse(existingJournalBytes.toString('utf8')); }
        catch (error) { fail('registry_journal_invalid', 'journal_read', `The active registry journal is invalid: ${journalPath}.`, 'Preserve the journal and resolve it manually before changing App config.'); }
      }
      if (existingJournal && existingJournal.stage !== 'waiting_for_reload') {
        if (existingJournal.operation !== 'set_sidecar_enabled' || existingJournal.input_enabled !== enabled ||
            existingJournal.cwd_realpath !== cwdReal || existingJournal.project_id !== route.project_id) {
          fail('registry_recovery_required', 'transaction_recovery', 'A different interrupted registry transaction owns this Sidecar journal.',
            'Resume its exact original operation or resolve its journaled conflict before changing enabled state.');
        }
        const finished = await runJournal(journalPath, existingJournal, appConfigWriter);
        return { state: 'configured', transaction_id: finished.transaction_id, project_id: route.project_id,
          sidecar_id: route.sidecar_id, enabled, config_digest: finished.targets.app_config.target_sha256,
          resumed: true, next_action: 'Reload the App Sidecar configuration and wait for a fresh worker heartbeat.' };
      }
      const configBefore = await readOptionalBytes(globalConfigPath, 'app_config_read');
      const planned = buildAppConfigEnabledTarget(configBefore, globalConfigPath, route.sidecar_id, route.project_id, enabled);
      const baselineHash = configBefore === null ? null : sha(configBefore);
      const targetHash = sha(planned.bytes);
      if (planned.diff.operation === 'unchanged') {
        return { state: 'already_configured', project_id: route.project_id, sidecar_id: route.sidecar_id,
          enabled, config_digest: targetHash, targets: [{ path: globalConfigPath, target_sha256: targetHash, changed: false }] };
      }
      if (baselineHash === null) {
        fail('app_config_missing', 'transaction_prepare', 'The App config file must already exist before changing Sidecar enabled state.',
          'Restore the existing App config file and retry; the registry does not create or replace it.');
      }
      if (process.platform !== 'win32') {
        fail('app_config_writer_unsupported', 'transaction_prepare', 'Changing App config requires the Windows exclusive FileStream writer.',
          'Run this operation on Windows; no rename-based or non-Windows fallback is available.');
      }
      const supersedesTransactionId = existingJournal?.stage === 'waiting_for_reload' ? existingJournal.transaction_id : undefined;
      if (supersedesTransactionId !== undefined) {
        await archiveCompletedJournal(journalPath, existingJournal, existingJournalBytes, path.join(lock.journalDir, 'history'));
      }
      if (await readOptionalBytes(journalPath, 'journal_write_baseline') !== null) {
        fail('registry_external_edit_conflict', 'journal_write_baseline', 'An unexpected active registry journal appeared before this transaction was recorded.',
          'Inspect the active journal and retry without overwriting it.');
      }
      const target = {
        path: globalConfigPath, baseline_sha256: baselineHash, target_sha256: targetHash,
        kind: 'app_config', sidecar_id: route.sidecar_id, project_id: route.project_id,
        intent: planned.intent, baseline_bytes_base64: configBefore.toString('base64'),
        target_bytes_base64: planned.bytes.toString('base64'), write_started: false,
      };
      const journal = {
        version: 1, transaction_id: randomUUID(), operation: 'set_sidecar_enabled',
        ...(supersedesTransactionId !== undefined ? { supersedes_transaction_id: supersedesTransactionId } : {}),
        project_id: route.project_id, sidecar_id: route.sidecar_id, cwd_realpath: cwdReal,
        input_enabled: enabled, requires_reload: true, stage: 'prepared',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        targets: { app_config: target },
      };
      await writeJournal(journalPath, journal);
      const finished = await runJournal(journalPath, journal, appConfigWriter);
      return { state: 'configured', transaction_id: finished.transaction_id, project_id: route.project_id,
        sidecar_id: route.sidecar_id, enabled, config_digest: targetHash, targets: [
          { path: globalConfigPath, target_sha256: targetHash, changed: true },
        ], next_action: 'Reload the App Sidecar configuration and wait for a fresh worker heartbeat.' };
    } catch (error) {
      throw asRegistryError(error, 'set_sidecar_enabled');
    } finally {
      await release();
    }
  }

  return { catalog, resolveRoute, connect, status, modelCatalog, setDefaultModel, setSidecarEnabled };
}
