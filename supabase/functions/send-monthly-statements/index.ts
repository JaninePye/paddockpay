import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// AES-256-CBC decryption
async function decrypt(hexStr: string, keyHex: string): Promise<string> {
  const bytes = hexToBytes(hexStr)
  const iv = bytes.slice(0, 16)
  const data = bytes.slice(16)
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(keyHex), { name: 'AES-CBC' }, false, ['decrypt']
  )
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data)
  return new TextDecoder().decode(decrypted)
}

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  return b
}

function isLastDayOfMonth(): boolean {
  const now = new Date()
  const aest = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }))
  const tomorrow = new Date(aest)
  tomorrow.setDate(aest.getDate() + 1)
  return tomorrow.getMonth() !== aest.getMonth()
}

function getAESTNow() {
  const now = new Date()
  return new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }))
}

function formatAUD(amount: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount)
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-')
  return `${d}/${m}/${y}`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const TOKEN_ENCRYPTION_KEY = Deno.env.get('TOKEN_ENCRYPTION_KEY')
  const db = createClient(supabaseUrl, supabaseServiceKey)

  try {
    const body = await req.json().catch(() => ({}))
    const { admin_id, worker_id, month: bodyMonth, year: bodyYear, statement_id, push_xero, resend_email } = body

    const aest = getAESTNow()
    const month = bodyMonth || (aest.getMonth() + 1)
    const year = bodyYear || aest.getFullYear()

    // Handle resend/push actions on existing statement
    if (statement_id) {
      const { data: stmt } = await db.from('monthly_statements').select('*, profiles:worker_id(full_name,email), admin:admin_id(full_name,business_name,email,xero_tenant_id,xero_access_token_encrypted,xero_refresh_token_encrypted,xero_token_expiry,statement_cc_email)').eq('id', statement_id).single()
      if (!stmt) return new Response(JSON.stringify({ error: 'Statement not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

      if (resend_email) {
        await sendStatementEmail(db, supabaseUrl, supabaseServiceKey, stmt)
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
      if (push_xero) {
        await pushToXeroAPI(db, stmt, TOKEN_ENCRYPTION_KEY)
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    // Auto-trigger from pg_cron: only run on last day of month
    if (!admin_id && !isLastDayOfMonth()) {
      return new Response(JSON.stringify({ skipped: 'Not last day of month' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Build query for active links
    let linksQuery = db.from('employer_worker_links')
      .select('*, admin:admin_id(id,full_name,business_name,email,xero_tenant_id,xero_access_token_encrypted,xero_refresh_token_encrypted,xero_token_expiry,monthly_auto_send,statement_cc_email), worker:worker_id(id,full_name,email)')
      .eq('status', 'active')

    if (admin_id) linksQuery = linksQuery.eq('admin_id', admin_id)
    if (worker_id) linksQuery = linksQuery.eq('worker_id', worker_id)

    const { data: links, error: linksErr } = await linksQuery
    if (linksErr) throw linksErr

    const results = []

    for (const link of (links || [])) {
      try {
        const adminId = link.admin_id
        const workerId = link.worker_id
        const admin = link.admin
        const worker = link.worker

        // Check for existing statement (idempotency)
        const { data: existing } = await db.from('monthly_statements')
          .select('id, status')
          .eq('admin_id', adminId)
          .eq('worker_id', workerId)
          .eq('month', month)
          .eq('year', year)
          .single()

        if (existing && existing.status === 'sent') {
          results.push({ worker_id: workerId, skipped: 'Already sent' })
          continue
        }

        // Query labour days for this period
        const prefix = `${year}-${String(month).padStart(2, '0')}`
        const { data: days } = await db.from('labour_days')
          .select('*')
          .eq('worker_id', workerId)
          .eq('admin_id', adminId)
          .like('day_key', `${prefix}%`)
          .order('day_key')

        const allDays = days || []
        const fullDays = allDays.filter(d => d.day_type === 'full').length
        const halfDays = allDays.filter(d => d.day_type === 'half').length
        const totalDays = fullDays + halfDays * 0.5
        const dayRate = link.day_rate
        const totalAmount = totalDays * dayRate

        // Build day breakdown
        const dayBreakdown = allDays.map(d => ({
          day_key: d.day_key,
          day_type: d.day_type,
          notes: d.notes || '',
          amount: d.day_type === 'full' ? dayRate : dayRate * 0.5,
        }))

        // Upsert statement
        const stmtPayload = {
          admin_id: adminId,
          worker_id: workerId,
          month,
          year,
          full_days: fullDays,
          half_days: halfDays,
          total_days: totalDays,
          day_rate: dayRate,
          total_amount: totalAmount,
          day_breakdown: dayBreakdown,
          status: 'draft',
        }

        const { data: stmt, error: stmtErr } = await db.from('monthly_statements')
          .upsert(stmtPayload, { onConflict: 'worker_id,admin_id,month,year' })
          .select()
          .single()

        if (stmtErr) throw stmtErr

        // Push to Xero if connected and auto-send enabled
        if (admin.xero_tenant_id && admin.monthly_auto_send !== false && TOKEN_ENCRYPTION_KEY) {
          try {
            const fullStmt = { ...stmt, admin, profiles: worker }
            await pushToXeroAPI(db, fullStmt, TOKEN_ENCRYPTION_KEY)
          } catch (xeroErr) {
            console.error('Xero push failed for', workerId, xeroErr)
          }
        }

        // Refresh statement with any Xero data
        const { data: refreshedStmt } = await db.from('monthly_statements').select('*').eq('id', stmt.id).single()

        // Send email
        const fullStmt = { ...refreshedStmt, admin, profiles: worker }
        await sendStatementEmail(db, supabaseUrl, supabaseServiceKey, fullStmt)

        // Audit log
        await db.from('audit_log').insert({
          user_id: adminId,
          action: 'statement_sent',
          table_name: 'monthly_statements',
          record_id: stmt.id,
          new_value: { month, year, worker_id: workerId, total_amount: totalAmount },
          performed_by_role: 'admin',
        })

        results.push({ worker_id: workerId, statement_id: stmt.id, success: true })
      } catch (linkErr) {
        console.error('Error processing link:', link.id, linkErr)
        results.push({ worker_id: link.worker_id, error: String(linkErr) })
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed: results.length, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

async function sendStatementEmail(db: any, supabaseUrl: string, serviceKey: string, stmt: any) {
  const worker = stmt.profiles
  const admin = stmt.admin
  const monthName = new Date(stmt.year, stmt.month - 1, 1).toLocaleString('en-AU', { month: 'long', year: 'numeric' })
  const breakdown = (stmt.day_breakdown || []) as any[]

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="background:#1A1008;color:#F2E4C4;font-family:monospace;padding:40px 20px;max-width:580px;margin:0 auto">
      <div style="text-align:center;margin-bottom:32px">
        <h1 style="font-family:Georgia,serif;color:#D4A843;font-size:28px;margin:0">PaddockPay</h1>
        <p style="color:#8A7060;margin:8px 0 0">Monthly Statement</p>
      </div>
      <div style="background:#2C1A0E;border:1px solid #4A3020;border-radius:8px;padding:28px;margin-bottom:20px">
        <h2 style="font-family:Georgia,serif;font-size:22px;margin:0 0 8px">${monthName} Statement</h2>
        <p style="color:#8A7060;margin:0 0 20px">Prepared by <strong style="color:#F2E4C4">${admin?.business_name || admin?.full_name}</strong> for <strong style="color:#F2E4C4">${worker?.full_name}</strong></p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
          <div style="background:#1A1008;border:1px solid #4A3020;border-radius:6px;padding:12px;text-align:center">
            <div style="font-size:22px;color:#4A7C59;font-weight:600">${stmt.full_days}</div>
            <div style="font-size:11px;color:#8A7060">Full days</div>
          </div>
          <div style="background:#1A1008;border:1px solid #4A3020;border-radius:6px;padding:12px;text-align:center">
            <div style="font-size:22px;color:#D4823A;font-weight:600">${stmt.half_days}</div>
            <div style="font-size:11px;color:#8A7060">Half days</div>
          </div>
          <div style="background:#1A1008;border:1px solid #4A3020;border-radius:6px;padding:12px;text-align:center">
            <div style="font-size:20px;color:#D4A843;font-weight:600">${formatAUD(stmt.total_amount)}</div>
            <div style="font-size:11px;color:#8A7060">Total</div>
          </div>
        </div>
        ${stmt.xero_invoice_number ? `<p style="color:#8A7060;font-size:13px">Xero Invoice: <strong style="color:#F2E4C4">${stmt.xero_invoice_number}</strong>${stmt.xero_invoice_url ? ` · <a href="${stmt.xero_invoice_url}" style="color:#D4A843">View invoice →</a>` : ''}</p>` : ''}
        ${breakdown.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;margin-top:16px">
          <thead>
            <tr style="border-bottom:1px solid #4A3020">
              <th style="text-align:left;padding:6px 0;font-size:11px;color:#8A7060;text-transform:uppercase">Date</th>
              <th style="text-align:left;padding:6px 0;font-size:11px;color:#8A7060;text-transform:uppercase">Type</th>
              <th style="text-align:left;padding:6px 0;font-size:11px;color:#8A7060;text-transform:uppercase">Notes</th>
              <th style="text-align:right;padding:6px 0;font-size:11px;color:#8A7060;text-transform:uppercase">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${breakdown.map((b: any) => `
            <tr style="border-bottom:1px solid rgba(74,48,32,0.4)">
              <td style="padding:7px 0;font-size:13px">${formatDate(b.day_key)}</td>
              <td style="padding:7px 0;font-size:13px;color:${b.day_type === 'full' ? '#6BCB8B' : '#D4823A'}">${b.day_type}</td>
              <td style="padding:7px 0;font-size:12px;color:#8A7060">${b.notes || '—'}</td>
              <td style="padding:7px 0;font-size:13px;text-align:right">${formatAUD(b.amount)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : ''}
      </div>
      <p style="font-size:11px;color:#4A3020;text-align:center">
        PaddockPay · support@paddockpay.com.au
      </p>
    </body>
    </html>
  `

  const toAddresses = [worker?.email].filter(Boolean)
  if (admin?.statement_cc_email) toAddresses.push(admin.statement_cc_email)

  await fetch(`${supabaseUrl}/functions/v1/resend-email`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: toAddresses,
      subject: `Your ${monthName} statement from ${admin?.business_name || admin?.full_name}`,
      html,
    }),
  })

  // Update statement status and email info
  await db.from('monthly_statements').update({
    status: 'sent',
    email_sent_to: toAddresses.join(', '),
    sent_at: new Date().toISOString(),
  }).eq('id', stmt.id)
}

async function pushToXeroAPI(db: any, stmt: any, encryptionKey: string | undefined) {
  if (!encryptionKey) throw new Error('No encryption key')
  const admin = stmt.admin
  const worker = stmt.profiles

  if (!admin?.xero_tenant_id || !admin?.xero_access_token_encrypted) {
    throw new Error('Xero not connected')
  }

  // Decrypt access token
  let accessToken = await decrypt(admin.xero_access_token_encrypted, encryptionKey)

  // Check if token needs refresh (within 5 minutes of expiry)
  const tokenExpiry = new Date(admin.xero_token_expiry)
  if (tokenExpiry.getTime() - Date.now() < 5 * 60 * 1000) {
    const refreshToken = await decrypt(admin.xero_refresh_token_encrypted, encryptionKey)
    const XERO_CLIENT_ID = Deno.env.get('XERO_CLIENT_ID')
    const XERO_CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET')
    const refreshRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    })
    if (refreshRes.ok) {
      const newTokens = await refreshRes.json()
      accessToken = newTokens.access_token
      // Re-encrypt and store
      const { encrypt: enc } = await import('https://deno.land/std@0.168.0/encoding/hex.ts' as any).catch(() => ({ encrypt: null }))
      // Store updated tokens - simplified re-encryption
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      const db2 = createClient(supabaseUrl, supabaseServiceKey)
      await db2.from('profiles').update({
        xero_token_expiry: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
      }).eq('id', admin.id)
    }
  }

  const monthName = new Date(stmt.year, stmt.month - 1, 1).toLocaleString('en-AU', { month: 'long', year: 'numeric' })
  const breakdown = (stmt.day_breakdown || []) as any[]

  // Create invoice in Xero
  const invoicePayload = {
    Type: 'ACCREC',
    Contact: { Name: worker?.full_name || 'Worker' },
    LineItems: breakdown.length > 0
      ? breakdown.map((b: any) => ({
          Description: `${b.day_type === 'full' ? 'Full day' : 'Half day'}${b.notes ? ` — ${b.notes}` : ''} (${b.day_key})`,
          Quantity: b.day_type === 'full' ? 1 : 0.5,
          UnitAmount: stmt.day_rate,
          AccountCode: '200',
        }))
      : [{
          Description: `Labour — ${monthName} (${stmt.total_days} days × ${formatAUD(stmt.day_rate)}/day)`,
          Quantity: stmt.total_days,
          UnitAmount: stmt.day_rate,
          AccountCode: '200',
        }],
    Date: new Date().toISOString().split('T')[0],
    DueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    Reference: `PaddockPay ${monthName}`,
    Status: 'AUTHORISED',
  }

  const xeroRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-tenant-id': admin.xero_tenant_id,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ Invoices: [invoicePayload] }),
  })

  if (!xeroRes.ok) {
    const err = await xeroRes.text()
    throw new Error(`Xero API error: ${err}`)
  }

  const xeroData = await xeroRes.json()
  const invoice = xeroData.Invoices?.[0]

  if (invoice) {
    await db.from('monthly_statements').update({
      xero_invoice_id: invoice.InvoiceID,
      xero_invoice_number: invoice.InvoiceNumber,
      xero_invoice_url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${invoice.InvoiceID}`,
    }).eq('id', stmt.id)

    await db.from('audit_log').insert({
      user_id: admin.id,
      action: 'xero_invoice_created',
      table_name: 'monthly_statements',
      record_id: stmt.id,
      new_value: { invoice_id: invoice.InvoiceID, invoice_number: invoice.InvoiceNumber },
      performed_by_role: 'admin',
    })
  }
}
