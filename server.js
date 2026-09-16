"use strict";
/* Faction Hours API — plain Node, no dependencies.
   Listens on localhost only; Caddy handles TLS and proxies /api/* here.

   Identity comes from Torn player IDs, never from typed names:
     - the roster is pulled from the Torn API using the leader's Public key
     - members pick themselves from that roster, so typos can't create duplicates
     - members may optionally prove who they are with their own Public key
     - a verified entry can only be replaced by another verified submission

   Members' API keys are used once to read their player ID and then discarded.
   Nothing key-related is ever written to disk. */

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const PORT        = Number(process.env.PORT || 3000);
const DATA_FILE   = process.env.DATA_FILE || "/var/lib/faction-hours/board.json";
const JOIN_PASS   = process.env.JOIN_PASS || "";
const ADMIN_KEY   = process.env.ADMIN_KEY || "";
const TORN_KEY    = process.env.TORN_KEY  || "";
const ROSTER_MINS = Number(process.env.ROSTER_MINS || 10);
const POLL_MINS   = Number(process.env.POLL_MINS || 2);
const HIST_FILE   = process.env.HIST_FILE || "/var/lib/faction-hours/history.json";
const SESS_FILE   = process.env.SESS_FILE || "/var/lib/faction-hours/sessions.json";
const SESS_DAYS   = Number(process.env.SESS_DAYS || 30);
const CAL_FILE    = process.env.CAL_FILE  || "/var/lib/faction-hours/calendar.json";
const DOCS_FILE   = process.env.DOCS_FILE || "/var/lib/faction-hours/docs.json";
const WAR_MINS    = Number(process.env.WAR_MINS || 5);
const EV_FILE     = process.env.EV_FILE || "/var/lib/faction-hours/events.json";
const RSVP_FILE   = process.env.RSVP_FILE || "/var/lib/faction-hours/rsvps.json";
const NFL_FILE    = process.env.NFL_FILE || "/var/lib/faction-hours/nfl.json";
const NFL_MINS    = Number(process.env.NFL_MINS || 15);
const NFL_HITS    = Number(process.env.NFL_HITS || 4);
/* Who administers the forfeit. Comma separated in the env file. */
const NFL_ENFORCERS = String(process.env.NFL_ENFORCERS || "PR0D1G4L,RivenProtocol")
                        .split(",").map(x=>x.trim()).filter(Boolean);
/* Player IDs that get admin regardless of their rank in Torn, for whoever
   actually runs this thing. Comma separated in the env file. */
const ADMIN_IDS   = String(process.env.ADMIN_IDS || "").split(",")
                      .map(x=>Number(x.trim())).filter(Boolean);
const APP_NAME    = process.env.APP_NAME || "FactionHours";

if (!JOIN_PASS || !ADMIN_KEY || !TORN_KEY) {
  console.error("JOIN_PASS, ADMIN_KEY and TORN_KEY must all be set. Refusing to start.");
  process.exit(1);
}

/* ---------- storage ---------- */
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { return { members: [] }; }
}
function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);          // atomic, so a crash mid-write can't corrupt it
}
let board = load();

function loadHist(){
  try { return JSON.parse(fs.readFileSync(HIST_FILE,"utf8")); }
  catch(e){ return { slots:{}, since:new Date().toISOString(), polls:0 }; }
}
function saveHist(h){
  fs.mkdirSync(path.dirname(HIST_FILE),{recursive:true});
  const tmp=HIST_FILE+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(h));
  fs.renameSync(tmp,HIST_FILE);
}
let history = loadHist();

function readJson(file,fallback){
  try { return JSON.parse(fs.readFileSync(file,"utf8")); } catch(e){ return fallback; }
}
function writeJson(file,data){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(data));
  fs.renameSync(tmp,file);
}

let calendar = readJson(CAL_FILE, { entries: [] });
calendar.entries = (calendar.entries||[]).filter(e=>e&&e.id);

const DEFAULT_DOCS = {
  "dos-donts": { title:"War dos and don'ts", body:"Nobody has written this yet. An admin can fill it in from this page." },
  "tips":      { title:"Tips and tricks",    body:"Nobody has written this yet. An admin can fill it in from this page." },
  "strategy":  { title:"Our strategies",     body:"Nobody has written this yet. An admin can fill it in from this page." }
};
/* The annual event list lives on the server so admins can correct dates and
   rewrite the notes. Rules cover the two that move: Easter, and the first
   Friday of August. Everything else is a fixed calendar date. */
const SEED_EVENTS=[
 {id:"valentines",name:"Valentine's Day",rule:"fixed",month:2,day:14,days:1,sure:true,
  what:"A flower themed day, with event-only flowers appearing across the game.",
  tip:"Worth having spare inventory space, and prices on event flowers move sharply either side of it."},
 {id:"stpatricks",name:"St Patrick's Day",rule:"fixed",month:3,day:17,days:1,sure:true,
  what:"A themed daily event. What it hands out changes year to year, so check the in-game calendar closer to the day.",tip:""},
 {id:"easter",name:"Easter Egg Hunt",rule:"easter",days:8,sure:true,
  what:"Eggs are hidden on pages all over the site and you collect them by finding them. It runs across several days, so there's no need to do the whole hunt in one sitting.",tip:""},
 {id:"420",name:"420 Day",rule:"fixed",month:4,day:20,days:1,sure:true,
  what:"A cannabis themed day with a temporary buff attached. Short, and easy to miss if you don't log in.",tip:""},
 {id:"museum",name:"Museum Day",rule:"fixed",month:5,day:18,days:1,sure:true,
  what:"A museum themed daily event. Check the in-game calendar for what it gives this year.",tip:""},
 {id:"blooddonor",name:"World Blood Donor Day",rule:"fixed",month:6,day:14,days:1,sure:true,
  what:"A themed daily event. Check the in-game calendar for what it gives this year.",tip:""},
 {id:"population",name:"World Population Day",rule:"fixed",month:7,day:11,days:1,sure:true,
  what:"A themed daily event. Check the in-game calendar for what it gives this year.",tip:""},
 {id:"tiger",name:"World Tiger Day",rule:"fixed",month:7,day:29,days:1,sure:true,
  what:"A themed daily event. Check the in-game calendar for what it gives this year.",tip:""},
 {id:"beerday",name:"International Beer Day",rule:"beerday",days:1,sure:true,
  what:"A themed daily event, always on the first Friday of August.",tip:""},
 {id:"tourism",name:"Tourism Day",rule:"fixed",month:9,day:27,days:1,sure:true,
  what:"The big travel day. Your entire carrying capacity doubles for the full twenty four hours.",
  tip:"Get your faction Excursion upgrades and a large suitcase sorted beforehand, because every point you add is doubled too, and read Smuggling For Beginners on the day itself so the +10 becomes +20 and you keep 30 more days of it afterwards. Bring extra cash and a backup destination, because the popular shops get stripped within the hour."},
 {id:"caffeinecon",name:"CaffeineCon",rule:"fixed",month:10,day:1,days:1,sure:false,
  what:"A coffee themed event. The exact date isn't certain, so treat this as a rough guide and check the in-game calendar.",tip:""},
 {id:"halloween",name:"Halloween (Trick or Treat)",rule:"fixed",month:10,day:25,days:8,sure:true,
  what:"Eight days of attacking other players to collect treats, which you then spend on candy, boosters, energy drinks and items.",
  tip:"Everyone gets the full 168 hours whatever start slot they pick. Energy is the whole game: stack cans and boosters well in advance, because prices climb through September and October. Your basket carries over between years, so upgrading it is never wasted."},
 {id:"diabetes",name:"World Diabetes Day",rule:"fixed",month:11,day:14,days:1,sure:true,
  what:"A themed daily event. Check the in-game calendar for what it gives this year.",tip:""},
 {id:"christmastown",name:"Christmas Town",rule:"fixed",month:12,day:15,days:20,sure:false,
  what:"Torn's biggest event. A walkable map with daily gifts from Santa, minigames, and random loot picked up as you go.",
  tip:"Roughly twenty days long. The start date shifts each year depending on when the devs finish it, so watch the newspaper. Log in every day. Santa moves around and the daily present is the easy part to miss."}
];
let annual = readJson(EV_FILE, null);
if(!annual){ annual = { events: SEED_EVENTS }; writeJson(EV_FILE, annual); }
annual.events = (annual.events||[]).filter(e=>e&&e.id);

