#!/usr/bin/env node
/**
 * pipedrive-sync.mjs - Pipedrive production drift detector (global skill)
 *
 * Bundled with the `pipedrive-config-sync` skill. Project-agnostic: it detects when
 * the live Pipedrive configuration has drifted from a project's local mirror files,
 * refreshes them, and manages deal filters.
 *
 * Mirror directory resolution (never next to this script):
 *   1. $PIPEDRIVE_MIRROR_DIR
 *   2. the nearest pipedrive/ directory at or above the current working directory
 *   3. the current working directory
 *
 * Mirrors checked:
 *   <mirror>/data_fields.csv          (Item type, Field name, Field type, Is custom field, API key)
 *   <mirror>/data_fields_options.csv  (Option ID, Option name, Item type, Field name, Field type, Field API key)
 *
 * It also snapshots pipelines, stages, and activity types (pipelines.csv / stages.csv /
 * activity_types.csv are created/updated by --write). Pipelines + stages are read from
 * the v2 API (their v1 endpoints are deprecated - see the API version policy below).
 *
 * API surface:
 *   auth   : x-api-token header -> api.pipedrive.com
 *   fields : dealFields/personFields/organizationFields/activityFields/productFields (v2, cursor),
 *            leadFields (v1, offset), projectFields (v2 beta, cursor; optional)
 *   config : pipelines (v2), stages (v2), activityTypes (v1), boards + phases (v2 beta; optional)
 *   filters: filters (v1, GET/POST)
 *   projects: boards + phases (v2, GET/POST); templates/tasks/plan (v1)
 *
 * API version policy (Pipedrive v1 CRUD deprecation):
 *   Pipedrive is retiring the v1 CRUD endpoints for activities, deals, persons,
 *   organizations, products, pipelines, stages and itemSearch - every verb, incl. GET.
 *   The changelog says end of 2025; partner notices quote mid-2026. Treat them as gone.
 *   => Never add a v1 call for any of those entities. Use /api/v2 (this file already
 *      does: pipelines + stages are v2).
 *   The v1 calls kept below are the ones with NO v2 successor, so they are safe:
 *      - {entity}Fields (field definitions)   - filters (no v2 filters)
 *      - activityTypes (not on the list)       - projectTemplates / project tasks / plan
 *   See docs/pipedrive-api.md in the gtm-tools repo for the full policy and gotchas.
 *
 * Usage:
 *   node pipedrive-sync.mjs                # check for drift, exit 1 if any
 *   node pipedrive-sync.mjs --write        # refresh local mirror files from live
 *   node pipedrive-sync.mjs --json         # machine-readable drift report
 *   node pipedrive-sync.mjs filters list    # list deal filters (list views)
 *   node pipedrive-sync.mjs filters ensure  # create filters from <mirror>/filters.json (idempotent)
 *   node pipedrive-sync.mjs projects list    # list project boards + phases
 *   node pipedrive-sync.mjs projects ensure  # create boards + phases from <mirror>/projects.json (idempotent)
 *
 * Token: PIPEDRIVE_API_TOKEN in the environment, or in .env / .env.local at the project
 * root or in the mirror dir (all gitignored; .env.local wins). The token is sent only to
 * api.pipedrive.com and is never printed or written to disk.
 */

import https from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename, resolve } from 'path';

/* ---------------------------------------------------- mirror dir resolution */
/* This script lives in the global skill directory, so mirrors are never written
   next to it. Resolve the project whose pipedrive/ mirrors we operate on. */
