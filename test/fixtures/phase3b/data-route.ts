import { NextRequest, NextResponse } from 'next/server'
import { qaDatabase } from './server'
import { fixtureTables, QA_OWNER, QA_OTHER } from './database'
export const dynamic = 'force-dynamic'
export async function GET() { const db = qaDatabase(); return NextResponse.json({ owner: db.owner(), changes: db.changes(), trace: db.trace, counts: Object.fromEntries(Object.entries(db.tables).map(([k,v]) => [k,v.length])) }) }
export async function POST(req: NextRequest) {
  const db = qaDatabase(), body = await req.json()
  if (body.control) {
    if (body.control === 'reset') { const fresh = fixtureTables(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Tirane' })); Object.keys(db.tables).forEach(k => db.tables[k] = fresh[k] ?? []); db.setOwner(QA_OWNER); db.setFailure(false); db.trace.length = 0 }
    if (body.control === 'error') db.setFailure(true)
    if (body.control === 'recover') db.setFailure(false)
    if (body.control === 'other') db.setOwner(QA_OTHER)
    if (body.control === 'logout') db.setOwner(null)
    if (body.control === 'empty') { db.tables.clients.forEach(c => { c.next_action = null; c.next_followup = null }); db.tables.ai_reminders.forEach(r => { r.is_dismissed = true }) }
    if (body.control === 'stale') db.tables.clients[0].next_action = 'Changed externally in offline QA'
    return NextResponse.json({ ok: true })
  }
  try { return NextResponse.json(db.operations(body.table, body.ops)) } catch (e) { return NextResponse.json({ data: null, error: { message: String(e) } }, { status: 500 }) }
}