/* Who says they're turning up, keyed by calendar entry then player id.
   Old records are dropped on load so this can't grow forever. */
let rsvps = readJson(RSVP_FILE, {});
(function pruneRsvps(){
  const cutoff = Date.now() - 90*864e5;
  let changed = false;
  for (const [entryId, people] of Object.entries(rsvps)) {
    for (const [pid, r] of Object.entries(people))
      if (!r || (r.at||0) < cutoff) { delete people[pid]; changed = true; }
    if (!Object.keys(people).length) { delete rsvps[entryId]; changed = true; }
  }
  if (changed) writeJson(RSVP_FILE, rsvps);
})();

/* ---------- the NFL respect run ----------
   Teams are assigned once, results come from the scoreboard feed, and the page
   works out who owes hits. Nobody has to check a fixture or argue about it. */
const SEED_TEAMS=[
 ["NYG","Sirderper1"],["BAL","Gilly1990"],["NE","VAPOR32"],["IND","Anthony1246"],
 ["NYJ","manhat"],["JAX",""],["HOU","kawtommud"],["SEA","spaghettiBob"],
 ["BUF","distracted_mess"],["MIN",""],["CHI","FeralGerbil"],["CLE","SirRender"],
 ["ARI",""],["DET","Ladytashie"],["LAC","stingray"],["KC","RivenProtocol"],
 ["MIA","AlexLinos"],["TEN",""],["SF","granny_milk"],["LV","PR0D1G4L"],
 ["DAL",""],["PHI","Callmebsar"],["LAR","Lorchan"],["TB","Slimqnn"],["GB","Dthe3rd"]
];
let nfl = readJson(NFL_FILE, null);
if(!nfl){
  nfl = { assignments: SEED_TEAMS.map(([team,name])=>({team,name,id:0})), hits:{}, manual:{} };
  writeJson(NFL_FILE, nfl);
}
nfl.assignments = nfl.assignments || [];
nfl.hits = nfl.hits || {};
nfl.manual = nfl.manual || {};
nfl.slaps = nfl.slaps || {};
/* The event begins the first time this runs with a start date set, so results
   from before then don't count towards anything. */
if(!nfl.startAt){ nfl.startAt = Date.now(); writeJson(NFL_FILE, nfl); }

/* Feeds disagree on a handful of abbreviations, so everything is folded to one
   spelling before anything is compared. */
const TEAM_ALIAS = { JAC:"JAX", WSH:"WAS", LA:"LAR", SD:"LAC", OAK:"LV", STL:"LAR" };
const TEAM_NAMES = {
 ARI:"Arizona Cardinals", ATL:"Atlanta Falcons", BAL:"Baltimore Ravens", BUF:"Buffalo Bills",
 CAR:"Carolina Panthers", CHI:"Chicago Bears", CIN:"Cincinnati Bengals", CLE:"Cleveland Browns",
 DAL:"Dallas Cowboys", DEN:"Denver Broncos", DET:"Detroit Lions", GB:"Green Bay Packers",
 HOU:"Houston Texans", IND:"Indianapolis Colts", JAX:"Jacksonville Jaguars", KC:"Kansas City Chiefs",
 LV:"Las Vegas Raiders", LAC:"Los Angeles Chargers", LAR:"Los Angeles Rams", MIA:"Miami Dolphins",
 MIN:"Minnesota Vikings", NE:"New England Patriots", NO:"New Orleans Saints", NYG:"New York Giants",
 NYJ:"New York Jets", PHI:"Philadelphia Eagles", PIT:"Pittsburgh Steelers", SF:"San Francisco 49ers",
 SEA:"Seattle Seahawks", TB:"Tampa Bay Buccaneers", TEN:"Tennessee Titans", WAS:"Washington Commanders"
};
const teamKey = t => { const u=String(t||"").toUpperCase(); return TEAM_ALIAS[u]||u; };

let nflState = { week:0, season:0, games:[], at:0, error:"" };

/* Early weeks were logged as a bare "W"/"L". Read both shapes so the archive
   doesn't lose anything recorded before the format changed. */
const resOf = v => (typeof v === "string") ? { r:v } : (v || {});

/* Hit counts used to be a bare number. They now carry who recorded them and
   when, so a total that appears three days after the deadline is visible
   rather than indistinguishable from one logged on the night. */
const hitOf = v => (typeof v === "number") ? { n:v, at:0, by:"" } : (v || { n:0 });
const hitN  = v => Number(hitOf(v).n || 0);

