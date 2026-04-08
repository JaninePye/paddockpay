import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// AES-256-CBC encryption helpers
async function encrypt(text: string, keyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  )
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const encoded = new TextEncoder().encode(text)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, encoded)
  const result = new Uint8Array(iv.byteLength + encrypted.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(encrypted), iv.byteLength)
  return bytesToHex(result)
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

const BASE_URL = 'https://janinepye.github.io/paddockpay'

serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return Response.redirect(`${BASE_URL}/#/settings?xero=error`, 302)
  }

  if (!code || !state) {
    return Response.redirect(`${BASE_URL}/#/settings?xero=error`, 302)
  }

  // Extract user_id from state (format: userId.timestamp)
  const userId = state.split('.')[0]
  if (!userId || userId.length < 10) {
    return Response.redirect(`${BASE_URL}/#/settings?xero=error`, 302)
  }

  try {
    const XERO_CLIENT_ID = Deno.env.get('XERO_CLIENT_ID')
    const XERO_CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET')
    const TOKEN_ENCRYPTION_KEY = Deno.env.get('TOKEN_ENCRYPTION_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    if (!XERO_CLIENT_ID || !XERO_CLIENT_SECRET || !TOKEN_ENCRYPTION_KEY) {
      console.error('Missing Xero credentials in environment')
      return Response.redirect(`${BASE_URL}/#/settings?xero=error`, 302)
    }

    const db = createClient(supabaseUrl, supabaseServiceKey)

    const redirectUri = `${supabaseUrl}/functions/v1/xero-callback`

    // Exchange auth code for tokens
    const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!tokenResponse.ok) {
      const err = await tokenResponse.text()
      console.error('Token exchange failed:', err)
      return Response.redirect(`${BASE_URL}/#/settings?xero=error`, 302)
    }

    const tokens = await tokenResponse.json()
    const { access_token, refresh_token, expires_in } = tokens

    // Get Xero tenant/org info
    const connectionsRes = await fetch('https://api.xero.com/connections', {
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    })

    let tenantId = ''
    let orgName = ''

    if (connectionsRes.ok) {
      const connections = await connectionsRes.json()
      if (connections.length > 0) {
        tenantId = connections[0].tenantId
        orgName = connections[0].tenantName || 'Xero'
      }
    }

    // Encrypt tokens before storing
    const encryptedAccess = await encrypt(access_token, TOKEN_ENCRYPTION_KEY)
    const encryptedRefresh = await encrypt(refresh_token, TOKEN_ENCRYPTION_KEY)
    const tokenExpiry = new Date(Date.now() + expires_in * 1000).toISOString()

    // Store in profiles
    const { error: updateErr } = await db.from('profiles').update({
      xero_tenant_id: tenantId,
      xero_access_token_encrypted: encryptedAccess,
      xero_refresh_token_encrypted: encryptedRefresh,
      xero_token_expiry: tokenExpiry,
      xero_org_name: orgName,
    }).eq('id', userId)

    if (updateErr) {
      console.error('Failed to store Xero tokens:', updateErr)
      return Response.redirect(`${BASE_URL}/#/settings?xero=error`, 302)
    }

    // Write audit log
    await db.from('audit_log').insert({
      user_id: userId,
      action: 'xero_connected',
      table_name: 'profiles',
      record_id: userId,
      new_value: { xero_org_name: orgName, tenant_id: tenantId },
      performed_by_role: 'admin',
    })

    return Response.redirect(`${BASE_URL}/#/settings?xero=connected`, 302)
  } catch (err) {
    console.error('Xero callback error:', err)
    return Response.redirect(`${BASE_URL}/#/settings?xero=error`, 302)
  }
})
