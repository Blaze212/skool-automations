// AUTO-GENERATED truth dataset for the on-device extraction eval.
// Source: LinkedInRawCapturesForPromptTesting.html (the "DROP — LLM-bound content"
// fragments — i.e. the exact `trimmedHtml` the sidepanel feeds extractContact()).
// Inputs are byte-exact; `expected` labels were hand-authored. Each record also
// carries `ownerName` (the capturing user) which is threaded into the prompt so
// the model can identify OUR messages in a thread. message_text labels follow the
// "most recent message the owner sent" rule. Regenerate / edit labels in
// scripts/gen-eval-dataset.mjs, not here.
//
// 44 cases across 8 capture categories.

window.EVAL_DATASET = [
  {
    "id": "00-name-links-from-search-page",
    "category": "Name links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/heather-hund/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\">Heather Hund<span> </span><span></span></a>",
    "expected": {
      "name": "Heather Hund",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/heather-hund/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "01-name-links-from-search-page",
    "category": "Name links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/sean-boyce/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\">Sean Boyce<span> </span><span></span></a>",
    "expected": {
      "name": "Sean Boyce",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/sean-boyce/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "02-name-links-from-search-page",
    "category": "Name links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/taniahansraj/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\">Tania H.<span> </span><span></span></a>",
    "expected": {
      "name": "Tania H.",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/taniahansraj/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "03-name-links-from-search-page",
    "category": "Name links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/timbates/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\">Timothy Bates<span> </span><span></span></a>",
    "expected": {
      "name": "Timothy Bates",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/timbates/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "04-name-links-from-search-page",
    "category": "Name links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/kmsmith70/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\">Kevin Smith<span> </span><span></span></a>",
    "expected": {
      "name": "Kevin Smith",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/kmsmith70/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "05-title-links-from-search-page",
    "category": "TITLE Links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/heather-hund/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/heather-hund/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/heather-hund/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"><div>Heather Hund<span> </span></div><figure></figure></a><div><a href=\"https://www.linkedin.com/in/heather-hund/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/heather-hund/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><a href=\"https://www.linkedin.com/in/heather-hund/\">Heather Hund<span> </span><span></span></a><span><span> • 2nd</span></span></p><div><p><span>Fractional Product Marketing, Consumer Insights &amp; Strategy | ex-BCG, Goldman | Stanford GSB | VC-Backed Startups | Artist</span></p></div><div><p><span>San Francisco, California, United States</span></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/search/results/people/?keywords=fractional%20product&amp;origin=GLOBAL_SEARCH_HEADER&amp;network=%5B%22S%22%5D\"><span><span>Pending</span></span></a></div></div></div></div></div></div><div><p><span>About: ...– Fractional Head of Product Marketing, doing consumer insights work and helping the company design and launch a...</span></p></div><div><figure></figure><div><p><span><a href=\"https://www.linkedin.com/in/lauradleach/\"><strong>Laura Leach, MPCC, SPCC, RCC</strong></a><span> </span>is a mutual connection</span></p></div></div></div>",
    "expected": {
      "name": "Heather Hund",
      "title": "Fractional Product Marketing, Consumer Insights & Strategy | ex-BCG, Goldman | Stanford GSB | VC-Backed Startups | Artist",
      "linkedin_url": "https://www.linkedin.com/in/heather-hund/",
      "message_text": null,
      "suggested_event_type": "connection_request"
    }
  },
  {
    "id": "06-title-links-from-search-page",
    "category": "TITLE Links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/sean-boyce/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/sean-boyce/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/sean-boyce/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"><div>Sean Boyce<span> </span></div><figure></figure></a><div><a href=\"https://www.linkedin.com/in/sean-boyce/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/sean-boyce/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><a href=\"https://www.linkedin.com/in/sean-boyce/\">Sean Boyce<span> </span><span></span></a><span><span> • 2nd</span></span></p><div><p><span>Fractional Product and CFO Expert</span></p></div><div><p><span>Greater Philadelphia</span></p></div></div><div><div><div><div><div><button><span><div><span><span>Follow</span></span></div></span></button></div></div></div></div></div></div><div><p><span>Current: Fractional Product Consultant at NxtStep Consulting</span></p></div><div><div><p><span><a href=\"https://www.linkedin.com/search/results/people/?origin=SHARED_FOLLOWERS_CANNED_SEARCH&amp;followerOf=%5B%22ACoAAAJeDSsBQBKN51DAWSrzatcADgD3bq_Ttbc%22%5D\">8K followers</a></span></p></div></div><div><ul><li><figure></figure></li><li><figure></figure></li><li><figure></figure></li></ul><div><p><span><a href=\"https://www.linkedin.com/in/brian-gilmore-914bbb1/\"><strong>Brian Gilmore</strong></a>,<span> </span><a href=\"https://www.linkedin.com/in/xunjing-wu/\"><strong>Xunjing Wu</strong></a><span> </span>and<span> </span><a href=\"https://www.linkedin.com/search/results/people/?origin=SHARED_CONNECTIONS_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAJeDSsBQBKN51DAWSrzatcADgD3bq_Ttbc%22%5D\"><strong>1 other mutual connection</strong></a></span></p></div></div><p><a href=\"https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fnxtstep%2Eio%2F&amp;urlhash=0Rp7&amp;mt=FUJwYCLz4w8wqtcLR08hFrFV0vV6aggeOUTW5jrwFeAiAdnWQMkZ4Yb89HTw8wEC-vYxznrV5ySCB8KVeWE8Xe1vsQU&amp;isSdui=true\">Visit my website</a></p></div>",
    "expected": {
      "name": "Sean Boyce",
      "title": "Fractional Product and CFO Expert",
      "linkedin_url": "https://www.linkedin.com/in/sean-boyce/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "07-title-links-from-search-page",
    "category": "TITLE Links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/taniahansraj/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/taniahansraj/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/taniahansraj/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"><div>Tania H.<span> </span></div><figure></figure></a><div><a href=\"https://www.linkedin.com/in/taniahansraj/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/taniahansraj/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><a href=\"https://www.linkedin.com/in/taniahansraj/\">Tania H.<span> </span><span></span></a><span><span> • 2nd</span></span></p><div><p><span>Product Strategy and Go-to-Market Leader I Fractional Product Marketer I Using a customer-centric approach to help you win with product-led GTM</span></p></div><div><p><span>Los Angeles, California, United States</span></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/search/results/people/?keywords=fractional%20product&amp;origin=GLOBAL_SEARCH_HEADER&amp;network=%5B%22S%22%5D\"><span><span>Pending</span></span></a></div></div></div></div></div></div><div><p><span>Current: Fractional Product Marketer at Conscious PMM</span></p></div><div><div><p><span><a href=\"https://www.linkedin.com/search/results/people/?origin=SHARED_FOLLOWERS_CANNED_SEARCH&amp;followerOf=%5B%22ACoAAAuS_-IBjOGM1VkqtLm5JaeS_x0zs1caRXU%22%5D\">2K followers</a></span></p></div></div><div><figure></figure><div><p><span><a href=\"https://www.linkedin.com/in/avantisenarath/\"><strong>Avanti Senarath</strong></a><span> </span>is a mutual connection</span></p></div></div></div>",
    "expected": {
      "name": "Tania H.",
      "title": "Product Strategy and Go-to-Market Leader I Fractional Product Marketer I Using a customer-centric approach to help you win with product-led GTM",
      "linkedin_url": "https://www.linkedin.com/in/taniahansraj/",
      "message_text": null,
      "suggested_event_type": "connection_request"
    }
  },
  {
    "id": "08-title-links-from-search-page",
    "category": "TITLE Links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/timbates/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/timbates/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/timbates/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"><div>Timothy Bates<span> </span></div><figure></figure></a><div><a href=\"https://www.linkedin.com/in/timbates/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/timbates/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><a href=\"https://www.linkedin.com/in/timbates/\">Timothy Bates<span> </span><span></span></a><span><span> • 2nd</span></span></p><div><p><span>Strategic Advisor | Fractional Product Management | 2X Founder | AI/ML | Growth/Scale | Enterprise Digital Transformation</span></p></div><div><p><span>Boulder, Colorado, United States</span></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/preload/search-custom-invite/?vanityName=timbates\"><span><div><span><span>Connect</span></span></div></span></a></div></div></div></div></div></div><div><p><span>Past: /Strategy - Fractional Product Management and Product Operations, offered insightful leadership and product ideation to emerging...</span></p></div><div><figure></figure><div><p><span><a href=\"https://www.linkedin.com/in/ryancamomile/\"><strong>Ryan Camomile</strong></a><span> </span>is a mutual connection</span></p></div></div></div>",
    "expected": {
      "name": "Timothy Bates",
      "title": "Strategic Advisor | Fractional Product Management | 2X Founder | AI/ML | Growth/Scale | Enterprise Digital Transformation",
      "linkedin_url": "https://www.linkedin.com/in/timbates/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "09-title-links-from-search-page",
    "category": "TITLE Links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/kmsmith70/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/kmsmith70/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/kmsmith70/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"><div>Kevin Smith<span> </span><span> </span>is open to work</div><figure></figure></a><div><a href=\"https://www.linkedin.com/in/kmsmith70/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/kmsmith70/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><a href=\"https://www.linkedin.com/in/kmsmith70/\">Kevin Smith<span> </span><span></span></a><span><span> • 2nd</span></span></p><div><p><span>Fractional &amp; Interim CPO (Chief Product Officer) | Product Advisor | ex-Google | ex-Trilogy</span></p></div><div><p><span>Austin, Texas, United States</span></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/search/results/people/?keywords=fractional%20product&amp;origin=GLOBAL_SEARCH_HEADER&amp;network=%5B%22S%22%5D\"><span><span>Pending</span></span></a></div></div></div></div></div></div><div><p><span>Current:<span> </span><strong><span>Fractional CPO (Chief Product Officer)</span></strong><span> </span>at Just Add Product</span></p></div><div><ul><li><figure></figure></li><li><figure></figure></li></ul><div><p><span><a href=\"https://www.linkedin.com/in/nafeger/\"><strong>Nathan Feger</strong></a><span> </span>and<span> </span><a href=\"https://www.linkedin.com/in/tonyfregoso/\"><strong>Tony Fregoso</strong></a><span> </span>are mutual connections</span></p></div></div></div>",
    "expected": {
      "name": "Kevin Smith",
      "title": "Fractional & Interim CPO (Chief Product Officer) | Product Advisor | ex-Google | ex-Trilogy",
      "linkedin_url": "https://www.linkedin.com/in/kmsmith70/",
      "message_text": null,
      "suggested_event_type": "connection_request"
    }
  },
  {
    "id": "10-title-links-from-search-page",
    "category": "TITLE Links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/davidjreinhold/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/davidjreinhold/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/davidjreinhold/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"><div>Dave Reinhold<span> </span></div><figure></figure></a><div><a href=\"https://www.linkedin.com/in/davidjreinhold/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/davidjreinhold/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><a href=\"https://www.linkedin.com/in/davidjreinhold/\">Dave Reinhold<span> </span><span></span></a><span><span> • 2nd</span></span></p><div><p><span>Fractional CPO | Helping Companies Build from 0→1 and Achieve Product-Market Fit</span></p></div><div><p><span>New York, New York, United States</span></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/search/results/people/?keywords=fractional%20product&amp;origin=GLOBAL_SEARCH_HEADER&amp;network=%5B%22S%22%5D\"><span><span>Pending</span></span></a></div></div></div></div></div></div><div><p><span>Current:<span> </span><strong><span>Fractional Chief Product Officer</span></strong><span> </span>at Loeb.nyc</span></p></div><div><div><p><span><a href=\"https://www.linkedin.com/search/results/people/?origin=SHARED_FOLLOWERS_CANNED_SEARCH&amp;followerOf=%5B%22ACoAAACTEdgB-N2Lm9yBrYpA60WznevdkTt4jjA%22%5D\">3K followers</a></span></p></div></div><div><figure></figure><div><p><span><a href=\"https://www.linkedin.com/in/denys-stukalenko-907022131/\"><strong>Denys Stukalenko</strong></a><span> </span>is a mutual connection</span></p></div></div></div>",
    "expected": {
      "name": "Dave Reinhold",
      "title": "Fractional CPO | Helping Companies Build from 0→1 and Achieve Product-Market Fit",
      "linkedin_url": "https://www.linkedin.com/in/davidjreinhold/",
      "message_text": null,
      "suggested_event_type": "connection_request"
    }
  },
  {
    "id": "11-title-links-from-search-page",
    "category": "TITLE Links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/minati-shah-6009945/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/minati-shah-6009945/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/minati-shah-6009945/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"><div>Minati Shah<span> </span></div><figure></figure></a><div><a href=\"https://www.linkedin.com/in/minati-shah-6009945/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/minati-shah-6009945/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><a href=\"https://www.linkedin.com/in/minati-shah-6009945/\">Minati Shah<span> </span><span></span></a><span><span> • 2nd</span></span></p><div><p><span>Fractional Product Consultant | Product Leader | Passionate About CX, Innovation &amp; Scalable Impact | Ex-Apple, Microsoft, E*TRADE</span></p></div><div><p><span>Mountain View, California, United States</span></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/preload/search-custom-invite/?vanityName=minati-shah-6009945\"><span><div><span><span>Connect</span></span></div></span></a></div></div></div></div></div></div><div><p><span>Current: Fractional Product Manager</span></p></div><div><figure></figure><div><p><span><a href=\"https://www.linkedin.com/in/carmenmartinho/\"><strong>Carmen Gutierrez Martinho</strong></a><span> </span>is a mutual connection</span></p></div></div></div>",
    "expected": {
      "name": "Minati Shah",
      "title": "Fractional Product Consultant | Product Leader | Passionate About CX, Innovation & Scalable Impact | Ex-Apple, Microsoft, E*TRADE",
      "linkedin_url": "https://www.linkedin.com/in/minati-shah-6009945/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "12-title-links-from-search-page",
    "category": "TITLE Links from search page",
    "pageUrl": "https://www.linkedin.com/search/results/people/?keywords=fractional%20product",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/shikha-nalla/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/shikha-nalla/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/shikha-nalla/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"><div>Shikha Nalla<span> </span></div><figure></figure></a><div><a href=\"https://www.linkedin.com/in/shikha-nalla/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/shikha-nalla/?lipi=urn%3Ali%3Apage%3Ad_flagship3_search_srp_people%3BH64D5om8T82O71Mw1FrULw%3D%3D\"></a><a href=\"https://www.linkedin.com/in/shikha-nalla/\">Shikha Nalla<span> </span><span></span></a><span><span> • 2nd</span></span></p><div><p><span>Building something new | Fractional Product Leader | Ex-Tempo, Pivot, Fitbit</span></p></div><div><p><span>Greater Seattle Area</span></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/preload/search-custom-invite/?vanityName=shikha-nalla\"><span><div><span><span>Connect</span></span></div></span></a></div></div></div></div></div></div><div><p><span>Current: Fractional Product Leader at OTM</span></p></div><div><figure></figure><div><p><span><a href=\"https://www.linkedin.com/in/julia-arpag/\"><strong>Julia Arpag</strong></a><span> </span>is a mutual connection</span></p></div></div></div>",
    "expected": {
      "name": "Shikha Nalla",
      "title": "Building something new | Fractional Product Leader | Ex-Tempo, Pivot, Fitbit",
      "linkedin_url": "https://www.linkedin.com/in/shikha-nalla/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "13-profile-name",
    "category": "Profile Name",
    "pageUrl": "https://www.linkedin.com/in/shikha-nalla/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/shikha-nalla/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"><div><div><h2>Shikha Nalla</h2></div></div></a>",
    "expected": {
      "name": "Shikha Nalla",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/shikha-nalla/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "14-profile-name",
    "category": "Profile Name",
    "pageUrl": "https://www.linkedin.com/in/minati-shah-6009945/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/minati-shah-6009945/\"><div><div><h2>Minati Shah</h2></div></div></a>",
    "expected": {
      "name": "Minati Shah",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/minati-shah-6009945/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "15-profile-name",
    "category": "Profile Name",
    "pageUrl": "https://www.linkedin.com/in/br1an-r00t/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/br1an-r00t/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3BDuk%2FvEZJTWCVcGX3aXkbtA%3D%3D\"><div><div><h2>Brian Root</h2></div></div></a>",
    "expected": {
      "name": "Brian Root",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/br1an-r00t/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "16-profile-name",
    "category": "Profile Name",
    "pageUrl": "https://www.linkedin.com/in/mark-koslow-83a0b375/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/mark-koslow-83a0b375/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3BbQxLP%2Bh6Sv6N%2B3mHfJcVyg%3D%3D\"><div><div><h2>Mark Koslow</h2></div></div></a>",
    "expected": {
      "name": "Mark Koslow",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/mark-koslow-83a0b375/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "17-profile-name",
    "category": "Profile Name",
    "pageUrl": "https://www.linkedin.com/in/timbates/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/timbates/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3BIEOKKf0HTee9ELqzeAOeSg%3D%3D\"><div><div><h2>Timothy Bates</h2></div></div></a>",
    "expected": {
      "name": "Timothy Bates",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/timbates/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "18-profile-name",
    "category": "Profile Name",
    "pageUrl": "https://www.linkedin.com/in/taniahansraj/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/taniahansraj/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3BwAn5QJZbQcuePivQN4lhqw%3D%3D\"><div><div><h2>Tania H.</h2></div></div></a>",
    "expected": {
      "name": "Tania H.",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/taniahansraj/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "19-profile-name",
    "category": "Profile Name",
    "pageUrl": "https://www.linkedin.com/in/sean-boyce/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/sean-boyce/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3BpI%2FIERoaT8qH%2F1KGHv1N5A%3D%3D\"><div><h2>Sean Boyce</h2></div></a>",
    "expected": {
      "name": "Sean Boyce",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/sean-boyce/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "20-profile-manually-highlight-header",
    "category": "Profile Manually highlight header",
    "pageUrl": "https://www.linkedin.com/in/sean-boyce/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<div><div><div><div><a href=\"https://www.linkedin.com/in/sean-boyce/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3BIa9071yfRSuYe%2BbtNWYXeg%3D%3D\"><div><h2>Sean Boyce</h2></div></a><p>He/Him</p><p>· 2nd</p></div><p>Fractional Product and CFO Expert</p><div><p>Greater Philadelphia</p><p>·</p><p><a href=\"https://www.linkedin.com/in/sean-boyce/#\">Contact info</a></p></div></div></div><div><div><div><div><figure></figure><div><div><div><p><span>NxtStep Consulting</span></p></div></div></div></div></div><div><div><figure></figure><div><div><div><p><span>Drexel University</span></p></div></div></div></div></div></div></div></div><div><p>8,191 followers</p><p>·</p><p>500+</p><p>connections</p></div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAJeDSsBQBKN51DAWSrzatcADgD3bq_Ttbc%22%5D\"></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAJeDSsBQBKN51DAWSrzatcADgD3bq_Ttbc%22%5D\"><ul><li><figure></figure></li><li><figure></figure></li></ul></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAJeDSsBQBKN51DAWSrzatcADgD3bq_Ttbc%22%5D\"></a><p><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAJeDSsBQBKN51DAWSrzatcADgD3bq_Ttbc%22%5D\"><span></span></a><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAJeDSsBQBKN51DAWSrzatcADgD3bq_Ttbc%22%5D\"><strong>Jennifer</strong>,<span> </span><strong>Xunjing</strong><span> </span>and 1 other mutual connection</a></p></div></div><div><div><div><div><div><div><div><button><span><div><span><span>Follow</span></span></div></span></button></div></div></div><div><div><button><span><span>Save in Sales Navigator</span></span></button></div></div><div><a href=\"https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fnxtstep%2Eio%2F&amp;urlhash=0Rp7&amp;mt=1tItQrQGAt47qo8NOvMhUbYZL9-kq7tSi0Vud65K5xPW8JxmEdWydroKJc-64L-mfD1PpNyQ1Uf6T4LcJo5vevkfVKQ&amp;isSdui=true\"><span><span>Visit my website</span></span></a></div><div><button><span></span></button></div></div></div></div></div><br>",
    "expected": {
      "name": "Sean Boyce",
      "title": "Fractional Product and CFO Expert",
      "linkedin_url": "https://www.linkedin.com/in/sean-boyce/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "21-profile-manually-highlight-header",
    "category": "Profile Manually highlight header",
    "pageUrl": "https://www.linkedin.com/in/taniahansraj/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<div><section><div><div><div><div><div><div><div><div><a href=\"https://www.linkedin.com/in/taniahansraj/\"><div><div><h2>Tania H.</h2></div></div></a></div><p>· 2nd</p></div><p>Product Strategy and Go-to-Market Leader I Fractional Product Marketer I Using a customer-centric approach to help you win with product-led GTM</p><div><p>Los Angeles, California, United States</p><p>·</p><p><a href=\"https://www.linkedin.com/in/taniahansraj/#\">Contact info</a></p></div></div></div><div><div><div><div><figure></figure><div><div><div><p><span>Conscious PMM</span></p></div></div></div></div></div><div><div><figure></figure><div><div><div><p><span>University of Southern California - Marshall School of Business</span></p></div></div></div></div></div></div></div></div><p><a href=\"https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fcalendly%2Ecom%2Ftaniahansraj_free_consultation%2Fproduct-marketing-consultation-inquiry%3Fmonth%3D2024-02&amp;urlhash=Yix2&amp;mt=DQMPDAdkHYZDnqORmFSB0EnOn7wPRmnxGkgPs6YSsKqX7QZF6igk2GFZVTO1ng79SCMZnOt9oBO-P-kxjAIfc0hlA7c&amp;isSdui=true\">Book a Connection Call<span> </span></a></p><div><p>1,515 followers</p><p>·</p><p>500+</p><p>connections</p></div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAuS_-IBjOGM1VkqtLm5JaeS_x0zs1caRXU%22%5D\"></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAuS_-IBjOGM1VkqtLm5JaeS_x0zs1caRXU%22%5D\"><figure></figure></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAuS_-IBjOGM1VkqtLm5JaeS_x0zs1caRXU%22%5D\"></a><p><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAuS_-IBjOGM1VkqtLm5JaeS_x0zs1caRXU%22%5D\"><span></span></a><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAuS_-IBjOGM1VkqtLm5JaeS_x0zs1caRXU%22%5D\"><strong>Avanti</strong><span> </span>is a mutual connection</a></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAAuS_-IBjOGM1VkqtLm5JaeS_x0zs1caRXU&amp;recipient=ACoAAAuS_-IBjOGM1VkqtLm5JaeS_x0zs1caRXU&amp;screenContext=NON_SELF_PROFILE_VIEW&amp;interop=msgOverlay\"><span><span>Message</span></span></a></div><div><div><button><span><span>Save in Sales Navigator</span></span></button></div></div><div><button><span></span></button></div></div></div></div></div></div></div></div></section></div><div><div><div><div><div><section><div><div><div></div></div></div></section></div></div></div></div></div><br>",
    "expected": {
      "name": "Tania H.",
      "title": "Product Strategy and Go-to-Market Leader I Fractional Product Marketer I Using a customer-centric approach to help you win with product-led GTM",
      "linkedin_url": "https://www.linkedin.com/in/taniahansraj/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "22-profile-manually-highlight-header",
    "category": "Profile Manually highlight header",
    "pageUrl": "https://www.linkedin.com/in/timbates/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<div><div><a href=\"https://www.linkedin.com/in/timbates/\"><div><div><h2>Timothy Bates</h2></div></div></a></div><p>Awesome / Incredible</p><p>· 2nd</p></div><p>Strategic Advisor | Fractional Product Management | 2X Founder | AI/ML | Growth/Scale | Enterprise Digital Transformation</p><div><p>Boulder, Colorado, United States</p><p>·</p><p><a href=\"https://www.linkedin.com/in/timbates/#\">Contact info</a></p></div>",
    "expected": {
      "name": "Timothy Bates",
      "title": "Strategic Advisor | Fractional Product Management | 2X Founder | AI/ML | Growth/Scale | Enterprise Digital Transformation",
      "linkedin_url": "https://www.linkedin.com/in/timbates/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "23-profile-manually-highlight-header",
    "category": "Profile Manually highlight header",
    "pageUrl": "https://www.linkedin.com/in/mark-koslow-83a0b375/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<div><section><div><div><div><div><div><div><div><div><a href=\"https://www.linkedin.com/in/mark-koslow-83a0b375/\"><div><div><h2>Mark Koslow</h2></div></div></a></div><p>· 2nd</p></div><p>Fractional Product Manager | Ex-Reforge</p><div><p>Los Angeles, California, United States</p><p>·</p><p><a href=\"https://www.linkedin.com/in/mark-koslow-83a0b375/#\">Contact info</a></p></div></div></div><div><div><div><div><figure></figure><div><div><div><p><span>Maple Counseling</span></p></div></div></div></div></div><div><div><figure></figure><div><div><div><p><span>Pacifica Graduate Institute</span></p></div></div></div></div></div></div></div></div><div><p>500+</p><p>connections</p></div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAA_ao-4BjXetjXW3Q2l0B68WNQ_sXRbc5Vk%22%5D\"></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAA_ao-4BjXetjXW3Q2l0B68WNQ_sXRbc5Vk%22%5D\"><ul><li><figure></figure></li><li><figure></figure></li></ul></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAA_ao-4BjXetjXW3Q2l0B68WNQ_sXRbc5Vk%22%5D\"></a><p><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAA_ao-4BjXetjXW3Q2l0B68WNQ_sXRbc5Vk%22%5D\"><span></span></a><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAA_ao-4BjXetjXW3Q2l0B68WNQ_sXRbc5Vk%22%5D\"><strong>Perry</strong><span> </span>and<span> </span><strong>Michael</strong><span> </span>are mutual connections</a></p></div></div><div><div><div><div><div><a href=\"https://www.linkedin.com/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAA_ao-4BjXetjXW3Q2l0B68WNQ_sXRbc5Vk&amp;recipient=ACoAAA_ao-4BjXetjXW3Q2l0B68WNQ_sXRbc5Vk&amp;screenContext=NON_SELF_PROFILE_VIEW&amp;interop=msgOverlay\"><span><span>Message</span></span></a></div><div><div><button><span><span>Save in Sales Navigator</span></span></button></div></div><div><button><span></span></button></div></div></div></div></div></div></div></div></section></div><div><div><div></div></div></div><br>",
    "expected": {
      "name": "Mark Koslow",
      "title": "Fractional Product Manager | Ex-Reforge",
      "linkedin_url": "https://www.linkedin.com/in/mark-koslow-83a0b375/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "24-profile-manually-highlight-header",
    "category": "Profile Manually highlight header",
    "pageUrl": "https://www.linkedin.com/in/br1an-r00t/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<div><div><div><div><div><div><a href=\"https://www.linkedin.com/in/br1an-r00t/\"><div><div><h2>Brian Root</h2></div></div></a></div><p>He/Him</p><p>· 2nd</p></div><p>Fractional CPO | Most product problems live upstream of the product</p><div><p>New York, New York, United States</p><p>·</p><p><a href=\"https://www.linkedin.com/in/br1an-r00t/#\">Contact info</a></p></div></div></div><div><div><div><div><figure></figure><div><div><div><p><span>Rooted In Product</span></p></div></div></div></div></div><div><div><figure></figure><div><div><div><p><span>Princeton University</span></p></div></div></div></div></div></div></div></div><div><p>500+</p><p>connections</p></div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEoqEcB-SPCgPFyq0RRHBxWS6NRhT7F0Po%22%5D\"></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEoqEcB-SPCgPFyq0RRHBxWS6NRhT7F0Po%22%5D\"><figure></figure></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEoqEcB-SPCgPFyq0RRHBxWS6NRhT7F0Po%22%5D\"></a><p><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEoqEcB-SPCgPFyq0RRHBxWS6NRhT7F0Po%22%5D\"><span></span></a><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEoqEcB-SPCgPFyq0RRHBxWS6NRhT7F0Po%22%5D\"><strong>Boomie</strong><span> </span>is a mutual connection</a></p></div></div><div><div><div><div><div><div><div><a href=\"https://www.linkedin.com/preload/custom-invite/?vanityName=br1an-r00t\"><span><div><span><span>Connect</span></span></div></span></a></div></div></div><div><div><button><span><span>Save in Sales Navigator</span></span></button></div></div><div><a href=\"https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fwww%2Erootedinproduct%2Ecom&amp;urlhash=qhba&amp;mt=1e4bKpDySZe9NnTMai6O3btNs3rc08FEelRhrGLDxtyo6wg9A5fN0qdC99q0Q5li8h8JIfpuWE6yglTmsmEQLZOeo5M&amp;isSdui=true\"><span><span>Visit my website</span></span></a></div><div><button><span></span></button></div></div></div></div></div></div><div><div><div><section><ul><li><div><div><a href=\"https://www.linkedin.com/in/br1an-r00t/opportunities/volunteering/details/\"><div><div></div></div></a></div></div></li></ul></section></div></div></div><br>",
    "expected": {
      "name": "Brian Root",
      "title": "Fractional CPO | Most product problems live upstream of the product",
      "linkedin_url": "https://www.linkedin.com/in/br1an-r00t/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "25-profile-manually-highlight-header",
    "category": "Profile Manually highlight header",
    "pageUrl": "https://www.linkedin.com/in/minati-shah-6009945/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<div><div><div><div><div><div><a href=\"https://www.linkedin.com/in/minati-shah-6009945/\"><div><div><h2>Minati Shah</h2></div></div></a></div><p>She/Her</p><p>· 2nd</p></div><p>Fractional Product Consultant | Product Leader | Passionate About CX, Innovation &amp; Scalable Impact | Ex-Apple, Microsoft, E*TRADE</p><div><p>Mountain View, California, United States</p><p>·</p><p><a href=\"https://www.linkedin.com/in/minati-shah-6009945/#\">Contact info</a></p></div></div></div><div><div><div><div><figure></figure><div><div><div><p><span></span></p></div></div></div></div></div><div><div><figure></figure><div><div><div><p><span>General Assembly</span></p></div></div></div></div></div></div></div></div><div><p>500+</p><p>connections</p></div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEI82ABzVxVYV9Zug78U32dy_FguWAHSPM%22%5D\"></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEI82ABzVxVYV9Zug78U32dy_FguWAHSPM%22%5D\"><figure></figure></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEI82ABzVxVYV9Zug78U32dy_FguWAHSPM%22%5D\"></a><p><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEI82ABzVxVYV9Zug78U32dy_FguWAHSPM%22%5D\"><span></span></a><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAEI82ABzVxVYV9Zug78U32dy_FguWAHSPM%22%5D\"><strong>Carmen</strong><span> </span>is a mutual connection</a></p></div></div><div><div><div><div><div><div><div><a href=\"https://www.linkedin.com/preload/custom-invite/?vanityName=minati-shah-6009945\"><span><div><span><span>Connect</span></span></div></span></a></div></div></div><div><div><button><span><span>Save in Sales Navigator</span></span></button></div></div><div><button><span></span></button></div></div></div></div></div></div><div><div><div><section><ul><li><div><div><a href=\"https://www.linkedin.com/in/minati-shah-6009945/opportunities/volunteering/details/\"><div><div></div></div></a></div></div></li></ul></section></div></div></div><br>",
    "expected": {
      "name": "Minati Shah",
      "title": "Fractional Product Consultant | Product Leader | Passionate About CX, Innovation & Scalable Impact | Ex-Apple, Microsoft, E*TRADE",
      "linkedin_url": "https://www.linkedin.com/in/minati-shah-6009945/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "26-profile-manually-highlight-header",
    "category": "Profile Manually highlight header",
    "pageUrl": "https://www.linkedin.com/in/shikha-nalla/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<div><section><div><div><div><div><div><div><div><div><a href=\"https://www.linkedin.com/in/shikha-nalla/\"><div><div><h2>Shikha Nalla</h2></div></div></a></div><p>· 2nd</p></div><p>Building something new | Fractional Product Leader | Ex-Tempo, Pivot, Fitbit</p><div><p>Greater Seattle Area</p><p>·</p><p><a href=\"https://www.linkedin.com/in/shikha-nalla/#\">Contact info</a></p></div></div></div><div><div><div><div><figure></figure><div><div><div><p><span>OTM</span></p></div></div></div></div></div><div><div><figure></figure><div><div><div><p><span>Carnegie Mellon University - School of Computer Science - Human-Computer Interaction Institute</span></p></div></div></div></div></div></div></div></div><div><p>500+</p><p>connections</p></div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAwlSVwB3frw1d7HGrRf71zErcHt5SDyUFk%22%5D\"></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAwlSVwB3frw1d7HGrRf71zErcHt5SDyUFk%22%5D\"><figure></figure></a><div><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAwlSVwB3frw1d7HGrRf71zErcHt5SDyUFk%22%5D\"></a><p><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAwlSVwB3frw1d7HGrRf71zErcHt5SDyUFk%22%5D\"><span></span></a><a href=\"https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&amp;network=%5B%22F%22%5D&amp;connectionOf=%5B%22ACoAAAwlSVwB3frw1d7HGrRf71zErcHt5SDyUFk%22%5D\"><strong>Julia</strong><span> </span>is a mutual connection</a></p></div></div><div><div><div><div><div><div><div><a href=\"https://www.linkedin.com/preload/custom-invite/?vanityName=shikha-nalla\"><span><div><span><span>Connect</span></span></div></span></a></div></div></div><div><div><button><span><span>Save in Sales Navigator</span></span></button></div></div><div><button><span></span></button></div></div></div></div></div></div></div></div></section></div><div><div><div><div><div><section><div><div><div></div></div></div></section></div></div></div></div></div><br>",
    "expected": {
      "name": "Shikha Nalla",
      "title": "Building something new | Fractional Product Leader | Ex-Tempo, Pivot, Fitbit",
      "linkedin_url": "https://www.linkedin.com/in/shikha-nalla/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "27-profile-side-panle-connects-name-drag",
    "category": "Profile side panle connects name drag",
    "pageUrl": "",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/phoebef/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\">Phoebe Fan<span> </span><span></span></a>",
    "expected": {
      "name": "Phoebe Fan",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/phoebef/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "28-profile-side-panle-connects-name-drag",
    "category": "Profile side panle connects name drag",
    "pageUrl": "",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/sanjeet-singh06/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\">Sanjeet Singh<span> </span><span></span></a>",
    "expected": {
      "name": "Sanjeet Singh",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/sanjeet-singh06/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "29-profile-side-panle-connects-name-drag",
    "category": "Profile side panle connects name drag",
    "pageUrl": "",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/nicole-roze/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\">Nicole Roze<span> </span><span></span></a>",
    "expected": {
      "name": "Nicole Roze",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/nicole-roze/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "30-profile-side-panle-connects-name-drag",
    "category": "Profile side panle connects name drag",
    "pageUrl": "",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/jess-thevenoz/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\">Jess Thevenoz<span> </span><span></span></a>",
    "expected": {
      "name": "Jess Thevenoz",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/jess-thevenoz/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "31-profile-side-panle-connects-name-drag",
    "category": "Profile side panle connects name drag",
    "pageUrl": "",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/ashleykera/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\">Ashley Kera<span> </span><span></span></a>",
    "expected": {
      "name": "Ashley Kera",
      "title": null,
      "linkedin_url": "https://www.linkedin.com/in/ashleykera/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "32-profile-side-panel-connects-message-drag",
    "category": "Profile side panel connects message drag",
    "pageUrl": "",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/phoebef/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/phoebef/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"><figure></figure></a><div><a href=\"https://www.linkedin.com/in/phoebef/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/phoebef/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/phoebef/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/phoebef/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"><span></span></a><a href=\"https://www.linkedin.com/in/phoebef/\">Phoebe Fan<span> </span><span></span></a></p></div><p>· 2nd</p></div><div><p><span>Operating Partner @ Foothill Ventures | Ecosystem Builder to Empower Frontier Builders in AI &amp; Deep Tech</span></p></div></div></div>",
    "expected": {
      "name": "Phoebe Fan",
      "title": "Operating Partner @ Foothill Ventures | Ecosystem Builder to Empower Frontier Builders in AI & Deep Tech",
      "linkedin_url": "https://www.linkedin.com/in/phoebef/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "33-profile-side-panel-connects-message-drag",
    "category": "Profile side panel connects message drag",
    "pageUrl": "",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/jess-thevenoz/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/jess-thevenoz/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"><figure></figure></a><div><a href=\"https://www.linkedin.com/in/jess-thevenoz/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/jess-thevenoz/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/jess-thevenoz/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/jess-thevenoz/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"><span></span></a><a href=\"https://www.linkedin.com/in/jess-thevenoz/\">Jess Thevenoz<span> </span><span></span></a></p></div><p>· 2nd</p></div><div><p><span>Founder of Theodora | Find wine you love without becoming a sommelier</span></p></div></div></div>",
    "expected": {
      "name": "Jess Thevenoz",
      "title": "Founder of Theodora | Find wine you love without becoming a sommelier",
      "linkedin_url": "https://www.linkedin.com/in/jess-thevenoz/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "34-profile-side-panel-connects-message-drag",
    "category": "Profile side panel connects message drag",
    "pageUrl": "",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<a href=\"https://www.linkedin.com/in/ashleykera/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/ashleykera/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"><figure></figure></a><div><a href=\"https://www.linkedin.com/in/ashleykera/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/ashleykera/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><div><a href=\"https://www.linkedin.com/in/ashleykera/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"></a><p><a href=\"https://www.linkedin.com/in/ashleykera/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base%3B7%2F6H1%2FnUS%2BmY7WvdFQ2Q5g%3D%3D\"><span></span></a><a href=\"https://www.linkedin.com/in/ashleykera/\">Ashley Kera<span> </span><span></span></a></p></div><p>· 2nd</p></div><div><p><span>People Ops Consultant &amp; Coach | Scaled multimillion-dollar talent programs | I help orgs scale smarter and women move through change with clarity and self-trust</span></p></div></div></div>",
    "expected": {
      "name": "Ashley Kera",
      "title": "People Ops Consultant & Coach | Scaled multimillion-dollar talent programs | I help orgs scale smarter and women move through change with clarity and self-trust",
      "linkedin_url": "https://www.linkedin.com/in/ashleykera/",
      "message_text": null,
      "suggested_event_type": null
    }
  },
  {
    "id": "35-messager-pop-ups-highlighting",
    "category": "Messager pop ups highlighting",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><a href=\"https://www.linkedin.com/in/ACoAABv4_WUB6LM7ArEcx5A-UU-mPm0TnpT43M8\"><div><div></div></div></a><div><div><span><a href=\"https://www.linkedin.com/in/ACoAABv4_WUB6LM7ArEcx5A-UU-mPm0TnpT43M8\"><span>Jesse Leonard<span> </span></span></a></span><div><span>1st degree connection</span><span>· 1st</span></div></div><div><div>Founder &amp; CEO at Leonard Workforce Solutions | Helping companies hire better, lead stronger, and grow faster</div></div></div></div></div></li><li><time>Thursday</time><span>Barton Holdridge sent the following message at 4:22 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>4:22 PM</time></div><div><div><ul><li><div><span></span></div></li><li><div><span></span></div></li><li><div><span></span></div></li></ul><div><span><button><li-icon></li-icon></button></span></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Hey Jesse, appreciate the connection.<br><br>I’ve been building submittal and workflow automations with a few boutique agencies and noticed Leonard Workforce Solutions is doing a lot of recruiting and staffing work.<br><br>I put together a tiny tool that takes a candidate’s resume + target role and auto‑builds a client‑ready submittal in your branding (snapshot, ‘why this candidate,’ key qualifications) and logs time saved per run.<br><br>Would you be open to a 60‑second Loom showing how it works on a sample candidate, just to see if it’s relevant for your stack?</p></div><span></span></div></div></div></li><li><time>Today</time><span>Jesse Leonard sent the following message at 12:35 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABv4_WUB6LM7ArEcx5A-UU-mPm0TnpT43M8\"><span>View Jesse’s profile</span></a></div></li></ul>",
    "expected": {
      "name": "Jesse Leonard",
      "title": "Founder & CEO at Leonard Workforce Solutions | Helping companies hire better, lead stronger, and grow faster",
      "linkedin_url": "https://www.linkedin.com/in/ACoAABv4_WUB6LM7ArEcx5A-UU-mPm0TnpT43M8",
      "message_text": "Hey Jesse, appreciate the connection.\n\nI've been building submittal and workflow automations with a few boutique agencies and noticed Leonard Workforce Solutions is doing a lot of recruiting and staffing work.\n\nI put together a tiny tool that takes a candidate's resume + target role and auto-builds a client-ready submittal in your branding (snapshot, 'why this candidate,' key qualifications) and logs time saved per run.\n\nWould you be open to a 60-second Loom showing how it works on a sample candidate, just to see if it's relevant for your stack?",
      "suggested_event_type": "direct_message"
    }
  },
  {
    "id": "36-messager-pop-ups-highlighting",
    "category": "Messager pop ups highlighting",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><a href=\"https://www.linkedin.com/in/ACoAAAAlFm0BLjdAV7KITsuGazBO7U9P3bvFfI0\"><div><div></div></div></a><div><div><span><a href=\"https://www.linkedin.com/in/ACoAAAAlFm0BLjdAV7KITsuGazBO7U9P3bvFfI0\"><span>John Ricciardi<span> </span></span></a></span><div><span>1st degree connection</span><span>· 1st</span></div></div><div><div>Regulatory Affairs Search Partner | Helping Life Sciences Leaders Build High-Impact Teams</div></div></div></div></div></li><li><time>Today</time><span>Barton Holdridge sent the following messages at 2:01 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>2:01 PM</time></div><div><div><ul><li><div><span>🎉</span></div></li><li><div><span>😅</span></div></li><li><div><span>👏</span></div></li></ul><div><span><button><li-icon></li-icon></button></span></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Looking forward to connecting with you here, John!</p></div><span></span></div></div></div></li></ul><br>",
    "expected": {
      "name": "John Ricciardi",
      "title": "Regulatory Affairs Search Partner | Helping Life Sciences Leaders Build High-Impact Teams",
      "linkedin_url": "https://www.linkedin.com/in/ACoAAAAlFm0BLjdAV7KITsuGazBO7U9P3bvFfI0",
      "message_text": "Looking forward to connecting with you here, John!",
      "suggested_event_type": "accepted_connection"
    }
  },
  {
    "id": "37-messager-pop-ups-highlighting",
    "category": "Messager pop ups highlighting",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><a href=\"https://www.linkedin.com/in/ACoAAAiGOBoBdlF5K9W-Zm3Pc_GDvZcHD8zxiCU\"><div><div></div></div></a><div><div><span><a href=\"https://www.linkedin.com/in/ACoAAAiGOBoBdlF5K9W-Zm3Pc_GDvZcHD8zxiCU\"><span>David Hampton, Jr.<span> </span></span></a></span><div><span>2nd degree connection</span><span>· 2nd</span></div></div><div><div>Founder, Hampton Strategies | Executive Search for Tax Directors, VPs of Tax, and Heads of Tax at Fortune 500, Public, and Complex Growth Companies</div></div></div></div></div></li><li><time>Thursday</time><span>Barton Holdridge sent the following message at 4:47 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>4:47 PM</time></div><div><div><ul><li><div><span></span></div></li><li><div><span></span></div></li><li><div><span></span></div></li></ul><div><span><button><li-icon></li-icon></button></span></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Looking forward to connecting with you here, David!</p></div><span></span></div></div></div></li><li><span>David Hampton, Jr. sent the following message at 4:47 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAAAiGOBoBdlF5K9W-Zm3Pc_GDvZcHD8zxiCU\"><span>View David’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAAAiGOBoBdlF5K9W-Zm3Pc_GDvZcHD8zxiCU\"><span>David Hampton, Jr.</span></a><span> </span><span> </span></span></div></div></li></ul>",
    "expected": {
      "name": "David Hampton, Jr.",
      "title": "Founder, Hampton Strategies | Executive Search for Tax Directors, VPs of Tax, and Heads of Tax at Fortune 500, Public, and Complex Growth Companies",
      "linkedin_url": "https://www.linkedin.com/in/ACoAAAiGOBoBdlF5K9W-Zm3Pc_GDvZcHD8zxiCU",
      "message_text": "Looking forward to connecting with you here, David!",
      "suggested_event_type": "accepted_connection"
    }
  },
  {
    "id": "38-messager-pop-ups-highlighting",
    "category": "Messager pop ups highlighting",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><div><div><span><a href=\"https://www.linkedin.com/in/ACoAAABTGRkBntPhlaWE2SA5bs_9Uk7y9xjItRw\"><span>Kevin Clifford<span> </span></span></a></span><div><span>1st degree connection</span><span>· 1st</span></div></div><div><div>Sports AI &amp; Data Recruitment | Hiring AI/ML Engineers, Data Scientists &amp; Analytics Leaders in Sport &amp; SportsTech | 17 years in data hiring | Founder of Animo Group</div></div></div></div></div></li><li><time>Thursday</time><span>Barton Holdridge sent the following message at 4:36 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>4:36 PM</time></div><div><div><ul><li><div><span></span></div></li><li><div><span></span></div></li><li><div><span></span></div></li></ul><div><span><button><li-icon></li-icon></button></span><div><div></div></div></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Hey Kevin, appreciate the connection.<br><br>I’ve been building submittal and workflow automations with a few boutique agencies and noticed your team is doing a lot of work in Sports and SportTech recruiting.<br><br>I put together a tiny tool that takes a candidate’s resume + target role and auto‑builds a client‑ready submittal in your branding (snapshot, ‘why this candidate,’ key qualifications) and logs time saved per run.<br><br>Would you be open to a 60‑second Loom showing how it works on a sample candidate, just to see if it’s relevant for your stack?<br><br>As a fellow \"Soccer\" 😅 fan the niche you are in is really cool!</p></div><span></span></div></div></div></li><li><time>Today</time><span>Kevin Clifford sent the following message at 5:22 AM</span><div><a href=\"https://www.linkedin.com/in/ACoAAABTGRkBntPhlaWE2SA5bs_9Uk7y9xjItRw\"><span>View Kevin’s profile</span></a></div></li></ul>",
    "expected": {
      "name": "Kevin Clifford",
      "title": "Sports AI & Data Recruitment | Hiring AI/ML Engineers, Data Scientists & Analytics Leaders in Sport & SportsTech | 17 years in data hiring | Founder of Animo Group",
      "linkedin_url": "https://www.linkedin.com/in/ACoAAABTGRkBntPhlaWE2SA5bs_9Uk7y9xjItRw",
      "message_text": "Hey Kevin, appreciate the connection.\n\nI've been building submittal and workflow automations with a few boutique agencies and noticed your team is doing a lot of work in Sports and SportTech recruiting.\n\nI put together a tiny tool that takes a candidate's resume + target role and auto-builds a client-ready submittal in your branding (snapshot, 'why this candidate,' key qualifications) and logs time saved per run.\n\nWould you be open to a 60-second Loom showing how it works on a sample candidate, just to see if it's relevant for your stack?\n\nAs a fellow \"Soccer\" 😅 fan the niche you are in is really cool!",
      "suggested_event_type": "direct_message"
    }
  },
  {
    "id": "39-messanger-page-chat-highlight",
    "category": "Messanger page chat highlight",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><div><div><span><a href=\"https://www.linkedin.com/in/ACoAAAGaZn8Bf5H-or6Q41Vwzh4xAlzZxjiBoQM\"><span><br>Amy Ospital<span> </span></span></a></span><span>(She/Her)</span><div><span>1st degree connection</span><span>· 1st</span></div></div><div><div>Founder &amp; CEO @ The Network 101 | Executive Search - Accounting &amp; Finance, Legal, &amp; others | 12+ years closing Enterprise Deals</div></div></div></div></div></li><li><time>Today</time><span>Barton Holdridge sent the following message at 4:48 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>4:48 PM</time></div><div><div><ul><li><div><span></span></div></li><li><div><span></span></div></li><li><div><span></span></div></li></ul><div><span><button><li-icon></li-icon></button></span><div><div></div></div></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Looking forward to connecting with you here, Amy!</p></div><span></span></div></div></div></li><li><span>Amy Ospital sent the following messages at 5:43 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAAAGaZn8Bf5H-or6Q41Vwzh4xAlzZxjiBoQM\"><span>View Amy’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAAAGaZn8Bf5H-or6Q41Vwzh4xAlzZxjiBoQM\"><span>Amy Ospital</span></a><span> </span><span> </span></span><span>(She/Her)<span> </span></span></div></div></li></ul>",
    "expected": {
      "name": "Amy Ospital",
      "title": "Founder & CEO @ The Network 101 | Executive Search - Accounting & Finance, Legal, & others | 12+ years closing Enterprise Deals",
      "linkedin_url": "https://www.linkedin.com/in/ACoAAAGaZn8Bf5H-or6Q41Vwzh4xAlzZxjiBoQM",
      "message_text": "Looking forward to connecting with you here, Amy!",
      "suggested_event_type": "accepted_connection"
    }
  },
  {
    "id": "40-messanger-page-chat-highlight",
    "category": "Messanger page chat highlight",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><a href=\"https://www.linkedin.com/in/ACoAAACmmjoBC0pdnHi9XxoBzw9ekQO1NekkTXk\"><div><div></div></div></a><div><div><span><a href=\"https://www.linkedin.com/in/ACoAAACmmjoBC0pdnHi9XxoBzw9ekQO1NekkTXk\"><span>Nick Starbuck<span> </span></span></a></span><span>(He/Him)</span><div><span>1st degree connection</span><span>· 1st</span></div></div><div><div>Specialist Recruiter | Platform Law Firms &amp; Financial Services | Placing entrepreneurial professionals into consultant models | Smart Match Network</div></div></div></div></div></li><li><time>Today</time><span>Barton Holdridge sent the following message at 5:35 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>5:35 PM</time></div><div><div><ul><li><div><span></span></div></li><li><div><span></span></div></li><li><div><span></span></div></li></ul><div><span><button><li-icon></li-icon></button></span></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Looking forward to connecting with you here, Nick!</p></div><span></span></div></div></div></li><li><span>Nick Starbuck sent the following messages at 5:35 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAAACmmjoBC0pdnHi9XxoBzw9ekQO1NekkTXk\"><span>View Nick’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAAACmmjoBC0pdnHi9XxoBzw9ekQO1NekkTXk\"></a></span></div></div></li></ul>",
    "expected": {
      "name": "Nick Starbuck",
      "title": "Specialist Recruiter | Platform Law Firms & Financial Services | Placing entrepreneurial professionals into consultant models | Smart Match Network",
      "linkedin_url": "https://www.linkedin.com/in/ACoAAACmmjoBC0pdnHi9XxoBzw9ekQO1NekkTXk",
      "message_text": "Looking forward to connecting with you here, Nick!",
      "suggested_event_type": "accepted_connection"
    }
  },
  {
    "id": "41-messanger-page-chat-highlight",
    "category": "Messanger page chat highlight",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><a href=\"https://www.linkedin.com/in/ACoAAAAhTGsBUXS3JhEdmXT15NIznlzNBjfYgLA\"><div><div></div></div></a><div><div><span><a href=\"https://www.linkedin.com/in/ACoAAAAhTGsBUXS3JhEdmXT15NIznlzNBjfYgLA\"><span>Somer Hackley<span> </span></span></a></span><div><span>1st degree connection</span><span>· 1st</span></div></div><div><div>Executive Recruiter | Technology, Data, Product, Security | C-level, SVP, VP | Author: Search in Plain Sight</div></div></div></div></div></li><li><time>Today</time><span>Barton Holdridge sent the following messages at 4:52 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>4:52 PM</time></div><div><div><ul><li><div><span></span></div></li><li><div><span></span></div></li><li><div><span></span></div></li></ul><div><span><button><li-icon></li-icon></button></span><div><div></div></div></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Looking forward to connecting with you here, Somer!</p></div><span></span></div></div></div></li></ul><br>",
    "expected": {
      "name": "Somer Hackley",
      "title": "Executive Recruiter | Technology, Data, Product, Security | C-level, SVP, VP | Author: Search in Plain Sight",
      "linkedin_url": "https://www.linkedin.com/in/ACoAAAAhTGsBUXS3JhEdmXT15NIznlzNBjfYgLA",
      "message_text": "Looking forward to connecting with you here, Somer!",
      "suggested_event_type": "accepted_connection"
    }
  },
  {
    "id": "42-messanger-page-chat-highlight",
    "category": "Messanger page chat highlight",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><div><div><span><a href=\"https://www.linkedin.com/in/ACoAAABJ-h0B05Q1fxCes85_dpnAcyo_33NEgEY\"><span>Douglas Wetzel<span> </span></span></a></span><span>(He/Him)</span><div><span>1st degree connection</span><span>· 1st</span></div></div><div><div>Founder &amp; CEO at Ashton North | Executive Search Partner for Manufacturing, Industrial &amp; PE Backed Companies | Building Leadership Teams That Drive Growth</div></div></div></div></div></li><li><time>Wednesday</time><span>Barton Holdridge sent the following message at 8:56 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>8:56 PM</time></div><div><div><ul><li><div><span></span></div></li><li><div><span></span></div></li><li><div><span></span></div></li></ul><div><span><button><li-icon></li-icon></button></span></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Looking forward to connecting with you here, Douglas!</p></div><span></span></div></div></div></li><li><time>Thursday</time><span>Douglas Wetzel sent the following message at 6:59 AM</span><div><a href=\"https://www.linkedin.com/in/ACoAAABJ-h0B05Q1fxCes85_dpnAcyo_33NEgEY\"><span>View Douglas’ profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAAABJ-h0B05Q1fxCes85_dpnAcyo_33NEgEY\"><span>Douglas Wetzel</span></a><span> </span><span> </span></span><span>(He/Him)<span> </span></span><time><span> </span>6:59 AM</time></div></div></li></ul>",
    "expected": {
      "name": "Douglas Wetzel",
      "title": "Founder & CEO at Ashton North | Executive Search Partner for Manufacturing, Industrial & PE Backed Companies | Building Leadership Teams That Drive Growth",
      "linkedin_url": "https://www.linkedin.com/in/ACoAAABJ-h0B05Q1fxCes85_dpnAcyo_33NEgEY",
      "message_text": "Looking forward to connecting with you here, Douglas!",
      "suggested_event_type": "accepted_connection"
    }
  },
  {
    "id": "43-messanger-page-chat-highlight",
    "category": "Messanger page chat highlight",
    "pageUrl": "https://www.linkedin.com/messaging/",
    "ownerName": "Barton Holdridge",
    "trimmedHtml": "<ul><li><div><div><a href=\"https://www.linkedin.com/in/ACoAAAGNks4BMIb9wePnn8oxFclEC3X5vXLSynE\"><div><div></div></div></a><div><div><span><a href=\"https://www.linkedin.com/in/ACoAAAGNks4BMIb9wePnn8oxFclEC3X5vXLSynE\"><span>Vince Toves<span> </span></span></a></span><div><span>1st degree connection</span><span>· 1st</span></div></div><div><div>Program &amp; Operations Leader: The 0-to-1 Catalyst | Directed 340x Listing Growth at Zillow | Reduced wasted spend by ~$40M/yr &amp; contributed to ~15% revenue uplift (~$100M/yr) for P&amp;G | AI Builder &amp; Leader | UW MBA</div></div></div></div></div></li><li><time>Wednesday</time><span>Vince Toves sent the following message at 3:29 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAAAGNks4BMIb9wePnn8oxFclEC3X5vXLSynE\"><span>View Vince’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAAAGNks4BMIb9wePnn8oxFclEC3X5vXLSynE\"><span>Vince Toves</span></a><span> </span><span> </span></span><time><span> </span>3:29 PM</time></div><div><div><ul><li><div><span></span></div></li><li><div><span></span></div></li><li><div><span></span></div></li></ul><div><span><button><li-icon></li-icon></button></span></div><button><span></span></button><div><button></button><div><div></div></div></div></div><div><div><p>Looking forward to connecting with you here, Barton!</p></div></div></div></div></li><li><span>Barton Holdridge sent the following messages at 6:45 PM</span><div><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>View Barton’s profile</span></a><div><span><a href=\"https://www.linkedin.com/in/ACoAABPgFYABKbKtR8OUL2cEpRe0vD8FPNssXl0\"><span>Barton Holdridge</span></a><span> </span><span> </span></span><time><span> </span>6:45 PM</time></div></div></li></ul>",
    "expected": {
      "name": "Vince Toves",
      "title": "Program & Operations Leader: The 0-to-1 Catalyst | Directed 340x Listing Growth at Zillow | Reduced wasted spend by ~$40M/yr & contributed to ~15% revenue uplift (~$100M/yr) for P&G | AI Builder & Leader | UW MBA",
      "linkedin_url": "https://www.linkedin.com/in/ACoAAAGNks4BMIb9wePnn8oxFclEC3X5vXLSynE",
      "message_text": null,
      "suggested_event_type": "accepted_connection"
    }
  }
];