function normaliseScoreboard(data){
  const events = data.events || [];
  /* Feeds are inconsistent between games. A single odd entry should cost us
     that one game, not the entire scoreboard. */
  return events.map(ev=>{
   try{
    const comp = (ev.competitions||[])[0] || {};
    const cs = comp.competitors || [];
    const home = cs.find(c=>c.homeAway==="home") || cs[0] || {};
    const away = cs.find(c=>c.homeAway==="away") || cs[1] || {};
    const st = (comp.status||ev.status||{});
    const stype = st.type || {};
    const side = c => {
      const key = teamKey((c.team||{}).abbreviation);
      return {
        team: key,
        name: TEAM_NAMES[key] || (c.team||{}).displayName || key,
        short: (c.team||{}).shortDisplayName || key,
        score: Number(c.score||0),
        winner: !!c.winner,
        record: ((c.records||[])[0]||{}).summary || "",
        logo: (c.team||{}).logo || "",
        colour: (c.team||{}).color ? "#"+(c.team||{}).color : "",
        quarters: (c.linescores||[]).map(l=>Number(l.value||0))
      };
    };
    const odds = (comp.odds||[])[0] || {};
    const links = (ev.links||[]).filter(l=>(l.rel||[]).includes("summary"))[0] || {};
    const head = (comp.headlines||[])[0] || {};
    return {
      id: String(ev.id||""),
      start: Date.parse(ev.date||comp.date||0) || 0,
      /* pre, in or post. "not played" was wrong for a game being played. */
      state: String(stype.state||"pre"),
      done: !!stype.completed,
      statusDetail: String(stype.shortDetail||stype.detail||""),
      period: Number(st.period||0),
      clock: String(st.displayClock||""),
      venue: ((comp.venue||{}).fullName)||"",
      city: [((comp.venue||{}).address||{}).city,((comp.venue||{}).address||{}).state].filter(Boolean).join(", "),
      neutral: !!comp.neutralSite,
      note: ((comp.notes||[])[0]||{}).headline || "",
      broadcast: String(ev.broadcast || (((ev.broadcasts||[])[0]||{}).names||[]).join("/") || ""),
      weather: ev.weather ? {
        summary: String(ev.weather.displayValue||""),
        temp: Number(ev.weather.temperature||0)
      } : null,
      odds: odds.details ? {
        line: String(odds.details||""),            // e.g. "KC -2.5"
        total: Number(odds.overUnder||0),
        favourite: teamKey((((odds.homeTeamOdds||{}).team)||{}).abbreviation) || "",
        homeML: (((odds.moneyline||{}).home||{}).close||{}).odds || "",
        awayML: (((odds.moneyline||{}).away||{}).close||{}).odds || ""
      } : null,
      headline: String(head.shortLinkText||""),
      gamecast: String(links.href||""),
      highlights: String((((ev.links||[]).find(l=>(l.rel||[]).includes("highlights"))||{}).href)||""),
      boxscore: String((((ev.links||[]).find(l=>(l.rel||[]).includes("boxscore"))||{}).href)||""),
      attendance: Number(comp.attendance||0),
      leaders: ((comp.leaders||[])).map(l=>{
        const top=(l.leaders||[])[0]||{};
        return top.athlete ? {
          what: String(l.shortDisplayName||l.abbreviation||""),
          who: String(top.athlete.shortName||top.athlete.displayName||""),
          line: String(top.displayValue||"")
        } : null;
      }).filter(Boolean).slice(0,3),
      home: side(home),
      away: side(away)
    };
   }catch(err){
     console.error(new Date().toISOString(),"skipped a game we couldn't read:",(ev&&ev.id)||"?",err.message);
     return null;
   }
  }).filter(g=>g && g.home.team && g.away.team);
}

async function pollNfl(){
  try{
    const url="https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
    const res=await fetch(url,{signal:AbortSignal.timeout(12000)});
    if(!res.ok) throw new Error("Scoreboard returned "+res.status);
    const data=await res.json();
    const games=normaliseScoreboard(data);
    if(!games.length) throw new Error("Scoreboard had no games in it.");
    nflState={
      week: Number((data.week||{}).number||0),
      season: Number((data.season||{}).year||0),
      games, at: Date.now(), error:""
    };
    /* ESPN only serves the current week, so finished results are written down
       as they land. Without this the season table would reset every Tuesday. */
    const wk = nflState.season+"-"+nflState.week;
    nfl.log = nfl.log || {};
    nfl.weeks = nfl.weeks || {};
    const earliest = Math.min(...games.map(g=>g.start).filter(Boolean));
    if(earliest && nfl.weeks[wk] !== earliest) nfl.weeks[wk] = earliest;
    const before = JSON.stringify(nfl.log[wk]||null);
    games.filter(g=>g.done).forEach(g=>{
      nfl.log[wk] = nfl.log[wk] || {};
      const hw = g.home.score > g.away.score;
      nfl.log[wk][g.home.team] = { r: hw?"W":"L", o: g.away.team, s: g.home.score+"-"+g.away.score };
      nfl.log[wk][g.away.team] = { r: hw?"L":"W", o: g.home.team, s: g.away.score+"-"+g.home.score };
    });
    if(JSON.stringify(nfl.log[wk]||null) !== before) writeJson(NFL_FILE, nfl);
    console.log(new Date().toISOString(),"NFL week",nflState.week,"-",games.length,"games");
  }catch(err){
    nflState.error=err.message; nflState.at=Date.now();
    console.error(new Date().toISOString(),"NFL poll failed:",err.message);
  }
}

/* Hits are due by 23:59 TCT the day after that member's game, which differs for
   Thursday, Sunday and Monday night players. */
function deadlineFor(gameStart){
  const d=new Date(gameStart);
  return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1,23,59,59);
}

function nflBoard(){
  const key = nflState.season+"-"+nflState.week;
  const weekHits = nfl.hits[key] || {};
  const byTeam = {};
  nflState.games.forEach(g=>{ byTeam[g.home.team]=g; byTeam[g.away.team]=g; });

  const rows = nfl.assignments.map(a=>{
    /* Seeded names have no Torn id yet; match them to the roster once so hits
       are filed against a player rather than a spelling. */
    if(!a.id && a.name){
      const hit = roster.find(m=>m.name.toLowerCase()===a.name.toLowerCase());
      if(hit) a.id = hit.id;
    }
    const team=teamKey(a.team);
    const g=byTeam[team];
    const row={ team, teamName:TEAM_NAMES[team]||team, name:a.name||"", id:a.id||0, played:!!g };
    if(!g){ row.bye=true; return row; }
    const us = g.home.team===team ? g.home : g.away;
    const them = g.home.team===team ? g.away : g.home;
    const manual = nfl.manual[g.id];
    const decided = g.done || !!manual;
    const lost = manual ? manual.loserTeam===team
                        : (g.done ? (us.score < them.score) : false);
    /* Games played before the event began are shown but carry no obligation. */
    const counts = g.start >= (nfl.startAt || 0);
    Object.assign(row,{
      opponent: them.team, opponentName: them.name, opponentRecord: them.record,
      record: us.record, gameId: g.id,
      state: g.state, statusDetail: g.statusDetail, period: g.period, clock: g.clock,
      live: g.state === "in",
      liveScore: g.state === "in" ? us.score+"-"+them.score : "",
      logo: us.logo, colour: us.colour, opponentLogo: them.logo,
      quarters: us.quarters, opponentQuarters: them.quarters,
      venue: g.venue, city: g.city, neutral: g.neutral, note: g.note,
      broadcast: g.broadcast, weather: g.weather, odds: g.odds,
      headline: g.headline, gamecast: g.gamecast, leaders: g.leaders,
      highlights: g.highlights, boxscore: g.boxscore, attendance: g.attendance,
      start: g.start, done: decided,
      score: decided ? us.score+"-"+them.score : "",
      favourite: g.odds ? (g.odds.favourite === team) : null,
      lost: decided ? lost : null,
      counts,
      owes: decided && lost && counts ? NFL_HITS : 0,
      deadline: decided && lost && counts ? deadlineFor(g.start) : 0,
      hits: hitN(weekHits[a.id||a.name]),
      hitMeta: hitOf(weekHits[a.id||a.name])
    });
    return row;
  });

  /* Two members drawn against each other. The whole point of the thing. */
  const named = rows.filter(r=>r.name);
  const slaps=[];
  named.forEach(r=>{
    if(!r.opponent) return;
    const other = named.find(x=>x.team===r.opponent);
    if(other && r.team < other.team && r.counts !== false){
      const key = nflState.season+"-"+nflState.week+":"+r.team+"-"+other.team;
      slaps.push({ a:r, b:other, key, slapped: nfl.slaps[key] || null });
    }
  });

  /* Season totals: how often your team has lost, how many hits you've actually
     done, and how many weeks you owed and never paid. The last column is the
     one people will care about. */
  const log = nfl.log || {};
  const weeksMeta = nfl.weeks || {};
  const counts = wk => (weeksMeta[wk] || 0) >= (nfl.startAt || 0);
  const season = nfl.assignments.filter(a=>a.name).map(a=>{
    const team=teamKey(a.team), who=String(a.id||a.name);
    let losses=0, done=0, owed=0, defaults=0;
    Object.keys(log).forEach(wk=>{
      if(!wk.startsWith(nflState.season+"-") || !counts(wk)) return;
      if(resOf(log[wk][team]).r !== "L") return;
      losses++; owed+=NFL_HITS;
      const d=hitN((nfl.hits[wk]||{})[who]);
      done+=Math.min(d,NFL_HITS);
      const isCurrent = wk===(nflState.season+"-"+nflState.week);
      if(!isCurrent && d<NFL_HITS) defaults++;   // the current week is still in play
    });
    return { team, teamName:TEAM_NAMES[team]||team, name:a.name, id:a.id||0,
             losses, owed, done, defaults };
  }).sort((a,b)=> b.done-a.done || a.defaults-b.defaults || a.name.localeCompare(b.name));

  /* The monthly prize runs on calendar months, not the season, so weeks are
     bucketed by when their first game kicked off. */
  const weeks = nfl.weeks || {};
  const monthKey = wk => {
    const at = weeks[wk];
    if(!at) return null;
    const d = new Date(at);
    return d.getUTCFullYear()+"-"+String(d.getUTCMonth()+1).padStart(2,"0");
  };
  const thisMonth = (()=>{ const n=new Date(); return n.getUTCFullYear()+"-"+String(n.getUTCMonth()+1).padStart(2,"0"); })();
  const monthly = nfl.assignments.filter(a=>a.name).map(a=>{
    const team=teamKey(a.team), who=String(a.id||a.name);
    let done=0, losses=0;
    Object.keys(log).forEach(wk=>{
      if(monthKey(wk)!==thisMonth || !counts(wk)) return;
      if(resOf(log[wk][team]).r !== "L") return;
      losses++;
      done += Math.min(hitN((nfl.hits[wk]||{})[who]), NFL_HITS);
    });
    return { name:a.name, id:a.id||0, team, teamName:TEAM_NAMES[team]||team, losses, done };
  }).filter(r=>r.losses>0)
    .sort((a,b)=> b.done-a.done || b.losses-a.losses || a.name.localeCompare(b.name));

  /* Anyone past their deadline with hits outstanding. The forfeit list. */
  const forfeits = rows.filter(r=>r.name && r.lost===true && r.deadline &&
                                  Date.now() > r.deadline && r.hits < NFL_HITS)
    .map(r=>({ name:r.name, id:r.id, team:r.team, teamName:r.teamName,
               short:NFL_HITS-r.hits, deadline:r.deadline }));

  return { week:nflState.week, season:nflState.season, rows, slaps, seasonTable:season,
           monthly, monthLabel:thisMonth, forfeits, enforcers:NFL_ENFORCERS,
           startAt: nfl.startAt || 0,
           hitsRequired:NFL_HITS, updated:nflState.at, error:nflState.error||undefined };
}

