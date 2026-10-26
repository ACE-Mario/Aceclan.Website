// ACE Clan form relay (Cloudflare Worker).
// The website posts tier lists and applications here; this forwards them to Discord.
// The webhook links live in the Worker's secrets (TIERLIST_WEBHOOK, APPLY_WEBHOOK),
// never in the public website code.

const ALLOWED_ORIGINS = ["https://aceclan.lol", "https://www.aceclan.lol", "http://127.0.0.1:8765"];
const TIERS = ["S", "A", "B", "C", "D"];
const LIMIT = 5;               // max submissions per visitor...
const WINDOW_MS = 60 * 60 * 1000; // ...per hour
const recent = new Map();

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function reply(origin, status, message) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

function tooMany(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > LIMIT;
}

// Trim, cap length, and never allow an empty Discord field.
const clean = (value, max) => String(value ?? "").trim().slice(0, max) || "-";

function tierListEmbed(body) {
  const tiers = body.tiers && typeof body.tiers === "object" ? body.tiers : {};
  const fields = TIERS.map(t => ({
    name: t,
    value: clean((Array.isArray(tiers[t]) ? tiers[t] : []).slice(0, 20).join(", "), 1000),
  }));
  if (Array.isArray(body.unranked) && body.unranked.length) {
    fields.push({ name: "Not ranked", value: clean(body.unranked.slice(0, 20).join(", "), 1000) });
  }
  if (fields.every(f => f.value === "-")) return null;
  return {
    username: "ACE Tier Lists",
    embeds: [{ title: "Tier list from " + clean(body.from, 40), color: 0x7c3aed, fields }],
  };
}

function applicationEmbed(body) {
  if (!String(body.discord ?? "").trim() || !String(body.riot ?? "").includes("#")) return null;
  const field = (name, value, max, inline = true) => ({ name, value: clean(value, max), inline });
  return {
    username: "ACE Applications",
    embeds: [{
      title: "New application: " + clean(body.discord, 40),
      color: 0x7c3aed,
      fields: [
        field("Discord", body.discord, 40),
        field("Riot ID", body.riot, 40),
        field("Games", Array.isArray(body.games) ? body.games.join(", ") : body.games, 40),
        field("Rank", body.rank, 60),
        field("Mains", body.mains, 100),
        field("Why do you want to join?", body.why, 800, false),
      ],
      timestamp: new Date().toISOString(),
    }],
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "POST") return reply(origin, 405, "POST only");
    if (!ALLOWED_ORIGINS.includes(origin)) return reply(origin, 403, "Not allowed");

    const path = new URL(request.url).pathname;
    const route = {
      "/tierlist": [env.TIERLIST_WEBHOOK, tierListEmbed],
      "/apply": [env.APPLY_WEBHOOK, applicationEmbed],
    }[path];
    if (!route) return reply(origin, 404, "Unknown form");

    if (tooMany(request.headers.get("CF-Connecting-IP") || "unknown")) {
      return reply(origin, 429, "Too many submissions, try again later");
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return reply(origin, 400, "Bad request");
    }
    const [webhook, build] = route;
    const payload = build(body);
    if (!payload) return reply(origin, 400, "Missing details");

    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    });
    return res.ok ? reply(origin, 200, "Sent") : reply(origin, 502, "Discord error");
  },
};
