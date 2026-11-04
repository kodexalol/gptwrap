'use strict';

const fs = require('fs');
const path = require('path');

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// Sample content so the site is not empty on first run.
// Everything here is fake and exists only for local development and screenshots.
function seed() {
  const airline = (id, slug, name, description, verified, createdAt, kind = 'airline') => ({
    id,
    slug,
    name,
    kind,
    description,
    robloxGroupId: null,
    verified,
    ownerUserId: null,
    ownerRobloxId: null,
    createdByUserId: null,
    discordInvite: null,
    discordWebhook: null,
    sample: true,
    createdAt,
  });
  const job = (id, airlineId, title, role, description, createdAt) => ({
    id,
    airlineId,
    title,
    role,
    description,
    open: true,
    createdAt,
  });
  // Sample accounts are pre-confirmed so their badges show on first run. They have no real Roblox link.
  const user = (id, username, displayName, bio, createdAt) => ({
    id,
    robloxUserId: null,
    robloxUsername: username,
    confirmed: true,
    pendingRoblox: null,
    username,
    displayName,
    bio,
    verifiedMember: username === 'maya_flies',
    createdAt,
  });
  const post = (id, authorType, airlineId, authorUserId, body, tags, h) => ({
    id,
    authorType,
    airlineId,
    authorUserId,
    body,
    imageUrl: null,
    tags,
    hidden: false,
    createdAt: hoursAgo(h),
  });

  const created = hoursAgo(24 * 60);
  return {
    users: [
      user('user-maya', 'maya_flies', 'Maya', 'First Officer in training. Coffee first, then flights.', created),
      user('user-kai', 'kai_taxi', 'Kai', 'Ground ops at Harbor Jet. Ask me about the gate board.', created),
    ],
    sessions: [],
    airlines: [
      airline('air-northwind', 'northwind-air', 'Northwind Air', 'Regional network across the Harbor Coast. Two-pilot operations, paid training.', true, created),
      airline('air-harbor', 'harbor-jet', 'Harbor Jet', 'Short-haul carrier with fast turns and friendly crews.', true, created),
      airline('air-cobalt', 'cobalt-regional', 'Cobalt Regional', 'Small-fleet regional carrier, growing its crew team this season.', true, created),
      airline('air-skybridge', 'skybridge', 'Skybridge', 'New carrier, still waiting on verification.', false, created),
      airline('air-skyline-store', 'skyline-rostore', 'Skyline Rostore', 'Sample Roblox store selling livery, uniforms and aircraft parts.', true, created, 'store'),
    ],
    jobs: [
      job('job-first-officer', 'air-northwind', 'First Officer', 'pilot', 'Two-pilot operations, flexible rotations, paid type training. Current licence required.', hoursAgo(72)),
      job('job-flight-attendant', 'air-northwind', 'Flight Attendant', 'cabin-crew', 'Passenger care, safety briefings and inflight service across the Harbor Coast network.', hoursAgo(30)),
      job('job-dispatcher', 'air-northwind', 'Ground Dispatcher', 'ground', 'Flight planning support and on-time coordination with ground crews.', hoursAgo(10)),
      job('job-captain', 'air-harbor', 'Captain', 'pilot', 'Short-haul captain role. Strong handling and crew leadership expected.', hoursAgo(48)),
      job('job-gate-agent', 'air-harbor', 'Gate Agent', 'ground', 'Check-in, boarding and gate duties. Weekend availability a plus.', hoursAgo(6)),
      job('job-cabin-lead', 'air-cobalt', 'Cabin Crew Lead', 'cabin-crew', 'Lead a small cabin team and run onboarding for new crew.', hoursAgo(120)),
    ],
    applications: [],
    posts: [
      post('post-1', 'airline', 'air-northwind', null, 'Two pilot seats are open for the winter schedule. Paid training, flexible rotations. Apply from the Jobs tab. #hiring #pilots', ['hiring', 'pilots'], 3),
      post('post-2', 'user', null, 'user-maya', 'First sim session with the new crew today. The approach into Harbor City was clean. #pilots #training', ['pilots', 'training'], 5),
      post('post-3', 'airline', 'air-harbor', null, 'New gate team starts Monday. Welcome aboard, everyone. #ground #teamwork', ['ground', 'teamwork'], 9),
      post('post-4', 'user', null, 'user-kai', 'Boarding got four minutes faster after the new gate layout. Small wins add up. #ground', ['ground'], 14),
      post('post-5', 'airline', 'air-cobalt', null, 'Route map for next season is up on our Discord. Tell us which city you want next. #routes', ['routes'], 26),
    ],
    comments: [
      { id: 'comment-1', postId: 'post-2', authorUserId: 'user-kai', body: 'Congrats. Hope the crosswind wasn\'t too rough.', createdAt: hoursAgo(4) },
    ],
    likes: [
      { postId: 'post-1', userId: 'user-maya', createdAt: hoursAgo(2) },
      { postId: 'post-1', userId: 'user-kai', createdAt: hoursAgo(2) },
      { postId: 'post-2', userId: 'user-kai', createdAt: hoursAgo(4) },
      { postId: 'post-3', userId: 'user-maya', createdAt: hoursAgo(8) },
      { postId: 'post-4', userId: 'user-maya', createdAt: hoursAgo(12) },
    ],
    follows: [],
    reports: [],
    conversations: [],
    messages: [],
    blocks: [],
    audit: [],
  };
}

// Small JSON-file store. Fine for a prototype; move to SQLite or Postgres before real traffic.
class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Add any collections missing from an older database file.
      const base = seed();
      for (const key of Object.keys(base)) {
        if (!Array.isArray(this.data[key])) this.data[key] = base[key];
      }
    } else {
      this.data = seed();
      this.save();
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
