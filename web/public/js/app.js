window.addEventListener("error", function(e){ console.error("TEMP-DEBUG window error:", e.message, e.filename, e.lineno); });
(function(){
  // Declared this early (not down near renderHubRingGauge() itself) on
  // purpose: buildNeuralMap() gets triggered for the first time from deep
  // inside renderTodos()'s own init call, which runs well before the
  // script reaches wherever these constants would otherwise sit. A `var`
  // declaration's assignment only takes effect when that line actually
  // executes (unlike the function declarations below it, which are fully
  // hoisted) - so on that first, earlier-than-expected call these were
  // silently still `undefined`, and the array-based polygon math (unlike
  // the old string-concatenation-based arc math it replaced, which just
  // produced harmless "NaN" text) throws a real TypeError on undefined.x
  // when it tries to read the first vertex of a loop that never ran.
  // Inner/outer gap kept narrow (was 30/52, a 22-unit-thick band) - a thin
  // band reads as a diamond/eternity ring, a thick one reads as a donut.
  var HUB_FACETS = 18, HUB_R_INNER = 40, HUB_R_OUTER = 54;
  // Fixed "light source" direction for the jewel-facet shading (0deg =
  // top, clockwise) - upper-left, the conventional default light angle
  // used across most icon/game art. Shared by facetOpacity() (brightness
  // falloff per facet) and the specular glint, both in renderHubRingGauge().
  var HUB_LIGHT_ANGLE = 325;
  // Holds the pending re-randomization timer for the hub spark (see
  // renderHubSpark()) - the spark is otherwise only rebuilt when
  // buildNeuralMap() reruns (habit/todo edits, refresh), so on an idle
  // screen it would loop the exact same burst position forever. Tracked
  // here so a fresh renderHubSpark() call (from a real data change) can
  // cancel any still-pending self-scheduled one instead of stacking timers.
  var hubSparkTimer = null;
  // Same early-call hoisting hazard as above, just for a different variable:
  // buildNeuralMap()'s attention-count math (countMarked(conferences, ...))
  // reads `conferences` on that same too-early first call, and a `var`
  // assignment further down the file (where this used to live, next to the
  // rest of the Conferences feature) hadn't run yet - undefined.filter()
  // threw, and since it's uncaught, it silently halted the rest of the
  // script's top-level execution for that pass, including everything after
  // it (settingsPanel.init(), the settings-button click handler, etc.).
  var CONF_KEY = "nexus_conferences_v1";
  var CONF_TASKS = [
    { key:"registration", label:"Registration" },
    { key:"abstract", label:"Abstract Submission" },
    { key:"accommodation", label:"Accommodation" },
    { key:"content", label:"Content" }
  ];
  function loadConferences(){ try{ return JSON.parse(localStorage.getItem(CONF_KEY))||[]; }catch(e){ return []; } }
  function saveConferences(c){ localStorage.setItem(CONF_KEY, JSON.stringify(c)); driveSync.scheduleSync(); }
  var CONF_TOMBSTONES_KEY = "nexus_conferences_tombstones_v1";
  function loadConfTombstones(){ try{ return JSON.parse(localStorage.getItem(CONF_TOMBSTONES_KEY))||[]; }catch(e){ return []; } }
  function saveConfTombstones(t){ localStorage.setItem(CONF_TOMBSTONES_KEY, JSON.stringify(t)); }
  var confTombstones = loadConfTombstones();
  function tombstoneConf(id){ confTombstones.push({ id:id, deletedAt:Date.now() }); saveConfTombstones(confTombstones); }
  var conferences = loadConferences();
  // The page scrolls vertically inside its iframe, and the scrollbar only
  // ever eats space on the right - so margin:auto centering (.nexus, and
  // the disc's hub inside it) centers correctly within the content area,
  // but that area itself is narrower than the full visible width, so
  // everything reads as shifted slightly left. scrollbar-gutter and the
  // classic 100vw/100% margin trick both failed to engage in this
  // iframe context, so measure the actual scrollbar width directly and
  // shift the root by half of it to recenter on the true visible width.
  (function(){
    var sbw = window.innerWidth - document.documentElement.clientWidth;
    if(sbw > 0) document.documentElement.style.marginLeft = (sbw/2) + "px";
  })();

  // ---------- 3D map spin clock (shared reference point so re-rendered
  // billboards stay phase-locked to the ambient .spinner3d rotation instead
  // of restarting at their own creation time) ----------
  var SPIN_START = performance.now();

  // ---------- Real data (fetched live from Google Calendar / Gmail via the app) ----------
  var SYNCED_AT = null;
  var EVENTS = [];
  var EMAILS = [];
  var GMAIL_CONNECTED = false;
  var CALENDAR_CONNECTED = false;

  // No bridge here - this build talks to Google's APIs directly via
  // calendarApi.js/gmailApi.js (auth.js handles the OAuth tokens), and to
  // the in-page settingsPanel.js instead of a separate Electron window.

  var DEFAULT_HABITS = [
    { id:"sleep", name:"Slept 7+ hours", pts:10 },
    { id:"move", name:"Moved / exercised", pts:15 },
    { id:"deepwork", name:"One deep-work block", pts:15 },
    { id:"read", name:"Read 20 minutes", pts:10 },
    { id:"nophone", name:"No phone first hour", pts:10 },
    { id:"hydrate", name:"Hydrated (2L+)", pts:5 }
  ];
  var HABIT_DEFS_KEY = "nexus_habit_defs_v1";
  function loadHabitDefs(){
    try{
      var saved = JSON.parse(localStorage.getItem(HABIT_DEFS_KEY));
      return Array.isArray(saved) ? saved : DEFAULT_HABITS.slice();
    }catch(e){ return DEFAULT_HABITS.slice(); }
  }
  function saveHabitDefs(defs){ localStorage.setItem(HABIT_DEFS_KEY, JSON.stringify(defs)); driveSync.scheduleSync(); }
  var HABIT_TOMBSTONES_KEY = "nexus_habit_defs_tombstones_v1";
  function loadHabitTombstones(){ try{ return JSON.parse(localStorage.getItem(HABIT_TOMBSTONES_KEY))||[]; }catch(e){ return []; } }
  function saveHabitTombstones(t){ localStorage.setItem(HABIT_TOMBSTONES_KEY, JSON.stringify(t)); }
  var habitTombstones = loadHabitTombstones();
  function tombstoneHabit(id){ habitTombstones.push({ id:id, deletedAt:Date.now() }); saveHabitTombstones(habitTombstones); }
  var HABITS = loadHabitDefs();
  function recomputeMaxDaily(){ MAX_DAILY = HABITS.reduce(function(a,h){return a+h.pts;},0); }
  var MAX_DAILY = HABITS.reduce(function(a,h){return a+h.pts;},0);

  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function fmtDay(iso){ return new Date(iso+"T00:00:00").toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"}); }
  function fmtTime(iso){ return new Date(iso).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}); }
  function fmtWhen(iso){
    var d = new Date(iso), now = new Date();
    var diffH = Math.round((now-d)/36e5);
    if(diffH < 1) return "just now";
    if(diffH < 24) return diffH+"h ago";
    return Math.round(diffH/24)+"d ago";
  }
  function escapeHtml(s){
    return s.replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; });
  }

  // ---------- Toasts ----------
  function showToast(msg, isError){
    var el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999;padding:10px 16px;border-radius:8px;"+
      "font-size:13px;font-family:inherit;color:#fff;background:"+(isError?"#dc2626":"#16a34a")+
      ";box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:0;transition:opacity .2s;";
    document.body.appendChild(el);
    requestAnimationFrame(function(){ el.style.opacity = "1"; });
    setTimeout(function(){
      el.style.opacity = "0";
      setTimeout(function(){ el.remove(); }, 250);
    }, 3200);
  }

  // an event covers a given day if that day falls anywhere in its
  // [startDate, endDate] range, not just on its start day - needed so
  // multi-day events show up on every day they span, not only the first.
  function eventCoversDate(e, iso){
    return iso >= e.startDate && iso <= (e.endDate || e.startDate);
  }

  // upserts fetched events into the shared EVENTS array by id, instead of
  // replacing it wholesale - lets us lazily fetch extra months (past/future)
  // on top of whatever's already loaded without losing earlier fetches.
  function mergeEvents(newEvents){
    (newEvents||[]).forEach(function(ne){
      var idx = EVENTS.findIndex(function(e){ return e.id===ne.id; });
      if(idx>-1) EVENTS[idx] = ne; else EVENTS.push(ne);
    });
  }

  // ---------- Real Google Calendar event creation ----------
  function createEventFromApp(title, dateISO, time, endTime, endDate, location){
    var date = dateISO || todayISO();
    calendarApi.createEvent({
      title: title, date: date, time: time || undefined,
      endTime: endTime || undefined, endDate: endDate || undefined, location: location || undefined
    }).then(function(){
      showToast('Added "'+title+'" to Google Calendar.');
      bumpDailyStat("calendarCreated");
      renderHabits();
      doRefresh();
    }).catch(function(err){
      showToast(err.message || "Could not add to Google Calendar.", true);
    });
  }

  // ================= Today / Week =================
  var today = todayISO();
  document.getElementById("todayDateLabel").textContent = new Date().toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});

  // habit log is initialized here (ahead of the to-do/habit sections below) so
  // buildNeuralMap() can safely read it the first time renderTodos() runs.
  var HABIT_KEY = "nexus_habits_v1";
  var HABIT_LOG_UPDATED_KEY = "nexus_habits_v1_updatedAt";
  function loadHabitLog(){ try{ return JSON.parse(localStorage.getItem(HABIT_KEY))||{}; }catch(e){ return {}; } }
  function saveHabitLog(l){
    localStorage.setItem(HABIT_KEY, JSON.stringify(l));
    localStorage.setItem(HABIT_LOG_UPDATED_KEY, String(Date.now()));
    driveSync.scheduleSync();
  }
  var habitLog = loadHabitLog();
  if(!habitLog[today]) habitLog[today] = {};

  // one-time actions (marking mail read, creating a calendar event) have no
  // "current state" to derive a day's count from the way a checkbox does -
  // once read, a message just disappears from the list. Log a running count
  // per day instead, bumped at the moment each action succeeds.
  var DAILY_STATS_KEY = "nexus_daily_stats_v1";
  var DAILY_STATS_UPDATED_KEY = "nexus_daily_stats_v1_updatedAt";
  function loadDailyStats(){ try{ return JSON.parse(localStorage.getItem(DAILY_STATS_KEY))||{}; }catch(e){ return {}; } }
  function saveDailyStats(s){
    localStorage.setItem(DAILY_STATS_KEY, JSON.stringify(s));
    localStorage.setItem(DAILY_STATS_UPDATED_KEY, String(Date.now()));
    driveSync.scheduleSync();
  }
  var dailyStats = loadDailyStats();
  function bumpDailyStat(statKey){
    var day = todayISO();
    if(!dailyStats[day]) dailyStats[day] = {};
    dailyStats[day][statKey] = (dailyStats[day][statKey]||0) + 1;
    saveDailyStats(dailyStats);
  }

  // unified Daily Score shown in the neural-map hub: habit points (as
  // before) plus +20 per to-do/conference-task completed *that specific
  // day* (not just currently-done - completedDate/taskDates below record
  // when each was finished, so the score reflects that day only, and
  // un-completing something the same day removes its points, same as
  // habits already behave) plus +5 per mail marked read / calendar event
  // created that day (logged via bumpDailyStat, since those have no
  // "current state" to check later).
  function dailyPointsFor(dayKey){
    // (todos||[]) / (conferences||[]) - both are declared further down the
    // file and buildNeuralMap() (which calls this) first runs from the
    // to-dos section, before conferences is assigned - same ordering
    // pitfall as elsewhere in this file.
    var habitPts = scoreFor(dayKey);
    var todoPts = (todos||[]).reduce(function(sum,t){ return sum + (t.completedDate===dayKey ? 20 : 0); }, 0);
    var confPts = (conferences||[]).reduce(function(sum,c){
      var dates = c.taskDates || {};
      return sum + CONF_TASKS.reduce(function(s,t){ return s + (dates[t.key]===dayKey ? 20 : 0); }, 0);
    }, 0);
    var stats = dailyStats[dayKey] || {};
    var mailPts = (stats.mailRead||0)*5;
    var calPts = (stats.calendarCreated||0)*5;
    return habitPts + todoPts + confPts + mailPts + calPts;
  }

  // neural-map color/icon data, also needed ahead of the to-do/habit sections
  // below since buildNeuralMap() is invoked the first time renderTodos() runs.
  var CATEGORY_HEX = { today:"#fb7185", conferences:"#f0b559", inbox:"#8b7cf6", todos:"#5b9df0", habits:"#e3c14a", week:"#46e0c6" };
  var ICONS = {
    today:'<circle cx="20" cy="20" r="7"/><line x1="20" y1="4" x2="20" y2="10"/><line x1="20" y1="30" x2="20" y2="36"/><line x1="4" y1="20" x2="10" y2="20"/><line x1="30" y1="20" x2="36" y2="20"/>',
    conferences:'<circle cx="20" cy="20" r="3"/><ellipse cx="20" cy="20" rx="15" ry="6"/><ellipse cx="20" cy="20" rx="15" ry="6" transform="rotate(60 20 20)"/><ellipse cx="20" cy="20" rx="15" ry="6" transform="rotate(120 20 20)"/>',
    inbox:'<rect x="5" y="10" width="30" height="20" rx="2"/><path d="M6 11 L20 23 L34 11"/>',
    todos:'<line x1="9" y1="12" x2="31" y2="12"/><line x1="9" y1="20" x2="31" y2="20"/><line x1="9" y1="28" x2="23" y2="28"/><path d="M25 27 l2.5 2.5 l5 -5"/>',
    habits:'<line x1="20" y1="5" x2="20" y2="35"/><line x1="5" y1="20" x2="35" y2="20"/><line x1="9" y1="9" x2="31" y2="31"/><line x1="31" y1="9" x2="9" y2="31"/>',
    week:'<circle cx="7" cy="20" r="2.8"/><circle cx="15" cy="20" r="2.8"/><circle cx="23" cy="20" r="2.8"/><circle cx="31" cy="20" r="2.8"/>'
  };
  function hexToRgb(hex){
    hex = hex.replace('#','');
    return [parseInt(hex.substring(0,2),16), parseInt(hex.substring(2,4),16), parseInt(hex.substring(4,6),16)];
  }
  function rgba(hex,a){ var c = hexToRgb(hex); return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'; }
  function shadeRgba(hex,pct,a){
    var c = hexToRgb(hex), r,g,b;
    if(pct>=0){ r=c[0]+(255-c[0])*pct; g=c[1]+(255-c[1])*pct; b=c[2]+(255-c[2])*pct; }
    else { var p=-pct; r=c[0]*(1-p); g=c[1]*(1-p); b=c[2]*(1-p); }
    return 'rgba('+Math.round(r)+','+Math.round(g)+','+Math.round(b)+','+a+')';
  }

  var todaysEvents = [];
  var todayListEl = document.getElementById("todayList");
  var weekListEl = document.getElementById("weekList");
  var emailListEl = document.getElementById("emailList");
  var syncedAtEl = document.getElementById("syncedAt");

  // ================= Calendar card: Agenda / Month toggle =================
  var CAL_VIEW_KEY = "nexus_cal_view_v1";
  function loadCalView(){ try{ var v = localStorage.getItem(CAL_VIEW_KEY); return (v==="month"||v==="agenda") ? v : "agenda"; }catch(e){ return "agenda"; } }
  function saveCalView(v){ localStorage.setItem(CAL_VIEW_KEY, v); }
  var calView = loadCalView();
  var calMonthDate = new Date();
  var calAgendaViewEl = document.getElementById("calAgendaView");
  var calMonthViewEl = document.getElementById("calMonthView");
  var calMonthNavEl = document.getElementById("calMonthNav");
  var calGridEl = document.getElementById("calGrid");
  var calMonthLabelEl = document.getElementById("calMonthLabel");
  var calOpenPopup = null;

  function closeQuickAdd(){
    if(calOpenPopup && calOpenPopup.parentNode) calOpenPopup.parentNode.removeChild(calOpenPopup);
    calOpenPopup = null;
  }

  function renderAgendaView(){
    todaysEvents = EVENTS.filter(function(e){ return eventCoversDate(e, today); });
    if(!CALENDAR_CONNECTED){
      todayListEl.innerHTML = '<div class="empty-state">Connect Google Calendar in Settings to see today’s events.</div>';
    } else if(todaysEvents.length){
      todayListEl.innerHTML = todaysEvents.map(function(e){
        return '<div class="event-row"><div class="event-time">'+(e.allDay?"ALL DAY":fmtTime(e.startTime||e.startDate))+'</div>'+
          '<div><div class="event-title">'+escapeHtml(e.title)+'</div>'+
          '<div class="event-meta">Primary calendar</div></div></div>';
      }).join("");
    } else {
      todayListEl.innerHTML = '<div class="empty-state">Nothing on the books today. Clear runway.</div>';
    }

    var weekRows = [];
    for(var i=0;i<7;i++){
      var d = new Date(); d.setDate(d.getDate()+i);
      var iso = d.toISOString().slice(0,10);
      var dayEvents = EVENTS.filter(function(e){ return eventCoversDate(e, iso); });
      var content = dayEvents.length
        ? dayEvents.map(function(e){ return escapeHtml(e.title) + (e.allDay ? "" : " · "+fmtTime(e.startTime||e.startDate)); }).join(", ")
        : null;
      weekRows.push(
        '<div class="week-row">'+
          '<div class="week-day'+(i===0?' is-today':'')+'">'+(i===0?"Today":fmtDay(iso))+'</div>'+
          (content
            ? '<div class="week-content">'+content+'</div>'
            : '<div class="week-content muted">'+(CALENDAR_CONNECTED?"no events scheduled":"connect Calendar")+'</div>')+
        '</div>'
      );
    }
    weekListEl.innerHTML = weekRows.join("");
  }

  function isoOf(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }

  function monthGridRange(year, month){
    var firstOfMonth = new Date(year, month, 1);
    var daysInMonth = new Date(year, month+1, 0).getDate();
    var leadOffset = (firstOfMonth.getDay()+6)%7; // Monday-first
    var totalCells = Math.ceil((leadOffset+daysInMonth)/7)*7;
    return {
      leadOffset: leadOffset, daysInMonth: daysInMonth, totalCells: totalCells,
      firstCell: new Date(year, month, 1-leadOffset),
      lastCell: new Date(year, month, totalCells-leadOffset)
    };
  }

  function drawMonthGrid(year, month, range){
    var cellsHtml = [];
    for(var i=0;i<range.totalCells;i++){
      var dayNum = i-range.leadOffset+1;
      var cellDate = new Date(year, month, dayNum);
      var iso = isoOf(cellDate);
      var inMonth = dayNum>=1 && dayNum<=range.daysInMonth;
      var isToday = iso===today;
      var dayEvents = EVENTS.filter(function(e){ return eventCoversDate(e, iso); });
      cellsHtml.push(
        '<div class="cal-day'+(inMonth?"":" outside")+(isToday?" today":"")+'" data-date="'+iso+'">'+
          '<div class="cal-day-num">'+cellDate.getDate()+'</div>'+
          (dayEvents.length ? '<div class="cal-day-events">'+dayEvents.map(function(e){
            return '<div class="cal-day-pill" data-event-id="'+escapeHtml(e.id)+'">'+escapeHtml(truncate(e.title,16))+'</div>';
          }).join("")+'</div>' : '')+
        '</div>'
      );
    }
    calGridEl.innerHTML = cellsHtml.join("");
  }

  // caches which "year-month" ranges we've already fetched from Google this
  // session, so navigating around doesn't refetch the same month repeatedly.
  var calFetchedMonths = {};

  function renderMonthView(){
    closeQuickAdd();
    var year = calMonthDate.getFullYear(), month = calMonthDate.getMonth();
    calMonthLabelEl.textContent = calMonthDate.toLocaleDateString(undefined,{month:"long",year:"numeric"});

    var range = monthGridRange(year, month);
    drawMonthGrid(year, month, range);

    var key = year+"-"+month;
    if(!CALENDAR_CONNECTED || calFetchedMonths[key]) return;
    calFetchedMonths[key] = true;

    var timeMin = new Date(range.firstCell.getFullYear(), range.firstCell.getMonth(), range.firstCell.getDate(), 0,0,0).toISOString();
    var timeMax = new Date(range.lastCell.getFullYear(), range.lastCell.getMonth(), range.lastCell.getDate(), 23,59,59).toISOString();
    calendarApi.listEvents({ timeMin: timeMin, timeMax: timeMax }).then(function(events){
      if(events && events.length){
        mergeEvents(events);
        if(calView==="month" && calMonthDate.getFullYear()===year && calMonthDate.getMonth()===month){
          drawMonthGrid(year, month, range);
        }
        buildNeuralMap();
      }
    }).catch(function(){
      calFetchedMonths[key] = false; // allow retry on next visit to this month
    });
  }

  function renderCalendarSection(){
    document.getElementById("calViewAgendaBtn").classList.toggle("active", calView==="agenda");
    document.getElementById("calViewMonthBtn").classList.toggle("active", calView==="month");
    calAgendaViewEl.style.display = calView==="agenda" ? "" : "none";
    calMonthViewEl.style.display = calView==="month" ? "" : "none";
    calMonthNavEl.classList.toggle("visible", calView==="month");
    if(calView==="month") renderMonthView(); else renderAgendaView();
  }

  document.getElementById("calViewAgendaBtn").addEventListener("click", function(){
    calView = "agenda"; saveCalView(calView); renderCalendarSection();
  });
  document.getElementById("calViewMonthBtn").addEventListener("click", function(){
    calView = "month"; saveCalView(calView); renderCalendarSection();
  });
  document.getElementById("calPrevMonth").addEventListener("click", function(){
    calMonthDate.setMonth(calMonthDate.getMonth()-1); renderMonthView();
  });
  document.getElementById("calNextMonth").addEventListener("click", function(){
    calMonthDate.setMonth(calMonthDate.getMonth()+1); renderMonthView();
  });
  document.getElementById("calTodayBtn").addEventListener("click", function(){
    calMonthDate = new Date(); renderMonthView();
  });

  function findEventById(id){
    return EVENTS.find(function(e){ return e.id===id; });
  }

  function openEventEditPopup(dayEl, eventId){
    var e = findEventById(eventId);
    if(!e) return;
    if(calOpenPopup && calOpenPopup.parentNode===dayEl){ closeQuickAdd(); return; }
    closeQuickAdd();
    var iso = e.startDate;
    var popup = document.createElement("div");
    popup.className = "cal-quickadd";
    var timeVal = e.allDay ? "" : (e.startTime||"").slice(11,16);
    var endTimeVal = e.allDay ? "" : (e.endTime||"").slice(11,16);
    var endDateVal = (e.endDate && e.endDate!==e.startDate) ? e.endDate : "";
    popup.innerHTML =
      '<input type="text" id="qaTitle" placeholder="Event title" maxlength="200" value="'+escapeHtml(e.title)+'" />'+
      '<input type="text" id="qaLocation" placeholder="Location (optional)" maxlength="200" value="'+escapeHtml(e.location||"")+'" />'+
      '<div class="cal-quickadd-row">'+
        '<input type="time" id="qaTime" title="Start time" value="'+timeVal+'" />'+
        '<input type="time" id="qaEndTime" title="End time" value="'+endTimeVal+'" />'+
      '</div>'+
      '<div class="cal-quickadd-hint">End date (optional, for multi-day)</div>'+
      '<input type="date" id="qaEndDate" min="'+iso+'" value="'+endDateVal+'" />'+
      '<div class="cal-quickadd-actions">'+
        '<button class="chip-btn danger" id="qaDelete">Delete</button>'+
        '<button class="chip-btn" id="qaCancel">Cancel</button>'+
        '<button class="chip-btn" id="qaSave">Save</button>'+
      '</div>';
    dayEl.appendChild(popup);
    calOpenPopup = popup;
    popup.addEventListener("click", function(e2){ e2.stopPropagation(); });
    var titleInput = popup.querySelector("#qaTitle");
    var locationInput = popup.querySelector("#qaLocation");
    var timeInput = popup.querySelector("#qaTime");
    var endTimeInput = popup.querySelector("#qaEndTime");
    var endDateInput = popup.querySelector("#qaEndDate");
    titleInput.focus();
    titleInput.select();

    function refetchCurrentMonth(){
      delete calFetchedMonths[calMonthDate.getFullYear()+"-"+calMonthDate.getMonth()];
      renderMonthView();
    }

    function save(){
      var title = titleInput.value.trim();
      if(!title){ titleInput.focus(); return; }
      var time = timeInput.value || null;
      var endTime = endTimeInput.value || null;
      var endDate = endDateInput.value || null;
      var location = locationInput.value.trim() || null;
      closeQuickAdd();
      calendarApi.updateEvent({
        eventId: eventId, title: title, date: iso, time: time||undefined,
        endTime: endTime||undefined, endDate: endDate||undefined, location: location||undefined
      }).then(function(){
        showToast('Updated "'+title+'".');
        refetchCurrentMonth();
        doRefresh();
      }).catch(function(err){ showToast(err.message || "Could not update the event.", true); });
    }
    function del(){
      closeQuickAdd();
      calendarApi.deleteEvent({ eventId: eventId }).then(function(){
        showToast('Deleted "'+e.title+'".');
        var idx = EVENTS.findIndex(function(x){ return x.id===eventId; });
        if(idx>-1) EVENTS.splice(idx,1);
        renderMonthView();
        buildNeuralMap();
      }).catch(function(err){ showToast(err.message || "Could not delete the event.", true); });
    }
    popup.querySelector("#qaSave").addEventListener("click", save);
    popup.querySelector("#qaDelete").addEventListener("click", del);
    popup.querySelector("#qaCancel").addEventListener("click", function(){ closeQuickAdd(); });
    [titleInput, locationInput, timeInput, endTimeInput, endDateInput].forEach(function(el){
      el.addEventListener("keydown", function(e2){ if(e2.key==="Enter"){ e2.preventDefault(); save(); } if(e2.key==="Escape"){ closeQuickAdd(); } });
    });
  }

  document.getElementById("calGrid").addEventListener("click", function(ev){
    var pillEl = ev.target.closest(".cal-day-pill");
    if(pillEl){
      openEventEditPopup(pillEl.closest(".cal-day"), pillEl.getAttribute("data-event-id"));
      return;
    }
    var dayEl = ev.target.closest(".cal-day");
    if(!dayEl || dayEl.classList.contains("outside")) return;
    if(calOpenPopup && calOpenPopup.parentNode===dayEl){ closeQuickAdd(); return; }
    closeQuickAdd();
    var iso = dayEl.getAttribute("data-date");
    var popup = document.createElement("div");
    popup.className = "cal-quickadd";
    popup.innerHTML =
      '<input type="text" id="qaTitle" placeholder="Event title" maxlength="200" />'+
      '<input type="text" id="qaLocation" placeholder="Location (optional)" maxlength="200" />'+
      '<div class="cal-quickadd-row">'+
        '<input type="time" id="qaTime" title="Start time" />'+
        '<input type="time" id="qaEndTime" title="End time" />'+
      '</div>'+
      '<div class="cal-quickadd-hint">End date (optional, for multi-day)</div>'+
      '<input type="date" id="qaEndDate" min="'+iso+'" />'+
      '<div class="cal-quickadd-actions">'+
        '<button class="chip-btn" id="qaCancel">Cancel</button>'+
        '<button class="chip-btn" id="qaSave">Save</button>'+
      '</div>';
    dayEl.appendChild(popup);
    calOpenPopup = popup;
    popup.addEventListener("click", function(e){ e.stopPropagation(); });
    var titleInput = popup.querySelector("#qaTitle");
    var locationInput = popup.querySelector("#qaLocation");
    var timeInput = popup.querySelector("#qaTime");
    var endTimeInput = popup.querySelector("#qaEndTime");
    var endDateInput = popup.querySelector("#qaEndDate");
    titleInput.focus();

    function save(){
      var title = titleInput.value.trim();
      if(!title){ titleInput.focus(); return; }
      var time = timeInput.value || null;
      var endTime = endTimeInput.value || null;
      var endDate = endDateInput.value || null;
      var location = locationInput.value.trim() || null;
      closeQuickAdd();
      createEventFromApp(title, iso, time, endTime, endDate, location);
    }
    popup.querySelector("#qaSave").addEventListener("click", save);
    popup.querySelector("#qaCancel").addEventListener("click", function(){ closeQuickAdd(); });
    [titleInput, locationInput, timeInput, endTimeInput, endDateInput].forEach(function(el){
      el.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); save(); } if(e.key==="Escape"){ closeQuickAdd(); } });
    });
  });

  document.addEventListener("click", function(ev){
    if(calOpenPopup && !calOpenPopup.contains(ev.target) && !ev.target.closest(".cal-day")){
      closeQuickAdd();
    }
  });

  function renderCalendarAndInbox(){
    renderCalendarSection();

    // ================= Emails =================
    if(!GMAIL_CONNECTED){
      emailListEl.innerHTML = '<div class="empty-state">Connect Gmail in Settings to see your inbox.</div>';
    } else if(EMAILS.length){
      emailListEl.innerHTML = EMAILS.map(function(m){
        return '<div class="email-row" data-uid="'+m.uid+'">'+
          '<div class="email-top"><span class="email-from">'+escapeHtml(m.from)+'</span><span class="email-when">'+fmtWhen(m.date)+'</span></div>'+
          '<div class="email-subject">'+escapeHtml(m.subject)+'</div>'+
          '<div class="email-snippet">'+escapeHtml(m.snippet||"")+'</div>'+
          '<div class="row-actions">'+
            '<button class="chip-btn" data-markread="'+m.uid+'">Mark read</button>'+
            '<button class="chip-btn" data-followup="'+escapeHtml(m.subject)+'">Add follow-up to to-do</button>'+
          '</div>'+
        '</div>';
      }).join("");
    } else {
      emailListEl.innerHTML = '<div class="empty-state">Inbox is quiet — no unread mail.</div>';
    }

    renderSyncedAt();
    buildNeuralMap();
  }

  function renderSyncedAt(){
    syncedAtEl.textContent = SYNCED_AT ? fmtWhen(SYNCED_AT) : "never";
  }
  setInterval(renderSyncedAt, 30000);

  // Replaces the old single "refreshDashboardData" IPC call - one unified
  // Google sign-in covers both Calendar and Gmail scopes together, so
  // there's no scenario where one is connected and the other isn't; both
  // just mirror auth.isConnected(). Reshaped into the exact {inbox,
  // calendar, syncedAt} object doRefresh() already expects.
  function fetchDashboardData(){
    if(!auth.isConnected()){
      return Promise.resolve({
        inbox: { connected:false, emails:[] },
        calendar: { connected:false, events:[] },
        syncedAt: new Date().toISOString()
      });
    }
    return Promise.all([
      gmailApi.getUnreadSummaries(5).catch(function(err){ return { __error: err.message }; }),
      calendarApi.listUpcomingEvents().catch(function(err){ return { __error: err.message }; })
    ]).then(function(results){
      var emailsResult = results[0], eventsResult = results[1];
      var inbox = Array.isArray(emailsResult) ? { connected:true, emails:emailsResult } : { connected:true, emails:[], error:emailsResult.__error };
      var calendar = Array.isArray(eventsResult) ? { connected:true, events:eventsResult } : { connected:true, events:[], error:eventsResult.__error };
      return { inbox: inbox, calendar: calendar, syncedAt: new Date().toISOString() };
    });
  }

  var refreshing = false;
  function doRefresh(){
    if(refreshing) return Promise.resolve();
    refreshing = true;
    var refreshBtn = document.getElementById("refreshBtn");
    if(refreshBtn) refreshBtn.disabled = true;
    return fetchDashboardData().then(function(data){
      GMAIL_CONNECTED = !!(data.inbox && data.inbox.connected);
      EMAILS = (data.inbox && data.inbox.emails) || [];
      CALENDAR_CONNECTED = !!(data.calendar && data.calendar.connected);
      // merge (not replace) so previously-fetched past/future months browsed
      // in the Month view aren't wiped out by this default-window refresh
      mergeEvents((data.calendar && data.calendar.events) || []);
      calFetchedMonths = {}; // force whichever month is on screen to refetch fresh
      SYNCED_AT = data.syncedAt;
      renderCalendarAndInbox();
    }).catch(function(err){
      showToast(err.message || "Could not refresh.", true);
    }).finally(function(){
      refreshing = false;
      if(refreshBtn) refreshBtn.disabled = false;
    });
  }

  console.log("TEMP-DEBUG: before renderCalendarAndInbox");
  renderCalendarAndInbox();
  console.log("TEMP-DEBUG: before settingsPanel.init, typeof settingsPanel=", typeof settingsPanel);
  settingsPanel.init();
  console.log("TEMP-DEBUG: after settingsPanel.init");

  // Cross-device sync (todos/habits/conferences, via the user's own Google
  // Drive) - gather/apply wire driveSync.js's merge result back into this
  // file's own in-memory vars + localStorage without going through
  // saveTodos/saveConferences/etc. (which would just schedule another sync).
  driveSync.init({
    gather: function(){
      return {
        version: 1,
        todos: { data: todos, tombstones: todoTombstones },
        conferences: { data: conferences, tombstones: confTombstones },
        habitDefs: { data: HABITS, tombstones: habitTombstones },
        habitLog: { updatedAt: parseInt(localStorage.getItem(HABIT_LOG_UPDATED_KEY),10)||0, data: habitLog },
        dailyStats: { updatedAt: parseInt(localStorage.getItem(DAILY_STATS_UPDATED_KEY),10)||0, data: dailyStats }
      };
    },
    apply: function(merged){
      if(merged.todos){
        todos = merged.todos.data || [];
        todoTombstones = merged.todos.tombstones || [];
        localStorage.setItem(TODO_KEY, JSON.stringify(todos));
        localStorage.setItem(TODO_TOMBSTONES_KEY, JSON.stringify(todoTombstones));
      }
      if(merged.conferences){
        conferences = merged.conferences.data || [];
        confTombstones = merged.conferences.tombstones || [];
        localStorage.setItem(CONF_KEY, JSON.stringify(conferences));
        localStorage.setItem(CONF_TOMBSTONES_KEY, JSON.stringify(confTombstones));
      }
      if(merged.habitDefs){
        HABITS = (merged.habitDefs.data && merged.habitDefs.data.length) ? merged.habitDefs.data : HABITS;
        habitTombstones = merged.habitDefs.tombstones || [];
        localStorage.setItem(HABIT_DEFS_KEY, JSON.stringify(HABITS));
        localStorage.setItem(HABIT_TOMBSTONES_KEY, JSON.stringify(habitTombstones));
        recomputeMaxDaily();
      }
      if(merged.habitLog){
        habitLog = merged.habitLog.data || {};
        if(!habitLog[today]) habitLog[today] = {};
        localStorage.setItem(HABIT_KEY, JSON.stringify(habitLog));
        localStorage.setItem(HABIT_LOG_UPDATED_KEY, String(merged.habitLog.updatedAt||Date.now()));
      }
      if(merged.dailyStats){
        dailyStats = merged.dailyStats.data || {};
        localStorage.setItem(DAILY_STATS_KEY, JSON.stringify(dailyStats));
        localStorage.setItem(DAILY_STATS_UPDATED_KEY, String(merged.dailyStats.updatedAt||Date.now()));
      }
      renderTodos(); renderConferences(); renderHabits();
    },
    toast: showToast
  });

  // Must resolve (a no-op {handled:false} on a normal load, or the actual
  // token exchange when returning from Google) before the first doRefresh()
  // - otherwise a fresh sign-in redirect would race its own token save and
  // this initial fetch would still see "not connected".
  auth.handleRedirectIfPresent().then(function(result){
    if(result.handled && !result.ok){
      showToast("Google sign-in failed: " + result.error, true);
    } else if(result.handled && result.ok){
      showToast("Connected to your Google account.");
      driveSync.syncOnLoad();
    }
    doRefresh();
  });
  driveSync.syncOnLoad();

  document.getElementById("refreshBtn").addEventListener("click", function(){ doRefresh(); });
  document.getElementById("settingsBtn").addEventListener("click", function(){
    settingsPanel.toggle();
  });

  document.getElementById("emailList").addEventListener("click", function(ev){
    var markBtn = ev.target.closest("[data-markread]");
    var followBtn = ev.target.closest("[data-followup]");
    if(markBtn){
      var uid = markBtn.getAttribute("data-markread");
      markBtn.disabled = true;
      gmailApi.markAsRead(uid).then(function(){
        EMAILS = EMAILS.filter(function(m){ return String(m.uid) !== String(uid); });
        bumpDailyStat("mailRead");
        renderCalendarAndInbox();
      }).catch(function(err){
        showToast(err.message || "Could not mark as read.", true);
        markBtn.disabled = false;
      });
    }
    if(followBtn){
      var subj = followBtn.getAttribute("data-followup");
      todos.unshift({ id:"t"+Date.now(), text:"Follow up: "+subj, done:false, due:null, priority:"medium", updatedAt:Date.now() });
      saveTodos(todos); renderTodos();
    }
  });

  // ================= To-do list (local, editable) =================
  var TODO_KEY = "nexus_todos_v1";
  var PRIORITIES = ["low","medium","high"];
  function loadTodos(){
    try{
      var list = JSON.parse(localStorage.getItem(TODO_KEY))||[];
      list.forEach(function(t){ if(PRIORITIES.indexOf(t.priority)===-1) t.priority = "medium"; });
      return list;
    }catch(e){ return []; }
  }
  function saveTodos(t){ localStorage.setItem(TODO_KEY, JSON.stringify(t)); driveSync.scheduleSync(); }
  var TODO_TOMBSTONES_KEY = "nexus_todos_tombstones_v1";
  function loadTodoTombstones(){ try{ return JSON.parse(localStorage.getItem(TODO_TOMBSTONES_KEY))||[]; }catch(e){ return []; } }
  function saveTodoTombstones(t){ localStorage.setItem(TODO_TOMBSTONES_KEY, JSON.stringify(t)); }
  var todoTombstones = loadTodoTombstones();
  function tombstoneTodo(id){ todoTombstones.push({ id:id, deletedAt:Date.now() }); saveTodoTombstones(todoTombstones); }
  var todos = loadTodos();

  function renderTodos(){
    var listEl = document.getElementById("todoList");
    if(!todos.length){
      listEl.innerHTML = '<div class="empty-state">No tasks yet — add your first one above.</div>';
    } else {
      listEl.innerHTML = todos.map(function(t){
        return '<div class="todo-item'+(t.done?' done':'')+'" data-id="'+t.id+'">'+
          '<input type="checkbox" '+(t.done?'checked':'')+' data-action="toggle" />'+
          '<div class="todo-main" style="flex:1">'+
            '<div class="todo-text" data-action="text">'+escapeHtml(t.text)+'</div>'+
            (t.due?'<div class="todo-due">due '+fmtDay(t.due)+'</div>':'')+
          '</div>'+
          '<div class="todo-actions">'+
            '<button class="todo-priority '+t.priority+'" data-action="priority" title="Priority: '+t.priority+' (click to change)"></button>'+
            '<button class="icon-btn" data-action="edit" title="Edit">✎</button>'+
            '<button class="icon-btn" data-action="delete" title="Delete">✕</button>'+
          '</div>'+
        '</div>';
      }).join("");
    }
    buildNeuralMap();
  }
  renderTodos();

  document.getElementById("todoForm").addEventListener("submit", function(ev){
    ev.preventDefault();
    var input = document.getElementById("todoInput");
    var dueInput = document.getElementById("todoDue");
    var priorityInput = document.getElementById("todoPriority");
    var text = input.value.trim();
    if(!text) return;
    todos.unshift({ id: "t"+Date.now(), text: text, done:false, due: dueInput.value||null, priority: priorityInput.value, updatedAt: Date.now() });
    saveTodos(todos); renderTodos();
    input.value=""; dueInput.value=""; priorityInput.value="medium";
  });

  document.getElementById("todoList").addEventListener("click", function(ev){
    var btn = ev.target.closest("[data-action]");
    if(!btn) return;
    var row = ev.target.closest(".todo-item");
    var id = row && row.getAttribute("data-id");
    var t = todos.find(function(x){return x.id===id;});
    var action = btn.getAttribute("data-action");

    if(action==="toggle" && t){
      t.done = btn.checked;
      // completedDate records *which day* this checkoff counts toward for
      // the Daily Score - cleared on un-check so un-completing it the same
      // day removes those points again, same as habits already behave.
      t.completedDate = t.done ? todayISO() : null;
      t.updatedAt = Date.now();
      saveTodos(todos); renderTodos();
    } else if(action==="delete" && t){
      tombstoneTodo(t.id);
      todos = todos.filter(function(x){return x.id!==id;});
      saveTodos(todos); renderTodos();
    } else if(action==="priority" && t){
      var idx = PRIORITIES.indexOf(t.priority);
      t.priority = PRIORITIES[(idx+1)%PRIORITIES.length];
      t.updatedAt = Date.now();
      saveTodos(todos); renderTodos();
    } else if(action==="edit" && t){
      var mainEl = row.querySelector('.todo-main');
      var currentText = t.text;
      mainEl.style.display = "flex";
      mainEl.style.flexDirection = "column";
      mainEl.style.gap = "4px";
      mainEl.innerHTML =
        '<input type="text" class="todo-edit-input" value="'+escapeHtml(currentText)+'" />'+
        '<input type="date" class="todo-edit-due" value="'+(t.due||'')+'" />';
      var textInput = mainEl.querySelector('.todo-edit-input');
      var dueInput = mainEl.querySelector('.todo-edit-due');
      textInput.focus();
      textInput.select();
      var committed = false;
      function commit(){
        if(committed) return;
        committed = true;
        var v = textInput.value.trim();
        t.text = v || currentText;
        t.due = dueInput.value || null;
        t.updatedAt = Date.now();
        saveTodos(todos); renderTodos();
      }
      mainEl.addEventListener("focusout", function(e){
        if(!mainEl.contains(e.relatedTarget)) commit();
      });
      mainEl.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); commit(); } });
    }
  });

  // ================= Conferences (abstract/accommodation/content prep) =================
  // CONF_KEY/CONF_TASKS/loadConferences/saveConferences/conferences moved to
  // the top of the file (see the comment up there) - buildNeuralMap() reads
  // `conferences` on a first call that happens earlier than this point.

  function fmtConfDates(c){
    if(!c.startDate) return "";
    var start = fmtDay(c.startDate);
    if(c.endDate && c.endDate!==c.startDate) return start+" – "+fmtDay(c.endDate);
    return start;
  }

  // "urgent" once a task's own due date is within a week and it's still
  // unticked; "overdue" once that date has passed. No due date set at all
  // means no reminder, so existing conferences with none are unaffected.
  var TASK_URGENT_WINDOW_DAYS = 7;
  function taskUrgency(dueDate){
    if(!dueDate) return null;
    if(dueDate < today) return "overdue";
    var diffDays = Math.round((new Date(dueDate+"T00:00:00") - new Date(today+"T00:00:00")) / 86400000);
    return diffDays <= TASK_URGENT_WINDOW_DAYS ? "urgent" : null;
  }

  function renderConferences(){
    var listEl = document.getElementById("confList");
    if(!conferences.length){
      listEl.innerHTML = '<div class="empty-state">No conferences yet — add one above.</div>';
    } else {
      var sorted = conferences.slice().sort(function(a,b){
        if(!a.startDate && !b.startDate) return 0;
        if(!a.startDate) return 1;
        if(!b.startDate) return -1;
        return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0;
      });
      listEl.innerHTML = sorted.map(function(c){
        var meta = [fmtConfDates(c), c.location ? escapeHtml(c.location) : ""].filter(Boolean).join(" · ");
        return '<div class="conf-item" data-id="'+c.id+'">'+
          '<div class="conf-header">'+
            '<div class="conf-main"><div class="conf-title">'+escapeHtml(c.title)+'</div>'+
            (meta?'<div class="conf-dates">'+meta+'</div>':'')+
            '</div>'+
            '<div class="todo-actions">'+
              '<button class="icon-btn" data-action="edit" title="Edit">✎</button>'+
              '<button class="icon-btn" data-action="delete" title="Delete">✕</button>'+
            '</div>'+
          '</div>'+
          '<div class="conf-tasks">'+
            CONF_TASKS.map(function(t){
              var done = !!(c.tasks && c.tasks[t.key]);
              var dueDate = c.taskDueDates && c.taskDueDates[t.key];
              var urgency = done ? null : taskUrgency(dueDate);
              var cls = "conf-task"+(done?" done":"")+(urgency?" "+urgency:"");
              var dueBadge = (!done && dueDate) ? '<span class="conf-task-due">'+fmtDay(dueDate)+'</span>' : "";
              return '<span class="conf-task-wrap">'+
                '<button class="'+cls+'" data-task="'+t.key+'">'+(done?'✓ ':'')+t.label+dueBadge+'</button>'+
                (!done ? '<button class="conf-task-date-btn" data-task-date="'+t.key+'" title="Set due date">📅</button>' : '')+
              '</span>';
            }).join("")+
          '</div>'+
        '</div>';
      }).join("");
    }
    buildNeuralMap();
  }
  renderConferences();

  document.getElementById("confForm").addEventListener("submit", function(ev){
    ev.preventDefault();
    var titleInput = document.getElementById("confTitle");
    var locationInput = document.getElementById("confLocation");
    var startInput = document.getElementById("confStart");
    var endInput = document.getElementById("confEnd");
    var title = titleInput.value.trim();
    if(!title) return;
    conferences.unshift({
      id: "c"+Date.now(),
      title: title,
      location: locationInput.value.trim()||null,
      startDate: startInput.value||null,
      endDate: endInput.value||null,
      tasks: { registration:false, abstract:false, accommodation:false, content:false },
      taskDueDates: { registration:null, abstract:null, accommodation:null, content:null },
      updatedAt: Date.now()
    });
    saveConferences(conferences); renderConferences();
    titleInput.value=""; locationInput.value=""; startInput.value=""; endInput.value="";
  });

  var confDateOpenPopup = null;
  function closeConfDatePopup(){
    if(confDateOpenPopup && confDateOpenPopup.parentNode) confDateOpenPopup.parentNode.removeChild(confDateOpenPopup);
    confDateOpenPopup = null;
  }
  document.addEventListener("click", function(ev){
    if(confDateOpenPopup && !confDateOpenPopup.contains(ev.target) && !ev.target.closest(".conf-task-wrap")){
      closeConfDatePopup();
    }
  });

  document.getElementById("confList").addEventListener("click", function(ev){
    var row = ev.target.closest(".conf-item");
    if(!row) return;
    var id = row.getAttribute("data-id");
    var c = conferences.find(function(x){return x.id===id;});
    if(!c) return;
    var delBtn = ev.target.closest('[data-action="delete"]');
    var editBtn = ev.target.closest('[data-action="edit"]');
    var taskDateBtn = ev.target.closest('[data-task-date]');
    var taskBtn = !taskDateBtn && ev.target.closest('[data-task]');
    if(delBtn){
      tombstoneConf(c.id);
      conferences = conferences.filter(function(x){return x.id!==id;});
      saveConferences(conferences); renderConferences();
    } else if(editBtn){
      var mainEl = row.querySelector('.conf-main');
      var cur = { title:c.title, location:c.location||"", startDate:c.startDate||"", endDate:c.endDate||"" };
      mainEl.innerHTML =
        '<input type="text" class="todo-edit-input" placeholder="Title" value="'+escapeHtml(cur.title)+'" style="display:block;width:100%;box-sizing:border-box" />'+
        '<input type="text" class="todo-edit-input" placeholder="Location" value="'+escapeHtml(cur.location)+'" style="display:block;width:100%;box-sizing:border-box;margin-top:6px" />'+
        '<div style="display:flex;gap:6px;margin-top:6px">'+
          '<input type="date" class="todo-edit-due" value="'+cur.startDate+'" />'+
          '<input type="date" class="todo-edit-due" value="'+cur.endDate+'" />'+
        '</div>';
      var inputs = mainEl.querySelectorAll('input');
      var titleInput = inputs[0], locationInput = inputs[1], startInput = inputs[2], endInput = inputs[3];
      titleInput.focus();
      titleInput.select();
      var committed = false;
      function commit(){
        if(committed) return;
        committed = true;
        var v = titleInput.value.trim();
        c.title = v || cur.title;
        c.location = locationInput.value.trim() || null;
        c.startDate = startInput.value || null;
        c.endDate = endInput.value || null;
        c.updatedAt = Date.now();
        saveConferences(conferences); renderConferences();
      }
      mainEl.addEventListener("focusout", function(e){
        if(!mainEl.contains(e.relatedTarget)) commit();
      });
      mainEl.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); commit(); } });
    } else if(taskBtn){
      var key = taskBtn.getAttribute("data-task");
      if(!c.tasks) c.tasks = { registration:false, abstract:false, accommodation:false, content:false };
      c.tasks[key] = !c.tasks[key];
      // taskDates records *which day* each tick counts toward for the Daily
      // Score (same "clears on un-tick" logic as to-dos above).
      if(!c.taskDates) c.taskDates = {};
      c.taskDates[key] = c.tasks[key] ? todayISO() : null;
      c.updatedAt = Date.now();
      saveConferences(conferences); renderConferences();
    } else if(taskDateBtn){
      var tkey = taskDateBtn.getAttribute("data-task-date");
      var wrap = taskDateBtn.closest(".conf-task-wrap");
      if(confDateOpenPopup && confDateOpenPopup.parentNode===wrap){ closeConfDatePopup(); return; }
      closeConfDatePopup();
      var current = (c.taskDueDates && c.taskDueDates[tkey]) || "";
      var popup = document.createElement("div");
      popup.className = "conf-task-datepopup";
      popup.innerHTML =
        '<input type="date" id="tdDate" value="'+current+'" />'+
        '<div class="conf-task-datepopup-actions">'+
          '<button class="chip-btn" id="tdClear">Clear</button>'+
          '<button class="chip-btn" id="tdSave">Save</button>'+
        '</div>';
      wrap.appendChild(popup);
      confDateOpenPopup = popup;
      popup.addEventListener("click", function(e2){ e2.stopPropagation(); });
      var dateInput = popup.querySelector("#tdDate");
      dateInput.focus();
      function setTaskDue(val){
        if(!c.taskDueDates) c.taskDueDates = { registration:null, abstract:null, accommodation:null, content:null };
        c.taskDueDates[tkey] = val || null;
        c.updatedAt = Date.now();
        saveConferences(conferences); renderConferences();
      }
      popup.querySelector("#tdSave").addEventListener("click", function(){ var v = dateInput.value; closeConfDatePopup(); setTaskDue(v); });
      popup.querySelector("#tdClear").addEventListener("click", function(){ closeConfDatePopup(); setTaskDue(null); });
      dateInput.addEventListener("keydown", function(e2){
        if(e2.key==="Enter"){ e2.preventDefault(); var v = dateInput.value; closeConfDatePopup(); setTaskDue(v); }
        if(e2.key==="Escape"){ closeConfDatePopup(); }
      });
    }
  });


  // ================= Habit tracker =================
  document.getElementById("habitDateLabel").textContent = "Check off today · resets daily";

  function scoreFor(dayKey){
    var log = habitLog[dayKey] || {};
    return HABITS.reduce(function(sum,h){ return sum + (log[h.id] ? h.pts : 0); }, 0);
  }

  function renderHabits(){
    var log = habitLog[today];
    var listEl = document.getElementById("habitList");
    if(!HABITS.length){
      listEl.innerHTML = '<div class="empty-state">No habits yet — add your first one below.</div>';
    } else {
      listEl.innerHTML = HABITS.map(function(h){
        var done = !!log[h.id];
        return '<div class="habit-row'+(done?' done':'')+'" data-id="'+h.id+'">'+
          '<input type="checkbox" data-action="toggle" '+(done?'checked':'')+' />'+
          '<div class="habit-name" data-action="name">'+escapeHtml(h.name)+'</div>'+
          '<div class="habit-pts" data-action="pts">+'+h.pts+'</div>'+
          '<div class="todo-actions">'+
            '<button class="icon-btn" data-action="edit" title="Edit">✎</button>'+
            '<button class="icon-btn" data-action="delete" title="Delete">✕</button>'+
          '</div>'+
        '</div>';
      }).join("");
    }

    var score = scoreFor(today);
    document.getElementById("scoreToday").textContent = score;
    document.getElementById("scoreBar").style.width = Math.round(100*score/(MAX_DAILY||1))+"%";

    var spark = [], labels = [];
    for(var i=6;i>=0;i--){
      var d = new Date(); d.setDate(d.getDate()-i);
      var iso = d.toISOString().slice(0,10);
      spark.push(scoreFor(iso));
      labels.push(d.toLocaleDateString(undefined,{weekday:"narrow"}));
    }

    document.getElementById("weekSpark").innerHTML = spark.map(function(s,i){
      var h = Math.max(4, Math.round(38*s/(MAX_DAILY||1)));
      return '<div class="spark-bar'+(i===6?' today':'')+'" style="height:'+h+'px"></div>';
    }).join("");
    document.getElementById("weekSparkLabels").innerHTML = labels.map(function(l){ return '<span>'+l+'</span>'; }).join("");
    buildNeuralMap();
  }
  renderHabits();

  document.getElementById("habitList").addEventListener("change", function(ev){
    var row = ev.target.closest(".habit-row");
    if(!row) return;
    var id = row.getAttribute("data-id");
    habitLog[today][id] = ev.target.checked;
    saveHabitLog(habitLog);
    renderHabits();
  });

  document.getElementById("habitForm").addEventListener("submit", function(ev){
    ev.preventDefault();
    var nameInput = document.getElementById("habitNameInput");
    var ptsInput = document.getElementById("habitPtsInput");
    var name = nameInput.value.trim();
    var pts = Math.max(1, Math.min(100, parseInt(ptsInput.value, 10) || 10));
    if(!name) return;
    HABITS.push({ id:"h"+Date.now(), name:name, pts:pts, updatedAt:Date.now() });
    saveHabitDefs(HABITS);
    recomputeMaxDaily();
    renderHabits();
    nameInput.value = "";
    ptsInput.value = "10";
  });

  document.getElementById("habitList").addEventListener("click", function(ev){
    var btn = ev.target.closest("[data-action]");
    if(!btn) return;
    var row = ev.target.closest(".habit-row");
    var id = row && row.getAttribute("data-id");
    var h = HABITS.find(function(x){return x.id===id;});
    var action = btn.getAttribute("data-action");

    if(action==="delete" && h){
      tombstoneHabit(h.id);
      HABITS = HABITS.filter(function(x){return x.id!==id;});
      saveHabitDefs(HABITS);
      recomputeMaxDaily();
      renderHabits();
    } else if(action==="edit" && h){
      var nameEl = row.querySelector('[data-action="name"]');
      var ptsEl = row.querySelector('[data-action="pts"]');
      var currentName = h.name, currentPts = h.pts;
      nameEl.outerHTML = '<input type="text" class="todo-edit-input" data-action="name" value="'+escapeHtml(currentName)+'" />';
      ptsEl.outerHTML = '<input type="number" class="todo-edit-input" data-action="pts" min="1" max="100" value="'+currentPts+'" style="max-width:60px" />';
      var nameInput = row.querySelector('[data-action="name"]');
      var ptsInput = row.querySelector('[data-action="pts"]');
      nameInput.focus();
      nameInput.select();
      var committed = false;
      function commit(){
        if(committed) return;
        committed = true;
        var newName = nameInput.value.trim();
        var newPts = Math.max(1, Math.min(100, parseInt(ptsInput.value, 10) || currentPts));
        h.name = newName || currentName;
        h.pts = newPts;
        h.updatedAt = Date.now();
        saveHabitDefs(HABITS);
        recomputeMaxDaily();
        renderHabits();
      }
      nameInput.addEventListener("blur", function(){ setTimeout(commit, 120); });
      ptsInput.addEventListener("blur", function(){ setTimeout(commit, 120); });
      nameInput.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); commit(); } });
      ptsInput.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); commit(); } });
    }
  });

  // ================= Neural map (3D radial summary) =================
  function truncate(s,n){ return s.length>n ? s.slice(0,n-1)+"…" : s; }

  function shadeDark(hex,pct){
    var c = hexToRgb(hex);
    var r = Math.round(c[0]*(1-pct)), g = Math.round(c[1]*(1-pct)), b = Math.round(c[2]*(1-pct));
    return 'rgb('+r+','+g+','+b+')';
  }
  function shadeLight(hex,pct){
    var c = hexToRgb(hex);
    var r = Math.round(c[0]+(255-c[0])*pct), g = Math.round(c[1]+(255-c[1])*pct), b = Math.round(c[2]+(255-c[2])*pct);
    return 'rgb('+r+','+g+','+b+')';
  }

  // Daily-score "tier" color for the hub: a red -> amber -> green gradient
  // using the app's own severity colors, so the hub reads as "how is today
  // going" at a glance. ratio=1 (green) means today's full Daily Score
  // equals today's total possible HABIT points - not capped there, since a
  // strong to-dos/mail/calendar day should be able to compensate for
  // missed habits and read as an even richer green past 100%.
  // Computes the 3 reference stops fresh on each call (instead of a
  // module-level var) - buildNeuralMap() gets invoked for the first time
  // from the to-dos section further up the file, before a later top-level
  // var assignment here would have run yet, so a cached module-level
  // value would still be undefined on that first call (same ordering
  // pitfall as todos/conferences elsewhere in this file).
  function tierColorRgb(ratio){
    var stops = [hexToRgb('#fb7185'), hexToRgb('#f0b559'), hexToRgb('#57d68d')]; // critical -> warn -> good
    var r = Math.max(0, Math.min(1, ratio));
    var seg = r*2; // 0..2 spanning the 3 stops
    var i = Math.min(1, Math.floor(seg));
    var t = seg - i;
    var a = stops[i], b = stops[i+1];
    return [
      Math.round(a[0]+(b[0]-a[0])*t),
      Math.round(a[1]+(b[1]-a[1])*t),
      Math.round(a[2]+(b[2]-a[2])*t)
    ];
  }

  // Shared polar-coordinate helper (0deg = top, clockwise, matching the
  // rotate() convention used all over this map), used by the faceted ring
  // gauge and the spark's color-zone wedge below.
  function polarPt(cx,cy,r,deg){
    var rad = deg*Math.PI/180;
    return {x:(cx+r*Math.sin(rad)).toFixed(2), y:(cy-r*Math.cos(rad)).toFixed(2)};
  }
  // i is taken mod N with a safe (always-non-negative) modulo, since the
  // crown triangulation below needs to walk one step backward (i-1) from
  // vertex 0 - JS's native % can return negative results for negative
  // operands, which would silently compute a wrong angle instead of
  // wrapping to N-1. offsetDeg (default 0) rotates the whole vertex ring
  // by a fixed amount - used to place the inner ring's vertices half a
  // slot off from the outer ring's, for the crown pattern below.
  function facetVertex(cx,cy,r,i,N,offsetDeg){
    var idx = ((i%N)+N)%N;
    return polarPt(cx,cy,r,idx*(360/N) + (offsetDeg||0));
  }
  // Shortest angular distance between two angles (0-180deg), and a
  // brightness factor from it: 1 at the light source itself, smoothly
  // falling to 0 on the directly opposite side, via a cosine curve
  // (classic Lambertian-style falloff) rather than a linear one, which
  // reads as a softer, more natural gradient. facetOpacity() maps that
  // factor onto a wide min/max range (much wider than a simple two-shade
  // checker) so the contrast between the "lit-by-the-source" side of the
  // ring and the "shadowed" side is dramatic, not subtle - deliberately
  // deterministic (same light angle every render, no per-facet
  // randomness) so the gem's "cut" looks considered rather than noisy.
  function angularDist(a,b){
    var d = Math.abs(a-b)%360;
    return d>180 ? 360-d : d;
  }
  // tIndex (this triangle's position in the overall 0..2*HUB_FACETS-1
  // sequence) drives a small deterministic +/-15% alternation on top of
  // the lighting factor - every second triangle a touch brighter, the
  // rest a touch dimmer - so adjacent facets never land at exactly the
  // same opacity even when their angles are close, the way real cut
  // facets never perfectly match their neighbor. Fixed odd/even, not
  // random, same reasoning as the light-source direction above.
  function facetOpacity(angleDeg,isLit,tIndex){
    var factor = (Math.cos(angularDist(angleDeg,HUB_LIGHT_ANGLE)*Math.PI/180)+1)/2;
    var min = isLit ? 0.22 : 0.12, max = isLit ? 0.88 : 0.58;
    var base = min + factor*(max-min);
    var alt = (tIndex%2===0) ? 1.15 : 0.85;
    return Math.max(0.05, Math.min(0.95, base*alt)).toFixed(2);
  }
  // Full polygon annulus (outer ring + inner ring, N vertices each) as one
  // path with fill-rule="evenodd" punching the inner polygon out of the
  // outer one - this is the dark backing plate the facets sit on top of.
  function polygonRingBasePath(cx,cy,rOuter,rInner,N,innerOffsetDeg){
    var o = [], inn = [];
    for(var i=0;i<N;i++){ o.push(facetVertex(cx,cy,rOuter,i,N)); inn.push(facetVertex(cx,cy,rInner,i,N,innerOffsetDeg)); }
    var d = "M"+o[0].x+","+o[0].y;
    for(var j=1;j<N;j++) d += " L"+o[j].x+","+o[j].y;
    d += " Z M"+inn[0].x+","+inn[0].y;
    for(var k=1;k<N;k++) d += " L"+inn[k].x+","+inn[k].y;
    d += " Z";
    return d;
  }
  // Polyline through consecutive polygon vertices from fromIdx to toIdx
  // (inclusive) at radius r - used for the split lit/unlit outline. Unlike
  // arc-based paths (which have to special-case a "full circle" span,
  // since identical arc endpoints are silently treated as omitted per
  // spec), plain line segments have no such edge case: an empty
  // (fromIdx===toIdx) range just draws nothing, and a full loop
  // (toIdx===fromIdx+N) draws every vertex normally.
  function polygonArcPath(cx,cy,r,fromIdx,toIdx,N,offsetDeg){
    if(toIdx <= fromIdx) return "";
    var d = "";
    for(var i=fromIdx; i<=toIdx; i++){
      var v = facetVertex(cx,cy,r,i,N,offsetDeg);
      d += (i===fromIdx ? "M" : " L")+v.x+","+v.y;
    }
    return d;
  }

  // Hub ring gauge: a faceted "crown cut" ring - N outer vertices (on the
  // outer circle, no offset) and N inner vertices (on the inner circle,
  // offset by half a slot), triangulated in the classic antiprism-strip
  // pattern real gem crown facets use: for each slot i, an "inward"
  // triangle (base along outer edge O[i]-O[i+1], apex at the inner vertex
  // I[i] centered beneath it) and an "outward" triangle (apex at O[i],
  // base between the two neighboring inner vertices I[i-1] and I[i]).
  // Together the 2*HUB_FACETS triangles tile the whole annulus with no
  // gaps. Each triangle's opacity comes from facetOpacity(), keyed to its
  // own apex angle, so brightness reads as "this facet's angle relative
  // to one fixed light source" rather than an alternating checker or
  // random noise. Colored red/green by slot index vs. today's score
  // rounded to the nearest facet (still a flat color per facet, not a
  // smooth gradient), dark backing plate underneath, thin seam line on
  // every triangle edge (colored to match whichever segment it borders,
  // same red/green split as the facets), and a bold glowing outline split
  // to match the fill too (red arc over the unlit run, green over the lit
  // one). Regenerated fresh (not diffed) each time score changes.
  function renderHubRingGauge(ratio){
    var ring = document.getElementById("hubBarRing");
    if(!ring) return;
    var cx = 56, cy = 64, N = HUB_FACETS;
    var half = 180/N, slot = 360/N;
    var clamped = Math.max(0, Math.min(1, ratio));
    var litCount = Math.round(clamped*N);
    var html = ['<path class="hub-ring-base" fill-rule="evenodd" d="'+polygonRingBasePath(cx,cy,HUB_R_OUTER,HUB_R_INNER,N,half)+'"/>'];
    for(var i=0; i<N; i++){
      var Oi = facetVertex(cx,cy,HUB_R_OUTER,i,N), Oi1 = facetVertex(cx,cy,HUB_R_OUTER,i+1,N);
      var Ii = facetVertex(cx,cy,HUB_R_INNER,i,N,half), Iim1 = facetVertex(cx,cy,HUB_R_INNER,i-1,N,half);
      var cls = i < litCount ? "lit" : "unlit", isLit = i < litCount;
      html.push('<path class="hub-facet '+cls+'" style="opacity:'+facetOpacity(i*slot,isLit,i*2)+'" d="M'+Iim1.x+','+Iim1.y+' L'+Oi.x+','+Oi.y+' L'+Ii.x+','+Ii.y+' Z"/>');
      html.push('<path class="hub-facet '+cls+'" style="opacity:'+facetOpacity(i*slot+half,isLit,i*2+1)+'" d="M'+Oi.x+','+Oi.y+' L'+Oi1.x+','+Oi1.y+' L'+Ii.x+','+Ii.y+' Z"/>');
    }
    for(var s=0; s<N; s++){
      var so = facetVertex(cx,cy,HUB_R_OUTER,s,N), so1 = facetVertex(cx,cy,HUB_R_OUTER,s+1,N);
      var si = facetVertex(cx,cy,HUB_R_INNER,s,N,half), si1 = facetVertex(cx,cy,HUB_R_INNER,s+1,N,half), sim1 = facetVertex(cx,cy,HUB_R_INNER,s-1,N,half);
      var seamCls = s < litCount ? "lit" : "unlit";
      html.push('<line class="hub-ring-seam '+seamCls+'" x1="'+so.x+'" y1="'+so.y+'" x2="'+so1.x+'" y2="'+so1.y+'"/>');
      html.push('<line class="hub-ring-seam '+seamCls+'" x1="'+si.x+'" y1="'+si.y+'" x2="'+si1.x+'" y2="'+si1.y+'"/>');
      html.push('<line class="hub-ring-seam '+seamCls+'" x1="'+so.x+'" y1="'+so.y+'" x2="'+si.x+'" y2="'+si.y+'"/>');
      html.push('<line class="hub-ring-seam '+seamCls+'" x1="'+so.x+'" y1="'+so.y+'" x2="'+sim1.x+'" y2="'+sim1.y+'"/>');
    }
    // Inner ring vertices are offset by `half` a slot from the outer
    // ring's (that's the whole crown/zigzag construction - see the block
    // comment above), so an inner vertex at index i sits at a DIFFERENT
    // physical angle than the outer vertex at the same index i. Using the
    // same [0,litCount] index range for both (as an earlier version did)
    // put the inner ring's color boundary about half a slot further
    // clockwise than the outer's real boundary - a visible mismatch
    // between the outline color and the facet color right at the seam.
    // The inner range needs to start and end one vertex earlier (an index
    // shift of -1) to land on the same physical angle as the outer's.
    var outerLit = polygonArcPath(cx,cy,HUB_R_OUTER,0,litCount,N);
    var outerUnlit = polygonArcPath(cx,cy,HUB_R_OUTER,litCount,N,N);
    var innerLit = polygonArcPath(cx,cy,HUB_R_INNER,-1,litCount-1,N,half);
    var innerUnlit = polygonArcPath(cx,cy,HUB_R_INNER,litCount-1,N-1,N,half);
    if(outerLit) html.push('<path class="hub-ring-outline lit" d="'+outerLit+'"/>');
    if(outerUnlit) html.push('<path class="hub-ring-outline unlit" d="'+outerUnlit+'"/>');
    if(innerLit) html.push('<path class="hub-ring-outline lit" d="'+innerLit+'"/>');
    if(innerUnlit) html.push('<path class="hub-ring-outline unlit" d="'+innerUnlit+'"/>');
    ring.innerHTML = html.join("");
  }

  // Hub contour spark: fires in sparse random bursts (grow -> travel ->
  // fade, mostly invisible in between) riding just outside the ring's
  // outer edge - the same rhythm the category triangles use, see
  // __catSparkD etc. in the categories loop below. Colored to match
  // whichever zone of the ring its random anchor happens to land in (red
  // if the unlit run, green if the lit one) - built from two copies of
  // the SAME grow/travel/fade animation (identical dasharray/dashoffset/
  // opacity keyframes on both), each inside its own <g> clipped to a
  // static pie-wedge matching the current lit/unlit boundary, so only
  // whichever copy's anchor currently falls inside its wedge is visible.
  // Rebuilt fresh (new random anchor/length/travel/timing) into
  // #hubSparkSlot every time the score (re)computes, same as the ring
  // gauge.
  function renderHubSpark(ratio){
    var slot = document.getElementById("hubSparkSlot");
    if(hubSparkTimer){ clearTimeout(hubSparkTimer); hubSparkTimer = null; }
    if(!slot) return;
    var cx = 56, cy = 64, r = HUB_R_OUTER, wedgeR = HUB_R_OUTER+4;
    var clamped = Math.max(0, Math.min(1, ratio));
    var litCount = Math.round(clamped*HUB_FACETS);
    var litDeg = (litCount/HUB_FACETS)*360;
    var d = (5 + Math.random()*4).toFixed(2);
    var offset = (Math.random()*100).toFixed(1);
    var len = (8 + Math.random()*14).toFixed(1);
    var gap = (100 - len).toFixed(1);
    var travel = (12 + Math.random()*14).toFixed(1);
    var offset2 = (offset - travel).toFixed(1);
    var animAttrs =
      '<animate attributeName="stroke-dasharray" dur="'+d+'s" begin="0s" fill="freeze" calcMode="linear" values="0 100;'+len+' '+gap+';'+len+' '+gap+'" keyTimes="0;0.05;1"/>'+
      '<animate attributeName="stroke-dashoffset" dur="'+d+'s" begin="0s" fill="freeze" calcMode="linear" values="'+offset+';'+offset+';'+offset2+';'+offset2+'" keyTimes="0;0.05;0.11;1"/>'+
      '<animate attributeName="opacity" dur="'+d+'s" begin="0s" fill="freeze" values="0;1;1;1;0;0" keyTimes="0;0.01;0.05;0.11;0.15;1"/>';
    var litCircle = '<circle class="hub-spark-arc hub-spark-lit" cx="'+cx+'" cy="'+cy+'" r="'+r+'" pathLength="100" stroke-dasharray="0 100" stroke-dashoffset="'+offset+'" opacity="0">'+animAttrs+'</circle>';
    var unlitCircle = '<circle class="hub-spark-arc hub-spark-unlit" cx="'+cx+'" cy="'+cy+'" r="'+r+'" pathLength="100" stroke-dasharray="0 100" stroke-dashoffset="'+offset+'" opacity="0">'+animAttrs+'</circle>';
    // Guard on the rounded facet count, not the raw ratio - a small
    // nonzero ratio can still round down to 0 lit facets (and vice versa
    // near 1), which would leave litDeg at exactly 0/360 and hit the same
    // identical-arc-endpoints degenerate case explained above if it fell
    // through to the wedge-path branch below.
    if(litCount <= 0){
      slot.innerHTML = unlitCircle;
    } else if(litCount >= HUB_FACETS){
      slot.innerHTML = litCircle;
    } else {
      var topX = cx, topY = cy - wedgeR;
      var w = polarPt(cx,cy,wedgeR,litDeg);
      var largeLit = litDeg > 180 ? 1 : 0;
      var largeUnlit = (360 - litDeg) > 180 ? 1 : 0;
      var litPath = "M"+cx+","+cy+" L"+topX+","+topY+" A"+wedgeR+","+wedgeR+" 0 "+largeLit+",1 "+w.x+","+w.y+" Z";
      var unlitPath = "M"+cx+","+cy+" L"+w.x+","+w.y+" A"+wedgeR+","+wedgeR+" 0 "+largeUnlit+",1 "+topX+","+topY+" Z";
      slot.innerHTML =
        '<clipPath id="hubLitZone" clipPathUnits="userSpaceOnUse"><path d="'+litPath+'"/></clipPath>'+
        '<clipPath id="hubUnlitZone" clipPathUnits="userSpaceOnUse"><path d="'+unlitPath+'"/></clipPath>'+
        '<g clip-path="url(#hubLitZone)">'+litCircle+'</g>'+
        '<g clip-path="url(#hubUnlitZone)">'+unlitCircle+'</g>';
    }
    // Unlike the SMIL "begin=-random()" trick used before (which loops the
    // SAME anchor/length/timing forever since the values are baked into the
    // markup once), this single-shot burst reschedules ITSELF with a fresh
    // random anchor every cycle - so the glint actually wanders around the
    // ring over time instead of replaying identically in the same spot.
    // repeatCount is gone (each burst plays once via fill="freeze"); the
    // next call re-derives the current score fresh rather than reusing a
    // possibly-stale closed-over ratio.
    hubSparkTimer = setTimeout(function(){
      renderHubSpark(dailyPointsFor(today) / (MAX_DAILY||1));
    }, Math.round(parseFloat(d)*1000));
  }

  function buildNeuralMap(){
    var spinner = document.getElementById("spinner3d");
    if(!spinner) return;
    var R1 = 205, R2 = 310;

    var todosOpen = (todos||[]).filter(function(t){ return !t.done; });
    var log = habitLog[today] || {};
    var habitsDone = HABITS.filter(function(h){ return !!log[h.id]; });

    // computed early (rather than down by the hub-color section below) so
    // the spark-speed scaling further down can use it too - today's total
    // possible HABIT points defines ratio=1, uncapped past that on a
    // strong to-dos/mail/calendar day (see hub-color comment below).
    var dailyScore = dailyPointsFor(today);
    var scoreRatio = dailyScore / (MAX_DAILY||1);

    // Only the very next day (i===1, "tomorrow") counts toward the "!" mark
    // below - the rest of this rolling 6-day window is further out than the
    // today/tomorrow scope the mark is for, so those leaves stay unmarked.
    var weekEventsOther = [];
    for(var i=1;i<7;i++){
      var d = new Date(); d.setDate(d.getDate()+i);
      var iso = d.toISOString().slice(0,10);
      EVENTS.filter(function(e){ return eventCoversDate(e, iso); }).forEach(function(e){
        weekEventsOther.push({ text: fmtDay(iso).slice(0,2)+": "+truncate(e.title,10), attn: i===1 });
      });
    }

    // Whether a conference has any unticked task that's due within a week
    // or overdue (taskUrgency, same rule the CONFS header count above already
    // uses) - reused per-conference so individual conference leaves can
    // carry the "!" mark independently of each other.
    function confNeedsAttn(c){
      return CONF_TASKS.some(function(t){
        var done = !!(c.tasks && c.tasks[t.key]);
        var due = c.taskDueDates && c.taskDueDates[t.key];
        return !done && !!taskUrgency(due);
      });
    }

    // every category is capped to the same max leaf count, so whichever
    // category currently has the most underlying items (habits especially,
    // since it always lists every habit) can't visually outweigh the rest
    // and create a lopsided-looking cluster wherever it happens to rotate to.
    var LEAF_CAP = 3;
    function capLeaves(list, mapFn){
      var mapped = list.slice(0, LEAF_CAP).map(mapFn);
      if(list.length > LEAF_CAP) mapped.push("+"+(list.length-LEAF_CAP));
      return mapped;
    }
    // A category with more items than LEAF_CAP only ever shows the first
    // LEAF_CAP of them, folding the rest into a plain "+N" leaf that never
    // carries the "!" mark - so an attention-needing item sitting past the
    // cap would be invisible, silently. Sorting attention-needing items to
    // the front before capping guarantees they always land in a visible
    // slot instead of getting buried behind "+N".
    function attnFirst(list, attnFn){
      return list.slice().sort(function(a,b){ return (attnFn(b)?1:0) - (attnFn(a)?1:0); });
    }
    // How many "!" marks a category will actually render, given attnFirst
    // already guarantees attention items sort into the visible slots first -
    // capped at LEAF_CAP, same as the leaves themselves, so the map-header
    // "N need attention" readout (built from this) can never drift from the
    // number of marks actually on screen.
    function countMarked(list, attnFn){
      return Math.min(list.filter(attnFn).length, LEAF_CAP);
    }

    // Per-leaf "needs attention" flag - drives the small "!" mark rendered
    // in that leaf triangle's own center further down (see leaves.forEach).
    // Scope is deliberately narrow, per explicit feedback: calendar events
    // today/tomorrow, conferences with a task due within a week (or
    // overdue), and to-dos with a due date within a week (or overdue) -
    // NOT habits (explicitly excluded) and NOT inbox/plain to-dos without a
    // due date, which stay unmarked even though they're "open".
    var categories = [
      { key:"today", label:"TODAY",
        stat: todaysEvents.length ? (todaysEvents.length+" today") : "clear",
        leaves: todaysEvents.length ? capLeaves(todaysEvents, function(e){ return { text:truncate(e.title,12), attn:true }; }) : ["Clear"] },
      { key:"conferences", label:"CONFS",
        stat: (conferences||[]).length+" tracked",
        leaves: (conferences||[]).length ? capLeaves(attnFirst(conferences, confNeedsAttn), function(c){ return { text:truncate(c.title,12), attn:confNeedsAttn(c) }; }) : ["None"] },
      { key:"inbox", label:"INBOX",
        stat: EMAILS.length+" unread",
        leaves: EMAILS.length ? capLeaves(EMAILS, function(m){ return truncate(m.subject,12); }) : ["Clear"] },
      { key:"todos", label:"TO-DOS",
        stat: todosOpen.length+" open",
        leaves: todosOpen.length ? capLeaves(attnFirst(todosOpen, function(t){ return !!taskUrgency(t.due); }), function(t){ return { text:truncate(t.text,12), attn:!!taskUrgency(t.due) }; }) : ["Clear"] },
      { key:"habits", label:"HABITS",
        stat: habitsDone.length+"/"+HABITS.length+" today",
        leaves: HABITS.slice(0,LEAF_CAP).map(function(h){ return truncate(h.name,12); })
          .concat(HABITS.length>LEAF_CAP ? ["+"+(HABITS.length-LEAF_CAP)] : []) },
      { key:"week", label:"WEEK",
        stat: EVENTS.length+" total",
        leaves: weekEventsOther.length ? capLeaves(attnFirst(weekEventsOther, function(x){ return x.attn; }), function(x){ return x; }) : ["Clear"] }
    ];

    var n = categories.length;
    var html = [];
    var curveIndex = 0;

    // Offset the whole ring by half the inter-category spacing (30deg for
    // n=6) so no category starts sitting exactly at the 0deg/180deg
    // crossing points - kept mainly so the initial layout (before the first
    // animation frame) isn't degenerate, since the real fix for left/right
    // balance is the per-frame radius compensation in spin3dTick below.
    categories.forEach(function(cat,i){ cat._angle = i * (360/n) + (180/n); });

    categories.forEach(function(cat){
      var nc = CATEGORY_HEX[cat.key];
      var ncDeep = shadeDark(nc,0.55), ncGlow = rgba(nc,0.5), ncSoft = rgba(nc,0.22), ncLight = shadeLight(nc,0.4);
      // glass variants for the big-node contour only - same hue, real alpha,
      // so the dark scene/stars behind actually show through the ring.
      var ncGlassLight = shadeRgba(nc,0.45,0.55), ncGlassBase = shadeRgba(nc,0,0.42), ncGlassDeep = shadeRgba(nc,-0.5,0.6);
      var ncStyle = '--nc:'+nc+';--nc-deep:'+ncDeep+';--nc-glow:'+ncGlow+';--nc-soft:'+ncSoft+';--nc-light:'+ncLight+';'+
        '--nc-glass-light:'+ncGlassLight+';--nc-glass:'+ncGlassBase+';--nc-glass-deep:'+ncGlassDeep+';';

      // spoke: hub -> category node, drawn as a gently curved 3-segment path
      // with a spark riding each segment (staggered so together they read as
      // one spark flowing hub-to-node). The category endpoint moves every
      // frame (see spin3dTick), so each segment just carries enough data-*
      // for that loop to recompute the whole curve fresh each tick - sparks
      // themselves are a plain looping CSS animation and don't need any
      // per-frame JS since they just ride whatever transform their parent
      // segment currently has.
      curveIndex++;
      var bendSign = (curveIndex % 2 === 0) ? 1 : -1;
      // sparks travel faster (shorter loop = more frequent) the higher
      // today's Daily Score is, so the map visibly livens up as the day
      // gets more productive - shrinks from the base 4-7s range down to
      // ~1.3-2.1s at a full (ratio=1) day. Clamped to 1 even though
      // scoreRatio itself can exceed that, so sparks never blur past
      // readability on an especially strong day.
      var __sparkSpeedRatio = Math.min(1, Math.max(0, scoreRatio));
      var __sparkMin = 4 - __sparkSpeedRatio*2.7, __sparkSpan = 3 - __sparkSpeedRatio*2.2;
      for(var __seg=0; __seg<3; __seg++){
        var __sparkT = (__sparkMin+Math.random()*__sparkSpan), __sparkBase = Math.random()*__sparkT;
        var __sparkDelay = (__sparkBase + (__seg*__sparkT/3)).toFixed(2);
        html.push(
          '<div class="spoke3d hub-curve-seg" data-curve-angle="'+cat._angle+'" data-curve-r="'+R1+'" data-curve-bend="'+bendSign+'" data-curve-seg="'+__seg+'" style="'+ncStyle+'">'+
            '<div class="spark" style="animation-delay:-'+__sparkDelay+'s;animation-duration:'+__sparkT.toFixed(2)+'s;"></div>'+
          '</div>'
        );
      }

      // "Contour lightning" spark: a segment of the triangle's own outline
      // (not a traveling dot) grows in from a random anchor point on the
      // perimeter, then slides a little further around before fading -
      // staying invisible for most of a sparse, several-second cycle.
      // Randomized once per category per render, with a random negative
      // `begin` so the 6 categories don't flash in sync. (Brought back
      // after removing it once - it was well liked, turned out the "static
      // random glimmer" complaint that round was about the hub's specular
      // glint, not this.)
      var __catSparkD = (5 + Math.random()*4).toFixed(2);
      var __catSparkOffset = (Math.random()*100).toFixed(1);
      var __catSparkLen = (8 + Math.random()*14).toFixed(1);
      var __catSparkGap = (100 - __catSparkLen).toFixed(1);
      var __catSparkTravel = (12 + Math.random()*14).toFixed(1);
      var __catSparkOffset2 = (__catSparkOffset - __catSparkTravel).toFixed(1);
      var __catSparkBegin = (-Math.random()*__catSparkD).toFixed(2);

      // category node - the ring (hex-cat) spins on its own axis; the icon
      // sits on top as a separate, non-spinning layer so it stays put while
      // the ring rotates around it. Position/facing is set every frame by
      // spin3dTick.
      html.push(
        '<div class="orbit-node" data-base-angle="'+cat._angle+'" data-r="'+R1+'" style="transform:rotateY('+cat._angle+'deg) translateZ('+R1+'px);">'+
          '<div class="billboard" data-base-angle="'+cat._angle+'">'+
            '<div class="node-stack cat-stack">'+
              '<div class="hex-cat-wrap" style="'+ncStyle+'">'+
                '<svg class="hex-cat-circuit" viewBox="0 0 78 92">'+
                  '<polygon class="cat-crest-base" points="9,20 69,20 39,72"/>'+
                  '<polygon class="cat-crest-facet f1" points="39,37 9,20 69,20"/>'+
                  '<polygon class="cat-crest-facet f2" points="39,37 69,20 39,72"/>'+
                  '<polygon class="cat-crest-facet f3" points="39,37 39,72 9,20"/>'+
                  '<path class="cat-crest-seam" d="M39,37 L9,20 M39,37 L69,20 M39,37 L39,72"/>'+
                  '<polygon class="cat-crest-outline" points="9,20 69,20 39,72"/>'+
                  '<path class="cat-crest-spark-arc" d="M9,20 L69,20 L39,72 Z" pathLength="100" stroke-dasharray="0 100" stroke-dashoffset="'+__catSparkOffset+'" opacity="0">'+
                    '<animate attributeName="stroke-dasharray" dur="'+__catSparkD+'s" begin="'+__catSparkBegin+'s" repeatCount="indefinite" calcMode="linear" values="0 100;'+__catSparkLen+' '+__catSparkGap+';'+__catSparkLen+' '+__catSparkGap+'" keyTimes="0;0.05;1"/>'+
                    '<animate attributeName="stroke-dashoffset" dur="'+__catSparkD+'s" begin="'+__catSparkBegin+'s" repeatCount="indefinite" calcMode="linear" values="'+__catSparkOffset+';'+__catSparkOffset+';'+__catSparkOffset2+';'+__catSparkOffset2+'" keyTimes="0;0.05;0.11;1"/>'+
                    '<animate attributeName="opacity" dur="'+__catSparkD+'s" begin="'+__catSparkBegin+'s" repeatCount="indefinite" values="0;1;1;1;0;0" keyTimes="0;0.01;0.05;0.11;0.15;1"/>'+
                  '</path>'+
                '</svg>'+
              '</div>'+
              '<div class="hex-cat-label">'+cat.label+'</div>'+
              '<div class="hex-cat-stat">'+cat.stat+'</div>'+
            '</div>'+
          '</div>'+
        '</div>'
      );

      // leaves - connectors run from this category node's own position out to
      // each leaf (not from the hub), so the hierarchy reads hub->category->leaf.
      var leaves = cat.leaves, m = leaves.length;
      leaves.forEach(function(leaf,j){
        var spread = Math.min(16, 46/m);
        var leafAngle = cat._angle + (j-(m-1)/2)*spread;
        var needsAttn = (leaf && typeof leaf === "object") ? !!leaf.attn : false;
        var text = (leaf && typeof leaf === "object") ? leaf.text : leaf;

        html.push('<div class="spoke3d leaf-spoke" data-base-angle="'+leafAngle+'" data-r="'+R2+'" data-from-angle="'+cat._angle+'" data-from-r="'+R1+'" style="'+ncStyle+'"></div>');

        html.push(
          '<div class="orbit-node" data-base-angle="'+leafAngle+'" data-r="'+R2+'" style="transform:rotateY('+leafAngle+'deg) translateZ('+R2+'px);">'+
            '<div class="billboard" data-base-angle="'+leafAngle+'">'+
              '<div class="node-stack leaf-stack">'+
                '<div class="hex-leaf" style="'+ncStyle+'">'+
                  '<svg class="leaf-crest" viewBox="0 0 18 21">'+
                    '<polygon class="leaf-crest-shape" points="2,4 16,4 9,16"/>'+
                    (needsAttn ? '<text class="leaf-attn-mark" x="9" y="9">!</text>' : '')+
                  '</svg>'+
                '</div>'+
                '<div class="hex-leaf-label">'+escapeHtml(text)+'</div>'+
              '</div>'+
            '</div>'+
          '</div>'
        );
      });
    });

    spinner.innerHTML = html.join("");

    document.getElementById("hubNum").textContent = dailyScore;
    var hubHex = document.querySelector(".hub-hex-wrap");
    if(hubHex){
      // today's total possible HABIT points defines "100%" (full green),
      // but the ratio isn't capped there - a strong to-dos/mail/calendar
      // day can push it past 1.0 and still read as an even richer green,
      // so a productive non-habit day can visibly compensate for missed
      // habits, same idea as the old habit-only % but now covering the
      // whole Daily Score. (scoreRatio computed up top, shared with the
      // spark-speed scaling.)
      hubHex.style.setProperty("--tier-rgb", tierColorRgb(scoreRatio).join(","));
      hubHex.style.setProperty("--hub-fill", (0.3 + 0.6*Math.min(1, scoreRatio)).toFixed(2));
    }
    renderHubRingGauge(scoreRatio);
    renderHubSpark(scoreRatio);

    // combined "needs attention" readout for the map header - deliberately
    // built from the exact same countMarked() calls (and the exact same
    // attn rules) that decide the per-leaf "!" marks below, so this number
    // can never say more (or fewer) items need attention than the marks
    // actually visible on the map. Previously counted ALL open to-dos and
    // ALL unread mail regardless of due date, which is why it used to read
    // "4 need attention" while only 1 leaf was ever marked - replaced per
    // explicit feedback that the two should always match.
    console.log("TEMP-DEBUG attentionCount inputs", JSON.stringify({
      todaysEvents: typeof todaysEvents, weekEventsOther: typeof weekEventsOther,
      conferences: typeof conferences, todosOpen: typeof todosOpen
    }));
    var attentionCount =
      countMarked(todaysEvents, function(){ return true; }) +
      countMarked(weekEventsOther, function(x){ return x.attn; }) +
      countMarked(conferences, confNeedsAttn) +
      countMarked(todosOpen, function(t){ return !!taskUrgency(t.due); });
    var attentionEl = document.getElementById("mapAttentionStat");
    if(attentionEl){
      attentionEl.textContent = attentionCount===0 ? "All clear" :
        attentionCount===1 ? "1 needs attention" : attentionCount+" need attention";
    }
  }

  // ================= Neural map orbit animation =================
  // Node rotation is driven here, per-frame, in JS rather than a CSS
  // keyframe animation, because the orbit radius needs correcting for the
  // scene's tilt at each node's *actual current* angle. A flat ring tilted
  // toward the camera foreshortens the front/back axis relative to the
  // untouched left/right axis - without compensation, whichever nodes are
  // currently "side-on" to the camera sit visibly further from the hub on
  // screen than ones "face-on", even though they're the same real distance
  // in 3D. A CSS animation can't compute that per-angle correction; this
  // loop can, since it always knows the exact current angle.
  var TILT_DEG = 36; // must match .tilt3d's rotateX magnitude in CSS
  var TILT_SIN = Math.sin(TILT_DEG*Math.PI/180);
  var SPIN_DURATION_S = 60; // full rotation period, seconds - was the CSS animation-duration
  // <1 makes the disc's on-screen shape a wider-than-tall oval instead of a
  // circle (0.85 = top/bottom pulled in to 85% of the left/right radius).
  // Kept modest deliberately: since angle still advances at a constant
  // *rate* (see spinDeg below), a more eccentric ellipse would make nodes
  // visibly slow down near the left/right ends and speed up near top/bottom
  // - true constant-*speed* motion around an ellipse needs a nonuniform
  // angular rate (no closed form, needs numerical arc-length integration),
  // which isn't worth the complexity here - staying close to circular
  // keeps that speed variation small enough to not be noticeable.
  var DISC_ECCENTRICITY = 0.85;

  function orbitPos(baseAngleDeg, r, spinDeg){
    var effDeg = baseAngleDeg + spinDeg;
    var rad = effDeg*Math.PI/180;
    var s = Math.sin(rad), c = Math.cos(rad);
    var rx = r, ry = r*DISC_ECCENTRICITY;
    // solves for the translateZ magnitude that lands each angle exactly on
    // the (rx,ry) ellipse after the tilt's foreshortening - same derivation
    // as the old circular version, just with two target radii instead of one.
    var comp = 1 / Math.sqrt((s*s)/(rx*rx) + (c*c*TILT_SIN*TILT_SIN)/(ry*ry));
    return { x: comp*s, z: comp*c, r: comp, effDeg: effDeg };
  }

  function bezierPt(P0,C,P1,t){
    var mt = 1-t;
    return { x: mt*mt*P0.x + 2*mt*t*C.x + t*t*P1.x, z: mt*mt*P0.z + 2*mt*t*C.z + t*t*P1.z };
  }

  function spin3dTick(){
    var spinDeg = -(((performance.now()-SPIN_START)/1000 % SPIN_DURATION_S)/SPIN_DURATION_S)*360;

    document.querySelectorAll(".orbit-node[data-base-angle]").forEach(function(el){
      var p = orbitPos(parseFloat(el.dataset.baseAngle), parseFloat(el.dataset.r), spinDeg);
      el.style.transform = "rotateY("+p.effDeg+"deg) translateZ("+p.r+"px)";
      var bb = el.firstElementChild; // .billboard - cancels this node's own current angle + the scene tilt
      if(bb) bb.style.transform = "rotateY("+(-p.effDeg)+"deg) rotateX("+TILT_DEG+"deg) translate(-50%,-50%)";
    });

    document.querySelectorAll(".spoke3d[data-base-angle]").forEach(function(el){
      var p1 = orbitPos(parseFloat(el.dataset.baseAngle), parseFloat(el.dataset.r), spinDeg);
      var x0 = 0, z0 = 0;
      if(el.dataset.fromAngle !== undefined){
        var p0 = orbitPos(parseFloat(el.dataset.fromAngle), parseFloat(el.dataset.fromR), spinDeg);
        x0 = p0.x; z0 = p0.z;
      }
      var dx = p1.x-x0, dz = p1.z-z0;
      var len = Math.sqrt(dx*dx+dz*dz);
      var phi = Math.atan2(dx,dz)*180/Math.PI;
      el.style.width = len+"px";
      el.style.transform = "translateX("+x0+"px) translateZ("+z0+"px) rotateY("+(phi-90)+"deg)";
    });

    // hub -> category curved connectors: recompute the whole 3-point bezier
    // fresh each frame (P1 moves with the category node) and place whichever
    // of the 3 segments this element represents. Redundant across a given
    // connector's 3 segments, but cheap - only 6 connectors on screen.
    // P0 used to sit exactly at the hub's own origin (0,0) - same Z-depth
    // as the hub itself, so in a preserve-3d scene z-index can't help: at
    // various rotation angles the near-hub segment's true 3D depth put it
    // in FRONT of the hub, visually cutting across the ring and number no
    // matter what CSS masking sat on the hub side. Starting P0 a bit out
    // from the origin (toward P1) means the line's geometry never enters
    // the hub's on-screen footprint in the first place, which fixes it
    // regardless of depth order.
    document.querySelectorAll(".hub-curve-seg").forEach(function(el){
      // Tied to HUB_R_OUTER (the ring's actual outer radius, same coordinate
      // space as P0/P1 here) plus a small margin, rather than a hardcoded
      // px value - a hardcoded 46 silently fell inside the ring's footprint
      // once the ring grew to radius 54 across later rounds, which is
      // exactly what let the line cut across the facets again.
      var HUB_GAP = HUB_R_OUTER + 8;
      var P1 = orbitPos(parseFloat(el.dataset.curveAngle), parseFloat(el.dataset.curveR), spinDeg);
      var fullLen = Math.sqrt(P1.x*P1.x + P1.z*P1.z) || 1;
      var t0 = Math.min(0.4, HUB_GAP/fullLen);
      var P0 = {x:P1.x*t0, z:P1.z*t0};
      var dx = P1.x-P0.x, dz = P1.z-P0.z;
      var len = Math.sqrt(dx*dx+dz*dz);
      var bend = len*0.16*parseFloat(el.dataset.curveBend);
      var mid = { x:(P0.x+P1.x)/2, z:(P0.z+P1.z)/2 };
      var perp = { x:-dz/len, z:dx/len };
      var C = { x:mid.x+perp.x*bend, z:mid.z+perp.z*bend };
      var pts = [P0, bezierPt(P0,C,P1,0.333), bezierPt(P0,C,P1,0.667), P1];
      var seg = parseInt(el.dataset.curveSeg, 10);
      var A = pts[seg], B = pts[seg+1];
      var sdx = B.x-A.x, sdz = B.z-A.z;
      var slen = Math.sqrt(sdx*sdx+sdz*sdz);
      var sphi = Math.atan2(sdx,sdz)*180/Math.PI;
      el.style.width = slen+"px";
      el.style.transform = "translateX("+A.x+"px) translateZ("+A.z+"px) rotateY("+(sphi-90)+"deg)";
    });

    requestAnimationFrame(spin3dTick);
  }
  requestAnimationFrame(spin3dTick);

  // No main-process data backup here - this build has no server holding
  // anyone's data by design, so localStorage is the sole store, same as any
  // ordinary web app (see web/README.md).

  // ================= Ambient starfield + neural network =================
  (function(){
    var canvas = document.getElementById("bg");
    var ctx = canvas.getContext("2d");
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var w,h,particles=[],stars=[],t=0;
    function resize(){
      w = canvas.width = window.innerWidth;
      h = canvas.height = Math.max(window.innerHeight, document.body.scrollHeight);
    }
    function init(){
      resize();
      var count = Math.min(55, Math.round(w*h/28000));
      particles = [];
      for(var i=0;i<count;i++){
        particles.push({
          x: Math.random()*w, y: Math.random()*h,
          vx: (Math.random()-0.5)*0.15, vy:(Math.random()-0.5)*0.15
        });
      }
      var starCount = Math.min(260, Math.round(w*h/9000));
      stars = [];
      for(var s=0;s<starCount;s++){
        var big = Math.random()<0.08;
        stars.push({
          x: Math.random()*w, y: Math.random()*h,
          r: big ? (1.4+Math.random()*1.1) : (0.4+Math.random()*0.9),
          baseAlpha: big ? (0.55+Math.random()*0.35) : (0.18+Math.random()*0.4),
          speed: 0.4+Math.random()*1.1,
          phase: Math.random()*Math.PI*2
        });
      }
    }
    function step(){
      ctx.clearRect(0,0,w,h);
      t += 0.016;

      for(var s=0;s<stars.length;s++){
        var st = stars[s];
        var a = reduceMotion ? st.baseAlpha : st.baseAlpha*(0.55+0.45*Math.sin(t*st.speed+st.phase));
        ctx.fillStyle = "rgba(226,236,247,"+Math.max(0,a).toFixed(3)+")";
        ctx.beginPath(); ctx.arc(st.x,st.y,st.r,0,Math.PI*2); ctx.fill();
      }

      for(var i=0;i<particles.length;i++){
        var p = particles[i];
        if(!reduceMotion){ p.x+=p.vx; p.y+=p.vy; }
        if(p.x<0||p.x>w) p.vx*=-1;
        if(p.y<0||p.y>h) p.vy*=-1;
        for(var j=i+1;j<particles.length;j++){
          var q = particles[j];
          var dx=p.x-q.x, dy=p.y-q.y, dist=Math.sqrt(dx*dx+dy*dy);
          if(dist<140){
            ctx.strokeStyle = "rgba(70,224,198,"+(0.07*(1-dist/140))+")";
            ctx.lineWidth=1;
            ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(q.x,q.y); ctx.stroke();
          }
        }
        ctx.fillStyle="rgba(143,245,226,0.5)";
        ctx.beginPath(); ctx.arc(p.x,p.y,1.4,0,Math.PI*2); ctx.fill();
      }
      if(!reduceMotion) requestAnimationFrame(step);
    }
    window.addEventListener("resize", init);
    init();
    step();
  })();

})();
