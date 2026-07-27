// Replaces src/mailChecker.js's ImapFlow (raw TLS socket - impossible from a
// browser) with the Gmail REST API over the same OAuth token calendarApi.js
// uses. The original hardcoded FORWARD_SENDER_FILTER + forwarded-header
// unwrapping was the app owner's own institutional-forwarding setup, not
// something every user should inherit - both are now optional, off-by-default
// settings (see settingsPanel.js) so a friend's inbox just shows their real
// unread mail via Gmail's own snippet field, while the owner can flip both
// on to get their exact previous behavior back.
var gmailApi = (function(){
  var API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
  var SENDER_FILTER_KEY = "nexus_gmail_sender_filter_v1";
  var DETECT_FORWARDED_KEY = "nexus_gmail_detect_forwarded_v1";

  async function getAccessToken(){
    var token = await auth.getValidAccessToken();
    if(!token) throw new Error("Gmail is not connected. Connect it in Settings.");
    return token;
  }

  function getSenderFilter(){
    return (localStorage.getItem(SENDER_FILTER_KEY) || "").trim();
  }
  function setSenderFilter(v){
    localStorage.setItem(SENDER_FILTER_KEY, v || "");
  }
  function getDetectForwarded(){
    return localStorage.getItem(DETECT_FORWARDED_KEY) === "1";
  }
  function setDetectForwarded(on){
    localStorage.setItem(DETECT_FORWARDED_KEY, on ? "1" : "0");
  }

  function buildQuery(){
    var q = "is:unread";
    var filter = getSenderFilter();
    if(filter) q += ' from:"'+filter+'"';
    return q;
  }

  // Same regexes as the original mailChecker.js, ported verbatim.
  function stripForwardPrefixes(subject){
    if(!subject) return subject;
    var prev, s = subject;
    do {
      prev = s;
      s = s.replace(/^\s*(WG|FW|FWD|AW|RE)\s*:\s*/i, "");
    } while(s !== prev);
    return s.trim();
  }
  function cleanOriginalFrom(raw){
    if(!raw) return null;
    var angle = raw.match(/^(.*?)<[^>]+>\s*$/);
    if(angle && angle[1].trim()) return angle[1].trim().replace(/^["']|["']$/g, "");
    var mailto = raw.match(/^(.*?)\[mailto:[^\]]+\]\s*$/i);
    if(mailto && mailto[1].trim()) return mailto[1].trim().replace(/^["']|["']$/g, "");
    var emailOnly = raw.match(/^<?([^<>\s]+@[^<>\s]+)>?$/);
    if(emailOnly) return emailOnly[1];
    return raw.trim();
  }
  function parseForwardedOriginal(bodyText){
    if(!bodyText) return null;
    var fromMatch = bodyText.match(/^(?:Von|From)\s*:\s*(.+)$/im);
    var subjectMatch = bodyText.match(/^(?:Betreff|Subject)\s*:\s*(.+)$/im);
    if(!fromMatch && !subjectMatch) return null;
    return {
      originalFrom: fromMatch ? cleanOriginalFrom(fromMatch[1]) : null,
      originalSubject: subjectMatch ? stripForwardPrefixes(subjectMatch[1].trim()) : null
    };
  }

  function decodeBase64Url(str){
    var b64 = str.replace(/-/g,"+").replace(/_/g,"/");
    while(b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  // Gmail's payload can be a single part or multipart/* nested arbitrarily -
  // walk it depth-first for the first text/plain part.
  function findPlainTextPart(payload){
    if(!payload) return null;
    if(payload.mimeType === "text/plain" && payload.body && payload.body.data){
      return decodeBase64Url(payload.body.data);
    }
    if(payload.parts){
      for(var i=0;i<payload.parts.length;i++){
        var found = findPlainTextPart(payload.parts[i]);
        if(found) return found;
      }
    }
    return null;
  }
  function headerValue(headers, name){
    var h = (headers||[]).find(function(x){ return x.name.toLowerCase() === name.toLowerCase(); });
    return h ? h.value : null;
  }
  function parseFromHeader(raw){
    if(!raw) return "Unknown sender";
    var m = raw.match(/^(.*?)<[^>]+>\s*$/);
    if(m && m[1].trim()) return m[1].trim().replace(/^["']|["']$/g, "");
    return raw;
  }

  async function getUnreadCount(){
    var token = await getAccessToken();
    var params = new URLSearchParams({ q: buildQuery(), maxResults: "1" });
    var res = await fetch(API_BASE+"/messages?"+params, { headers: { Authorization: "Bearer "+token } });
    if(!res.ok) throw new Error("Could not check Gmail ("+res.status+")");
    var data = await res.json();
    return data.resultSizeEstimate || 0;
  }

  async function getUnreadSummaries(limit){
    limit = limit || 10;
    var token = await getAccessToken();
    var listParams = new URLSearchParams({ q: buildQuery(), maxResults: String(limit) });
    var listRes = await fetch(API_BASE+"/messages?"+listParams, { headers: { Authorization: "Bearer "+token } });
    if(!listRes.ok) throw new Error("Could not list unread mail ("+listRes.status+")");
    var listData = await listRes.json();
    var ids = (listData.messages || []).map(function(m){ return m.id; });

    var detectForwarded = getDetectForwarded();
    var format = detectForwarded ? "full" : "metadata";

    var results = [];
    for(var i=0;i<ids.length;i++){
      var res = await fetch(API_BASE+"/messages/"+ids[i]+"?format="+format+(format==="metadata" ? "&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date" : ""), {
        headers: { Authorization: "Bearer "+token }
      });
      if(!res.ok) continue;
      var msg = await res.json();
      var headers = (msg.payload && msg.payload.headers) || [];
      var from = parseFromHeader(headerValue(headers, "From"));
      var subject = stripForwardPrefixes(headerValue(headers, "Subject") || "(no subject)");
      var dateHeader = headerValue(headers, "Date");
      var date = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();
      var snippet = msg.snippet || "";

      if(detectForwarded){
        var bodyText = findPlainTextPart(msg.payload) || "";
        if(bodyText) snippet = bodyText.replace(/\s+/g," ").trim().slice(0,140);
        var original = parseForwardedOriginal(bodyText);
        if(original){
          if(original.originalFrom) from = original.originalFrom;
          if(original.originalSubject) subject = original.originalSubject;
        }
      }

      results.push({ uid: msg.id, from: from, subject: subject, date: date, snippet: snippet });
    }
    return results;
  }

  async function markAsRead(uid){
    var token = await getAccessToken();
    var res = await fetch(API_BASE+"/messages/"+uid+"/modify", {
      method: "POST",
      headers: { Authorization: "Bearer "+token, "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] })
    });
    if(!res.ok) throw new Error("Could not mark message as read ("+res.status+")");
  }

  return {
    getUnreadCount: getUnreadCount,
    getUnreadSummaries: getUnreadSummaries,
    markAsRead: markAsRead,
    getSenderFilter: getSenderFilter,
    setSenderFilter: setSenderFilter,
    getDetectForwarded: getDetectForwarded,
    setDetectForwarded: setDetectForwarded
  };
})();