let docs = readJson(DOCS_FILE, null);
if(!docs){
  docs = {};
  for(const [k,v] of Object.entries(DEFAULT_DOCS))
    docs[k] = { ...v, updatedAt:null, updatedBy:"" };
  writeJson(DOCS_FILE, docs);
}

/* ---------- sessions ----------
   Sign-in exchanges a credential for a token once. The credential is never
   kept by the browser and never travels again; the token does. Tokens live on
   disk so a restart doesn't sign the whole faction out, and only a hash is
   stored, so the file leaking wouldn't hand anyone a working session. */
const SESS_MS = SESS_DAYS * 864e5;
function loadSess(){
  try { return JSON.parse(fs.readFileSync(SESS_FILE,"utf8")); }
  catch(e){ return {}; }
}
function saveSess(){
  fs.mkdirSync(path.dirname(SESS_FILE),{recursive:true});
  const tmp=SESS_FILE+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(sessions));
  fs.renameSync(tmp,SESS_FILE);
}
let sessions = loadSess();

const tokenHash = t => crypto.createHash("sha256").update(String(t)).digest("hex");

function pruneSessions(){
  const now=Date.now();let changed=false;
  for(const [h,v] of Object.entries(sessions))
    if(!v || v.expires < now){ delete sessions[h]; changed=true; }
  if(changed) saveSess();
}

function mintSession(who){
  pruneSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  sessions[tokenHash(token)] = {
    id: who.id || 0,
    name: who.name || "",
    admin: !!who.admin,
    created: Date.now(),
    expires: Date.now() + SESS_MS
  };
  saveSess();
  return token;
}

/* Leader and Co-leader are the only fixed position names in Torn; everything
   else a faction defines itself, so we match those two exactly and fall back
   to the explicit ID list for anyone else who needs it. */
function isAdmin(member){
  if(!member) return false;
  if(ADMIN_IDS.includes(member.id)) return true;
  const p = String(member.position || "").toLowerCase().replace(/[\s_-]/g,"");
  return p === "leader" || p === "coleader";
}

function readSession(req){
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if(!token) return null;
  const rec = sessions[tokenHash(token)];
  if(!rec || rec.expires < Date.now()) return null;
  /* Sliding expiry, written back only once a day so we aren't hitting the disk
     on every single request. */
  if(rec.expires - Date.now() < SESS_MS - 864e5){
    rec.expires = Date.now() + SESS_MS;
    saveSess();
  }
  return rec;
}
board.members = (board.members || []).filter(m => m && m.id);

/* ---------- secrets ---------- */
function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);     // constant time, so timing can't leak the secret
}

/* ---------- Torn API ---------- */
/* Torn signals failure with HTTP 200 and an error object in the body, so every
   response has to be inspected rather than trusting the status code. */
