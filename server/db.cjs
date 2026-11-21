// Database layer: connecting, reading schema, safe read queries, and guarded changes.
const { Pool } = require('pg');

const MAX_ROWS = 500;          // rows shown to the user
const TIMEOUT_MS = 15000;      // per statement
let pool = null;
let currentId = null;
const proposals = new Map();   // id -> { sql, kind }

// ---------- Connection ----------

function isLocalHost(cs) {
  try {
    const u = new URL(cs);
    return ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(u.hostname);
  } catch { return false; }
}

// Strip sslmode from the URL so our own ssl setting is used (pg lets the URL win otherwise).
function buildConfig(cs, useSsl) {
  let url = cs.trim();
  let sslDisabled = false;
  try {
    const u = new URL(url);
    const mode = (u.searchParams.get('sslmode') || '').toLowerCase();
    if (mode === 'disable') sslDisabled = true;
    ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'channel_binding'].forEach(k => u.searchParams.delete(k));
    url = u.toString();
  } catch { /* leave as is; pg will report a friendly error */ }
  return {
    connectionString: url,
    ssl: useSsl && !sslDisabled ? { rejectUnauthorized: false } : false,
    max: 3,
    connectionTimeoutMillis: 10000,
    statement_timeout: TIMEOUT_MS,
    application_name: 'AskDB',
  };
}

async function tryPool(cs, useSsl) {
  const p = new Pool(buildConfig(cs, useSsl));
  p.on('error', () => {}); // idle client errors should not crash the app
  try {
    const c = await p.connect();
    c.release();
    return p;
  } catch (e) {
    await p.end().catch(() => {});
    throw e;
  }
}

async function openPool(cs) {
  const preferSsl = !isLocalHost(cs);
  try {
    return await tryPool(cs, preferSsl);
  } catch (e) {
    const msg = String(e.message || '');
    // Server doesn't do SSL (or needs it): retry the other way once.
    if (/ssl|SSL/.test(msg) || e.code === 'ECONNRESET') return await tryPool(cs, !preferSsl);
    throw e;
  }
}

async function connect(id, cs) {
  if (pool && currentId === id) return;
  await disconnect();
  pool = await openPool(cs);
  currentId = id;
}

async function disconnect() {
  if (pool) await pool.end().catch(() => {});
  pool = null;
  currentId = null;
  proposals.clear();
}

async function testConnection(cs) {
  const p = await openPool(cs);
  try {
    const r = await p.query(`select count(*)::int as n from information_schema.tables
      where table_type in ('BASE TABLE','VIEW') and table_schema not in ('pg_catalog','information_schema')
      and table_schema not like 'pg_toast%'`);
    return { tables: r.rows[0].n };
  } finally { await p.end().catch(() => {}); }
}

function requirePool() {
  if (!pool) throw new Error('Not connected to a database.');
  return pool;
}

// ---------- Schema ----------

async function getSchema() {
  const p = requirePool();
  const cols = await p.query(`
    select c.table_schema s, c.table_name t, c.column_name col, c.data_type typ, t.table_type tt
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema not in ('pg_catalog','information_schema') and c.table_schema not like 'pg_toast%'
    order by c.table_schema, c.table_name, c.ordinal_position`);
  const keys = await p.query(`
    select n.nspname s, cl.relname t, con.contype k, pg_get_constraintdef(con.oid) def
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where con.contype in ('p','f') and n.nspname not in ('pg_catalog','information_schema')`);
  const sizes = await p.query(`
    select n.nspname s, c.relname t, c.reltuples::bigint est
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p','v','m') and n.nspname not in ('pg_catalog','information_schema')`);

  const tables = new Map();
  for (const r of cols.rows) {
    const name = r.s === 'public' ? r.t : `${r.s}.${r.t}`;
    if (!tables.has(name)) tables.set(name, { name, schema: r.s, table: r.t, isView: r.tt === 'VIEW', columns: [], keys: [], rows: -1 });
    tables.get(name).columns.push(`${r.col} ${r.typ}`);
  }
  const find = (s, t) => tables.get(s === 'public' ? t : `${s}.${t}`);
  for (const k of keys.rows) { const t = find(k.s, k.t); if (t) t.keys.push(k.def); }
  for (const z of sizes.rows) { const t = find(z.s, z.t); if (t) t.rows = Number(z.est); }
  return [...tables.values()];
}

function schemaToText(tables, full) {
  return tables.map(t => {
    const head = `${t.name}${t.isView ? ' (view)' : ''}${t.rows >= 0 ? ` ~${t.rows} rows` : ''}`;
    if (!full) return head;
    return `${head}\n  columns: ${t.columns.join(', ')}${t.keys.length ? `\n  keys: ${t.keys.join('; ')}` : ''}`;
  }).join('\n');
}

// ---------- Safe reads ----------

// Scan SQL respecting quotes, comments and $tag$ strings.
// Returns the SQL with comments removed and whether a semicolon appears outside literals.
function scan(sql) {
  let out = '', semi = false, i = 0;
  while (i < sql.length) {
    const ch = sql[i], nx = sql[i + 1];
    if (ch === '-' && nx === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += ' '; continue; }
    if (ch === '/' && nx === '*') {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      out += ' '; continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; } j++; }
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? sql.length : end + m[0].length;
        out += sql.slice(i, stop); i = stop; continue;
      }
    }
    if (ch === ';') semi = true;
    out += ch; i++;
  }
  return { bare: out.trim(), multiple: semi };
}