function resolveMirrorDir() {
  if (process.env.PIPEDRIVE_MIRROR_DIR) return resolve(process.env.PIPEDRIVE_MIRROR_DIR);
  let dir = process.cwd();
  for (;;) {
    if (basename(dir) === 'pipedrive') return dir;         // already inside it
    const cand = join(dir, 'pipedrive');
    if (existsSync(cand)) return cand;                     // project root (or an ancestor)
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();                                    // last resort
}

const MIRROR_DIR = resolveMirrorDir();
const PROJECT_ROOT = basename(MIRROR_DIR) === 'pipedrive' ? dirname(MIRROR_DIR) : MIRROR_DIR;

const BASE_V2 = 'https://api.pipedrive.com/api/v2';
const BASE_V1 = 'https://api.pipedrive.com/v1';

/* Entities whose fields we mirror. Lead fields live on v1; the rest on v2.
   Project fields are a v2 beta endpoint that keys custom fields by `field_code`
   (a 40-char hash, same shape as other entities' `key`) and may be disabled on a
   given account - so it is marked `optional`: if the fetch fails we warn and skip
   it rather than aborting the whole drift check, and we never treat local Project
   rows as deleted just because the endpoint was unavailable this run. */
const ENTITIES = [
  { name: 'Deal',         path: 'dealFields',         v1: false },
  { name: 'Person',       path: 'personFields',       v1: false },
  { name: 'Organization', path: 'organizationFields', v1: false },
  { name: 'Lead',         path: 'leadFields',         v1: true  },
  { name: 'Activity',     path: 'activityFields',     v1: false },
  { name: 'Product',      path: 'productFields',      v1: false },
  { name: 'Project',      path: 'projectFields',      v1: false, optional: true },
];
// Entities actually fetched this run (an optional entity is dropped if its
// endpoint was unavailable). Used so deletion checks never fire on missing data.
const FETCHED_ENTITIES = new Set();

/* Pipedrive API field_type -> the label the native CSV export uses.
   Only used to author *new* rows in --write; existing rows keep their label. */
const TYPE_LABEL = {
  varchar: 'Text', varchar_auto: 'Autocomplete', text: 'Large text',
  double: 'Numerical', int: 'Numerical', monetary: 'Monetary',
  date: 'Date', daterange: 'Date range', time: 'Time', timerange: 'Time range',
  enum: 'Single option', set: 'Multiple options',
  user: 'User', org: 'Organization', people: 'Person',
  phone: 'Phone', address: 'Address', picture: 'Picture',
};

const HASH_RE = /^[0-9a-f]{40}$/; // custom-field key shape

/* ------------------------------------------------------------------ args */
const ARGV = process.argv.slice(2);
const SUBCMD = ARGV[0] && !ARGV[0].startsWith('-') ? ARGV[0] : null;
const ARGS = new Set(ARGV);
const WRITE = ARGS.has('--write');
const JSON_OUT = ARGS.has('--json');

/* ------------------------------------------------------------------ env */
function loadToken() {
  if (process.env.PIPEDRIVE_API_TOKEN) return process.env.PIPEDRIVE_API_TOKEN.trim();
  const seen = new Set();
  for (const dir of [PROJECT_ROOT, MIRROR_DIR, process.cwd()]) {
    for (const name of ['.env.local', '.env']) { // .env.local takes precedence over .env
      const p = join(dir, name);
      if (seen.has(p)) continue;
      seen.add(p);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?PIPEDRIVE_API_TOKEN\s*=\s*(.*)\s*$/);
        if (m) return m[1].replace(/^["']|["']$/g, '').trim();
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ http */
function httpsGetJson(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'x-api-token': token, Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let j;
        try { j = JSON.parse(body); } catch (_) { j = null; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = j ? (j.error || j.message || '') : body.slice(0, 150);
          return reject(new Error(`HTTP ${res.statusCode}${detail ? ': ' + detail : ''}`));
        }
        if (!j || j.success === false) {
          return reject(new Error('success=false: ' + ((j && j.error) || 'unknown')));
        }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
  });
}

async function fetchAllV2(path, token, extra = {}) {
  const out = [];
  let cursor = null;
  do {
    const url = new URL(`${BASE_V2}/${path}`);
    url.searchParams.set('limit', '500');
    if (cursor) url.searchParams.set('cursor', cursor);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));
    const j = await httpsGetJson(url.toString(), token);
    (j.data || []).forEach((r) => out.push(r));
    cursor = (j.additional_data && j.additional_data.next_cursor) || null;
  } while (cursor);
  return out;
}

async function fetchAllV1(path, token, extra = {}) {
  const out = [];
  let start = 0;
  for (;;) {
    const url = new URL(`${BASE_V1}/${path}`);
    url.searchParams.set('limit', '500');
    url.searchParams.set('start', String(start));
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));
    const j = await httpsGetJson(url.toString(), token);
    (j.data || []).forEach((r) => out.push(r));
    const more = j.additional_data && j.additional_data.pagination && j.additional_data.pagination.more_items_in_collection;
    if (!more) break;
    start += 500;
  }
  return out;
}

