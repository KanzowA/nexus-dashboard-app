// Stateless OAuth token-exchange relay. The Phase 4.0 spike confirmed
// Google's token endpoint requires a client_secret for this "Web
// application" client type even with PKCE - this function's only job is to
// attach that secret (kept as an encrypted Cloudflare Pages environment
// variable, never in git) and forward the request to Google, then hand the
// response straight back. It never logs, stores, or inspects the tokens -
// they flow browser -> here -> Google -> here -> browser and nothing is
// kept server-side, consistent with "no shared backend holds anyone's data".
export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "invalid_request", error_description: "Body must be JSON." }, 400);
  }

  const { grant_type } = body;
  if (grant_type !== "authorization_code" && grant_type !== "refresh_token") {
    return jsonResponse({ error: "invalid_request", error_description: "grant_type must be authorization_code or refresh_token." }, 400);
  }

  const params = new URLSearchParams();
  params.set("client_id", body.client_id);
  params.set("client_secret", env.GOOGLE_OAUTH_CLIENT_SECRET);
  params.set("grant_type", grant_type);

  if (grant_type === "authorization_code") {
    params.set("code", body.code);
    params.set("redirect_uri", body.redirect_uri);
    params.set("code_verifier", body.code_verifier);
  } else {
    params.set("refresh_token", body.refresh_token);
  }

  const googleRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const text = await googleRes.text();
  return new Response(text, {
    status: googleRes.status,
    headers: { "Content-Type": "application/json" }
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