function stripComments(sql) { return scan(sql).bare; }
function hasMultipleStatements(sql) { return scan(sql).multiple; }

// Remove trailing semicolons (and trailing comments) so a single statement is clean.
function cleanSql(sql) {
  let s = String(sql || '').trim();
  for (;;) {
    const b = scan(s).bare;
    if (!b.endsWith(';')) break;
    const idx = s.lastIndexOf(';');
    s = s.slice(0, idx).trim();
  }
  return s;
}

async function runQuery(sql) {
  const p = requirePool();
  sql = cleanSql(sql);
  if (hasMultipleStatements(sql)) throw new Error('Please run one statement at a time.');
  const first = stripComments(sql).trim().split(/\s+/)[0].toLowerCase();
  const wrap = first === 'select' || first === 'with';
  const text = wrap ? `select * from (${sql}) as askdb_q limit ${MAX_ROWS + 1}` : sql;
  const c = await p.connect();
  try {
    await c.query('begin read only');
    let r;
    try { r = await c.query(text); }
    catch (e) {
      // Some valid selects can't be wrapped (e.g. ending in FOR UPDATE); try plain.
      if (!wrap) throw e;
      await c.query('rollback'); await c.query('begin read only');
      r = await c.query(sql);
    }
    const rows = r.rows || [];
    return {
      columns: (r.fields || []).map(f => f.name),
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
    };
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

async function describeTable(name) {
  const tables = await getSchema();
  const t = tables.find(x => x.name.toLowerCase() === String(name).toLowerCase());
  if (!t) throw new Error(`Table "${name}" not found. Available: ${tables.map(x => x.name).join(', ')}`);
  const ident = `"${t.schema.replace(/"/g, '""')}"."${t.table.replace(/"/g, '""')}"`;
  const sample = await runQuery(`select * from ${ident} limit 3`);
  return { table: t.name, columns: t.columns, keys: t.keys, approxRows: t.rows, sampleRows: sample.rows };
}

// ---------- Guarded changes ----------

const ALLOWED = ['insert', 'update', 'delete'];

function validateChange(sql) {
  const bare = stripComments(sql).trim();
  if (!bare) throw new Error('Empty change.');
  if (hasMultipleStatements(sql)) throw new Error('Only one change at a time is allowed.');
  const kind = bare.split(/\s+/)[0].toLowerCase();
  if (!ALLOWED.includes(kind)) {
    throw new Error('Only adding, editing or removing rows is allowed (INSERT, UPDATE, DELETE). Changing table structure is blocked.');
  }
  if ((kind === 'update' || kind === 'delete') && !/\bwhere\b/i.test(bare)) {
    throw new Error('UPDATE and DELETE must include a WHERE condition so only specific rows change.');
  }
  return kind;
}

async function proposeChange(sql) {
  const p = requirePool();
  sql = cleanSql(sql);
  const kind = validateChange(sql);
  const withReturning = /\breturning\b/i.test(stripComments(sql)) ? sql : `${sql} returning *`;
  const c = await p.connect();
  let r;
  try {
    await c.query('begin');
    r = await c.query(withReturning); // dry run
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
  const id = `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  proposals.set(id, { sql, kind });
  return {
    id, kind, sql,
    affected: r.rowCount,
    columns: (r.fields || []).map(f => f.name),
    preview: (r.rows || []).slice(0, 5),
  };
}

async function applyChange(id) {
  const p = requirePool();
  const prop = proposals.get(id);
  if (!prop) throw new Error('This change has expired. Please ask again.');
  const c = await p.connect();
  try {
    await c.query('begin');
    const r = await c.query(prop.sql);
    await c.query('commit');
    proposals.delete(id);
    return { affected: r.rowCount, sql: prop.sql };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

function cancelChange(id) { proposals.delete(id); }

// For the web version (stateless server): re-validate and run a change the user confirmed.
async function applySql(sql) {
  const p = requirePool();
  sql = cleanSql(sql);
  validateChange(sql);
  const c = await p.connect();
  try {
    await c.query('begin');
    const r = await c.query(sql);
    await c.query('commit');
    return { affected: r.rowCount, sql };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// ---------- Friendly errors ----------

function friendlyError(e) {
  const code = e && e.code;
  const msg = String((e && e.message) || e);
  const map = {
    ENOTFOUND: "I couldn't find that database server. Check the address in your database link.",
    ECONNREFUSED: 'The database server refused the connection. Is it running, and is the port correct?',
    ETIMEDOUT: 'The database took too long to respond. Check your internet connection or the database address.',
    '28P01': 'The username or password in your database link is incorrect.',
    '28000': 'The database rejected this login. Check the username and password.',
    '3D000': "That database name doesn't exist on the server.",
    '57014': 'That took too long (over 15 seconds), so I stopped it.',
    '25006': 'That would change data, so it was blocked. Changes need your confirmation first.',
    '42P01': 'That table does not exist.',
    '42703': 'That column does not exist.',
  };
  if (map[code]) return map[code];
  if (/Invalid URL|invalid connection/i.test(msg)) return "That doesn't look like a valid database link. It should start with postgres:// or postgresql://";
  if (/timeout/i.test(msg)) return 'The database took too long to respond. Check your internet connection.';
  return msg;
}

module.exports = {
  connect, disconnect, testConnection, getSchema, schemaToText,
  runQuery, describeTable, proposeChange, applyChange, cancelChange, applySql, friendlyError,
};
