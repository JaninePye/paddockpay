import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { admin_id, invited_email, day_rate } = await req.json()

    if (!admin_id || !invited_email || !day_rate) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const db = createClient(supabaseUrl, supabaseServiceKey)

    // Verify admin exists and is active
    const { data: admin, error: adminErr } = await db
      .from('profiles')
      .select('id, full_name, business_name, subscription_status, trial_ends_at')
      .eq('id', admin_id)
      .single()

    if (adminErr || !admin) {
      return new Response(
        JSON.stringify({ error: 'Admin not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create invitation record
    const { data: invite, error: invErr } = await db
      .from('invitations')
      .insert({
        admin_id,
        invited_email,
        day_rate,
      })
      .select()
      .single()

    if (invErr || !invite) {
      throw new Error(invErr?.message || 'Failed to create invitation')
    }

    const bizName = admin.business_name || admin.full_name || 'PaddockPay'
    const inviteUrl = `https://janinepye.github.io/paddockpay/#/accept-invite?token=${invite.token}`
    const formattedRate = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(day_rate)

    // Send invitation email
    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="background:#1A1008;color:#F2E4C4;font-family:monospace;padding:40px 20px;max-width:560px;margin:0 auto">
        <div style="text-align:center;margin-bottom:32px">
          <h1 style="font-family:Georgia,serif;color:#D4A843;font-size:28px;margin:0">PaddockPay</h1>
        </div>
        <div style="background:#2C1A0E;border:1px solid #4A3020;border-radius:8px;padding:28px">
          <h2 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px">You've been invited</h2>
          <p style="color:#8A7060;margin:0 0 16px">
            <strong style="color:#F2E4C4">${bizName}</strong> has invited you to join PaddockPay as a worker.
          </p>
          <div style="background:#1A1008;border:1px solid #4A3020;border-radius:6px;padding:16px;margin:16px 0">
            <div style="font-size:13px;color:#8A7060;margin-bottom:4px">Your day rate</div>
            <div style="font-size:24px;color:#D4A843;font-weight:600">${formattedRate}/day</div>
          </div>
          <p style="color:#8A7060;margin:0 0 24px;font-size:13px">
            This invitation expires in 7 days. Click the button below to accept.
          </p>
          <a href="${inviteUrl}"
             style="display:block;background:#D4A843;color:#1A1008;text-decoration:none;padding:14px 24px;border-radius:6px;text-align:center;font-weight:600;font-size:15px">
            Accept invitation
          </a>
          <p style="font-size:11px;color:#4A3020;margin:16px 0 0;text-align:center">
            Or copy this link: ${inviteUrl}
          </p>
        </div>
        <p style="font-size:11px;color:#4A3020;text-align:center;margin-top:24px">
          PaddockPay · Labour tracking for agricultural contractors<br>
          Questions? support@paddockpay.com.au
        </p>
      </body>
      </html>
    `

    // Call resend-email function
    const emailRes = await fetch(`${supabaseUrl}/functions/v1/resend-email`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: invited_email,
        subject: `You've been invited to join ${bizName} on PaddockPay`,
        html,
      }),
    })

    const emailData = await emailRes.json()

    // Write audit log
    await db.from('audit_log').insert({
      user_id: admin_id,
      action: 'worker_linked',
      table_name: 'invitations',
      record_id: invite.id,
      new_value: { invited_email, day_rate },
      performed_by_role: 'admin',
    })

    return new Response(
      JSON.stringify({ success: true, invitation_id: invite.id, email_sent: emailData.success }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
