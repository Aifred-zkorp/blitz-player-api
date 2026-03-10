const express = require('express');
const cors = require('cors');

const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// Blitz Player History API
// Aggregates player data across all known Blitz S0 game slots
// ============================================================================

// Known active Blitz slots (s0-game-5 through s0-game-12)
const SLOTS = [];
for (let i = 5; i <= 12; i++) SLOTS.push(`s0-game-${i}`);

// Also check historical slots that may have data
const HISTORICAL_SLOTS = ['s0-game-1', 's0-game-2', 's0-game-3', 's0-game-4'];

const TORII_BASE = 'https://api.cartridge.gg/x';

// Helper: query Torii SQL for a slot
async function toriiQuery(slot, sql) {
  try {
    const res = await fetch(`${TORII_BASE}/${slot}/torii/sql`, {
      method: 'POST',
      body: sql,
      headers: { 'Content-Type': 'text/plain' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data;
  } catch {
    return null;
  }
}

// Helper: decode hex to integer
function hexToInt(hex) {
  if (!hex) return 0;
  return parseInt(hex, 16);
}

// Helper: decode hex to human-readable name (felt252 to string)
function hexToString(hex) {
  if (!hex || hex === '0x0') return '';
  try {
    const clean = hex.replace(/^0x0*/, '');
    if (!clean) return '';
    let str = '';
    for (let i = 0; i < clean.length; i += 2) {
      const code = parseInt(clean.substr(i, 2), 16);
      if (code > 0 && code < 128) str += String.fromCharCode(code);
    }
    return str;
  } catch {
    return hex;
  }
}

// ============================================================================
// GET /player/:address — Full player history
// ============================================================================
app.get('/player/:address', async (req, res) => {
  const { address } = req.params;
  
  // Validate address format
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }

  // Normalize address (pad to 66 chars)
  const normalizedAddr = '0x' + address.slice(2).padStart(64, '0');
  
  const allSlots = [...SLOTS, ...HISTORICAL_SLOTS];
  
  const result = {
    address: normalizedAddr,
    queriedAt: new Date().toISOString(),
    slotsQueried: 0,
    slotsWithData: 0,
    summary: {
      totalGamesPlayed: 0,
      totalWins: 0,
      totalLosses: 0,
      bestRank: null,
      currentMmr: null,
      mmrHistory: [],
      activeGames: [],
    },
    games: [],
  };

  // Query all slots in parallel
  const slotPromises = allSlots.map(async (slot) => {
    const slotData = { slot, registered: false, mmrChanges: [], ranks: [], isActive: false };

    // 1. Check registration
    const reg = await toriiQuery(slot,
      `SELECT player, registered, once_registered FROM "s1_eternum-BlitzRealmPlayerRegister" WHERE player = '${normalizedAddr}' LIMIT 1`
    );
    if (!reg || reg.length === 0) return null;
    
    slotData.registered = true;
    result.slotsWithData++;

    // 2. Get MMR changes
    const mmr = await toriiQuery(slot,
      `SELECT old_mmr, new_mmr, rank, trial_id, timestamp FROM "s1_eternum-PlayerMMRChanged" WHERE player = '${normalizedAddr}' ORDER BY internal_created_at`
    );
    if (mmr && mmr.length > 0) {
      slotData.mmrChanges = mmr.map(m => ({
        oldMmr: hexToInt(m.old_mmr),
        newMmr: hexToInt(m.new_mmr),
        rank: m.rank,
        trialId: hexToInt(m.trial_id),
        timestamp: m.timestamp ? hexToInt(m.timestamp) : null,
      }));
    }

    // 3. Get player rank
    const ranks = await toriiQuery(slot,
      `SELECT rank, paid, trial_id FROM "s1_eternum-PlayerRank" WHERE player = '${normalizedAddr}' ORDER BY rank`
    );
    if (ranks && ranks.length > 0) {
      slotData.ranks = ranks.map(r => ({
        rank: r.rank,
        paid: r.paid === 1,
        trialId: r.trial_id ? hexToInt(r.trial_id) : null,
      }));
    }

    // 4. Check if game is still active (registered but not yet committed)
    const committed = await toriiQuery(slot,
      `SELECT trial_id FROM "s1_eternum-MMRGameCommitted" LIMIT 1`
    );
    if (!committed || committed.length === 0) {
      const regData = reg[0];
      if (regData.registered === 1 || regData.once_registered === 1) {
        slotData.isActive = true;
      }
    }

    return slotData;
  });

  const slotResults = await Promise.all(slotPromises);
  result.slotsQueried = allSlots.length;

  // Aggregate results
  for (const slot of slotResults) {
    if (!slot) continue;

    const game = {
      slot: slot.slot,
      isActive: slot.isActive,
      mmrChanges: slot.mmrChanges,
      finalRank: slot.ranks.length > 0 ? slot.ranks[0].rank : null,
      paid: slot.ranks.length > 0 ? slot.ranks[0].paid : false,
      gamesInSlot: slot.mmrChanges.length,
    };

    result.games.push(game);
    result.summary.totalGamesPlayed += slot.mmrChanges.length;

    // Track wins/losses from MMR changes
    for (const m of slot.mmrChanges) {
      if (m.newMmr > m.oldMmr) result.summary.totalWins++;
      else if (m.newMmr < m.oldMmr) result.summary.totalLosses++;
      result.summary.mmrHistory.push({
        slot: slot.slot,
        mmr: m.newMmr,
        rank: m.rank,
        trialId: m.trialId,
      });
    }

    // Best rank
    for (const r of slot.ranks) {
      if (result.summary.bestRank === null || r.rank < result.summary.bestRank) {
        result.summary.bestRank = r.rank;
      }
    }

    // Current MMR (latest change)
    if (slot.mmrChanges.length > 0) {
      const latest = slot.mmrChanges[slot.mmrChanges.length - 1];
      result.summary.currentMmr = latest.newMmr;
    }

    // Active games
    if (slot.isActive) {
      result.summary.activeGames.push(slot.slot);
    }
  }

  // Calculate derived stats
  const totalDecided = result.summary.totalWins + result.summary.totalLosses;
  result.summary.winRate = totalDecided > 0 
    ? Math.round((result.summary.totalWins / totalDecided) * 10000) / 100 
    : 0;
  result.summary.pointsPerGame = result.summary.totalGamesPlayed > 0
    ? Math.round((result.summary.currentMmr || 0) / result.summary.totalGamesPlayed * 100) / 100
    : 0;

  res.json(result);
});

// ============================================================================
// GET /leaderboard/:slot — Leaderboard for a specific slot
// ============================================================================
app.get('/leaderboard/:slot', async (req, res) => {
  const { slot } = req.params;
  
  if (!/^s0-game-\d+$/.test(slot)) {
    return res.status(400).json({ error: 'Invalid slot format. Use s0-game-N' });
  }

  const ranks = await toriiQuery(slot,
    `SELECT player, rank, paid FROM "s1_eternum-PlayerRank" ORDER BY rank LIMIT 50`
  );

  if (!ranks) {
    return res.status(404).json({ error: `Slot ${slot} not found or unavailable` });
  }

  // Get player names from AddressName table
  const players = await Promise.all(ranks.map(async (r) => {
    const nameData = await toriiQuery(slot,
      `SELECT name FROM "s1_eternum-AddressName" WHERE address = '${r.player}' LIMIT 1`
    );
    return {
      address: r.player,
      name: nameData && nameData[0] ? hexToString(nameData[0].name) : null,
      rank: r.rank,
      paid: r.paid === 1,
    };
  }));

  res.json({ slot, players, queriedAt: new Date().toISOString() });
});

// ============================================================================
// GET /slots — List all known slots and their status
// ============================================================================
app.get('/slots', async (req, res) => {
  const allSlots = [...SLOTS, ...HISTORICAL_SLOTS];
  
  const statuses = await Promise.all(allSlots.map(async (slot) => {
    const check = await toriiQuery(slot, 'SELECT COUNT(*) as c FROM "s1_eternum-BlitzRealmPlayerRegister"');
    if (!check) return { slot, status: 'offline', players: 0 };
    return { slot, status: 'online', players: check[0]?.c || 0 };
  }));

  res.json({ slots: statuses, queriedAt: new Date().toISOString() });
});

// ============================================================================
// GET /health
// ============================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', uptime: process.uptime() });
});

// ============================================================================
// GET /api — API docs (JSON)
// ============================================================================
app.get('/api', (req, res) => {
  res.json({
    name: 'Blitz Player History API',
    version: '1.0.0',
    description: 'Aggregated player stats across all Blitz S0 game slots',
    endpoints: {
      'GET /player/:address': 'Full player history (games, MMR, ranks, win/loss)',
      'GET /leaderboard/:slot': 'Top 50 players for a specific slot',
      'GET /slots': 'List all known slots and their status',
      'GET /health': 'Health check',
    },
    examplePlayer: 'GET /player/0x0643bce119f53a1ec83f57c4c42f694659c2da543d6f8a85b335d3f4bef12548',
    source: 'https://github.com/Aifred-zkorp/blitz-player-api',
  });
});

// For Vercel serverless
module.exports = app;

// For local/Docker
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Blitz Player History API running on port ${PORT}`);
  });
}
