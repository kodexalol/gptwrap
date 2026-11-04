'use strict';

const fs = require('fs');
const path = require('path');

const SEED_TIME = '2026-01-01T00:00:00.000Z';

// Sample airlines and roles so the site has something to show on first run.
// Every record with sample: true is fake and exists only for local development.
function seed() {
  return {
    airlines: [
      {
        id: 'air-northwind',
        slug: 'northwind-air',
        name: 'Northwind Air',
        description: 'Sample regional airline for local testing.',
        robloxGroupId: null,
        verified: true,
        ownerRobloxId: null,
        manageTokenHash: null,
        discordInvite: null,
        discordWebhook: null,
        sample: true,
        createdAt: SEED_TIME,
      },
      {
        id: 'air-harbor',
        slug: 'harbor-jet',
        name: 'Harbor Jet',
        description: 'Sample short-haul carrier with a small fleet.',
        robloxGroupId: null,
        verified: true,
        ownerRobloxId: null,
        manageTokenHash: null,
        discordInvite: null,
        discordWebhook: null,
        sample: true,
        createdAt: SEED_TIME,
      },
    ],
    jobs: [
      {
        id: 'job-first-officer',
        airlineId: 'air-northwind',
        title: 'First Officer',
        role: 'pilot',
        description: 'Sample role. Two-pilot operations, flexible hours, training provided.',
        open: true,
        createdAt: SEED_TIME,
      },
      {
        id: 'job-flight-attendant',
        airlineId: 'air-northwind',
        title: 'Flight Attendant',
        role: 'cabin-crew',
        description: 'Sample role. Passenger care and safety briefings.',
        open: true,
        createdAt: SEED_TIME,
      },
      {
        id: 'job-gate-agent',
        airlineId: 'air-harbor',
        title: 'Gate Agent',
        role: 'ground',
        description: 'Sample role. Check-in, boarding and gate duties.',
        open: true,
        createdAt: SEED_TIME,
      },
    ],
    applications: [],
  };
}

// Small JSON-file store. Fine for an MVP; swap for SQLite or Postgres before real traffic.
class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
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
