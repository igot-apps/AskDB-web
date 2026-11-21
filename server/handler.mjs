// AskDB web: database endpoint. Connects to the user's PostgreSQL database.
// Database links are sent from the user's browser with each request and are never stored here.
import crypto from 'node:crypto';
import db from './db.cjs';

const json = (data, status = 200) => Response.json(data, { status });

function passwordOk(given) {
  const expected = process.env.APP_PASSWORD || '';
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return expected.length > 0 && crypto.timingSafeEqual(h(given || ''), h(expected));
}

async function withDb(cs, fn) {
  if (!cs) throw new Error('No database link was provided.');
  const id = crypto.createHash('sha256').update(cs).digest('hex');
  await db.connect(id, cs);
  try { return await fn(); }
  finally { await db.disconnect(); }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
  if (!process.env.APP_PASSWORD) {
    return json({ ok: false, error: 'This AskDB site has no password yet. Set the APP_PASSWORD environment variable on your server, then restart it.' }, 503);
  }
  if (!passwordOk(req.headers.get('x-app-password'))) return json({ ok: false, error: 'Wrong password.' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request.' }, 400); }
  const { action, cs, sql, table, readOnly } = body || {};
  const readOnlyBlock = () => {
    if (readOnly) throw new Error('This database is in read-only mode, so nothing was changed. Click "🔒 Read only" at the top to allow changes.');
  };

  try {
    let data;
    switch (action) {
      case 'ping': data = true; break;
      case 'test': data = await db.testConnection(cs); break;
      case 'schema':
        data = await withDb(cs, async () => {
          const tables = await db.getSchema();
          const full = db.schemaToText(tables, true);
          const small = full.length < 15000;
          return {
            tables: tables.map(t => ({ name: t.name, rows: t.rows, isView: t.isView })),
            schemaText: small ? full : db.schemaToText(tables, false),
            fullSchema: small,
          };
        });
        break;
      case 'describe': data = await withDb(cs, () => db.describeTable(table)); break;
      case 'query': data = await withDb(cs, () => db.runQuery(sql)); break;
      case 'propose': readOnlyBlock(); data = await withDb(cs, () => db.proposeChange(sql)); break;
      case 'apply': readOnlyBlock(); data = await withDb(cs, () => db.applySql(sql)); break;
      default: return json({ ok: false, error: 'Unknown action.' }, 400);
    }
    return json({ ok: true, data });
  } catch (e) {
    return json({ ok: false, error: db.friendlyError(e) });
  }
};

// Used by server.mjs for POST /api/db.
