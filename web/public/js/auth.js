// PKCE OAuth flow against Google, with the token exchange relayed through
// /api/token-exchange (see functions/api/token-exchange.js and web/README.md
// - Google requires a client_secret for this client type even with PKCE, so
// that one step can't happen purely in-browser). Everything else - the
// authorization redirect, token storage, silent refresh - is plain browser
// code. Tokens live only in this browser's own localStorage, never sent
// anywhere except Google/our own relay.
var auth = (function(){
  // Not secret - OAuth client IDs are public identifiers, safe to embed.
  var CLIENT_ID = "823951447668-rvo82b3scnjm4hmvhr2hta51i0t3sive.apps.googleusercontent.com";
  var SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive.appdata openid email";
  var TOKENS_KEY = "nexus_oauth_tokens_v1";
  var VERIFIER_KEY = "nexus_oauth_verifier";
  var STATE_KEY = "nexus_oauth_state";
  // Root path, not a dedicated /callback route - keeps the redirect URI
  // allowlist in Cloud Console to just one entry per environment (localhost,
  // the Pages preview domain, production).
  var REDIRECT_URI = location.origin + "/";
  var REFRESH_SKEW_MS = 60000; // refresh a bit before actual expiry, not exactly at it

  function b64url(buf){
    var bytes = new Uint8Array(buf), str = "";
    for(var i=0;i<bytes.length;i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  }
  function randomString(len){
    var arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return b64url(arr.buffer);
  }
  async function sha256(str){
    return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  }

  function loadTokens(){
    try { return JSON.parse(localStorage.getItem(TOKENS_KEY)); } catch(e){ return null; }
  }
  function saveTokens(t){
    localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  }

  // Just for display ("Connected as ___") in the settings panel - not used
  // for any security decision, so no signature verification needed, a plain
  // base64url decode of the JWT payload is enough.
  function decodeEmailFromIdToken(idToken){
    if(!idToken) return null;
    try {
      var payload = idToken.split(".")[1];
      var json = decodeURIComponent(atob(payload.replace(/-/g,"+").replace(/_/g,"/")).split("").map(function(c){
        return "%" + ("00"+c.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
      return JSON.parse(json).email || null;
    } catch(e){ return null; }
  }
  function getConnectedEmail(){
    var t = loadTokens();
    return t ? (t.email || null) : null;
  }

  async function startSignIn(){
    var codeVerifier = randomString(64);
    var codeChallenge = b64url(await sha256(codeVerifier));
    var state = randomString(16);
    sessionStorage.setItem(VERIFIER_KEY, codeVerifier);
    sessionStorage.setItem(STATE_KEY, state);

    var url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    location.href = url.toString();
  }

  function signOut(){
    localStorage.removeItem(TOKENS_KEY);
  }

  function isConnected(){
    var t = loadTokens();
    return !!(t && t.refresh_token);
  }

  async function exchange(body){
    var res = await fetch("/api/token-exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var json = await res.json();
    if(!res.ok) throw new Error(json.error_description || json.error || "Token exchange failed.");
    return json;
  }

  // Call once, first thing, on every page load - no-op unless the URL is a
  // fresh redirect back from Google.
  async function handleRedirectIfPresent(){
    var params = new URLSearchParams(location.search);
    var code = params.get("code");
    var state = params.get("state");
    var error = params.get("error");
    if(!code && !error) return { handled:false };

    // Clean the URL immediately regardless of outcome so a reload never
    // resubmits a spent code.
    history.replaceState({}, "", REDIRECT_URI);

    if(error) return { handled:true, ok:false, error:error };

    var expectedState = sessionStorage.getItem(STATE_KEY);
    var codeVerifier = sessionStorage.getItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    if(!codeVerifier || state !== expectedState){
      return { handled:true, ok:false, error:"State mismatch - possible stale or replayed sign-in link." };
    }

    try {
      var json = await exchange({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier
      });
      if(!json.refresh_token){
        return { handled:true, ok:false, error:"Google didn't return a refresh token - try signing in again (this can happen if you'd already granted access once before without revoking it)." };
      }
      saveTokens({
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        email: decodeEmailFromIdToken(json.id_token),
        expires_at: Date.now() + (json.expires_in*1000)
      });
      return { handled:true, ok:true };
    } catch(err){
      return { handled:true, ok:false, error: err.message };
    }
  }

  async function refresh(){
    var t = loadTokens();
    if(!t || !t.refresh_token) return null;
    var json = await exchange({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: CLIENT_ID
    });
    var updated = {
      access_token: json.access_token,
      refresh_token: t.refresh_token, // Google doesn't resend it on refresh
      expires_at: Date.now() + (json.expires_in*1000)
    };
    saveTokens(updated);
    return updated;
  }

  // Returns null (never throws) if not connected or refresh fails, so
  // callers can uniformly prompt startSignIn() rather than handling errors
  // at every call site.
  async function getValidAccessToken(){
    var t = loadTokens();
    if(!t || !t.refresh_token) return null;
    if(t.access_token && t.expires_at && Date.now() < t.expires_at - REFRESH_SKEW_MS){
      return t.access_token;
    }
    try {
      var updated = await refresh();
      return updated ? updated.access_token : null;
    } catch(err){
      console.error("Silent token refresh failed:", err.message);
      return null;
    }
  }

  return {
    startSignIn: startSignIn,
    signOut: signOut,
    isConnected: isConnected,
    getConnectedEmail: getConnectedEmail,
    handleRedirectIfPresent: handleRedirectIfPresent,
    getValidAccessToken: getValidAccessToken
  };
})();
