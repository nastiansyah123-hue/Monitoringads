module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    token, ad_account_id, page_id,
    campaign_name, objective, daily_budget, lifetime_budget,
    age_min, age_max, genders,
    primary_text, headline, description, cta, website_url,
    image_hashes, // array of { hash, name }
    status
  } = req.body || {};

  if (!token)          return res.status(400).json({ error: 'token required' });
  if (!ad_account_id)  return res.status(400).json({ error: 'ad_account_id required' });
  if (!page_id)        return res.status(400).json({ error: 'page_id required' });
  if (!campaign_name)  return res.status(400).json({ error: 'campaign_name required' });
  if (!image_hashes || !image_hashes.length) return res.status(400).json({ error: 'image_hashes required' });

  const BASE = 'https://graph.facebook.com/v19.0';
  const campStatus = status || 'PAUSED';

  // Map objective → optimization_goal + billing_event
  const goalMap = {
    OUTCOME_LEADS:          { opt: 'LEAD_GENERATION',      bill: 'IMPRESSIONS' },
    OUTCOME_TRAFFIC:        { opt: 'LINK_CLICKS',           bill: 'LINK_CLICKS' },
    OUTCOME_SALES:          { opt: 'OFFSITE_CONVERSIONS',   bill: 'IMPRESSIONS' },
    OUTCOME_ENGAGEMENT:     { opt: 'POST_ENGAGEMENT',       bill: 'POST_ENGAGEMENT' },
    OUTCOME_AWARENESS:      { opt: 'REACH',                 bill: 'IMPRESSIONS' },
    OUTCOME_APP_PROMOTION:  { opt: 'APP_INSTALLS',          bill: 'IMPRESSIONS' },
  };
  const { opt: optimization_goal, bill: billing_event } = goalMap[objective] || goalMap.OUTCOME_LEADS;

  try {
    // 1. Create Campaign
    const campRes = await fetch(`${BASE}/${ad_account_id}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: campaign_name,
        objective: objective || 'OUTCOME_LEADS',
        status: campStatus,
        special_ad_categories: [],
        access_token: token
      })
    });
    const camp = await campRes.json();
    if (camp.error) return res.status(400).json({ step: 'campaign', error: camp.error.message });

    // 2. Create Ad Set
    const targeting = {
      geo_locations: { countries: ['ID'] },
      age_min: age_min || 18,
      age_max: age_max || 65
    };
    if (genders && genders !== 'all') targeting.genders = [parseInt(genders)];

    const adsetRes = await fetch(`${BASE}/${ad_account_id}/adsets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: campaign_name + ' — Ad Set',
        campaign_id: camp.id,
        ...(lifetime_budget ? { lifetime_budget: Math.round(lifetime_budget) } : { daily_budget: Math.round(daily_budget || 50000) }),
        billing_event,
        optimization_goal,
        targeting,
        status: campStatus,
        access_token: token
      })
    });
    const adset = await adsetRes.json();
    if (adset.error) return res.status(400).json({ step: 'adset', error: adset.error.message });

    // 3. Create Creative + Ad for each image hash
    const createdAds = [];
    for (let i = 0; i < image_hashes.length; i++) {
      const { hash, name: imgName } = image_hashes[i];
      const adName = `${campaign_name} — ${imgName || 'Ad ' + (i + 1)}`;

      // Create Ad Creative
      const creativeBody = {
        name: adName + ' Creative',
        object_story_spec: {
          page_id,
          link_data: {
            image_hash: hash,
            link: website_url,
            message: primary_text,
            name: headline,
            ...(description ? { description } : {}),
            call_to_action: {
              type: cta || 'LEARN_MORE',
              value: { link: website_url }
            }
          }
        },
        access_token: token
      };
      const creativeRes = await fetch(`${BASE}/${ad_account_id}/adcreatives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creativeBody)
      });
      const creative = await creativeRes.json();
      if (creative.error) {
        createdAds.push({ name: adName, error: creative.error.message });
        continue;
      }

      // Create Ad
      const adRes = await fetch(`${BASE}/${ad_account_id}/ads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: adName,
          adset_id: adset.id,
          creative: { creative_id: creative.id },
          status: campStatus,
          access_token: token
        })
      });
      const ad = await adRes.json();
      if (ad.error) {
        createdAds.push({ name: adName, error: ad.error.message });
      } else {
        createdAds.push({ name: adName, ad_id: ad.id });
      }
    }

    const actId = ad_account_id.replace('act_', '');
    return res.json({
      success: true,
      campaign_id: camp.id,
      adset_id: adset.id,
      ads: createdAds,
      status: campStatus,
      meta_url: `https://www.facebook.com/adsmanager/manage/campaigns?act=${actId}`
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