/* POST/DELETE for the v1 write endpoints (filters). GET stays on httpsGetJson. */
function httpsSendJson(method, url, token, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const req = https.request(url, {
      method,
      headers: {
        'x-api-token': token, Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let j; try { j = JSON.parse(body); } catch (_) { j = null; }
        if (res.statusCode < 200 || res.statusCode >= 300 || !j || j.success === false) {
          const detail = j ? (j.error || j.message || '') : body.slice(0, 150);
          return reject(new Error(`HTTP ${res.statusCode}${detail ? ': ' + detail : ''}`));
        }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

/* ------------------------------------------------------------------ filters */
/* Pipedrive deal filters (saved list views). A filter's conditions must be shaped
   as one AND group + one OR group: {glue:and, conditions:[{glue:and,...},{glue:or,...}]}.
   Since enum conditions only support "=", an "is one of A,B" set goes in the OR group;
   the whole filter is then (AND group) AND (OR group). field_id is the NUMERIC deal
   field id (custom and standard alike); enum values are numeric option ids.
   Relative date tokens Pipedrive accepts: today, yesterday, this_week, last_week,
   this_month, last_month, this_quarter, last_quarter, this_year, last_year,
   next_week, next_month. There is no arbitrary "last N days" token. */

const DEFAULT_VISIBLE_TO = '7'; // entire company, so the whole team sees the filters

/* Filter definitions are per-project config, loaded from <mirror>/filters.json.
   Either a bare array of specs, or { visible_to?: "7", filters: [...] }.
   A spec is { name, and: [[field, op, value?], ...], or: [...] } where <field> is a
   standard key (pipeline, status, stage_id, won_time, add_time, value, ...) or a custom
   field's exact name, and an enum <value> is the option label - both are resolved to
   numeric ids from live dealFields. */
const FILTERS_JSON = join(MIRROR_DIR, 'filters.json');

function loadFilterConfig() {
  if (!existsSync(FILTERS_JSON))
    throw new Error(`No filter definitions found at ${FILTERS_JSON}. Create it first (see the skill's SKILL.md for the format).`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(FILTERS_JSON, 'utf8')); }
  catch (e) { throw new Error(`${FILTERS_JSON} is not valid JSON: ${e.message}`); }
  const filters = Array.isArray(parsed) ? parsed : parsed.filters;
  if (!Array.isArray(filters) || !filters.length)
    throw new Error(`${FILTERS_JSON} must be an array of filter specs, or an object with a non-empty "filters" array.`);
  for (const f of filters) {
    if (!f || typeof f.name !== 'string' || !f.name.trim())
      throw new Error(`${FILTERS_JSON}: every filter needs a non-empty "name".`);
    if (!Array.isArray(f.and) && !Array.isArray(f.or))
      throw new Error(`${FILTERS_JSON}: filter "${f.name}" needs an "and" and/or "or" condition array.`);
  }
  const visibleTo = String((Array.isArray(parsed) ? null : parsed.visible_to) || DEFAULT_VISIBLE_TO);
  return { filters, visibleTo };
}

const NO_VALUE_OPS = new Set(['IS NULL', 'IS NOT NULL']);
const STD_ALIAS = { stage: 'stage_id', created: 'add_time', created_time: 'add_time' };

async function buildDealFieldIndex(token) {
  // v1 dealFields exposes standard fields (pipeline, status, stage_id, won_time, ...)
  // with the numeric ids and option ids that filter conditions require.
  const raw = await fetchAllV1('dealFields', token);
  const byName = new Map(); // exact field name -> rec
  const byKey = new Map();  // api key (standard key or hash) -> rec
  for (const f of raw) {
    const options = new Map((f.options || []).map((o) => [String(o.label), String(o.id)]));
    const rec = { id: String(f.id), type: f.field_type, name: f.name, key: f.key, options };
    if (f.name) byName.set(f.name, rec);
    if (f.key) byKey.set(f.key, rec);
  }
  return { byName, byKey };
}

function resolveCondition(idx, cond) {
  const [ref, operator, val] = cond;
  const rec = idx.byKey.get(STD_ALIAS[ref] || ref) || idx.byKey.get(ref) || idx.byName.get(ref);
  if (!rec) throw new Error(`Unknown deal field: "${ref}"`);
  if (NO_VALUE_OPS.has(operator)) return { object: 'deal', field_id: rec.id, operator, value: null, extra_value: null };
  // enum/set: translate an option label to its numeric id; otherwise pass the value through
  const value = rec.options.has(String(val)) ? rec.options.get(String(val)) : String(val);
  return { object: 'deal', field_id: rec.id, operator, value, extra_value: null };
}

function buildConditions(idx, spec) {
  return {
    glue: 'and',
    conditions: [
      { glue: 'and', conditions: (spec.and || []).map((c) => resolveCondition(idx, c)) },
      { glue: 'or', conditions: (spec.or || []).map((c) => resolveCondition(idx, c)) },
    ],
  };
}

async function listDealFilters(token) {
  const filters = await fetchAllV1('filters', token, { type: 'deals' });
  console.log(`Deal filters (${filters.length}):`);
  for (const f of filters.sort((a, b) => a.name.localeCompare(b.name)))
    console.log(`  #${f.id}  ${f.name}${f.filter_code ? '  [' + f.filter_code + ']' : ''}`);
}

async function ensureFilters(token) {
  const { filters: specs, visibleTo } = loadFilterConfig();
  const idx = await buildDealFieldIndex(token);
  const existing = await fetchAllV1('filters', token, { type: 'deals' });
  const have = new Set(existing.map((f) => f.name));
  let created = 0, skipped = 0;
  console.log(`Ensuring ${specs.length} deal filter(s) from ${FILTERS_JSON}:`);
  for (const spec of specs) {
    if (have.has(spec.name)) { console.log(`  skip (exists)   ${spec.name}`); skipped++; continue; }
    const body = { name: spec.name, type: 'deals', visible_to: visibleTo, conditions: buildConditions(idx, spec) };
    const j = await httpsSendJson('POST', `${BASE_V1}/filters`, token, body);
    console.log(`  created #${j.data.id}   ${spec.name}`);
    created++;
  }
  console.log(`\nDone. ${created} created, ${skipped} skipped (already existed). visible_to=${visibleTo}.`);
}

/* --------------------------------------------------------- project structure */
/* Project boards (v2 /boards) each contain ordered phases (v2 /phases?board_id=).
   `projects ensure` creates boards + phases from <mirror>/projects.json, and is
   idempotent: a board is matched by name, a phase by (board, name). Only missing
   items are created; nothing is renamed, reordered, or deleted. */
const PROJECTS_JSON = join(MIRROR_DIR, 'projects.json');

function loadProjectsConfig() {
  if (!existsSync(PROJECTS_JSON))
    throw new Error(`No project structure found at ${PROJECTS_JSON}. Create it first (see the skill's SKILL.md for the format).`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(PROJECTS_JSON, 'utf8')); }
  catch (e) { throw new Error(`${PROJECTS_JSON} is not valid JSON: ${e.message}`); }
  const boards = Array.isArray(parsed) ? parsed : parsed.boards;
  if (!Array.isArray(boards) || !boards.length)
    throw new Error(`${PROJECTS_JSON} must be an array of boards, or an object with a non-empty "boards" array.`);
  return boards.map((b) => {
    if (!b || typeof b.name !== 'string' || !b.name.trim())
      throw new Error(`${PROJECTS_JSON}: every board needs a non-empty "name".`);
    // phases: array of strings (name only) or objects {name, order_nr?}
    const phases = (b.phases || []).map((p) => {
      const rec = typeof p === 'string' ? { name: p } : p;
      if (!rec || typeof rec.name !== 'string' || !rec.name.trim())
        throw new Error(`${PROJECTS_JSON}: board "${b.name}" has a phase with no name.`);
      return { name: rec.name, order_nr: rec.order_nr };
    });
    // reference_project (optional): a project card pre-loaded with a task checklist,
    // so it can be saved as a Pipedrive project template. A task is a string (title)
    // or an object { title, phase?, description? }; `phase` places it in that phase.
    let referenceProject = null;
    if (b.reference_project) {
      const rp = b.reference_project;
      if (typeof rp.title !== 'string' || !rp.title.trim())
        throw new Error(`${PROJECTS_JSON}: board "${b.name}" reference_project needs a non-empty "title".`);
      const tasks = (rp.tasks || []).map((t) => {
        const rec = typeof t === 'string' ? { title: t } : t;
        if (!rec || typeof rec.title !== 'string' || !rec.title.trim())
          throw new Error(`${PROJECTS_JSON}: board "${b.name}" reference_project has a task with no title.`);
        return { title: rec.title, phase: rec.phase, description: rec.description };
      });
      referenceProject = { title: rp.title, tasks };
    }
    return { name: b.name, order_nr: b.order_nr, phases, referenceProject };
  });
}

async function listProjectBoards(token) {
  let boards;
  try { boards = await fetchAllV2('boards', token); }
  catch (e) { throw new Error(`could not list boards (Projects v2 beta may be disabled on this account): ${e.message}`); }
  console.log(`Project boards (${boards.length}):`);
  for (const b of boards.sort((a, c) => (a.order_nr ?? 0) - (c.order_nr ?? 0))) {
    console.log(`  #${b.id}  ${b.name}`);
    const phases = await fetchAllV2('phases', token, { board_id: b.id });
    for (const p of phases.sort((a, c) => (a.order_nr ?? 0) - (c.order_nr ?? 0)))
      console.log(`      phase #${p.id}  ${p.name}`);
  }
}

async function ensureProjectStructure(token) {
  const wanted = loadProjectsConfig();
  let liveBoards;
  try { liveBoards = await fetchAllV2('boards', token); }
  catch (e) { throw new Error(`could not read existing boards (Projects v2 beta may be disabled on this account): ${e.message}`); }
  const boardByName = new Map(liveBoards.map((b) => [b.name, b]));
  // Saved project templates: once a reference project has been "Saved as template",
  // Pipedrive consumes the source project. Skip re-creating a reference project when a
  // template of the same title already exists (otherwise ensure churns / duplicates).
  let templateTitles = new Set();
  try { const tmpls = await fetchAllV1('projectTemplates', token); templateTitles = new Set((tmpls || []).map((t) => t.title)); } catch (_) {}
  let boardsCreated = 0, boardsSkipped = 0, phasesCreated = 0, phasesSkipped = 0;
  let projCreated = 0, projSkipped = 0, tasksCreated = 0, tasksSkipped = 0, tasksPlaced = 0;

  console.log(`Ensuring ${wanted.length} project board(s) from ${PROJECTS_JSON}:`);
  for (const wb of wanted) {
    let board = boardByName.get(wb.name);
    if (board) { console.log(`  board skip (exists)   #${board.id}  ${wb.name}`); boardsSkipped++; }
    else {
      const body = { name: wb.name, ...(wb.order_nr != null ? { order_nr: wb.order_nr } : {}) };
      const j = await httpsSendJson('POST', `${BASE_V2}/boards`, token, body);
      board = j.data;
      boardByName.set(wb.name, board);
      console.log(`  board created         #${board.id}  ${wb.name}`);
      boardsCreated++;
    }
    // phases for this board, matched by name
    const livePhases = await fetchAllV2('phases', token, { board_id: board.id });
    const havePhase = new Set(livePhases.map((p) => p.name));
    for (const wp of wb.phases) {
      if (havePhase.has(wp.name)) { console.log(`      phase skip (exists)  ${wp.name}`); phasesSkipped++; continue; }
      const body = { name: wp.name, board_id: board.id, ...(wp.order_nr != null ? { order_nr: wp.order_nr } : {}) };
      const j = await httpsSendJson('POST', `${BASE_V2}/phases`, token, body);
      console.log(`      phase created #${j.data.id}  ${wp.name}`);
      havePhase.add(wp.name);
      phasesCreated++;
    }
    // optional reference project: a project card pre-loaded with the task checklist
    if (wb.referenceProject) {
      const finalPhases = await fetchAllV2('phases', token, { board_id: board.id });
      const phaseIdByName = new Map(finalPhases.map((p) => [p.name, p.id]));
      const r = await ensureReferenceProject(token, board.id, wb.phases, wb.referenceProject, phaseIdByName, templateTitles);
      projCreated += r.projCreated; projSkipped += r.projSkipped;
      tasksCreated += r.tasksCreated; tasksSkipped += r.tasksSkipped; tasksPlaced += r.tasksPlaced;
    }
  }
  console.log(`\nDone. Boards: ${boardsCreated} created, ${boardsSkipped} skipped. Phases: ${phasesCreated} created, ${phasesSkipped} skipped.` +
    (projCreated + projSkipped ? ` Reference projects: ${projCreated} created, ${projSkipped} skipped; tasks: ${tasksCreated} created, ${tasksSkipped} skipped, ${tasksPlaced} placed in phase.` : ''));
}

/* Create (idempotently) a reference project on a board, pre-loaded with the task
   checklist so it can be "Saved as template" in Pipedrive. Project matched by title;
   task matched by title within the project. Each task is placed into its phase via the
   v1 project-plan endpoint. Project = v2 POST /projects; task = v1 POST /tasks;
   placement = v1 PUT /projects/{id}/plan/tasks/{taskId} { phase_id }. */
async function ensureReferenceProject(token, boardId, wbPhases, rp, phaseIdByName, templateTitles) {
  if (templateTitles && templateTitles.has(rp.title)) {
    console.log(`    ref project skip (template already saved) ${rp.title}`);
    return { projCreated: 0, projSkipped: 1, tasksCreated: 0, tasksSkipped: 0, tasksPlaced: 0 };
  }
  let liveProjects = [];
  try { liveProjects = await fetchAllV2('projects', token, { board_id: boardId }); } catch (_) {}
  let project = liveProjects.find((p) => p.title === rp.title && (p.board_id == null || p.board_id === boardId));
  let projCreated = 0, projSkipped = 0;
  if (project) { console.log(`    ref project skip (exists) #${project.id}  ${rp.title}`); projSkipped = 1; }
  else {
    const firstPhaseId = wbPhases.length ? phaseIdByName.get(wbPhases[0].name) : undefined;
    const body = { title: rp.title, board_id: boardId, ...(firstPhaseId ? { phase_id: firstPhaseId } : {}) };
    const j = await httpsSendJson('POST', `${BASE_V2}/projects`, token, body);
    project = j.data;
    console.log(`    ref project created       #${project.id}  ${rp.title}`);
    projCreated = 1;
  }
  // existing tasks in the project, matched by title (idempotent re-runs)
  let liveTasks = [];
  try { liveTasks = await fetchAllV1(`projects/${project.id}/tasks`, token); }
  catch (_) { try { liveTasks = await fetchAllV1('tasks', token, { project_id: project.id }); } catch (_) {} }
  const haveTask = new Set(liveTasks.map((t) => t.title));
  let tasksCreated = 0, tasksSkipped = 0, tasksPlaced = 0;
  for (const t of rp.tasks) {
    if (haveTask.has(t.title)) { tasksSkipped++; continue; }
    const body = { title: t.title, project_id: project.id, ...(t.description ? { description: t.description } : {}) };
    const j = await httpsSendJson('POST', `${BASE_V1}/tasks`, token, body);
    const taskId = j.data && j.data.id;
    haveTask.add(t.title);
    tasksCreated++;
    if (taskId && t.phase && phaseIdByName.get(t.phase)) {
      try {
        await httpsSendJson('PUT', `${BASE_V1}/projects/${project.id}/plan/tasks/${taskId}`, token, { phase_id: phaseIdByName.get(t.phase) });
        tasksPlaced++;
      } catch (e) { console.log(`      (warn) place "${t.title}" in "${t.phase}" failed: ${e.message}`); }
    }
  }
  console.log(`      tasks: ${tasksCreated} created, ${tasksSkipped} skipped${tasksPlaced ? `, ${tasksPlaced} placed in phase` : ''}`);
  return { projCreated, projSkipped, tasksCreated, tasksSkipped, tasksPlaced };
}

/* ------------------------------------------------------------------ csv */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvLine = (vals) => vals.map(q).join(',');

/* ------------------------------------------------------------------ load local */
const FIELDS_CSV = join(MIRROR_DIR, 'data_fields.csv');
const OPTIONS_CSV = join(MIRROR_DIR, 'data_fields_options.csv');

function loadLocalFields() {
  const map = new Map(); // `${entity}::${key}` -> row
  if (!existsSync(FIELDS_CSV)) return map;
  for (const r of parseCsv(readFileSync(FIELDS_CSV, 'utf8'))) {
    map.set(`${r['Item type']}::${r['API key']}`, {
      entity: r['Item type'], name: r['Field name'], type: r['Field type'],
      custom: (r['Is custom field'] || '').toLowerCase() === 'yes', key: r['API key'],
    });
  }
  return map;
}

function loadLocalOptions() {
  const map = new Map(); // `${fieldKey}::${optId}` -> row
  if (!existsSync(OPTIONS_CSV)) return map;
  for (const r of parseCsv(readFileSync(OPTIONS_CSV, 'utf8'))) {
    map.set(`${r['Field API key']}::${r['Option ID']}`, {
      optId: r['Option ID'], optName: r['Option name'], entity: r['Item type'],
      fieldName: r['Field name'], fieldType: r['Field type'], fieldKey: r['Field API key'],
    });
  }
  return map;
}

/* ------------------------------------------------------------------ live model */
function liveKey(f) { return f.key || f.field_code || ''; }
function liveLabel(f) { return f.field_name || f.name || ''; }
function liveType(f) { return f.field_type || f.type || ''; }
function isCustom(f) {
  const k = liveKey(f);
  if (HASH_RE.test(k)) return true;
  return f.edit_flag === true;
}

async function fetchLive(token) {
  const fields = new Map(); // `${entity}::${key}` -> {entity,key,label,type,custom,options:[{id,label}]}
  const options = new Map(); // `${key}::${optId}` -> {fieldKey,optId,optLabel,entity,fieldLabel,fieldType}
  const skipped = []; // optional entities whose endpoint was unavailable
  for (const e of ENTITIES) {
    let raw;
    try {
      raw = e.v1 ? await fetchAllV1(e.path, token) : await fetchAllV2(e.path, token);
    } catch (err) {
      if (e.optional) { skipped.push({ name: e.name, reason: err.message }); continue; }
      throw err;
    }
    FETCHED_ENTITIES.add(e.name);
    for (const f of raw) {
      const key = liveKey(f);
      if (!key) continue;
      const rec = { entity: e.name, key, label: liveLabel(f), type: liveType(f), custom: isCustom(f), options: [] };
      fields.set(`${e.name}::${key}`, rec);
      for (const o of f.options || []) {
        const optId = String(o.id ?? '');
        rec.options.push({ id: optId, label: o.label ?? '' });
        options.set(`${key}::${optId}`, {
          fieldKey: key, optId, optLabel: o.label ?? '',
          entity: e.name, fieldLabel: rec.label, fieldType: rec.type,
        });
      }
    }
  }
  // Project boards + phases (v2 beta). Phases are fetched per board. Treated as
  // optional config: a disabled endpoint leaves boards/phases empty and flagged,
  // rather than aborting - mirror them only when the fetch succeeds.
  let boards = [], phases = [], projectsConfigOk = true, projectsConfigReason = null;
  try {
    boards = await fetchAllV2('boards', token);
    for (const b of boards) {
      const bid = b.id;
      const bphases = await fetchAllV2('phases', token, { board_id: bid });
      for (const p of bphases) phases.push({ ...p, board_id: p.board_id ?? bid });
    }
  } catch (err) {
    projectsConfigOk = false; projectsConfigReason = err.message; boards = []; phases = [];
  }

  // pipelines + stages are v2 (v1 CRUD for both is deprecated - retired end of 2025 /
  // mid-2026, see the "API version policy" note at the top of this file). activityTypes
  // is NOT on the deprecation list and has no v2 successor, so it legitimately stays v1.
  const [pipelines, stages, activityTypes] = await Promise.all([
    fetchAllV2('pipelines', token),
    fetchAllV2('stages', token),
    fetchAllV1('activityTypes', token),
  ]);
  return { fields, options, pipelines, stages, activityTypes, boards, phases, skipped, projectsConfigOk, projectsConfigReason };
}

/* ------------------------------------------------------------------ drift */
function computeDrift(live, localFields, localOptions) {
  const d = {
    fieldsAddedCustom: [], fieldsAddedSystem: [], fieldsDeletedCustom: [], fieldsRenamed: [],
    optionsAdded: [], optionsRemoved: [], optionsOrphanedDeletedField: [],
  };

  // fields: live vs local
  for (const [k, f] of live.fields) {
    if (!localFields.has(k)) (f.custom ? d.fieldsAddedCustom : d.fieldsAddedSystem).push(f);
    else {
      const loc = localFields.get(k);
      if (f.label && loc.name && f.label !== loc.name)
        d.fieldsRenamed.push({ entity: f.entity, key: f.key, local: loc.name, live: f.label });
    }
  }
  for (const [k, loc] of localFields) {
    if (!FETCHED_ENTITIES.has(loc.entity)) continue;   // Project etc. out of scope
    if (loc.custom && !live.fields.has(k))
      d.fieldsDeletedCustom.push(loc);
  }

  // options: live vs local (custom/hash-keyed only; system enums like channel/label differ between API and export)
  const liveFieldKeys = new Set([...live.fields.values()].map((f) => f.key));
  for (const [k, o] of live.options) if (HASH_RE.test(o.fieldKey) && !localOptions.has(k)) d.optionsAdded.push(o);
  for (const [k, loc] of localOptions) {
    if (!HASH_RE.test(loc.fieldKey)) continue;          // skip system enums (channel, label, priority...)
    if (live.options.has(k)) continue;
    if (!liveFieldKeys.has(loc.fieldKey)) d.optionsOrphanedDeletedField.push(loc); // field itself is gone
    else d.optionsRemoved.push(loc);                    // field exists, option removed
  }
  return d;
}

const driftCount = (d) => Object.values(d).reduce((s, a) => s + a.length, 0);

/* ------------------------------------------------------------------ report */
function printReport(d, live) {
  const L = console.log;
  const sec = (title, arr, fmt) => {
    if (!arr.length) return;
    L(`\n  ${title} (${arr.length})`);
    arr.forEach((x) => L('    - ' + fmt(x)));
  };
  L('Pipedrive drift report');
  L('======================');
  sec('NEW custom fields in production (add to data_fields.csv)', d.fieldsAddedCustom,
    (f) => `${f.entity} · ${f.label} · ${f.type} · ${f.key}`);
  sec('Custom fields DELETED in production (still in data_fields.csv)', d.fieldsDeletedCustom,
    (f) => `${f.entity} · ${f.name} · ${f.key}`);
  sec('Field LABEL changed (local -> live)', d.fieldsRenamed,
    (f) => `${f.entity} · ${f.key} · "${f.local}" -> "${f.live}"`);
  sec('NEW options in production (add to data_fields_options.csv)', d.optionsAdded,
    (o) => `${o.entity} · ${o.fieldLabel} · "${o.optLabel}" (${o.optId}) · ${o.fieldKey}`);
  sec('Options REMOVED in production (field still exists)', d.optionsRemoved,
    (o) => `${o.fieldName} · "${o.optName}" (${o.optId}) · ${o.fieldKey}`);
  sec('ORPHANED options - parent field is DELETED (cross-check gotcha)', d.optionsOrphanedDeletedField,
    (o) => `${o.fieldName} · "${o.optName}" (${o.optId}) · ${o.fieldKey}`);

  // system-field adds are informational (export vs API differences) - summarise only
  if (d.fieldsAddedSystem.length)
    L(`\n  (info) ${d.fieldsAddedSystem.length} system field(s) returned by the API but absent from the export - usually export/API naming differences, no action needed.`);

  // optional entities / config that couldn't be fetched this run (e.g. beta endpoint disabled)
  for (const s of live.skipped || [])
    L(`\n  (warn) ${s.name} fields skipped - endpoint unavailable (${s.reason}). Its rows in the mirror were left untouched, not flagged as deleted.`);
  if (live.projectsConfigOk === false)
    L(`\n  (warn) Project boards/phases skipped - endpoint unavailable (${live.projectsConfigReason}). boards.csv / phases.csv were left untouched.`);

  const n = driftCount(d);
  L('\n----------------------');
  if (n === 0) L('In sync. Local mirror files match production.');
  else L(`${n} drift item(s) found. Run with --write to refresh the local mirrors, or update them by hand.`);
  L(`Live: ${live.fields.size} fields, ${live.options.size} options, ${live.pipelines.length} pipelines, ${live.stages.length} stages, ${live.activityTypes.length} activity types, ${live.boards.length} boards, ${live.phases.length} phases.`);
}

/* ------------------------------------------------------------------ write */
function writeMirrors(live, localFields, localOptions) {
  /* data_fields.csv: the live v2 API exposes a different *system*-field inventory
     and keys than Pipedrive's native CSV export. So we keep every system row
     (non-hash key) byte-identical and only reconcile custom (hash-keyed) rows. */
  const liveCustomFields = new Map(); // `${entity}::${key}` -> live field
  for (const f of live.fields.values()) if (HASH_RE.test(f.key)) liveCustomFields.set(`${f.entity}::${f.key}`, f);

  const fieldLines = ['Item type,Field name,Field type,Is custom field,API key'];
  const usedFieldKeys = new Set();
  let addedFields = 0, droppedFields = 0;
  for (const loc of localFields.values()) {
    if (!HASH_RE.test(loc.key)) {                         // system row -> verbatim
      fieldLines.push(csvLine([loc.entity, loc.name, loc.type, loc.custom ? 'Yes' : 'No', loc.key]));
      continue;
    }
    const k = `${loc.entity}::${loc.key}`;
    const lf = liveCustomFields.get(k);
    if (!lf) { droppedFields++; continue; }               // custom field deleted in production -> drop
    usedFieldKeys.add(k);
    fieldLines.push(csvLine([loc.entity, lf.label || loc.name, loc.type, 'Yes', loc.key])); // refresh label on rename
  }
  for (const [k, lf] of liveCustomFields) {               // append new custom fields
    if (usedFieldKeys.has(k)) continue;
    fieldLines.push(csvLine([lf.entity, lf.label, TYPE_LABEL[lf.type] || lf.type, 'Yes', lf.key]));
    addedFields++;
  }
  writeFileSync(FIELDS_CSV, fieldLines.join('\n') + '\n');

  /* data_fields_options.csv: same rule - keep system-enum option rows (non-hash
     field key: channel, label, priority, health_status...) verbatim; reconcile
     only custom-field (hash) options. */
  const liveOpt = new Map(); // `${fieldKey}::${optId}` -> live option (hash only)
  for (const o of live.options.values()) if (HASH_RE.test(o.fieldKey)) liveOpt.set(`${o.fieldKey}::${o.optId}`, o);

  const optLines = ['Option ID,Option name,Item type,Field name,Field type,Field API key'];
  const usedOptKeys = new Set();
  let addedOpts = 0, droppedOpts = 0;
  for (const loc of localOptions.values()) {
    if (!HASH_RE.test(loc.fieldKey)) {                    // system enum option -> verbatim
      optLines.push(csvLine([loc.optId, loc.optName, loc.entity, loc.fieldName, loc.fieldType, loc.fieldKey]));
      continue;
    }
    const k = `${loc.fieldKey}::${loc.optId}`;
    const lo = liveOpt.get(k);
    if (!lo) { droppedOpts++; continue; }                 // option (or its field) gone -> drop
    usedOptKeys.add(k);
    optLines.push(csvLine([lo.optId, lo.optLabel, lo.entity, lo.fieldLabel, loc.fieldType, lo.fieldKey]));
  }
  for (const [k, lo] of liveOpt) {                        // append new custom options
    if (usedOptKeys.has(k)) continue;
    optLines.push(csvLine([lo.optId, lo.optLabel, lo.entity, lo.fieldLabel, TYPE_LABEL[lo.fieldType] || lo.fieldType, lo.fieldKey]));
    addedOpts++;
  }
  writeFileSync(OPTIONS_CSV, optLines.join('\n') + '\n');

  // config mirrors
  const pipeName = Object.fromEntries(live.pipelines.map((p) => [p.id, p.name || '']));
  // v2 /pipelines returns only live pipelines and may omit the v1 `active` / `order_nr`
  // fields, so default Active to Yes when absent and leave Order blank rather than guess.
  writeFileSync(join(MIRROR_DIR, 'pipelines.csv'),
    ['Pipeline ID,Name,Active,Order',
      ...live.pipelines.map((p) => csvLine([p.id, p.name || '', ('active' in p ? p.active : true) ? 'Yes' : 'No', p.order_nr ?? '']))].join('\n') + '\n');
  writeFileSync(join(MIRROR_DIR, 'stages.csv'),
    ['Stage ID,Name,Pipeline ID,Pipeline name,Order,Deal probability',
      ...live.stages.map((s) => csvLine([s.id, s.name || '', s.pipeline_id ?? '', pipeName[s.pipeline_id] || '', s.order_nr ?? '',
        s.deal_probability != null ? s.deal_probability : '']))].join('\n') + '\n');
  writeFileSync(join(MIRROR_DIR, 'activity_types.csv'),
    ['ID,Name,Key string,Active,Order',
      ...live.activityTypes.map((t) => csvLine([t.id, t.name || '', t.key_string || '',
        t.active_flag ? 'Yes' : 'No', t.order_nr ?? '']))].join('\n') + '\n');

  /* Project boards + phases (v2 beta). Written only when the fetch succeeded, so a
     disabled endpoint never wipes an existing mirror to an empty file. Phases carry
     their board name for readability, mirroring how stages carry the pipeline name. */
  let boardsWritten = null, phasesWritten = null;
  if (live.projectsConfigOk !== false) {
    const boardName = Object.fromEntries(live.boards.map((b) => [b.id, b.name || '']));
    writeFileSync(join(MIRROR_DIR, 'boards.csv'),
      ['Board ID,Name,Order',
        ...live.boards.map((b) => csvLine([b.id, b.name || '', b.order_nr ?? '']))].join('\n') + '\n');
    writeFileSync(join(MIRROR_DIR, 'phases.csv'),
      ['Phase ID,Name,Board ID,Board name,Order',
        ...live.phases.map((p) => csvLine([p.id, p.name || '', p.board_id ?? '', boardName[p.board_id] || '', p.order_nr ?? '']))].join('\n') + '\n');
    boardsWritten = live.boards.length;
    phasesWritten = live.phases.length;
  }

  return {
    fields: fieldLines.length - 1, options: optLines.length - 1,
    addedFields, droppedFields, addedOpts, droppedOpts,
    pipelines: live.pipelines.length, stages: live.stages.length, activityTypes: live.activityTypes.length,
    boards: boardsWritten, phases: phasesWritten,
  };
}

/* ------------------------------------------------------------------ main */
async function main() {
  const token = loadToken();
  if (!token) {
    console.error('No API token found. Add PIPEDRIVE_API_TOKEN to a .env or .env.local file at the');
    console.error(`project root (${PROJECT_ROOT}) or in ${MIRROR_DIR}, or export PIPEDRIVE_API_TOKEN in your shell.`);
    process.exit(2);
  }

  // filters subcommand: manage deal list-view filters (no drift/mirror work)
  if (SUBCMD === 'filters') {
    const action = ARGV[1] || 'list';
    try {
      if (action === 'list') await listDealFilters(token);
      else if (action === 'ensure') await ensureFilters(token);
      else { console.error('Usage: pipedrive-sync.mjs filters [list|ensure]'); process.exit(2); }
    } catch (e) {
      console.error('Filters ' + action + ' failed: ' + e.message);
      process.exit(2);
    }
    process.exit(0);
  }

  // projects subcommand: manage project boards + phases (no drift/mirror work)
  if (SUBCMD === 'projects') {
    const action = ARGV[1] || 'list';
    try {
      if (action === 'list') await listProjectBoards(token);
      else if (action === 'ensure') await ensureProjectStructure(token);
      else { console.error('Usage: pipedrive-sync.mjs projects [list|ensure]'); process.exit(2); }
    } catch (e) {
      console.error('Projects ' + action + ' failed: ' + e.message);
      process.exit(2);
    }
    process.exit(0);
  }

  console.log(`Mirror dir: ${MIRROR_DIR}`);

  let live;
  try {
    live = await fetchLive(token);
  } catch (e) {
    console.error('Fetch failed: ' + e.message);
    console.error('Verify the token is correct and active (Pipedrive > Settings > Personal preferences > API).');
    process.exit(2);
  }

  const localFields = loadLocalFields();
  const localOptions = loadLocalOptions();

  if (WRITE) {
    const n = writeMirrors(live, localFields, localOptions);
    console.log(`Refreshed local mirrors from production (${MIRROR_DIR}):`);
    console.log(`  data_fields.csv          ${n.fields} fields  (custom +${n.addedFields} / -${n.droppedFields}; system rows untouched)`);
    console.log(`  data_fields_options.csv  ${n.options} options (custom +${n.addedOpts} / -${n.droppedOpts}; system enum rows untouched)`);
    console.log(`  pipelines.csv            ${n.pipelines} pipelines`);
    console.log(`  stages.csv               ${n.stages} stages`);
    console.log(`  activity_types.csv       ${n.activityTypes} activity types`);
    if (n.boards != null) {
      console.log(`  boards.csv               ${n.boards} project boards`);
      console.log(`  phases.csv               ${n.phases} project phases`);
    } else {
      console.log(`  boards.csv / phases.csv  skipped (Project boards endpoint unavailable: ${live.projectsConfigReason})`);
    }
    for (const s of live.skipped || [])
      console.log(`  (${s.name} fields skipped: endpoint unavailable - ${s.reason})`);
    console.log('Only custom (hash-keyed) fields/options are reconciled; system rows are preserved from the native export. Review the diff before committing.');
    process.exit(0);
  }

  const drift = computeDrift(live, localFields, localOptions);
  if (JSON_OUT) {
    console.log(JSON.stringify(drift, null, 2));
  } else {
    printReport(drift, live);
  }
  process.exit(driftCount(drift) > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Unexpected error: ' + (e && e.stack || e)); process.exit(2); });