async function torn(url, key) {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(url + sep + "key=" + encodeURIComponent(key) + "&comment=" + APP_NAME,
                          { signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("Torn sent back something unreadable.");
  if (data.error) {
    const c = data.error.code;
    if (c === 2)  throw new Error("Torn didn't recognise that API key.");
    if (c === 1)  throw new Error("No API key was sent.");
    if (c === 16) throw new Error("That key doesn't have enough access. A Public key is enough.");
    if (c === 5)  throw new Error("Too many requests to Torn just now. Try again shortly.");
    throw new Error("Torn said: " + (data.error.error || "unknown error"));
  }
  return data;
}

/* Accepts either the v2 or v1 shape so this keeps working if one changes. */
function normaliseRoster(data) {
  if (Array.isArray(data.members)) {                    // v2: [{id, name, position}, ...]
    return data.members
      .filter(m => m && (m.id || m.user_id))
      .map(m => ({ id: Number(m.id || m.user_id), name: String(m.name || ""),
                   position: String(m.position || "") }));
  }
  if (data.members && typeof data.members === "object") { // v1: {"123": {name, position}, ...}
    return Object.entries(data.members)
      .map(([id, m]) => ({ id: Number(id), name: String((m && m.name) || ""),
                           position: String((m && m.position) || "") }));
  }
  return [];
}

let roster = [];          // [{id, name}]
let rosterAt = 0;
let rosterError = "";

async function refreshRoster() {
  try {
    let data;
    try { data = await torn("https://api.torn.com/v2/faction/members", TORN_KEY); }
    catch (e) { data = await torn("https://api.torn.com/faction/?selections=basic", TORN_KEY); }
    const list = normaliseRoster(data).filter(m => m.id && m.name);
    if (!list.length) throw new Error("Torn returned an empty member list.");
    roster = list.sort((a, b) => a.name.localeCompare(b.name));
    rosterAt = Date.now();
    rosterError = "";
    console.log(new Date().toISOString(), "roster refreshed:", roster.length, "members");
  } catch (err) {
    rosterError = err.message;
    console.error(new Date().toISOString(), "roster refresh failed:", err.message);
  }
}

async function verifyMemberKey(key) {
  if (!/^[A-Za-z0-9]{16}$/.test(String(key || "").trim()))
    throw new Error("That doesn't look like a Torn API key — they're 16 letters and numbers.");
  let data;
  try { data = await torn("https://api.torn.com/user/?selections=basic", key.trim()); }
  catch (e) { data = await torn("https://api.torn.com/v2/user/basic", key.trim()); }
  const id = Number(data.player_id || (data.basic && data.basic.player_id) || data.id);
  const name = String(data.name || (data.basic && data.basic.name) || "");
  if (!id) throw new Error("Couldn't read a player ID from that key.");
  return { id, name };
}

/* ---------- live status ----------
   One call to faction/members carries everything: who is online, who is in
   hospital and until when, and who is abroad. That same call feeds the roster,
   this board, and the turnout history, so polling it once serves all three. */
let live = { members: [], at: 0, error: "" };
const seen = {};        // id -> {state, since} so we can say how long someone has been travelling

function normaliseMembers(data){
  const rows = Array.isArray(data.members)
    ? data.members.map(m => [m.id || m.user_id, m])
    : Object.entries(data.members || {});
  return rows.map(([id,m])=>{
    const st = m.status || {}, la = m.last_action || {};
    return {
      id: Number(id),
      name: String(m.name || ""),
      state: String(st.state || "Unknown"),
      description: String(st.description || ""),
      until: Number(st.until || 0),
      online: String(la.status || "Offline"),
      lastAction: Number(la.timestamp || 0)
    };
  }).filter(m=>m.id && m.name);
}

/* Which hour of the Torn week is it right now? Slot 0 is Monday 00:00 UTC. */
function currentSlot(){
  const n = new Date();
  return ((n.getUTCDay()+6)%7)*24 + n.getUTCHours();
}

async function pollStatus(){
  try{
    let data;
    try { data = await torn("https://api.torn.com/v2/faction/members?striptags=true", TORN_KEY); }
    catch(e){ data = await torn("https://api.torn.com/faction/?selections=basic&striptags=true", TORN_KEY); }
    const list = normaliseMembers(data);
    if(!list.length) throw new Error("Torn returned no members.");

    const now = Date.now();
    list.forEach(m=>{
      const prev = seen[m.id];
      if(!prev || prev.state !== m.state) seen[m.id] = { state:m.state, since:now };
      m.since = seen[m.id].since;             // when they entered this state, as far as we've observed
    });
    live = { members:list, at:now, error:"" };

    /* Turnout sample: count anyone Online or Idle as present for this hour. */
    const slot = String(currentSlot());
    const bucket = history.slots[slot] || (history.slots[slot] = { n:0, by:{} });
    bucket.n++;
    history.polls++;
    list.forEach(m=>{
      if(m.online === "Online" || m.online === "Idle")
        bucket.by[m.id] = (bucket.by[m.id] || 0) + 1;
    });
    saveHist(history);
  }catch(err){
    live.error = err.message;
    console.error(new Date().toISOString(), "status poll failed:", err.message);
  }
}

/* ---------- wars and chains ----------
   Ranked wars carry their own start time, so they belong on the calendar
   without anyone typing them in. Whether these selections work on a Public key
   isn't something I can promise, so a refusal is recorded and shown rather
   than silently swallowed. */
let warState = { wars: [], chain: null, at: 0, error: "" };

/* Torn returns names HTML-escaped, so "Wanderers' Refuge" arrives as
   "Wanderers&#039; Refuge". We render with textContent, so decode it here. */
function unescapeHtml(t){
  return String(t)
    .replace(/&#0?39;/g,"'").replace(/&apos;/g,"'")
    .replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&amp;/g,"&");
}

function normaliseWars(data){
  const raw = data.rankedwars || data.rankedWars || {};
  const rows = Array.isArray(raw) ? raw.map(w=>[w.id||w.war_id,w]) : Object.entries(raw);
  return rows.map(([id,w])=>{
    if(!w) return null;
    const war = w.war || w;
    const facs = w.factions || {};
    const list = Array.isArray(facs) ? facs : Object.entries(facs).map(([fid,f])=>({id:Number(fid),...f}));
    const us   = list.find(f=>String(f.name||"").length && Number(f.id)===Number(ourFactionId)) || list[0] || {};
    const them = list.find(f=>f!==us) || {};
    return {
      id: String(id),
      start: Number(war.start||0)*1000,
      end:   Number(war.end||0)*1000,
      target: Number(war.target||0),
      winner: Number(war.winner||0),
      us:   { name: unescapeHtml(us.name||"Us"),   score: Number(us.score||0) },
      them: { name: unescapeHtml(them.name||"Them"), score: Number(them.score||0) },
      winnerName: unescapeHtml((list.find(f=>Number(f.id)===Number(war.winner))||{}).name||"")
    };
  }).filter(Boolean).filter(w=>w.start);
}

let ourFactionId = 0;

async function pollWars(){
  try{
    let data;
    try { data = await torn("https://api.torn.com/faction/?selections=basic,rankedwars,chain", TORN_KEY); }
    catch(e){ data = await torn("https://api.torn.com/v2/faction/rankedwars", TORN_KEY); }
    if(data.ID) ourFactionId = Number(data.ID);
    if(data.id) ourFactionId = Number(data.id);
    const c = data.chain || null;
    warState = {
      wars: normaliseWars(data),
      chain: c && Number(c.current) ? {
        current: Number(c.current||0), max: Number(c.max||0),
        timeout: Number(c.timeout||0), modifier: Number(c.modifier||0),
        cooldown: Number(c.cooldown||0), start: Number(c.start||0)*1000
      } : null,
      at: Date.now(), error: ""
    };
  }catch(err){
    warState.error = err.message;
    warState.at = Date.now();
    console.error(new Date().toISOString(), "war/chain poll failed:", err.message);
  }
}

/* Synced war entries are rebuilt from Torn every time, so they can't drift.
   Manual entries live in the file and are only ever touched by an admin. */
function calendarEntries(){
  const now = Date.now();
  const synced = warState.wars.map(w=>{
    const ended = w.end && w.end < now;
    const won = w.winner && w.winner === ourFactionId;
    const score = w.us.score + " to " + w.them.score;
    return {
      id: "torn-war-"+w.id,
      source: "torn",
      type: "war",
      title: (ended ? "Finished: war vs " : "Ranked war vs ") + w.them.name,
      startsAt: w.start,
      endsAt: w.end || (w.start + 5*864e5),
      finished: !!ended,
      body: ended
        ? (w.winner ? (won ? "We won, " : "We lost, ") + score + "." : "Ended " + score + ".")
        : "Target " + (w.target||"?") + ". Score " + score + ".",
      createdBy: "Torn",
      updatedAt: warState.at
    };
  });
  return [...synced, ...calendar.entries]
    .map(e=>({ ...e, rsvps: Object.values(rsvps[e.id]||{}) }))
    .sort((a,b)=>a.startsAt-b.startsAt);
}

/* ---------- share codes ---------- */
/* Only the timezone and the painted hours are taken from the code.
   The name is always the one Torn gives us. */
function decodeCode(code) {
  const raw = String(code || "").trim().replace(/\s+/g, "").replace(/^TSC1-/, "");
  if (raw.length > 2000) throw new Error("That code is too long to be real.");
  let obj;
  try { obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
  catch (e) { throw new Error("Your hours didn't come through properly. Try painting them again."); }
  if (!obj || typeof obj.z !== "string" || typeof obj.g !== "string")
    throw new Error("Your hours didn't come through properly. Try painting them again.");
  if (!/^[A-Za-z0-9+/]{28}$/.test(obj.g)) throw new Error("Your hours look corrupted. Try painting them again.");
  try { new Intl.DateTimeFormat("en", { timeZone: obj.z }); }
  catch (e) { throw new Error("Your browser reported a timezone Torn's server doesn't know."); }
  return { tz: obj.z, g: obj.g };
}

/* ---------- plumbing ---------- */
const hits = new Map();
function rateLimited(ip, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 8192) { reject(new Error("Request too large.")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error("Malformed request.")); }
    });
    req.on("error", reject);
  });
}

