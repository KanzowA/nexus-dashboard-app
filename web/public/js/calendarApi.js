// Ported from src/googleCalendar.js - the REST operations were already plain
// fetch() calls against the Calendar API with a Bearer token, so they carry
// over unchanged. Only token sourcing changes: getAccessToken() here comes
// from auth.js's browser-side PKCE flow instead of google-auth-library's
// OAuth2Client + a Node loopback server.
var calendarApi = (function(){
  var API_BASE = "https://www.googleapis.com/calendar/v3";

  async function getAccessToken(){
    var token = await auth.getValidAccessToken();
    if(!token) throw new Error("Google Calendar is not connected. Connect it in Settings.");
    return token;
  }

  function addDaysISO(dateStr, days){
    var d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function addHoursToTime(timeStr, hours){
    var parts = timeStr.split(":").map(Number), h = parts[0], m = parts[1];
    var total = (h*60 + m + hours*60) % (24*60);
    var endH = Math.floor(total/60), endM = total%60;
    return String(endH).padStart(2,"0") + ":" + String(endM).padStart(2,"0");
  }

  function buildEventBody(opts){
    var title = opts.title, date = opts.date, time = opts.time, endTime = opts.endTime, endDate = opts.endDate, location = opts.location;
    var isMultiDay = endDate && endDate !== date;
    var body = { summary: title };
    if(location) body.location = location;

    if(time){
      var timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      var finalEndDate = isMultiDay ? endDate : date;
      var finalEndTime = endTime || (isMultiDay ? time : addHoursToTime(time, 1));
      body.start = { dateTime: date+"T"+time+":00", timeZone: timeZone };
      body.end = { dateTime: finalEndDate+"T"+finalEndTime+":00", timeZone: timeZone };
    } else {
      var finalEndDate2 = isMultiDay ? endDate : date;
      body.start = { date: date };
      body.end = { date: addDaysISO(finalEndDate2, 1) };
    }
    return body;
  }

  async function createEvent(opts){
    var token = await getAccessToken();
    var body = buildEventBody(opts);
    var res = await fetch(API_BASE+"/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: "Bearer "+token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if(!res.ok){
      var text = await res.text().catch(function(){ return ""; });
      throw new Error("Google Calendar rejected the event ("+res.status+"): "+text);
    }
    return res.json();
  }

  async function updateEvent(opts){
    var token = await getAccessToken();
    var body = buildEventBody(opts);
    var res = await fetch(API_BASE+"/calendars/primary/events/"+encodeURIComponent(opts.eventId), {
      method: "PATCH",
      headers: { Authorization: "Bearer "+token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if(!res.ok){
      var text = await res.text().catch(function(){ return ""; });
      throw new Error("Google Calendar rejected the update ("+res.status+"): "+text);
    }
    return res.json();
  }

  async function deleteEvent(opts){
    var token = await getAccessToken();
    var res = await fetch(API_BASE+"/calendars/primary/events/"+encodeURIComponent(opts.eventId), {
      method: "DELETE",
      headers: { Authorization: "Bearer "+token }
    });
    // 204 = deleted, 410 = already gone - both mean the event isn't there anymore.
    if(!res.ok && res.status !== 410){
      var text = await res.text().catch(function(){ return ""; });
      throw new Error("Google Calendar rejected the delete ("+res.status+"): "+text);
    }
    return { ok: true };
  }

  async function listEvents(opts){
    var token = await getAccessToken();
    var params = new URLSearchParams({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250"
    });
    var res = await fetch(API_BASE+"/calendars/primary/events?"+params, {
      headers: { Authorization: "Bearer "+token }
    });
    if(!res.ok){
      var text = await res.text().catch(function(){ return ""; });
      throw new Error("Could not list events ("+res.status+"): "+text);
    }
    var data = await res.json();
    return (data.items || []).map(function(e){
      var allDay = !!e.start.date;
      return {
        id: e.id,
        title: e.summary || "(untitled event)",
        location: e.location || null,
        startDate: allDay ? e.start.date : e.start.dateTime.slice(0,10),
        startTime: allDay ? null : e.start.dateTime,
        endTime: allDay ? null : e.end.dateTime,
        // Google's all-day end.date is exclusive (the day after the last
        // actual day) - normalize to the inclusive last day so range checks
        // elsewhere (does this event cover day X?) don't count one day too many.
        endDate: allDay ? addDaysISO(e.end.date, -1) : e.end.dateTime.slice(0,10),
        allDay: allDay
      };
    });
  }

  async function listUpcomingEvents(){
    var now = new Date();
    var in14Days = new Date(now.getTime() + 14*24*60*60*1000);
    return listEvents({ timeMin: now.toISOString(), timeMax: in14Days.toISOString() });
  }

  return {
    createEvent: createEvent,
    updateEvent: updateEvent,
    deleteEvent: deleteEvent,
    listEvents: listEvents,
    listUpcomingEvents: listUpcomingEvents
  };
})();
