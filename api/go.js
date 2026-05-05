// api/go.js
// Vercel Serverless Function — Tracking clics + redirection
//
// URL format : /api/go?ref=USER_ID&offer=OFFER_ID
//
// Flux complet :
//  1. Valide les paramètres
//  2. Récupère l'URL de l'offre depuis Supabase
//  3. Insère un clic dans link_clicks (déclenche le realtime dashboard)
//  4. Incrémente total_clicks dans profiles (via RPC ou update direct)
//  5. Redirige vers offer.url?ref=USER_ID

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service_role pour bypasser le RLS
)

export default async function handler(req, res) {
  const { ref: userId, offer: offerId } = req.query

  // ── CORS (utile si appelé depuis un domaine différent) ────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!userId || !offerId) {
    return res.status(400).send('Paramètres manquants (ref et offer requis).')
  }

  // Validation UUID basique (évite les injections)
  const UUID_RE = /^[0-9a-f-]{32,36}$/i
  if (!UUID_RE.test(userId) || !UUID_RE.test(offerId)) {
    return res.status(400).send('Paramètres invalides.')
  }

  try {
    // ── 1. Récupérer l'URL de l'offre ────────────────────────────────────────
    const { data: offer, error: offerError } = await supabase
      .from('offers')
      .select('url, title, status')
      .eq('id', offerId)
      .single()

    if (offerError || !offer || !offer.url) {
      console.error('[go.js] Offre introuvable:', offerId, offerError?.message)
      return res.status(404).send('Offre introuvable.')
    }

    if (offer.status && offer.status !== 'active') {
      // Offre désactivée → rediriger quand même mais sans logguer
      return res.redirect(302, offer.url)
    }

    // ── 2. Construire l'URL finale avec ?ref=userId ───────────────────────────
    const separator = offer.url.includes('?') ? '&' : '?'
    const finalUrl  = `${offer.url}${separator}ref=${userId}`

    // ── 3. Insérer le clic dans link_clicks (non-bloquant) ────────────────────
    // Cette table déclenche le realtime écouté par le dashboard
    const clickPromise = supabase
      .from('link_clicks')
      .insert({
        user_id:    userId,    // l'affilieur (celui dont le lien a été cliqué)
        offer_id:   offerId,
        ip:         req.headers['x-forwarded-for']?.split(',')[0].trim()
                    || req.socket?.remoteAddress
                    || null,
        user_agent: req.headers['user-agent'] || null,
        // created_at est géré automatiquement par Supabase (default: now())
      })
      .then(({ error }) => {
        if (error) console.error('[go.js] link_clicks insert error:', error.message)
      })

    // ── 4. Incrémenter total_clicks dans profiles (non-bloquant) ─────────────
    // Utilise une RPC si disponible, sinon update manuel
    // Option A : via RPC Supabase (recommandé — atomique)
    //   CREATE OR REPLACE FUNCTION increment_clicks(uid uuid)
    //   RETURNS void LANGUAGE sql AS $$
    //     UPDATE profiles SET total_clicks = COALESCE(total_clicks, 0) + 1
    //     WHERE user_id = uid;
    //   $$;
    const incrPromise = supabase
      .rpc('increment_clicks', { uid: userId })
      .then(({ error }) => {
        if (error) {
          // Fallback si la RPC n'existe pas : lire puis écrire
          console.warn('[go.js] RPC increment_clicks indisponible, fallback manual:', error.message)
          return supabase
            .from('profiles')
            .select('total_clicks')
            .eq('user_id', userId)
            .single()
            .then(({ data: p }) => {
              if (!p) return
              return supabase
                .from('profiles')
                .update({ total_clicks: (p.total_clicks ?? 0) + 1 })
                .eq('user_id', userId)
            })
        }
      })

    // On lance les deux en parallèle sans bloquer la redirection
    Promise.all([clickPromise, incrPromise]).catch(err =>
      console.error('[go.js] tracking error (non-bloquant):', err)
    )

    // ── 5. Rediriger immédiatement ────────────────────────────────────────────
    return res.redirect(302, finalUrl)

  } catch (err) {
    console.error('[go.js] Erreur serveur:', err)
    return res.status(500).send('Erreur serveur.')
  }
}