/* ---------- routes ---------- */
const server = http.createServer(async (req, res) => {
  const fwd = req.headers["x-forwarded-for"];
  const ip  = fwd ? String(fwd).split(",")[0].trim() : req.socket.remoteAddress;
  const url = req.url.split("?")[0];

  try {
    if (req.method === "GET" && url === "/api/roster") {
      if (!roster.length && !rosterError) await refreshRoster();
      return send(res, 200, {
        roster,
        updated: rosterAt ? new Date(rosterAt).toISOString() : null,
        error: rosterError || undefined
      });
    }

    /* Everything below here is faction business, so it needs a session. The
       roster stays open because Torn shows faction membership publicly anyway,
       and people need it to pick their name before they can sign in. */
    if (req.method === "GET" && ["/api/live","/api/board","/api/turnout","/api/calendar","/api/docs","/api/annual","/api/nfl","/api/nfl/history"].includes(url)) {
      if (!readSession(req)) return send(res, 401, { error: "Sign in to see this." });
    }

    if (req.method === "GET" && url === "/api/calendar") {
      return send(res, 200, {
        entries: calendarEntries(),
        chain: warState.chain,
        warError: warState.error || undefined,
        updated: warState.at ? new Date(warState.at).toISOString() : null
      });
    }

    if (req.method === "POST" && url === "/api/calendar") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      const title = String(b.title||"").trim().slice(0,120);
      const startsAt = Number(b.startsAt||0);
      if (!title) return send(res, 400, { error: "Give it a title." });
      if (!startsAt) return send(res, 400, { error: "Give it a start date and time." });
      const type = ["war","chain","event","note"].includes(b.type) ? b.type : "event";
      const entry = {
        id: String(b.id||"").startsWith("m-") ? b.id : "m-"+crypto.randomBytes(8).toString("hex"),
        source: "manual", type, title, startsAt,
        endsAt: Number(b.endsAt||0) || startsAt + 3600e3,
        body: String(b.body||"").slice(0,4000),
        createdBy: sess.name, updatedAt: Date.now()
      };
      const at = calendar.entries.findIndex(e=>e.id===entry.id);
      if (at>=0) calendar.entries[at]=entry; else calendar.entries.push(entry);
      writeJson(CAL_FILE, calendar);
      console.log(new Date().toISOString(), (at>=0?"calendar updated":"calendar added"), title, "by", sess.name);
      return send(res, 200, { ok:true, entry });
    }

    /* Any signed-in member can say whether they're coming. Admin-key sessions
       have no player behind them, so they can't. */
    if (req.method === "POST" && url === "/api/calendar/rsvp") {
      const sess = readSession(req);
      if (!sess) return send(res, 401, { error: "Sign in to do that." });
      if (!sess.id) return send(res, 403, { error: "Sign in with your own API key to answer for yourself." });
      const b = await readBody(req);
      const id = String(b.id||"");
      if (!id) return send(res, 400, { error: "Which entry?" });
      const known = calendarEntries().some(e=>e.id===id);
      if (!known) return send(res, 404, { error: "No entry with that id." });
      const status = ["in","maybe","out"].includes(b.status) ? b.status : null;
      rsvps[id] = rsvps[id] || {};
      if (!status) delete rsvps[id][sess.id];
      else rsvps[id][sess.id] = {
        id: sess.id, name: sess.name, status,
        note: String(b.note||"").trim().slice(0,200),
        at: Date.now()
      };
      if (!Object.keys(rsvps[id]).length) delete rsvps[id];
      writeJson(RSVP_FILE, rsvps);
      return send(res, 200, { ok:true, rsvps: Object.values(rsvps[id]||{}) });
    }

    if (req.method === "POST" && url === "/api/calendar/delete") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      const before = calendar.entries.length;
      calendar.entries = calendar.entries.filter(e=>e.id!==String(b.id));
      if (calendar.entries.length===before) return send(res, 404, { error: "No entry with that id. Torn-synced wars can't be deleted." });
      if (rsvps[String(b.id)]) { delete rsvps[String(b.id)]; writeJson(RSVP_FILE, rsvps); }
      writeJson(CAL_FILE, calendar);
      console.log(new Date().toISOString(), "calendar deleted", b.id, "by", sess.name);
      return send(res, 200, { ok:true });
    }

    if (req.method === "GET" && url === "/api/nfl/history") {
      const log = nfl.log || {}, weeks = nfl.weeks || {};
      const order = Object.keys(log)
        .filter(wk=>(weeks[wk]||0) >= (nfl.startAt||0))
        .sort((a,b)=>(weeks[b]||0)-(weeks[a]||0));
      const out = order.map(wk=>{
        const rows = nfl.assignments.filter(a=>a.name).map(a=>{
          const team = teamKey(a.team);
          const v = resOf(log[wk][team]);
          if(!v.r) return null;
          const who = String(a.id || a.name);
          const meta = hitOf((nfl.hits[wk]||{})[who]);
          const done = Number(meta.n||0);
          return { name:a.name, id:a.id||0, team, teamName:TEAM_NAMES[team]||team,
                   result:v.r, opponent:v.o||"", score:v.s||"",
                   hits: done, recordedAt: meta.at||0, recordedBy: meta.by||"",
                   paid: v.r!=="L" ? null : done >= NFL_HITS };
        }).filter(Boolean).sort((a,b)=>(a.result===b.result?0:a.result==="L"?-1:1)||0);
        return { week:wk, at:weeks[wk]||0, rows,
                 losers: rows.filter(r=>r.result==="L").length,
                 paidUp: rows.filter(r=>r.paid===true).length };
      }).filter(w=>w.rows.length);
      return send(res, 200, { weeks: out, hitsRequired: NFL_HITS });
    }

    if (req.method === "GET" && url === "/api/nfl") {
      return send(res, 200, nflBoard());
    }

    /* Anyone records their own hits. Admins can correct anybody's. */
    if (req.method === "POST" && url === "/api/nfl/hits") {
      const sess = readSession(req);
      if (!sess) return send(res, 401, { error: "Sign in to do that." });
      const b = await readBody(req);
      const who = b.who ? String(b.who) : String(sess.id || sess.name);
      if (who !== String(sess.id) && who !== sess.name && !sess.admin)
        return send(res, 403, { error: "You can only record your own hits." });
      const key = nflState.season + "-" + nflState.week;
      const n = Math.max(0, Math.min(99, Number(b.hits) || 0));
      nfl.hits[key] = nfl.hits[key] || {};
      if (n) nfl.hits[key][who] = { n, at: Date.now(), by: sess.name };
      else delete nfl.hits[key][who];
      writeJson(NFL_FILE, nfl);
      console.log(new Date().toISOString(), "NFL hits", who, "=", n, "recorded by", sess.name);
      return send(res, 200, { ok: true, hits: n });
    }

    /* Either person in the fixture, or an admin, can say the slapping happened. */
    if (req.method === "POST" && url === "/api/nfl/slap") {
      const sess = readSession(req);
      if (!sess) return send(res, 401, { error: "Sign in to do that." });
      const b = await readBody(req);
      const key = String(b.key || "");
      if (!key) return send(res, 400, { error: "Which fixture?" });
      const pair = nflBoard().slaps.find(s => s.key === key);
      if (!pair) return send(res, 404, { error: "No such fixture this week." });
      const involved = [pair.a, pair.b].some(p =>
        (p.id && p.id === sess.id) || (p.name || "").toLowerCase() === (sess.name || "").toLowerCase());
      if (!involved && !sess.admin)
        return send(res, 403, { error: "Only the two involved, or an admin, can mark this." });
      if (b.done === false) delete nfl.slaps[key];
      else nfl.slaps[key] = { by: sess.name, at: Date.now() };
      writeJson(NFL_FILE, nfl);
      console.log(new Date().toISOString(), "trout slap", key, b.done === false ? "unmarked" : "marked", "by", sess.name);
      return send(res, 200, { ok: true });
    }

    /* Restart the whole thing from now, wiping nothing but ignoring everything
       before this point. */
    if (req.method === "POST" && url === "/api/nfl/start") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      nfl.startAt = b.at ? Number(b.at) : Date.now();
      writeJson(NFL_FILE, nfl);
      console.log(new Date().toISOString(), "NFL event start set to", new Date(nfl.startAt).toISOString(), "by", sess.name);
      return send(res, 200, { ok: true, startAt: nfl.startAt });
    }

    if (req.method === "POST" && url === "/api/nfl/assign") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      const team = teamKey(b.team);
      if (!team) return send(res, 400, { error: "Which team?" });
      const at = nfl.assignments.findIndex(a => teamKey(a.team) === team);
      const entry = { team, name: String(b.name || "").trim().slice(0, 40), id: Number(b.id) || 0 };
      if (at >= 0) nfl.assignments[at] = entry; else nfl.assignments.push(entry);
      writeJson(NFL_FILE, nfl);
      console.log(new Date().toISOString(), "NFL", team, "->", entry.name || "(nobody)", "by", sess.name);
      return send(res, 200, { ok: true });
    }

    /* If the scoreboard feed is down or wrong, an admin can call a result. */
    if (req.method === "POST" && url === "/api/nfl/result") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      const gameId = String(b.gameId || "");
      if (!gameId) return send(res, 400, { error: "Which game?" });
      if (b.clear) delete nfl.manual[gameId];
      else nfl.manual[gameId] = { loserTeam: teamKey(b.loserTeam), by: sess.name, at: Date.now() };
      writeJson(NFL_FILE, nfl);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/nfl/refresh") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      await pollNfl();
      return send(res, 200, { ok: true, error: nflState.error || undefined });
    }

    if (req.method === "GET" && url === "/api/annual") {
      return send(res, 200, { events: annual.events });
    }

    if (req.method === "POST" && url === "/api/annual") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      const name = String(b.name||"").trim().slice(0,80);
      if (!name) return send(res, 400, { error: "Give it a name." });
      const rule = ["fixed","easter","beerday"].includes(b.rule) ? b.rule : "fixed";
      const ev = {
        id: String(b.id||"").trim() || "c-"+crypto.randomBytes(6).toString("hex"),
        name, rule,
        month: Math.min(12, Math.max(1, Number(b.month)||1)),
        day:   Math.min(31, Math.max(1, Number(b.day)||1)),
        days:  Math.min(60, Math.max(1, Number(b.days)||1)),
        sure: b.sure !== false,
        what: String(b.what||"").slice(0,2000),
        tip:  String(b.tip||"").slice(0,2000)
      };
      const at = annual.events.findIndex(e=>e.id===ev.id);
      if (at>=0) annual.events[at]=ev; else annual.events.push(ev);
      writeJson(EV_FILE, annual);
      console.log(new Date().toISOString(), (at>=0?"event updated":"event added"), name, "by", sess.name);
      return send(res, 200, { ok:true, event:ev });
    }

    if (req.method === "POST" && url === "/api/annual/delete") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      const before = annual.events.length;
      annual.events = annual.events.filter(e=>e.id!==String(b.id));
      if (annual.events.length===before) return send(res, 404, { error: "No event with that id." });
      writeJson(EV_FILE, annual);
      console.log(new Date().toISOString(), "event deleted", b.id, "by", sess.name);
      return send(res, 200, { ok:true });
    }

    if (req.method === "POST" && url === "/api/docs/delete") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      const key = String(b.key||"");
      if (!docs[key]) return send(res, 404, { error: "No page by that name." });
      delete docs[key];
      writeJson(DOCS_FILE, docs);
      console.log(new Date().toISOString(), "doc deleted:", key, "by", sess.name);
      return send(res, 200, { ok:true });
    }

    if (req.method === "GET" && url === "/api/docs") {
      return send(res, 200, {
        docs: Object.entries(docs).map(([key,d])=>({ key, ...d }))
      });
    }

    if (req.method === "POST" && url === "/api/docs") {
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const b = await readBody(req);
      const key = String(b.key||"").trim().slice(0,40).replace(/[^a-z0-9-]/gi,"");
      if (!key) return send(res, 400, { error: "That page name isn't valid." });
      docs[key] = {
        title: String(b.title||key).trim().slice(0,120),
        body: String(b.body||"").slice(0,40000),   // stored as plain text; the page renders it safely
        updatedAt: Date.now(),
        updatedBy: sess.name
      };
      writeJson(DOCS_FILE, docs);
      console.log(new Date().toISOString(), "doc saved:", key, "by", sess.name);
      return send(res, 200, { ok:true, doc:{ key, ...docs[key] } });
    }

    if (req.method === "GET" && url === "/api/live") {
      return send(res, 200, {
        members: live.members,
        updated: live.at ? new Date(live.at).toISOString() : null,
        error: live.error || undefined,
        chain: warState.chain
      });
    }

    if (req.method === "GET" && url === "/api/turnout") {
      return send(res, 200, {
        slots: history.slots,
        polls: history.polls,
        since: history.since,
        pollMins: POLL_MINS
      });
    }

    if (req.method === "GET" && url === "/api/board") {
      /* People who have left the faction stop appearing, without deleting
         their hours in case they come back. */
      const ids = new Set(roster.map(m => m.id));
      const visible = roster.length ? board.members.filter(m => ids.has(m.id)) : board.members;
      return send(res, 200, { members: visible });
    }

    /* Lets a returning browser confirm a saved passphrase without submitting
       anything, so people aren't locked out of the board they already joined. */
    if (req.method === "POST" && url === "/api/check") {
      if (rateLimited(ip, 30, 60000)) return send(res, 429, { error: "Too many attempts. Wait a minute." });
      const body = await readBody(req);
      const ok = (body.pass && sameSecret(body.pass, JOIN_PASS)) ||
                 (body.admin && sameSecret(body.admin, ADMIN_KEY));
      if (!ok) return send(res, 403, { error: "Wrong passphrase." });
      return send(res, 200, { ok: true });
    }

    /* Signing in with a key alone: proves faction membership, unlocks the rest
       of the site, and hands back whatever hours this person already sent so
       they can pick up on a new device without starting again. */
    if (req.method === "POST" && url === "/api/signin") {
      if (rateLimited(ip, 15, 60000)) return send(res, 429, { error: "Too many attempts. Wait a minute." });
      const body = await readBody(req);
      const who = await verifyMemberKey(body.apiKey);
      if (!roster.length) await refreshRoster();
      if (!roster.length) return send(res, 503, { error: "Can't reach Torn to check the roster. Try again in a minute." });
      const onRoster = roster.find(m => m.id === who.id);
      if (!onRoster) return send(res, 403, { error: "That player isn't in this faction." });
      const entry = board.members.find(m => m.id === who.id);
      const admin = isAdmin(onRoster);
      const token = mintSession({ id: who.id, name: onRoster.name, admin });
      console.log(new Date().toISOString(), "signin", onRoster.name, "(" + who.id + ")",
                  onRoster.position || "no position", admin ? "ADMIN" : "");
      return send(res, 200, {
        ok: true, id: who.id, name: onRoster.name,
        position: onRoster.position || "", admin, token,
        hours: entry ? { tz: entry.tz, g: entry.g, updated: entry.updated } : null
      });
    }

    /* Break-glass: the shared key buys an admin session and is then done with.
       The browser keeps the token, never the key. */
    if (req.method === "POST" && url === "/api/admin") {
      if (rateLimited(ip, 8, 60000)) return send(res, 429, { error: "Too many attempts. Wait a minute." });
      const body = await readBody(req);
      if (!body.admin || !sameSecret(body.admin, ADMIN_KEY))
        return send(res, 403, { error: "Wrong admin key." });
      const token = mintSession({ id: 0, name: "admin key", admin: true });
      console.log(new Date().toISOString(), "admin key sign-in from", ip);
      return send(res, 200, { ok: true, admin: true, name: "admin key", token });
    }

    if (req.method === "GET" && url === "/api/session") {
      const sess = readSession(req);
      if (!sess) return send(res, 401, { error: "Not signed in." });
      return send(res, 200, { ok: true, id: sess.id, name: sess.name, admin: sess.admin });
    }

    if (req.method === "POST" && url === "/api/signout") {
      const auth = req.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (token && sessions[tokenHash(token)]) { delete sessions[tokenHash(token)]; saveSess(); }
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/submit") {
      if (rateLimited(ip, 15, 60000)) return send(res, 429, { error: "Too many attempts. Wait a minute." });
      const body = await readBody(req);
      const hours = decodeCode(body.code);
      if (!roster.length) await refreshRoster();
      if (!roster.length) return send(res, 503, { error: "Can't reach Torn to check the roster. Try again in a minute." });

      /* Two ways in. A Public API key proves who you are outright, so it stands
         on its own. Without one you need the shared faction passphrase, and the
         entry is marked unverified. */
      let id, verified;
      const sess = readSession(req);
      if (sess && sess.id) {
        id = sess.id;                                     // already proved who they are at sign-in
        verified = true;
      } else if (body.apiKey) {
        const who = await verifyMemberKey(body.apiKey);   // used here, then forgotten
        id = who.id;
        verified = true;
      } else {
        if (!sameSecret(body.pass, JOIN_PASS)) return send(res, 403, { error: "Wrong faction passphrase." });
        id = Number(body.playerId);
        verified = false;
        if (!id) return send(res, 400, { error: "Pick your name from the list first." });
      }

      const onRoster = roster.find(m => m.id === id);
      if (!onRoster) return send(res, 403, { error: "That player isn't in this faction." });

      const at = board.members.findIndex(m => m.id === id);
      if (at >= 0 && board.members[at].verified && !verified)
        return send(res, 409, { error: onRoster.name + " has verified their entry. Verify with your own API key to change it." });

      const entry = {
        id,
        name: onRoster.name,                 // always Torn's spelling, never typed input
        tz: hours.tz,
        g: hours.g,
        verified,
        updated: new Date().toISOString()
      };
      if (at >= 0) board.members[at] = entry; else board.members.push(entry);
      board.members.sort((a, b) => a.name.localeCompare(b.name));
      save(board);
      console.log(new Date().toISOString(), (at >= 0 ? "updated" : "added"), entry.name,
                  "(" + id + ")", verified ? "verified" : "unverified");
      const admin = verified && isAdmin(onRoster);
      return send(res, 200, {
        ok: true, name: entry.name, verified, admin: !!admin,
        token: verified ? mintSession({ id, name: entry.name, admin }) : undefined
      });
    }

    if (req.method === "POST" && url === "/api/remove") {
      if (rateLimited(ip, 20, 60000)) return send(res, 429, { error: "Too many attempts. Wait a minute." });
      const sess = readSession(req);
      if (!sess || !sess.admin) return send(res, 403, { error: "You need to be an admin to do that." });
      const body = await readBody(req);
      const id = Number(body.id);
      const before = board.members.length;
      board.members = board.members.filter(m => m.id !== id);
      if (board.members.length === before) return send(res, 404, { error: "Nobody on the board with that ID." });
      save(board);
      console.log(new Date().toISOString(), "removed", id, "by", sess.name);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "No such endpoint." });
  } catch (err) {
    /* Log the stack here; send only the message to the browser. */
    console.error(new Date().toISOString(), "request failed:", req.method, url, "\n", err.stack || err);
    return send(res, 400, { error: err.message || "Something went wrong." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Faction Hours API listening on 127.0.0.1:" + PORT);
  console.log("Board file:", DATA_FILE, "-", board.members.length, "members loaded");
  console.log("History:", HIST_FILE, "-", Object.keys(history.slots).length, "hours sampled so far");
  pruneSessions();
  console.log("Sessions:", Object.keys(sessions).length, "active");
  if (ADMIN_IDS.length) console.log("Always-admin player IDs:", ADMIN_IDS.join(", "));
  setInterval(pruneSessions, 6 * 3600e3);
  refreshRoster();
  setInterval(refreshRoster, ROSTER_MINS * 60000);
  pollStatus();
  setInterval(pollStatus, POLL_MINS * 60000);
  pollWars();
  setInterval(pollWars, WAR_MINS * 60000);
  pollNfl();
  setInterval(pollNfl, NFL_MINS * 60000);
});
